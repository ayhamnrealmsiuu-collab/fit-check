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
const DAILY_LIMIT = 3;       // per signed-up email
const IP_DAILY_LIMIT = 15;   // per IP address, catches someone using fake/rotating emails

// Only your real site is allowed to call this endpoint directly (stops other
// websites embedding a script that quietly drains your API quota).
const ALLOWED_ORIGINS = [
  "https://fit-check-sepia.vercel.app",
];

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

// Increments a counter key with a given daily cap, returns true if allowed.
async function checkAndIncrement(key, limit) {
  const incrResult = await redis(["INCR", key]);
  const used = incrResult.result || 1;
  if (used === 1) {
    await redis(["EXPIRE", key, 93600]); // ~26h, so it always outlasts the calendar day
  }
  return used <= limit;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");

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

    // Reject absurdly large payloads early (protects against someone sending
    // huge/many images to burn tokens or overload the function).
    const approxSize = JSON.stringify(content).length;
    if (approxSize > 8_000_000) {
      res.status(413).json({ error: { message: "Request too large" } });
      return;
    }
    const blocksIn = Array.isArray(content) ? content : [];
    const imageCount = blocksIn.filter((b) => b.type === "image").length;
    if (imageCount > 25) {
      res.status(400).json({ error: { message: "Max 25 clothing photos per request" } });
      return;
    }

    if (REDIS_URL && REDIS_TOKEN) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const who = String(email || "anonymous").trim().toLowerCase();

      const ipOk = await checkAndIncrement(`usage:ip:${ip}:${today}`, IP_DAILY_LIMIT);
      if (!ipOk) {
        res.status(429).json({
          error: { message: "Too many requests from this network today, try again tomorrow.", code: "DAILY_LIMIT" },
        });
        return;
      }

      const emailOk = await checkAndIncrement(`usage:${who}:${today}`, DAILY_LIMIT);
      if (!emailOk) {
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
      return { text: String(block.text || "").slice(0, 20000) };
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
