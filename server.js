import http           from 'http';
import { get as icyGet } from 'icy';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // リクエスト URL をパース
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // ヘルスチェック用エンドポイント
  if (reqUrl.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('OK');
  }

  // 1) クエリ ?url=... を優先
  let target = reqUrl.searchParams.get('url');

  // 2) なければパス方式 (/http://... or /https://...)
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

  // CORS とオーディオヘッダー
  res.writeHead(200, {
    'Content-Type':              'audio/mpeg',
    'Transfer-Encoding':         'chunked',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  });

  // ICY(HTTP/0.9) も HTTP/1.x もこの一行で両対応
  const icyReq = icyGet(target, icyRes => {
    icyRes.on('metadata', () => {}); // メタデータ無視
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
