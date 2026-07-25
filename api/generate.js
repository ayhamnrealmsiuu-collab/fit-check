// Serverless proxy for FIT-CHECK.
// Deployed on Vercel, this holds YOUR Gemini API key as a private
// environment variable. Visitors' browsers call this endpoint instead of
// Google directly, so the key never reaches their browser.
//
// Set up on Vercel:
//   1. In your Vercel project settings -> Environment Variables, add:
//        GEMINI_API_KEY = AIzaSy...   (your real key, from aistudio.google.com)
//   2. Deploy. This file is automatically picked up as /api/generate.
//
// NOTE: this calls Google's Gemini API (has a free tier), but reshapes the
// response into the same { content: [{ text: "..." }] } format the frontend
// already expects, so index.html did not need any changes.

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const DAILY_LIMIT = 5;

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  return res.json();
}

export default async function handler(req, res) {
  // Basic CORS so the static frontend (same domain, but harmless to allow)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: "Server misconfigured: GEMINI_API_KEY is not set" } });
    return;
  }

  try {
    const { content, maxTokens, email } = req.body || {};
    if (!content) {
      res.status(400).json({ error: { message: "Missing content in request body" } });
      return;
    }

    // Daily limit per signed-up email, so one visitor can't burn through the
    // whole free-tier quota by themselves. Falls back to "anonymous" (shared
    // bucket) if no email was sent, so the limit still applies either way.
    if (REDIS_URL && REDIS_TOKEN) {
      const who = String(email || "anonymous").trim().toLowerCase();
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const key = `usage:${who}:${today}`;

      const incrResult = await redis(["INCR", key]);
      const usedToday = incrResult.result || 1;
      if (usedToday === 1) {
        // First request of the day for this key - set it to expire in ~26h
        await redis(["EXPIRE", key, 93600]);
      }
      if (usedToday > DAILY_LIMIT) {
        res.status(429).json({
          error: {
            message: `Daily limit reached (${DAILY_LIMIT} per day). Try again tomorrow!`,
            code: "DAILY_LIMIT",
          },
        });
        return;
      }
    }

    // Hard cap so a malicious/bulk caller can't request huge, expensive completions.
    const safeMaxTokens = Math.min(Number(maxTokens) || 1500, 2000);

    // The frontend sends Anthropic-style content blocks: an array of
    // { type: "text", text } and { type: "image", source: { type: "base64", media_type, data } }.
    // Convert those into Gemini's "parts" format.
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
    const parts = blocks.map((block) => {
      if (block.type === "image" && block.source) {
        return {
          inline_data: {
            mime_type: block.source.media_type || "image/jpeg",
            data: block.source.data,
          },
        };
      }
      return { text: block.text || "" };
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: safeMaxTokens },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data.error || { message: "Gemini API error" } });
      return;
    }

    // Reshape Gemini's response into the { content: [{ text }] } shape
    // the frontend expects (same shape Anthropic's API used to return).
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: { message: err.message || "Proxy request failed" } });
  }
}
