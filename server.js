// server.js
import http            from 'http';
import { get as icyGet } from 'icy';
import { URL }         from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // ── 1) CORS／プリフライト対応 ──
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── 2) ?url=… or /http(s)://… からターゲット取得 ──
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

  // ── 3) クライアント向けレスポンスヘッダー ──
  res.writeHead(200, {
    'Content-Type':            'audio/mpeg',
    'Transfer-Encoding':       'chunked'
  });

  // ── 4) Shoutcast/Icecast サーバへ飛ばすヘッダー ──
  const headers = { 'Icy-MetaData': '1' };         // 必ずメタデータ要求
  if (req.headers.range) {
    headers.Range = req.headers.range;            // GET+Range 判定用
  }

  // ── 5) icy モジュールで取得 & パイプ ──
  const icyReq = icyGet(target, { headers }, icyRes => {
    icyRes.on('metadata', () => {});   // メタデータは無視
    icyRes.pipe(res);                  // 音声チャンクをそのまま返却
  });

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
