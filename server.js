import http from 'http';
import { get as icyGet } from 'icy';
import { URL } from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url');

  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (p.startsWith('http://') || p.startsWith('https://')) {
      target = p;
    }
  }

  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=... or /http(s)://… in path');
  }

  console.log('[Proxy] Target URL:', target);

  res.writeHead(200, {
    'Content-Type':              'audio/mpeg',
    'Transfer-Encoding':         'chunked',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  });

  const icyReq = icyGet(target, icyRes => {
    console.log('[Proxy] ICY Response Headers:', icyRes.headers);
    icyRes.on('metadata', () => {}); // メタデータ無視
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.error('[Proxy] ICY upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
