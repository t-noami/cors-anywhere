// server.js
import http            from 'http';
import { get as icyGet } from 'icy';
import net             from 'net';
import { URL }         from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // ── 1) CORS/プリフライト対応 ──
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── 2) ?url=… または /http(s)://… からターゲットURLを取得 ──
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url');
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) target = p;
  }
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // ── 3) クライアント向けレスポンスヘッダー ──
  res.writeHead(200, {
    'Content-Type':      'audio/mpeg',
    'Transfer-Encoding': 'chunked'
  });

  // ── 4) Upstream に渡すヘッダー ──
  const headers = { 'Icy-MetaData': '1' };
  if (req.headers.range) headers.Range = req.headers.range;

  // ── 5) icy モジュールでまず試行 ──
  let handled = false;
  const icyReq = icyGet(target, { headers }, icyRes => {
    handled = true;
    icyRes.on('metadata', () => {}); // メタデータは無視
    icyRes.pipe(res);
  });
  icyReq.on('error', err => {
    console.warn('ICY upstream error → fallbackRaw', err);
    if (!handled) {
      fallbackRaw(target, res);
    } else {
      res.destroy();
    }
  });
});

// ── 6) HTTP/0.9 互換の自前 TCP GET フォールバック ──
function fallbackRaw(target, res) {
  const u    = new URL(target);
  const port = u.port || 80;
  const socket = net.connect(port, u.hostname, () => {
    // HTTP/0.9 スタイルの GET
    socket.write(`GET ${u.pathname + u.search}\r\n\r\n`);
    socket.pipe(res);
  });
  socket.on('error', err => {
    console.error('fallbackRaw error', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
