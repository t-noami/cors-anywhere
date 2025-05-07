/*
 * server.js
 * Universal ICY proxy + Basic authentication + CORS + ICY metadata parsing
 * Enhanced debug: logging before icy.get
 * ... (rest unchanged)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import http from 'http';
const https = require('https');
const fs    = require('fs');
const icy   = require('icy');
const { URL } = require('url');
const { Transform } = require('stream');

const HOST        = process.env.HOST || '0.0.0.0';
const PORT        = process.env.PORT || 8080;
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';
const TLS_CERT    = process.env.TLS_CERT || '';
const TLS_KEY     = process.env.TLS_KEY || '';
const MAX_RETRIES      = 5;
const BASE_BACKOFF_MS  = 1000;
const IDLE_TIMEOUT_MS  = 15000;

function createMetadataStripper(metaInt) { /* ... */ }
function normalizeScheme(url) { /* ... */ }
function fallbackHttp09(target, opts, res) { /* ... */ }

// Core proxy with debug before icy.get
function proxyRequest(target, opts, res, retries = 0) {
  console.log('[Proxy] calling icy.get with opts:', opts);
  const req = icy.get(target, opts, upstream => {
    console.log('[Proxy] upstream headers:', upstream.headers);
    const metaInt = parseInt(upstream.headers['icy-metaint'] || '0', 10);
    const status = upstream.statusCode || 200;
    const headers = {
      Date: new Date().toUTCString(),
      Server: 'Node.js-ICY-Proxy',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,icy-metaint',
      'Content-Type': upstream.headers['content-type'] || 'audio/mpeg',
      'Content-Range': upstream.headers['content-range'] || '',
      'Accept-Ranges': upstream.headers['accept-ranges'] || '',
      'Content-Length': upstream.headers['content-length'] || ''
    };
    res.writeHead(status, headers);
    res.flushHeaders();
    let stream = upstream;
    if (metaInt > 0) stream = upstream.pipe(createMetadataStripper(metaInt));
    const timer = setTimeout(() => req.abort(), IDLE_TIMEOUT_MS);
    stream.on('data', () => clearTimeout(timer));
    stream.pipe(res);
  });

  req.on('error', err => {
    console.error(`[Proxy] error on attempt ${retries + 1}:`, err);
    if (retries < MAX_RETRIES) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retries);
      console.log(`[Proxy] retrying in ${backoff}ms...`);
      setTimeout(() => proxyRequest(target, opts, res, retries + 1), backoff);
    } else {
      console.error('[Proxy] max retries, falling back to HTTP/0.9');
      fallbackHttp09(target, opts, res);
    }
  });
}

// HTTP server ...
const server = http.createServer((req, res) => { /* ... */ });

server.listen(PORT, HOST, () => console.log(`Proxy listening on http://${HOST}:${PORT}`));
