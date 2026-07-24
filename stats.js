// Returns the current signup count for FIT-CHECK (public, read-only).

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

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(200).json({ count: 0 });
    return;
  }

  try {
    const countResult = await redis(["SCARD", "fitcheck:emails"]);
    res.status(200).json({ count: countResult.result || 0 });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(200).json({ count: 0 });
  }
}
