// Handles new signups for FIT-CHECK.
// Stores emails in a free Upstash Redis database (connected via Vercel Storage).
//
// Set up on Vercel (one-time):
//   1. In your Vercel project -> "Storage" tab -> "Create Database" -> choose "Upstash for Redis" (free tier)
//   2. Connect it to this project. Vercel will automatically add the
//      environment variables this file needs (KV_REST_API_URL / KV_REST_API_TOKEN,
//      or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN depending on setup).
//   3. Redeploy. This file is automatically picked up as /api/signup.

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(500).json({ error: "Server misconfigured: database not connected" });
    return;
  }

  try {
    const { email } = req.body || {};
    const clean = String(email || "").trim().toLowerCase();

    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
    if (!validEmail) {
      res.status(400).json({ error: "Please enter a valid email address" });
      return;
    }

    // SADD only adds it if it's not already there, so double-signups don't
    // inflate the count. Response is 1 if newly added, 0 if it already existed.
    const addResult = await redis(["SADD", "fitcheck:emails", clean]);
    const alreadySignedUp = addResult.result === 0;

    const countResult = await redis(["SCARD", "fitcheck:emails"]);
    const count = countResult.result || 0;

    res.status(200).json({ success: true, alreadySignedUp, count });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: err.message || "Signup failed" });
  }
}
