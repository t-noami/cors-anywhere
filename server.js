import http from 'http';
import https from 'https';
import net from 'net';
import { get as icyGet } from 'icy';
import { URL } from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const USER_AGENTS = [
  'WinampMPEG/5.09',
  'SecondLife (FMOD) Audio Client'
];

function rawSocketStream(host, port, path, res) {
  const socket = net.connect(port, host, () => {
    console.log('[RawSocket] Connected to', host + ':' + port);
    try {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, icy-metaint',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'icy-name': 'SL-Compatible Proxy Stream',
        'icy-notice1': 'This stream is public',
        'icy-pub': '1',
        'icy-metaint': '0',
        'Server': 'SHOUTcast Server/Linux'
      });
    } catch (e) {}
    socket.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
  });

  socket.on('data', chunk => res.write(chunk));
  socket.on('end', () => res.end());
  socket.on('error', err => {
    console.error('[RawSocket] Stream error:', err.message);
    res.destroy();
  });
  res.on('close', () => socket.destroy());
}

function tryIcyStreamWithAgents(url, res, uaList, onFail) {
  if (uaList.length === 0) return onFail();
  const userAgent = uaList.shift();
  const headers = {
    'Icy-MetaData': '1',
    'User-Agent': userAgent,
    'Accept': 'audio/mpeg',
    'Connection': 'keep-alive'
  };

  const icyReq = icyGet(url, { headers }, icyRes => {
    console.log(`[Proxy] Success with UA: ${userAgent}`);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, icy-metaint',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'icy-name': 'SL-Compatible Proxy Stream',
      'icy-notice1': 'This stream is public',
      'icy-pub': '1',
      'icy-metaint': '0',
      'Server': 'SHOUTcast Server/Linux'
    });
    icyRes.on('metadata', () => {});
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.warn(`[Proxy] UA failed: ${userAgent}, trying next`);
    tryIcyStreamWithAgents(url, res, uaList, onFail);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, icy-metaint'
    });
    return res.end();
  }

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
    return res.end('Missing ?url=... or /http(s)://… in path');
  }

  console.log('[Proxy] Target URL:', target);

  const parsed = new URL(target);
  tryIcyStreamWithAgents(target, res, [...USER_AGENTS], () => {
    console.warn('[Proxy] All UA failed, trying raw socket fallback');
    rawSocketStream(parsed.hostname, parsed.port || 80, parsed.pathname + parsed.search, res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy with UA fallback running on http://${HOST}:${PORT}`);
});
