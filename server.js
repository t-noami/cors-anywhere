// server.js
import * as http    from 'http';
import * as https   from 'https';
import { get as icyGet } from 'icy';
import net          from 'net';
import { URL }      from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// ── Icecast JSON ／ Shoutcast マウント候補 ──
const SC_CANDIDATES = ['/;?sid=1', '/;', '/stream'];
async function detectMount(target) {
  const base = new URL(target);
  // 1) Icecast?: status-json.xsl
  try {
    const stat = await fetch(target.replace(/\/$/, '') + '/status-json.xsl')
                      .then(r => r.json());
    let src = stat.icestats.source;
    if (Array.isArray(src)) src = src[0];
    const url = new URL(src.listenurl);
    return url.pathname + url.search;
  } catch {}
  // 2) Shoutcast v2/v1: probe candidates
  for (let m of SC_CANDIDATES) {
    if (await probeMount(target, m)) {
      return m;
    }
  }
  // 3) 最終フォールバック
  return '/;';
}

// ── マウント候補検証 (GET+Range で最初の1バイトを取って audio/* を返すか) ──
function probeMount(target, mount) {
  return new Promise(resolve => {
    const u = new URL(target);
    // Icecast の場合 mount が full URL path (starting slash)
    u.pathname = mount;
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  {
        'Range': 'bytes=0-1',
        'Icy-MetaData': '1'
      },
      timeout: 3000
    }, res => {
      const ok = (res.statusCode === 200 || res.statusCode === 206)
              && (res.headers['content-type']||'').startsWith('audio/');
      res.destroy();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // ── 1) CORS & プリフライト ──
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── 2) ?url= or /http(s)://… から target を取得 ──
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

  // 非同期にマウントを検出してからストリーム開始
  (async () => {
    const mount = await detectMount(target);
    const streamUrl = target.replace(/\/$/, '') + mount;

    // ── 3) アップストリームへリクエスト送信 ──
    // 音声チャンクとして返却するヘッダー
    res.writeHead(200, {
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // クライアントの Range を転送
    const headers = { 'Icy-MetaData': '1' };
    if (req.headers.range) headers.Range = req.headers.range;

    // ── 4) icy モジュールでパース & パイプ ──
    const icyReq = icyGet(streamUrl, { headers }, icyRes => {
      icyRes.on('metadata', () => {});
      icyRes.pipe(res);
    });
    icyReq.on('error', err => {
      console.warn('icyGet error, fallbackTCP:', err);
      // ── 5) TCP GET フォールバック ──
      const u = new URL(streamUrl);
      const sk = net.connect(u.port||80, u.hostname, () => {
        sk.write(`GET ${u.pathname + u.search}\r\n\r\n`);
        sk.pipe(res);
      });
      sk.on('error', e => {
        console.error('fallback TCP error', e);
        res.destroy();
      });
    });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Universal proxy listening on http://${HOST}:${PORT}`);
});
