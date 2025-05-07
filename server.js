/*
 * server.js
 * Universal ICY proxy + Basic 認証 + CORS + ICYメタデータパース + リダイレクト + SNI/証明書対応
 * クライアント Range ヘッダー中継
 * Viewer互換ヘッダー (User-Agent, Accept)
 * Accept-Ranges 転送
 * Upstream のステータス/ヘッダーをそのまま返す
 * CommonJS 形式 (Render互換)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import http from 'http';
const https = require('https');
const fs    = require('fs');
const icy   = require('icy');
const { URL } = require('url');

const HOST        = process.env.HOST || '0.0.0.0';
const PORT        = process.env.PORT || 8080;
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';
const TLS_CERT    = process.env.TLS_CERT || '';
const TLS_KEY     = process.env.TLS_KEY || '';

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

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData, Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // Upstream リクエストヘッダー
  const upstreamHeaders = {
    'Icy-MetaData': '1',
    'User-Agent': 'SecondLife (FMOD) Audio Client',
    'Accept': 'audio/mpeg, audio/*;q=0.9, */*;q=0.8'
  };
  if (STREAM_USER && STREAM_PASS) {
    upstreamHeaders['Authorization'] = 'Basic ' + Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64');
  }
  if (req.headers.range) {
    upstreamHeaders['Range'] = req.headers.range;
  }

  // Agent (SNI/証明書)
  const u = new URL(target);
  const agentOptions = {};
  let agent = null;
  if (u.protocol === 'https:') {
    agentOptions.servername = u.hostname;
    if (TLS_CERT && TLS_KEY) {
      agentOptions.cert = fs.readFileSync(TLS_CERT);
      agentOptions.key  = fs.readFileSync(TLS_KEY);
    }
    agent = new https.Agent(agentOptions);
  }

  const icyOpts = { headers: upstreamHeaders, followRedirects: true, maxRedirects: 5 };
  if (agent) icyOpts.agent = agent;

  // Upstream call
  const icyReq = icy.get(target, icyOpts, icyRes => {
    // レスポンスステータス
    const status = icyRes.statusCode || 200;
    // Upstream ヘッダー
    const h = icyRes.headers;
    // クライアントレスポンスヘッダー
    const respHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData, Authorization',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Content-Type': h['content-type'] || 'audio/mpeg',
      'Content-Range': h['content-range'] || '',
      'Accept-Ranges': h['accept-ranges'] || '',
      'Content-Length': h['content-length'] || ''
    };
    res.writeHead(status, respHeaders);
    // メタデータイベント
    icyRes.on('metadata', md => console.log('ICY metadata:', md.toString()));
    icyRes.pipe(res);
  });
  icyReq.on('error', err => { console.error('Upstream error:', err); res.destroy(); });
});

server.listen(PORT, HOST, () => console.log(`Proxy running on http://${HOST}:${PORT}`));
