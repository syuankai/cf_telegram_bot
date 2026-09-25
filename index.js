from pathlib import Path
base = Path("/mnt/data/telegram-ai-bot")
base.mkdir(exist_ok=True)

index_js = r'''const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const HISTORY_LIMIT = 20;
const MAX_CONTEXT_CHARS = 12000;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Telegram AI Bot is running.", { status: 200 });
    }

    // Optional webhook authentication. Configure TELEGRAM_WEBHOOK_SECRET
    // and set the same value as Telegram's setWebhook secret_token.
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const message = update.message;
    if (!message?.text || !message.chat?.id) return new Response("OK");

    const chatId = String(message.chat.id);
    if (!env.TGBOTUSER || chatId !== String(env.TGBOTUSER)) {
      return new Response("Forbidden", { status: 403 });
    }

    const text = message.text.trim();

    try {
      if (text === "/start") {
        await sendTelegram(env, chatId,
          "你好！我是 AI 機器人。\n直接傳送訊息即可聊天。\n\n" +
          "/help - 查看指令\n/clear - 清除記憶\n/export - 匯出 JSON");
        return new Response("OK");
      }

      if (text === "/help") {
        await sendTelegram(env, chatId,
          "指令：\n/start - 開始使用\n/help - 說明\n" +
          "/clear - 清除歷史紀錄\n/export - 匯出歷史紀錄 JSON\n\n" +
          "直接傳送文字即可聊天。");
        return new Response("OK");
      }

      if (text === "/clear") {
        await redis(env, ["DEL", historyKey(chatId)]);
        await sendTelegram(env, chatId, "已清除對話記憶。");
        return new Response("OK");
      }

      if (text === "/export") {
        const history = await getHistory(env, chatId);
        const file = {
          chat_id: chatId,
          exported_at: new Date().toISOString(),
          message_count: history.length,
          messages: history
        };
        await sendDocument(
          env, chatId, JSON.stringify(file, null, 2),
          `telegram-history-${chatId}.json`
        );
        return new Response("OK");
      }

      if (text.startsWith("/")) {
        await sendTelegram(env, chatId, "未知指令，輸入 /help 查看說明。");
        return new Response("OK");
      }

      const history = await getHistory(env, chatId);
      const messages = [
        {
          role: "system",
          content: "你是一個友善、樂於助人的 AI 助理，請使用繁體中文回答。"
        },
        ...trimHistory(history, MAX_CONTEXT_CHARS),
        { role: "user", content: text }
      ];

      const result = await askWithFallback(env, messages);

      const updated = [
        ...history,
        { role: "user", content: text, timestamp: Date.now() },
        {
          role: "assistant",
          content: result.answer,
          timestamp: Date.now(),
          provider: result.provider,
          model: result.model
        }
      ].slice(-HISTORY_LIMIT);

      await saveHistory(env, chatId, updated);
      await sendTelegram(
        env, chatId,
        result.answer + (env.SHOW_MODEL === "true"
          ? `\n\n[${result.provider}: ${result.model}]` : "")
      );
    } catch (error) {
      console.error("Bot error:", error);
      await sendTelegram(
        env, chatId,
        "處理失敗，請檢查設定或稍後再試。" +
        (env.SHOW_ERRORS === "true"
          ? `\n${String(error.message).slice(0, 500)}` : "")
      );
    }

    return new Response("OK");
  }
};

// Upstash Redis REST API: send Redis command arrays as JSON via POST.
async function redis(env, command) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis credentials missing");

  const response = await fetch(url.replace(/\/+$/, ""), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function historyKey(chatId) {
  return `tg:history:${chatId}`;
}

async function getHistory(env, chatId) {
  const raw = await redis(env, ["GET", historyKey(chatId)]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error("Stored history is invalid JSON");
    return [];
  }
}

async function saveHistory(env, chatId, history) {
  await redis(env, ["SET", historyKey(chatId), JSON.stringify(history)]);
}

function trimHistory(history, maxChars) {
  const result = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string") continue;
    const size = item.content.length;
    if (total + size > maxChars) break;
    result.unshift({ role: item.role, content: item.content });
    total += size;
  }
  return result;
}

async function askWithFallback(env, messages) {
  const selected = String(env.AI_PROVIDER || "AI").toUpperCase();

  if (selected !== "AUTO") {
    const model = selected === "AI"
      ? env.AI_MODEL || DEFAULT_MODEL
      : selected === "GAI"
        ? env.GAI_MODEL || "gemini-2.5-flash"
        : selected === "OCAI"
          ? env.OCAI_MODEL || "gpt-oss:20b"
          : null;
    if (!model) throw new Error(`Unsupported AI provider: ${selected}`);
    return {
      answer: await callProvider(env, selected, model, messages),
      provider: selected,
      model
    };
  }

  let candidates;
  try {
    candidates = JSON.parse(env.AUTO_MODELS || "[]");
  } catch {
    throw new Error("AUTO_MODELS must be valid JSON");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("AUTO mode has no configured models");
  }

  const failures = [];
  for (const candidate of candidates) {
    const provider = String(candidate?.provider || "").toUpperCase();
    const model = candidate?.model;
    if (!["AI", "GAI", "OCAI"].includes(provider) ||
        typeof model !== "string" || !model.trim()) {
      failures.push("Invalid model candidate configuration");
      continue;
    }
    try {
      const answer = await callProvider(env, provider, model, messages);
      if (!answer.trim()) throw new Error("Empty AI response");
      console.log(`Auto selected ${provider}/${model}`);
      return { answer, provider, model };
    } catch (error) {
      console.error(`Failover ${provider}/${model}:`, error.message);
      failures.push(`${provider}/${model}: ${error.message}`);
    }
  }
  throw new Error(`All AI models failed: ${failures.join(" | ")}`);
}

async function callProvider(env, provider, model, messages) {
  if (provider === "AI") {
    if (!env.AI) throw new Error("Workers AI binding AI is missing");
    const result = await env.AI.run(model, {
      messages: messages.map(({ role, content }) => ({ role, content }))
    });
    const answer = result?.response || result?.output_text || "";
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Workers AI returned no text");
    }
    return answer;
  }

  const isGoogle = provider === "GAI";
  const baseURL = isGoogle
    ? env.GAI_BASEAPIURL || "https://generativelanguage.googleapis.com/v1beta/openai/"
    : env.OCAI_BASEAPIURL || "https://ollama.com/v1";
  const apiKey = isGoogle ? env.GAIKEY : env.OCAIKEY;
  if (!apiKey) throw new Error(`${provider} API key missing`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(
      `${baseURL.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages })
      }
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Invalid or empty API response");
    }
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

function telegramBase(env) {
  const endpoint = (env.TGBOTAPI_ENDPOINT || "https://api.telegram.org")
    .replace(/\/+$/, "");
  if (!env.TGBOTAPI) throw new Error("TGBOTAPI is missing");
  return `${endpoint}/bot${env.TGBOTAPI}`;
}

async function sendTelegram(env, chatId, text) {
  for (const chunk of splitMessage(String(text), 4000)) {
    const response = await fetch(`${telegramBase(env)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk })
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage HTTP ${response.status}`);
    }
  }
}

async function sendDocument(env, chatId, contents, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(
    "document",
    new Blob([contents], { type: "application/json" }),
    filename
  );
  const response = await fetch(`${telegramBase(env)}/sendDocument`, {
    method: "POST",
    body: form
  });
  if (!response.ok) {
    throw new Error(`Telegram sendDocument HTTP ${response.status}`);
  }
}

function splitMessage(text, maxLength) {
  const chunks = [];
  while (text.length > maxLength) {
    let index = text.lastIndexOf("\n", maxLength);
    if (index < maxLength / 2) index = maxLength;
    chunks.push(text.slice(0, index));
    text = text.slice(index).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}
'''
wrangler = '''name = "telegram-ai-bot"
main = "index.js"
compatibility_date = "2026-09-25"

[ai]
binding = "AI"
'''
package = '''{
  "name": "telegram-ai-bot",
  "version": "1.0.0",
  "private": true,
  "description": "Telegram AI bot on Cloudflare Workers with Upstash history and model failover",
  "scripts": {
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
'''
(base / "index.js").write_text(index_js, encoding="utf-8")
(base / "wrangler.toml").write_text(wrangler, encoding="utf-8")
(base / "package.json").write_text(package, encoding="utf-8")
print("Created:", ", ".join(p.name for p in base.iterdir()))
            
