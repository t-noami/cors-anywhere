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
    /* existing handling... */
  });
  req.on('error', err => { /* retry logic... */ });
}

// HTTP server ...
const server = http.createServer((req, res) => { /* ... */ });

server.listen(PORT, HOST, () => console.log(`Proxy listening on http://${HOST}:${PORT}`));
