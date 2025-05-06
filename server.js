// server.js
import http           from 'http';
import { get as icyGet } from 'icy';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // 1) ?url=… or /http(s)://…
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
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // 2) CORS とオーディオヘッダー
  res.writeHead(200, {
    'Content-Type':              'audio/mpeg',
    'Transfer-Encoding':         'chunked',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  });

  // 3) 上流リクエストに Icy-MetaData ヘッダーを必ず追加
  //    さらに、クライアントが Range を投げていればそれも転送
  const headers = { 'Icy-MetaData': '1' };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const icyReq = icyGet(target, { headers }, icyRes => {
    icyRes.on('metadata', () => {}); // メタデータは無視
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
