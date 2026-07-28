import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const DIST = path.resolve('dist');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.map':'application/json', '.svg':'image/svg+xml' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const upstream = 'https://mlb-props-app.vercel.app' + req.url;
    try {
      const r = await fetch(upstream, { headers: { accept: 'application/json' } });
      const body = await r.text();
      res.writeHead(r.status, {
        'content-type': 'application/json',
        'x-requests-remaining': r.headers.get('x-requests-remaining') || '',
      });
      return res.end(body);
    } catch (e) { res.writeHead(502); return res.end(JSON.stringify({error:String(e)})); }
  }
  let f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(f)) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(4173, () => console.log('up on 4173'));
