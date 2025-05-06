// server.js
import * as http      from 'http';
import * as https     from 'https';
import { get as icyGet } from 'icy';
import net            from 'net';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast 用に試行するマウント候補リスト
const SC_CANDIDATES = ['/?sid=1', '/;', '/stream', ''];

// CORS ヘッダーを共通定義
const COMMON_CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
  'Access-Control-Expose-Headers':'Content-Length, Content-Range'
};

/**
 * マウントポイントを自動検出する
 * 1) Icecast の /status-json.xsl
 * 2) PLS (/listen.pls)
 * 3) Shoutcast のプローブ候補
 */
async function detectMount(base) {
  // 1) Icecast?
  try {
    const stat = await fetch(`${base}/status-json.xsl`);
    if (stat.ok) {
      const j = await stat.json();
      let src = Array.isArray(j.icestats.source)
                ? j.icestats.source[0]
                : j.icestats.source;
      const u = new URL(src.listenurl);
      return u.pathname + u.search;
    }
  } catch {}
  // 2) PLS プレイリスト
  try {
    const res = await fetch(`${base}/listen.pls`);
    const ct  = res.headers.get('content-type') || '';
    if (res.ok && (ct.includes('scpls') || ct.includes('audio/x-scpls') || ct.includes('pls'))) {
      const txt = await res.text();
      const m   = txt.match(/File1=(.+)/i);
      if (m) {
        const u = new URL(m[1].trim(), base);
        return u.pathname + u.search;
      }
    }
  } catch {}
  // 3) Shoutcast プローブ候補
  for (const m of SC_CANDIDATES) {
    if (await probeMount(base, m)) {
      return m;
    }
  }
  // フォールバック
  return '/;';
}

/**
 * GET + Range + Icy-MetaData で最初の1バイトだけ取得し、
 * audio/* が返ってくれば true を返す
 */
function probeMount(base, mount) {
  return new Promise(resolve => {
    const u      = new URL(base + mount);
    const client = u.protocol === 'https:' ? https : http;
    const req    = client.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol==='https:'?443:80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  {
        'Range':       'bytes=0-1',
        'Icy-MetaData':'1',
        'User-Agent':  'WinampMPEG/5.09'
      },
      timeout: 3000
    }, res => {
      const ct = (res.headers['content-type'] || '');
      const ok = (res.statusCode === 200 || res.statusCode === 206)
              && ct.startsWith('audio/');
      res.destroy();
      resolve(ok);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // CORS & プリフライト対応
  Object.entries(COMMON_CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ?url=… または /http(s)://… で target URL を取得
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let rawUrl   = reqUrl.searchParams.get('url');
  if (!rawUrl) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) rawUrl = p;
  }
  if (!rawUrl) {
    res.writeHead(400, { 'Content-Type':'text/plain' });
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // 既にマウント付きで渡されていればそのまま使う
  const u0  = new URL(rawUrl);
  const base = u0.origin;
  let mount  = (u0.pathname !== '/') ? u0.pathname + u0.search : '';

  // マウント自動検出＆ストリーミング開始
  (async () => {
    if (!mount) {
      mount = await detectMount(base);
    }
    const streamUrl = base + mount;

    // クライアント向けレスポンスヘッダー
    res.writeHead(200, {
      ...COMMON_CORS,
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // Shoutcast 判定
    const isShoutcast = mount.startsWith('/;') || mount.startsWith('/?sid');

    if (isShoutcast) {
      // ── Shoutcast 用: icy モジュール + TCP フォールバック ──
      const headers = {
        'Icy-MetaData':'1',
        'User-Agent':  'WinampMPEG/5.09',
        ...(req.headers.range ? { Range: req.headers.range } : {})
      };
      const icyReq = icyGet(
        { url: streamUrl, headers },
        icyRes => {
          icyRes.on('metadata', () => {});
          icyRes.pipe(res);
        }
      );
      icyReq.on('error', () => {
        // TCP (HTTP/0.9) フォールバック
        const u2 = new URL(streamUrl);
        const sk = net.connect(u2.port||80, u2.hostname, () => {
          sk.write(`GET ${u2.pathname + u2.search}\r\n\r\n`);
          sk.pipe(res);
        });
        sk.on('error', () => res.destroy());
      });

    } else {
      // ── Icecast 用: HTTP/1.x 生 GET ──
      const u2     = new URL(streamUrl);
      const client = u2.protocol === 'https:' ? https : http;
      const r2     = client.request({
        hostname: u2.hostname,
        port:     u2.port || (u2.protocol==='https:'?443:80),
        path:     u2.pathname + u2.search,
        method:   'GET',
        headers:  {
          ...(req.headers.range ? { Range: req.headers.range } : {})
        }
      }, up => up.pipe(res));
      r2.on('error', () => res.destroy());
      r2.end();
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Universal proxy listening on http://${HOST}:${PORT}`);
});
