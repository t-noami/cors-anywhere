import http from 'http';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url=...');
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  const protocol = parsed.protocol;
  const hostname = parsed.hostname;
  const port = parsed.port || (protocol === 'https:' ? 443 : 80);
  const path = parsed.pathname + (parsed.search || '');
  const connectFn = protocol === 'https:' ? tls.connect : net.connect;

  // Set CORS and audio headers
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
  });

  const upstream = connectFn(port, hostname, () => {
    upstream.write(
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${hostname}\r\n` +
      `Icy-MetaData:1\r\n` +
      `User-Agent: RawShoutcastProxy/1.0\r\n` +
      `Connection: close\r\n` +
      `\r\n`
    );
  });

  // Strip upstream HTTP headers before streaming audio
  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  upstream.on('data', chunk => {
    if (!headersDone) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        // Write remaining data after headers
        const audioData = headerBuf.slice(idx + 4);
        res.write(audioData);
        headersDone = true;
      }
    } else {
      res.write(chunk);
    }
  });

  upstream.on('end', () => {
    res.end();
  });

  upstream.on('error', err => {
    console.error('Upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
