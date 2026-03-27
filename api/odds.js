// Vercel serverless proxy for Odds API (avoids CORS issues)
module.exports = async function handler(req, res) {
  const KEY = process.env.ODDS_API_KEY;

  if (!KEY) {
    return res.status(500).json({ error: "ODDS_API_KEY env var not set" });
  }

  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: "Missing path param" });
  }

  // Build the Odds API URL
  const url = new URL(`https://api.the-odds-api.com/v4/${path}`);
  // Forward all query params except 'path'
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "path") url.searchParams.set(k, v);
  }
  url.searchParams.set("apiKey", KEY);

  try {
    const resp = await fetch(url.toString());
    const data = await resp.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
