// Vercel serverless proxy for Odds API (avoids CORS)
export default async function handler(req, res) {
  const KEY = process.env.ODDS_API_KEY;

  if (!KEY) {
    return res.status(500).json({ error: "ODDS_API_KEY not configured", hint: "Set it in Vercel project env vars" });
  }

  const { path, ...params } = req.query;
  if (!path) {
    return res.status(400).json({ error: "Missing path param" });
  }

  const url = new URL(`https://api.the-odds-api.com/v4/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("apiKey", KEY);

  try {
    const resp = await fetch(url.toString());
    const text = await resp.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.setHeader("Content-Type", "application/json");
    return res.status(resp.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { runtime: "nodejs22.x" };
