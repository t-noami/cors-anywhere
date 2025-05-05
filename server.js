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

  // CORS ヘッダー付きでストリームを返却
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
  });

  const upstream = connectFn(port, hostname, () => {
    // HTTP/1.0 スタイルでリクエスト
    upstream.write(
      `GET ${path} HTTP/1.0\r\n` +
      `Host: ${hostname}\r\n` +
      `Icy-MetaData:1\r\n` +
      `User-Agent: RawShoutcastProxy/1.0\r\n` +
      `\r\n`
    );
    upstream.pipe(res);
  });

  upstream.on('error', err => {
    console.error('Upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`);
});
