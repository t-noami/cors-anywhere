/*
 * server.js
 * Universal ICY proxy + Basic 認証 + CORS + ICYメタデータパース + リダイレクト + SNI/証明書対応
 * クライアント Range ヘッダー中継
 * Viewer互換ヘッダー (User-Agent, Accept)
 * Accept-Ranges 転送
 * CommonJS形式 (Render互換)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import http from 'http';
const https = require('https');
const icy   = require('icy');
const { URL } = require('url');

const HOST        = process.env.HOST || '0.0.0.0';
const PORT        = process.env.PORT || 8080;
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';
// SSLクライアント証明書用 (必要あれば環境変数で設定)
const TLS_CERT    = process.env.TLS_CERT || null;
const TLS_KEY     = process.env.TLS_KEY || null;

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url') || '';
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) target = p;
  }
  if (!target) {
    res.writeHead(400, {'Content-Type':'text/plain'});
    return res.end('Missing ?url=... or /http(s)://...');
  }

  // アップストリームヘッダー
  const headers = {
    'Icy-MetaData':'1',
    'User-Agent':'SecondLife (FMOD) Audio Client',
    'Accept':'audio/mpeg, audio/*;q=0.9, */*;q=0.8'
  };
  if (STREAM_USER && STREAM_PASS) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64');
  }
  if (req.headers.range) headers['Range'] = req.headers.range;

  // 初期レスポンス
  res.writeHead(200, {
    'Content-Type':'audio/mpeg',
    'Transfer-Encoding':'chunked',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Range, Icy-MetaData, Authorization',
    'Access-Control-Expose-Headers':'Content-Length, Content-Range, Accept-Ranges'
  });

  // Agent設定 (SNI/クライアント証明書対応)
  let agent = null;
  const u = new URL(target);
  if (u.protocol === 'https:') {
    agent = new https.Agent({
      servername: u.hostname,
      cert: TLS_CERT ? require('fs').readFileSync(TLS_CERT) : undefined,
      key:  TLS_KEY  ? require('fs').readFileSync(TLS_KEY)  : undefined,
    });
  }

  const icyOptions = { headers, followRedirects:true, maxRedirects:5 };
  if (agent) icyOptions.agent = agent;

  const icyReq = icy.get(target, icyOptions, icyRes => {
    const ar = icyRes.headers['accept-ranges'];
    if (ar) res.setHeader('Accept-Ranges', ar);
    icyRes.on('metadata', md => console.log('ICY metadata:', md.toString()));
    icyRes.pipe(res);
  });
  icyReq.on('error', err => { console.error('Upstream error:', err); res.destroy(); });
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy running on http://${HOST}:${PORT}`);
});
