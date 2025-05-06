// server.js
import http           from 'http';
import { get as icyGet } from 'icy';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // 1) ?url=… で指定があればそちらを使う
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target   = reqUrl.searchParams.get('url');

  // 2) なければパス方式 (/http://… or /https://…) を使う
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) {
      target = p;
    }
  }

  // 3) URL が取れなければ 400
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=... or /http(s)://… in path');
  }

  // 4) CORS ＆ audio レスポンスヘッダー
  res.writeHead(200, {
    'Content-Type':               'audio/mpeg',
    'Transfer-Encoding':          'chunked',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Range, Icy-MetaData',
    'Access-Control-Expose-Headers':'Content-Length, Content-Range',
  });

  // 5) icyGet を正しく呼び出す
  const icyReq = icyGet(
    {
      url: target,
      headers: {
        'Icy-MetaData': '1',
        'User-Agent':   'WinampMPEG/5.09',
        ...(req.headers.range ? { Range: req.headers.range } : {})
      }
    },
    icyRes => {
      icyRes.on('metadata', () => {});  // メタデータは無視
      icyRes.pipe(res);                 // 受信バイナリをそのままクライアントへ
    }
  );

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
