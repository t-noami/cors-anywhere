/*
 * server.js
 * Universal ICY proxy + Basic authentication + CORS + ICY metadata parsing
 * Redirect handling + SNI/cert support + HTTP/0.9 and icy:// fallback
 * Client Range header forwarding
 * Viewer-compatible headers (User-Agent, Accept)
 * Accept-Ranges passthrough
 * Reflect upstream status/headers + standard meta-info
 * Keep-Alive support
 * Explicit Transfer-Encoding: chunked
 * Stream buffering control with highWaterMark
 * Automatic retry with exponential backoff on errors
 * Dedicated metadata-stripping layer
 * Immediate header flush via res.flushHeaders()
 * CommonJS/ESM hybrid for Render
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import http from 'http';
const https = require('https');
const fs    = require('fs');
const icy   = require('icy');
const { URL } = require('url');
const { PassThrough } = require('stream');

const HOST        = process.env.HOST || '0.0.0.0';
const PORT        = process.env.PORT || 8080;
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';
const TLS_CERT    = process.env.TLS_CERT || '';
const TLS_KEY     = process.env.TLS_KEY || '';
// Retry settings
const MAX_RETRIES      = 5;
const BASE_BACKOFF_MS  = 1000;

// Normalize icy:// to http://
function normalizeScheme(target) {
  return target.startsWith('icy://')
    ? 'http://' + target.slice(6)
    : target;
}

// Fallback for HTTP/0.9 ICY servers
function fallbackHttp09(target, opts, onResponse) {
  const parsed = new URL(target);
  const getFn  = parsed.protocol === 'https:' ? https.get : http.get;
  const req = getFn(target, { headers: opts.headers, agent: opts.agent }, res => onResponse(res));
  req.on('error', err => console.warn('Fallback HTTP/0.9 error:', err));
  return req;
}

// Proxy request with retry/backoff and metadata stripping
function proxyRequest(target, opts, res, retries = 0) {
  const req = icy.get(target, opts, icyRes => {
    // On first chunk, flush headers immediately
    const h = icyRes.headers;
    const status = icyRes.statusCode || 200;
    const respHeaders = {
      'Date': new Date().toUTCString(),
      'Server': 'Node.js-ICY-Proxy',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, icy-metaint',
      'Content-Type': h['content-type'] || 'audio/mpeg',
      'Content-Range': h['content-range'] || '',
      'Accept-Ranges': h['accept-ranges'] || '',
      'Content-Length': h['content-length'] || ''
    };
    res.writeHead(status, respHeaders);
    res.flushHeaders();

    // Dedicated metadata event handler (stripped)
    icyRes.on('metadata', md => { /* drop or handle as needed */ });

    // Buffering control
    const pass = new PassThrough({ highWaterMark: 64 * 1024 });
    icyRes.pipe(pass).pipe(res);
  });

  req.on('error', err => {
    console.error(`Stream error (attempt ${retries + 1}):`, err);
    if (retries < MAX_RETRIES) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retries);
      console.log(`Retrying in ${backoff}ms...`);
      setTimeout(() => proxyRequest(target, opts, res, retries + 1), backoff);
    } else {
      console.error('Max retries reached. Falling back to HTTP/0.9.');
      fallbackHttp09(target, opts, rawRes => {
        const headers = rawRes.headers || {};
        const fallbackHeaders = {
          'Date': new Date().toUTCString(),
          'Server': 'Node.js-ICY-Proxy',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*',
          ...headers
        };
        res.writeHead(200, fallbackHeaders);
        res.flushHeaders();
        const pass = new PassThrough({ highWaterMark: 64 * 1024 });
        rawRes.pipe(pass).pipe(res);
      });
    }
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url') || '';
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^(?:https?:\/\/|icy:\/\/)/.test(p)) target = p;
  }
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=... or /http(s)://... or /icy://...');
  }

  target = normalizeScheme(target);

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Date': new Date().toUTCString(),
      'Server': 'Node.js-ICY-Proxy',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // Build upstream headers
  const upstreamHeaders = {
    'Icy-MetaData': '1',
    'User-Agent': 'SecondLife (FMOD) Audio Client',
    'Accept': 'audio/mpeg, audio/*;q=0.9, */*;q=0.8',
    'Connection': 'keep-alive'
  };
  if (STREAM_USER && STREAM_PASS) upstreamHeaders['Authorization'] = 'Basic ' + Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64');
  if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

  // SSL/TLS agent with SNI and optional cert/key
  let agent = null;
  const u = new URL(target);
  if (u.protocol === 'https:') {
    const agentOpts = { servername: u.hostname, rejectUnauthorized: true };
    if (TLS_CERT && TLS_KEY) {
      agentOpts.cert = fs.readFileSync(TLS_CERT);
      agentOpts.key  = fs.readFileSync(TLS_KEY);
    }
    agent = new https.Agent(agentOpts);
  }

  // ICY options
  const icyOpts = { headers: upstreamHeaders, followRedirects: true, maxRedirects: 5, agent };

  // Explicitly set chunked transfer encoding for compatibility
res.setHeader('Transfer-Encoding', 'chunked');
proxyRequest(target, icyOpts, res);
});

server.listen(PORT, HOST, () => console.log(`Proxy running on http://${HOST}:${PORT}`));
