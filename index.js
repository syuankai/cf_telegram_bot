const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_GAI_MODEL = "gemini-2.5-flash";
const DEFAULT_OCAI_MODEL = "gpt-oss:20b";
const MAX_HISTORY_MESSAGES = 20;
const MAX_TELEGRAM_LENGTH = 4000;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Telegram AI bot is running.", { status: 200 });
    }

    // Optional Telegram webhook secret verification.
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const receivedSecret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const message = update.message;

    // Ignore updates that are not ordinary text messages.
    if (!message?.text || !message?.chat?.id) {
      return new Response("OK", { status: 200 });
    }

    const chatId = String(message.chat.id);
    const allowedChatId = String(env.TGBOTUSER || "").trim();

    // Only respond to the configured chat ID.
    if (!allowedChatId || chatId !== allowedChatId) {
      return new Response("OK", { status: 200 });
    }

    try {
      await handleMessage(message, env);
    } catch (error) {
      console.error("Bot error:", error);

      try {
        await sendMessage(
          env,
          chatId,
          "發生錯誤，請稍後再試。若問題持續，請檢查 Cloudflare Workers 日誌。"
        );
      } catch (sendError) {
        console.error("Could not send error message:", sendError);
      }
    }

    return new Response("OK", { status: 200 });
  },
};

async function handleMessage(message, env) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();

  if (text.startsWith("/start")) {
    await sendMessage(
      env,
      chatId,
      [
        "嗨！我是你的 Telegram AI Bot。",
        "",
        "直接傳訊息就可以開始聊天。",
        "",
        "可用指令：",
        "/start - 顯示說明",
        "/clear - 清除對話記憶",
        "/export - 匯出對話紀錄",
      ].join("\n")
    );
    return;
  }

  if (text.startsWith("/clear")) {
    await clearHistory(env, chatId);
    await sendMessage(env, chatId, "已清除這個聊天的對話記憶。");
    return;
  }

  if (text.startsWith("/export")) {
    await exportHistory(env, chatId);
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(
      env,
      chatId,
      "不認識這個指令。輸入 /start 查看可用指令。"
    );
    return;
  }

  await sendMessage(env, chatId, "思考中…");

  const history = await getHistory(env, chatId);
  const userMessage = {
    role: "user",
    content: text,
    timestamp: new Date().toISOString(),
  };

  const messagesForModel = [
    ...history.map((item) => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: text,
    },
  ];

  const result = await generateAnswer(env, messagesForModel);

  const assistantMessage = {
    role: "assistant",
    content: result.answer,
    timestamp: new Date().toISOString(),
    provider: result.provider,
    model: result.model,
  };

  const updatedHistory = [
    ...history,
    userMessage,
    assistantMessage,
  ].slice(-MAX_HISTORY_MESSAGES);

  await saveHistory(env, chatId, updatedHistory);

  const answer =
    `🤖 ${result.provider} / ${result.model}\n\n${result.answer}`;

  await sendLongMessage(env, chatId, answer);
}

/* -----------------------------
   AI provider selection
----------------------------- */

async function generateAnswer(env, messages) {
  const selectedProvider = String(env.AI_PROVIDER || "AUTO")
    .trim()
    .toUpperCase();

  if (selectedProvider === "AI") {
    return callWorkersAI(env, env.AI_MODEL || DEFAULT_MODEL, messages);
  }

  if (selectedProvider === "GAI") {
    return callGoogleAI(
      env,
      env.GAI_MODEL || DEFAULT_GAI_MODEL,
      messages
    );
  }

  if (selectedProvider === "OCAI") {
    return callOllamaCloud(
      env,
      env.OCAI_MODEL || DEFAULT_OCAI_MODEL,
      messages
    );
  }

  if (selectedProvider !== "AUTO") {
    throw new Error(
      `Invalid AI_PROVIDER "${selectedProvider}". Use AI, GAI, OCAI, or AUTO.`
    );
  }

  const fallbackModels = parseAutoModels(env.AUTO_MODELS);

  const errors = [];

  for (const item of fallbackModels) {
    try {
      if (item.provider === "AI") {
        return await callWorkersAI(env, item.model, messages);
      }

      if (item.provider === "GAI") {
        return await callGoogleAI(env, item.model, messages);
      }

      if (item.provider === "OCAI") {
        return await callOllamaCloud(env, item.model, messages);
      }
    } catch (error) {
      console.error(
        `Provider ${item.provider} (${item.model}) failed:`,
        error
      );

      errors.push(`${item.provider}/${item.model}: ${error.message}`);
    }
  }

  throw new Error(
    "所有 Auto 模型都無法使用：\n" + errors.join("\n")
  );
}

function parseAutoModels(value) {
  const defaultModels = [
    {
      provider: "AI",
      model: DEFAULT_MODEL,
    },
    {
      provider: "GAI",
      model: DEFAULT_GAI_MODEL,
    },
    {
      provider: "OCAI",
      model: DEFAULT_OCAI_MODEL,
    },
  ];

  if (!value || !String(value).trim()) {
    return defaultModels;
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AUTO_MODELS 不是有效的 JSON。");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AUTO_MODELS 必須是非空的 JSON 陣列。");
  }

  const supportedProviders = new Set(["AI", "GAI", "OCAI"]);

  return parsed.map((item) => {
    const provider = String(item?.provider || "").trim().toUpperCase();
    const model = String(item?.model || "").trim();

    if (!supportedProviders.has(provider) || !model) {
      throw new Error(
        "AUTO_MODELS 每個項目都需要有效的 provider 和 model。"
      );
    }

    return { provider, model };
  });
}

/* -----------------------------
   Cloudflare Workers AI
----------------------------- */

async function callWorkersAI(env, model, messages) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("找不到 Workers AI binding，請確認 binding 名稱為 AI。");
  }

  const result = await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content:
          "You are a helpful AI assistant. Answer the user clearly and accurately.",
      },
      ...messages,
    ],
  });

  const answer =
    result?.response ||
    result?.output_text ||
    result?.choices?.[0]?.message?.content;

  if (!answer || typeof answer !== "string") {
    throw new Error("Workers AI 回傳了空白或無法辨識的內容。");
  }

  return {
    answer,
    provider: "Workers AI",
    model,
  };
}

/* -----------------------------
   Google AI Studio
----------------------------- */

async function callGoogleAI(env, model, messages) {
  if (!env.GAIKEY) {
    throw new Error("缺少 GAIKEY Secret。");
  }

  const baseUrl = (
    env.GAI_BASEAPIURL ||
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");

  const url =
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

  const contents = messages.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }],
  }));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GAIKEY,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: "You are a helpful AI assistant. Answer the user clearly and accurately.",
          },
        ],
      },
      contents,
      generationConfig: {
        temperature: 0.7,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Google AI API ${response.status}: ${extractApiError(data)}`
    );
  }

  const answer = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    throw new Error("Google AI 回傳了空白內容。");
  }

  return {
    answer,
    provider: "Google AI Studio",
    model,
  };
}

/* -----------------------------
   Ollama Cloud
   OpenAI-compatible API
----------------------------- */

async function callOllamaCloud(env, model, messages) {
  if (!env.OCAIKEY) {
    throw new Error("缺少 OCAIKEY Secret。");
  }

  const baseUrl = (
    env.OCAI_BASEAPIURL || "https://ollama.com/v1"
  ).replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OCAIKEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI assistant. Answer the user clearly and accurately.",
        },
        ...messages,
      ],
      stream: false,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Ollama Cloud API ${response.status}: ${extractApiError(data)}`
    );
  }

  const answer = data.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error("Ollama Cloud 回傳了空白內容。");
  }

  return {
    answer,
    provider: "Ollama Cloud",
    model,
  };
}

function extractApiError(data) {
  if (typeof data?.error === "string") return data.error;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;

  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return "Unknown API error";
  }
}

/* -----------------------------
   Upstash Redis conversation history
   REST commands use POST + JSON.
----------------------------- */

function redisIsConfigured(env) {
  return Boolean(
    env.UPSTASH_REDIS_REST_URL &&
      env.UPSTASH_REDIS_REST_TOKEN
  );
}

function historyKey(chatId) {
  return `telegram-ai-bot:history:${chatId}`;
}

async function redisCommand(env, command) {
  if (!redisIsConfigured(env)) {
    throw new Error(
      "尚未設定 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN。"
    );
  }

  const url = env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(
      `Upstash Redis ${response.status}: ${data.error || "Request failed"}`
    );
  }

  return data.result;
}

async function getHistory(env, chatId) {
  if (!redisIsConfigured(env)) {
    return [];
  }

  const result = await redisCommand(env, [
    "GET",
    historyKey(chatId),
  ]);

  if (!result) {
    return [];
  }

  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not parse stored history:", error);
    return [];
  }
}

async function saveHistory(env, chatId, history) {
  if (!redisIsConfigured(env)) {
    throw new Error(
      "尚未設定 Upstash Redis。請設定 Redis URL 和 Token 才能保存對話記憶。"
    );
  }

  await redisCommand(env, [
    "SET",
    historyKey(chatId),
    JSON.stringify(history),
  ]);
}

async function clearHistory(env, chatId) {
  if (!redisIsConfigured(env)) {
    throw new Error("尚未設定 Upstash Redis。");
  }

  await redisCommand(env, [
    "DEL",
    historyKey(chatId),
  ]);
}

/* -----------------------------
   Export conversation as JSON
----------------------------- */

async function exportHistory(env, chatId) {
  if (!redisIsConfigured(env)) {
    await sendMessage(
      env,
      chatId,
      "尚未設定 Upstash Redis，無法匯出對話紀錄。"
    );
    return;
  }

  const history = await getHistory(env, chatId);

  const exportData = {
    exported_at: new Date().toISOString(),
    chat_id: chatId,
    message_count: history.length,
    messages: history,
  };

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], {
    type: "application/json",
  });

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", blob, "conversation-export.json");
  form.append("caption", "對話紀錄匯出");

  const response = await fetch(
    `${getTelegramBaseUrl(env)}/bot${env.TGBOTAPI}/sendDocument`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram 匯出失敗：${data.description || response.status}`
    );
  }
}

/* -----------------------------
   Telegram API helpers
----------------------------- */

function getTelegramBaseUrl(env) {
  return (
    env.TGBOTAPI_ENDPOINT || "https://api.telegram.org"
  ).replace(/\/+$/, "");
}

async function telegramRequest(env, method, body) {
  if (!env.TGBOTAPI) {
    throw new Error("缺少 TGBOTAPI Secret。");
  }

  const response = await fetch(
    `${getTelegramBaseUrl(env)}/bot${env.TGBOTAPI}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram API ${response.status}: ${
        data.description || "Request failed"
      }`
    );
  }

  return data.result;
}

async function sendMessage(env, chatId, text) {
  return telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendLongMessage(env, chatId, text) {
  const chunks = splitMessage(text, MAX_TELEGRAM_LENGTH);

  for (const chunk of chunks) {
    await sendMessage(env, chatId, chunk);
  }
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = String(text || "");

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);

    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }

    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
