/*
 * server.js
 * Full implementation with debug logging
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import http from 'http';
const https = require('https');
const fs    = require('fs');
const icy   = require('icy');
const { URL } = require('url');
const { Transform } = require('stream');

// Config
const HOST        = process.env.HOST || '0.0.0.0';
const PORT        = process.env.PORT || 8080;
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';
const TLS_CERT    = process.env.TLS_CERT || '';
const TLS_KEY     = process.env.TLS_KEY || '';
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const IDLE_TIMEOUT_MS = 15000;

// Strip ICY metadata
function createMetadataStripper(metaInt) {
  let bytesUntilMeta = metaInt;
  let metaRemain = 0;
  return new Transform({ transform(chunk, _, cb) {
      const out = [];
      let pos = 0;
      while (pos < chunk.length) {
        if (metaRemain > 0) {
          const skip = Math.min(metaRemain, chunk.length - pos);
          pos += skip; metaRemain -= skip;
        } else {
          const toCopy = Math.min(bytesUntilMeta, chunk.length - pos);
          out.push(chunk.slice(pos, pos + toCopy));
          pos += toCopy; bytesUntilMeta -= toCopy;
          if (bytesUntilMeta === 0) {
            const len = chunk[pos++] || 0;
            metaRemain = len * 16; bytesUntilMeta = metaInt;
          }
        }
      }
      cb(null, Buffer.concat(out));
  }});
}

// Normalize icy:// URLs
function normalizeScheme(url) {
  return url.startsWith('icy://') ? 'http://' + url.slice(6) : url;
}

// HTTP/0.9 fallback
function fallbackHttp09(target, opts, res) {
  console.log('[Fallback] HTTP/0.9', target);
  const getFn = target.startsWith('https:') ? https.get : http.get;
  getFn(target, { headers: opts.headers, agent: opts.agent }, raw => {
    res.writeHead(200, {
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      ...raw.headers
    });
    res.flushHeaders(); raw.pipe(res);
  }).on('error', e => console.warn('[Fallback] error', e));
}

// Core proxy logic with retry
function proxyRequest(target, opts, res, retries = 0) {
  console.log(`[Proxy] attempt ${retries+1} -> ${target}`, opts);
  const req = icy.get(target, opts, upstream => {
    console.log('[Proxy] upstream headers:', upstream.headers);
    const metaInt = parseInt(upstream.headers['icy-metaint']||'0',10);
    const headers = {
      Date: new Date().toUTCString(), Server:'Node.js-ICY-Proxy', 'Cache-Control':'no-store',
      Connection:'keep-alive','Transfer-Encoding':'chunked',
      'Access-Control-Allow-Origin':'*','Access-Control-Allow-Credentials':'true',
      'Access-Control-Expose-Headers':'Content-Length,Content-Range,Accept-Ranges,icy-metaint',
      'Content-Type':upstream.headers['content-type']||'audio/mpeg',
      'Content-Range':upstream.headers['content-range']||'',
      'Accept-Ranges':upstream.headers['accept-ranges']||'',
      'Content-Length':upstream.headers['content-length']||''
    };
    res.writeHead(upstream.statusCode||200, headers);
    res.flushHeaders();
    let stream = upstream;
    if (metaInt>0) stream = upstream.pipe(createMetadataStripper(metaInt));
    const timer=setTimeout(()=>req.abort(),IDLE_TIMEOUT_MS);
    stream.on('data',()=>clearTimeout(timer));
    stream.pipe(res);
  });
  req.on('error',err=>{
    console.error(`[Proxy] error ${retries+1}`,err);
    if (retries<MAX_RETRIES) {
      setTimeout(()=>proxyRequest(target,opts,res,retries+1),BASE_BACKOFF_MS*2**retries);
    } else fallbackHttp09(target,opts,res);
  });
}

// HTTP server
const server = http.createServer((req,res)=>{
  console.log('[Server] ',req.method,req.url);
    // HEAD quick return with metadata headers
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Date': new Date().toUTCString(),
      'Server': 'Node.js-ICY-Proxy',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Type, Content-Range, icy-metaint',
      'Accept-Ranges': 'bytes',
      'Content-Type': 'audio/mpeg'
    });
    res.flushHeaders();
    return res.end();
  }

  const urlObj=new URL(req.url,`http://${req.headers.host}`);
  // Remove client-side timestamp param 't' to avoid affecting upstream target
  urlObj.searchParams.delete('t');
  let target=urlObj.searchParams.get('url')||'';
  if(!target){const p=decodeURIComponent(urlObj.pathname.slice(1)),q=urlObj.search||'';if(/^(?:https?:\/\/|icy:\/\/)/.test(p))target=p+q;}
  console.log('[Server] target',target);
  if(!target) return res.writeHead(400).end('Missing ?url');
  target=normalizeScheme(target);
  if(req.method==='OPTIONS') return res.writeHead(204,{
    Date:new Date().toUTCString(),Server:'Node.js-ICY-Proxy','Cache-Control':'no-store',
    Connection:'keep-alive','Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Range,Icy-MetaData,Authorization',
    'Access-Control-Allow-Methods':'GET,OPTIONS'
  }),res.end();

  const upstreamHeaders={
    'Icy-MetaData':'1','User-Agent':'SecondLife (FMOD) Audio Client',Accept:'audio/mpeg',Connection:'keep-alive'
  };
  if(STREAM_USER&&STREAM_PASS) upstreamHeaders.Authorization='Basic '+Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64');
  if(req.headers.range) upstreamHeaders.Range=req.headers.range;
  console.log('[Server] upstreamHeaders',upstreamHeaders);

  let agent=null;
  if(target.startsWith('https://')){
    const opts={servername:new URL(target).hostname,rejectUnauthorized:true};
    if(TLS_CERT&&TLS_KEY){opts.cert=fs.readFileSync(TLS_CERT);opts.key=fs.readFileSync(TLS_KEY);}agent=new https.Agent(opts);
  }
  const opts={headers:upstreamHeaders,followRedirects:true,maxRedirects:5,agent};
  res.setHeader('Transfer-Encoding','chunked');
  proxyRequest(target,opts,res);
});

server.listen(PORT,HOST,()=>console.log(`Proxy on http://${HOST}:${PORT}`));
