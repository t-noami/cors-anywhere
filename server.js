import http            from 'http';
import { get as icyGet } from 'icy';
import net             from 'net';
import { URL }         from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // （CORS 設定は server.on('request') 側で済んでいる想定）
  if (req.method === 'OPTIONS') {
    return res.writeHead(204).end();
  }

  // 1) ターゲット URL 抽出…（省略）

  // 2) レスポンス用ヘッダー
  res.writeHead(200, {
    'Content-Type':      'audio/mpeg',
    'Transfer-Encoding': 'chunked'
  });

  // 3) upstream ヘッダー
  const headers = { 'Icy-MetaData': '1' };
  if (req.headers.range) headers.Range = req.headers.range;

  // 4) まずは icyGet で試す
  let handled = false;
  try {
    const icyReq = icyGet(target, { headers }, icyRes => {
      handled = true;
      icyRes.on('metadata', () => {});
      icyRes.pipe(res);
    });
    icyReq.on('error', onUpstreamError);
  } catch (e) {
    // すぐに sync なパースエラーならここへ
    console.warn('icyGet sync error → fallback', e);
    fallbackRaw();
  }

  // 5) 非同期パースエラーをキャッチ
  function onUpstreamError(err) {
    console.warn('ICY upstream error → fallback', err);
    if (!handled) {
      fallbackRaw();
    } else {
      res.destroy();
    }
  }

  // 6) HTTP/0.9 互換で自前 GET
  function fallbackRaw() {
    const u = new URL(target);
    const port = u.port || 80;
    const socket = net.connect(port, u.hostname, () => {
      // HTTP/0.9 スタイルで GET 投げる
      socket.write(`GET ${u.pathname + u.search}\r\n\r\n`);
      socket.pipe(res);
    });
    socket.on('error', e => {
      console.error('Fallback raw socket error', e);
      if (!res.headersSent) {
        res.writeHead(502, {'Content-Type':'text/plain'});
        res.end('Bad Gateway');
      } else {
        res.destroy();
      }
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy running on http://${HOST}:${PORT}`);
});
