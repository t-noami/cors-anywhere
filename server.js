  import http         from 'http';
  import { get as icyGet } from 'icy';
  import { URL }      from 'url';

  const HOST = process.env.HOST || '0.0.0.0';
  const PORT = process.env.PORT || 8080;

  const server = http.createServer((req, res) => {
-   // クエリ ?url=... から元URLを取得
-   const target = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
+   // 1) クエリ ?url=... を優先
+   const reqUrl = new URL(req.url, `http://${req.headers.host}`);
+   let target = reqUrl.searchParams.get('url');
+
+   // 2) なければ「パスで渡された /http://…」方式を試す
+   if (!target) {
+     const p = decodeURIComponent(reqUrl.pathname.slice(1));
+     if (p.startsWith('http://') || p.startsWith('https://')) {
+       target = p;
+     }
+   }

    if (!target) {
      res.writeHead(400, { 'Content-Type':'text/plain' });
      return res.end('Missing ?url=... or /http(s)://… in path');
    }

    // CORS＋オーディオヘッダー
    res.writeHead(200, {
      'Content-Type':            'audio/mpeg',
      'Transfer-Encoding':       'chunked',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
      'Access-Control-Expose-Headers':'Content-Length, Content-Range'
    });

    // ICY（HTTP/0.9）も HTTP/1.x もこの一行で両対応
    const icyReq = icyGet(target, icyRes => {
      icyRes.on('metadata', () =>{});  // メタデータは無視
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
