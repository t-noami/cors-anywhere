import http from 'http';
import https from 'https';
import { get as icyGet } from 'icy';
import { URL } from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // Determine target
  let target = reqUrl.searchParams.get('url') || '';
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    const q = reqUrl.search || '';
    if (/^(?:https?:\/\/|icy:\/\/)/.test(p)) target = p + q;
  }
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url');
  }
  if (target.startsWith('icy://')) target = 'http://' + target.slice(6);

  // HEAD request emulation
  if (req.method === 'HEAD') {
    const u = new URL(target);
    const isHttps = u.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const agent = isHttps ? new https.Agent({ servername: u.hostname, rejectUnauthorized: true }) : undefined;
    const opts = {
      method: 'HEAD',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'SecondLife (FMOD) Audio Client',
        'Accept': 'audio/mpeg',
        'Icy-MetaData': '1'
      },
      agent
    };
    const headReq = requestFn(opts, upstreamRes => {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes',
        'Content-Type': upstreamRes.headers['content-type'] || 'audio/mpeg',
        'Content-Range': upstreamRes.headers['content-range'] || '',
        'icy-metaint': upstreamRes.headers['icy-metaint'] || ''
      });
      res.end();
    });
    headReq.on('error', () => res.writeHead(502).end());
    headReq.end();
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
    });
    return res.end();
  }

  const headers = {
    'Icy-MetaData': '1',
    'User-Agent': 'SecondLife (FMOD) Audio Client',
    'Accept': 'audio/mpeg'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;
  headers['Host'] = new URL(target).host;

  const icyReq = icyGet(target, { headers }, icyRes => {
    res.writeHead(icyRes.statusCode || 200, {
      'Content-Type': icyRes.headers['content-type'] || 'audio/mpeg',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, icy-metaint',
      'Accept-Ranges': icyRes.headers['accept-ranges'] || 'bytes',
      'Content-Range': icyRes.headers['content-range'] || '',
      'icy-metaint': icyRes.headers['icy-metaint'] || ''
    });
    icyRes.on('metadata', () => {});
    icyRes.pipe(res);
  });

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err);
    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SecondLife-compatible ICY proxy listening on http://${HOST}:${PORT}`);
});
