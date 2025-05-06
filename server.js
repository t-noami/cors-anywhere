// server.js
import * as http      from 'http';
import * as https     from 'https';
import { get as icyGet } from 'icy';
import net            from 'net';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast 用に試すマウント候補
const SC_CANDIDATES = ['/?sid=1', '/;', '/stream', ''];

// 共通で先にセットする CORS ヘッダー
const COMMON_CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
  'Access-Control-Expose-Headers':'Content-Length, Content-Range'
};

const server = http.createServer((req, res) => {
  // プリフライト対応
  Object.entries(COMMON_CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1) ?url=… or /http(s)://… で target を取得
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let rawUrl = reqUrl.searchParams.get('url');
  if (!rawUrl) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) rawUrl = p;
  }
  if (!rawUrl) {
    res.writeHead(400, {'Content-Type':'text/plain'});
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // 2) ユーザーがパス付きで渡していればそのまま使う
  const u0 = new URL(rawUrl);
  const base = u0.origin;
  let mount = '';
  if (u0.pathname && u0.pathname !== '/') {
    mount = u0.pathname + u0.search;
  }

  // 3) マウント検出＆ストリーム開始
  (async () => {
    if (!mount) {
      // 3a) Icecast か？ → ルートの JSON ステータスを叩く
      try {
        const stat = await fetch(`${base}/status-json.xsl`);
        if (stat.ok) {
          const j = await stat.json();
          let src = j.icestats.source;
          if (Array.isArray(src)) src = src[0];
          const listen = new URL(src.listenurl);
          mount = listen.pathname + listen.search;
        }
      } catch {
        // Icecast でない or 失敗したら次へ
      }
      // 3b) Shoutcast 候補を順に probe
      if (!mount) {
        for (let m of SC_CANDIDATES) {
          if (await probeMount(base, m)) {
            mount = m;
            break;
          }
        }
      }
      // 3c) 最後に古典的フォールバック
      if (!mount) mount = '/;';
    }

    const streamUrl = base + mount;

    // 4) クライアントへ返すヘッダー
    res.writeHead(200, {
      ...COMMON_CORS,
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // 5) 上流に渡すヘッダーを準備
    const isShoutcast = mount.startsWith('/;') || mount.startsWith('/?sid');
    const upstreamHeaders = {};
    if (isShoutcast) {
      upstreamHeaders['Icy-MetaData'] = '1';
      upstreamHeaders['User-Agent']   = 'WinampMPEG/5.09';
      if (req.headers.range) {
        upstreamHeaders.Range = req.headers.range;
      }
    }
    // Icecast の場合はヘッダー不要

    // 6) 実際にパイプ
    const doTcpFallback = () => {
      const u2 = new URL(streamUrl);
      const port = u2.port || 80;
      const sk = net.connect(port, u2.hostname, () => {
        sk.write(`GET ${u2.pathname + u2.search}\r\n\r\n`);
        sk.pipe(res);
      });
      sk.on('error', () => res.destroy());
    };

    if (isShoutcast) {
      // Shoutcast は icyGet ＋ フォールバック
      const icyReq = icyGet(streamUrl, { headers: upstreamHeaders }, icyRes => {
        icyRes.on('metadata', () => {});
        icyRes.pipe(res);
      });
      icyReq.on('error', err => {
        console.warn('Shoutcast icyGet failed, TCP fallback:', err);
        doTcpFallback();
      });
    } else {
      // Icecast は直接 TCP GET
      doTcpFallback();
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy listening on http://${HOST}:${PORT}`);
});

// probeMount: Range+ICY で最初の1バイトを取って audio/* なら true
function probeMount(origin, mount) {
  return new Promise(resolve => {
    const u = new URL(origin + mount);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol==='https:'?443:80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Range':'bytes=0-1', 'Icy-MetaData':'1', 'User-Agent':'WinampMPEG/5.09' },
      timeout: 3000
    }, res => {
      const ct = (res.headers['content-type']||'');
      const ok = (res.statusCode===200 || res.statusCode===206) && ct.startsWith('audio/');
      res.destroy();
      resolve(ok);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
