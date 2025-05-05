import http from 'http';
import { get as icyGet } from 'icy';
import { URL } from 'url';

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// 汎用 Shoutcast/Icecast プロキシ
const server = http.createServer((req, res) => {
  // クエリから target URL を取得
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=...');
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Invalid URL');
  }

  // CORS ヘッダー＋オーディオヘッダー
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
  });

  // icy.get で HTTP/0.9 や HTTP/1.x 両対応
  const icyReq = icyGet(target, icyRes => {
    // メタデータイベントは無視
    icyRes.on('metadata', () => {});
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Upstream fetch error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal Shoutcast/Icecast proxy running on http://${HOST}:${PORT}`);
});
