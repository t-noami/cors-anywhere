// server.js
import * as http     from 'http';
import * as https    from 'https';
import { get as icyGet } from 'icy';
import net           from 'net';
import { URL }       from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast v2/v1 のマウント候補
const SC_CANDIDATES = ['/?sid=1', '/;', '/stream'];

// Icecast の JSON ステータス取得と Shoutcast マウント検出
async function detectMount(target) {
  // Icecast2? → /status-json.xsl から listenurl
  try {
    const statUrl = target.replace(/\/$/, '') + '/status-json.xsl';
    const res     = await fetch(statUrl);
    if (res.ok) {
      const data = await res.json();
      let src = data.icestats.source;
      if (Array.isArray(src)) src = src[0];
      return new URL(src.listenurl).pathname + new URL(src.listenurl).search;
    }
  } catch (e) {
    // Icecast でないか /status-json.xsl が返らない場合
  }

  // Shoutcast v2/v1 のマウントを順番に試す
  for (let m of SC_CANDIDATES) {
    if (await probeMount(target, m)) {
      return m;
    }
  }

  // 最終フォールバック
  return '/;';
}

// マウント候補を GET+Range で試し、audio/* が返れば OK
function probeMount(base, mount) {
  return new Promise(resolve => {
    const u = new URL(base);
    u.pathname = mount;
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol==='https:'?443:80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Range':'bytes=0-1', 'Icy-MetaData':'1' },
      timeout:  3000
    }, res => {
      const ok = (res.statusCode===200 || res.statusCode===206)
              && (res.headers['content-type']||'').startsWith('audio/');
      res.destroy();
      resolve(ok);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // CORS & プリフライト
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ?url=… または ルートパス /http(s)://… からターゲットURLを取得
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url');
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) target = p;
  }
  if (!target) {
    res.writeHead(400, { 'Content-Type':'text/plain' });
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // 非同期でマウントを自動検出→ストリーム取得
  (async () => {
    const mount    = await detectMount(target);
    const streamUrl = target.replace(/\/$/, '') + mount;

    // 音声チャンクのレスポンスヘッダー
    res.writeHead(200, {
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // クライアントの Range を転送
    const headers = { 'Icy-MetaData':'1' };
    if (req.headers.range) headers.Range = req.headers.range;

    // icy モジュールでパース＆パイプ
    const icyReq = icyGet(streamUrl, { headers }, icyRes => {
      icyRes.on('metadata', () => {});
      icyRes.pipe(res);
    });
    icyReq.on('error', err => {
      console.warn('icyGet failed, falling back TCP GET:', err);
      // TCPフォールバック
      const u = new URL(streamUrl);
      const sk = net.connect(u.port||80, u.hostname, () => {
        sk.write(`GET ${u.pathname + u.search}\r\n\r\n`);
        sk.pipe(res);
      });
      sk.on('error', e => {
        console.error('TCP fallback error:', e);
        res.destroy();
      });
    });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Universal proxy listening on http://${HOST}:${PORT}`);
});
