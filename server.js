// server.js
import http           from 'http';
import { get as icyGet } from 'icy';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // ── 1) CORS & preflight handling ──
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    // preflight request
    res.writeHead(204);
    return res.end();
  }

  // ── 2) Parse target stream URL ──
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url');

  if (!target) {
    // path‐based mode: /http://… or /https://…
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (p.startsWith('http://') || p.startsWith('https://')) {
      target = p;
    }
  }

  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // ── 3) Prepare response headers for audio ──
  res.writeHead(200, {
    'Content-Type':        'audio/mpeg',
    'Transfer-Encoding':   'chunked'
  });

  // ── 4) Forward headers from client to upstream ──
  const icyOptions = { url: target, headers: {} };
  // forward Range if present
  if (req.headers.range) {
    icyOptions.headers.Range = req.headers.range;
  }
  // always request metadata from Shoutcast
  icyOptions.headers['Icy-MetaData'] = '1';

  // ── 5) Fetch and pipe the ICY/HTTP stream ──
  const icyReq = icyGet(icyOptions, icyRes => {
    // ignore metadata events
    icyRes.on('metadata', () => {});
    // pipe raw audio+metadata chunks to our client
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + err.message);
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
