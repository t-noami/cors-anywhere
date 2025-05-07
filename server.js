/*
 * server.js
 * Universal ICY proxy + Basic authentication + CORS + ICY metadata parsing
 * Enhanced with debug logging for target, headers, and timeouts
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
const IDLE_TIMEOUT_MS  = 15000; // 15s idle timeout

function normalizeScheme(target) {
  return target.startsWith('icy://') ? 'http://' + target.slice(6) : target;
}

function fallbackHttp09(target, opts, onResponse) {
  console.log('[Fallback] HTTP/0.9 fallback for', target);
  const parsed = new URL(target);
  const getFn  = parsed.protocol === 'https:' ? https.get : http.get;
  return getFn(target, { headers: opts.headers, agent: opts.agent }, onResponse)
    .on('error', err => console.warn('[Fallback] error:', err));
}

function createMetadataStripper(metaInt) {
  let bytesUntilMeta = metaInt;
  let metaBytesRemaining = 0;
  return new Transform({
    transform(chunk, _, cb) {
      const out = [];
      let offset = 0;
      while (offset < chunk.length) {
        if (metaBytesRemaining) {
          const skip = Math.min(metaBytesRemaining, chunk.length - offset);
          offset += skip;
          metaBytesRemaining -= skip;
        } else {
          const copyLen = Math.min(bytesUntilMeta, chunk.length - offset);
          out.push(chunk.slice(offset, offset + copyLen));
          offset += copyLen;
          bytesUntilMeta -= copyLen;
          if (bytesUntilMeta === 0) {
            const lengthByte = chunk[offset++] || 0;
            metaBytesRemaining = lengthByte * 16;
            bytesUntilMeta = metaInt;
          }
        }
      }
      cb(null, Buffer.concat(out));
    }
  });
}

function proxyRequest(target, opts, res, retries = 0) {
  console.log(`[Proxy] connecting to ${target}, attempt ${retries + 1}`);
  const icyReq = icy.get(target, opts, icyRes => {
    console.log('[Proxy] upstream headers:', icyRes.headers);
    const metaInt = parseInt(icyRes.headers['icy-metaint'] || '0', 10);
    const status = icyRes.statusCode || 200;
    const h = icyRes.headers;
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

    const stream = metaInt > 0
      ? icyRes.pipe(createMetadataStripper(metaInt))
      : icyRes;

    // idle timeout to trigger retry
    let idleTimer = setTimeout(() => {
      console.warn('[Proxy] idle timeout, aborting');
      icyReq.abort();
    }, IDLE_TIMEOUT_MS);
    stream.on('data', () => clearTimeout(idleTimer));
    stream.on('end', () => clearTimeout(idleTimer));

    stream.pipe(res);
  });

  icyReq.on('error', err => {
    console.error(`[Proxy] error on attempt ${retries + 1}:`, err);
    if (retries < MAX_RETRIES) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retries);
      console.log(`[Proxy] retrying in ${backoff}ms...`);
      setTimeout(() => proxyRequest(target, opts, res, retries + 1), backoff);
    } else {
      console.error('[Proxy] max retries reached, falling back');
      fallbackHttp09(target, opts, rawRes => {
        console.log('[Fallback] piping raw response');
        res.writeHead(200, { 'Connection': 'keep-alive', ...rawRes.headers });
        rawRes.pipe(res);
      });
    }
  });
}

const server = http.createServer((req, res) => {
  console.log('[Server] incoming', req.method, req.url);
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url') || '';
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^(?:https?:\/\/|icy:\/\/)/.test(p)) target = p;
  }
  console.log('[Server] target:', target);
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=...');
  }

  target = normalizeScheme(target);

  if (req.method === 'OPTIONS') {
    console.log('[Server] preflight');
    res.writeHead(204, {
      'Date': new Date().toUTCString(),
      'Server': 'Node.js-ICY-Proxy',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    return res.end();
  }

  const upstreamHeaders = {
    'Icy-MetaData': '1',
    'User-Agent': 'SecondLife (FMOD) Audio Client',
    'Accept': 'audio/mpeg',
    'Connection': 'keep-alive'
  };
  if (STREAM_USER && STREAM_PASS) upstreamHeaders['Authorization'] = `Basic ${Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64')}`;
  if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;
  console.log('[Server] upstreamHeaders:', upstreamHeaders);

  const u = new URL(target);
  let agent = null;
  if (u.protocol === 'https:') {
    const agentOpts = { servername: u.hostname, rejectUnauthorized: true };
    if (TLS_CERT && TLS_KEY) {
      agentOpts.cert = fs.readFileSync(TLS_CERT);
      agentOpts.key  = fs.readFileSync(TLS_KEY);
    }
    agent = new https.Agent(agentOpts);
  }

  const icyOpts = { headers: upstreamHeaders, followRedirects: true, maxRedirects: 5, agent };

  res.setHeader('Transfer-Encoding', 'chunked');
  proxyRequest(target, icyOpts, res);
});

server.listen(PORT, HOST, () => console.log(`Proxy listening on http://${HOST}:${PORT}`));
