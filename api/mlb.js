// Vercel serverless proxy for MLB Stats API (free, no key needed — CORS bypass)
export default async function handler(req, res) {
  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: "Missing path param" });

  const url = new URL(`https://statsapi.mlb.com/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const resp = await fetch(url.toString());
    const text = await resp.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    res.setHeader("Content-Type", "application/json");
    return res.status(resp.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { runtime: "nodejs" };
