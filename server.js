import http from 'http';
import https from 'https';
import net from 'net';
import { get as icyGet } from 'icy';
import { URL } from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

function rawSocketStream(host, port, res) {
  const socket = net.connect(port, host, () => {
    console.log('[RawSocket] Connected to', host + ':' + port);
  });

  let headerParsed = false;
  let buffer = '';

  socket.on('data', chunk => {
    if (!headerParsed) {
      buffer += chunk.toString('utf-8');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        headerParsed = true;
        const headerLength = Buffer.byteLength(buffer.slice(0, headerEnd + 4));
        const remaining = chunk.slice(chunk.length - (buffer.length - headerLength));
        res.write(remaining);
      }
    } else {
      res.write(chunk);
    }
  });

  socket.on('end', () => {
    console.log('[RawSocket] Stream ended');
    res.end();
  });

  socket.on('error', err => {
    console.error('[RawSocket] Stream error:', err.message);
    res.destroy();
  });

  res.on('close', () => {
    socket.destroy();
  });
}

function streamWithFallback(targetUrl, res) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  const options = {
    headers: {
      'Icy-MetaData': '1',
      'User-Agent': 'SecondLife (FMOD) Audio Client',
      'Accept': 'audio/mpeg',
      'Connection': 'keep-alive',
      'Range': 'bytes=0-'
    }
  };

  const req = client.get(targetUrl, options, upstream => {
    console.log('[Fallback] Upstream headers:', upstream.headers);
    upstream.pipe(res);
  });

  req.on('error', err => {
    console.error('[Fallback] HTTP upstream error:', err.message);

    const host = parsed.hostname;
    const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (host && port) {
      console.log('[Fallback] Trying raw socket as final fallback');
      rawSocketStream(host, port, res);
    } else {
      res.destroy();
    }
  });
}

const server = http.createServer((req, res) => {
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

  const icyReq = icyGet(target, icyRes => {
    console.log('[Proxy] ICY Response Headers:', icyRes.headers || '[no headers]');
    icyRes.on('metadata', metadata => {
      console.log('[Proxy] ICY Metadata received (ignored):', metadata.toString());
    });
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.warn('[Proxy] ICY upstream failed, falling back to raw HTTP:', err.message);
    streamWithFallback(target, res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
