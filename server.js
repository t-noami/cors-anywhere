// server.js
import * as http      from 'http';
import * as https     from 'https';
import { get as icyGet } from 'icy';
import net            from 'net';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast 用マウント候補（v2/v1）
const SC_CANDIDATES = ['/?sid=1', '/;', '/stream', ''];

// HEADERS を最初にセットしておく
const COMMON_CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
};

const server = http.createServer((req, res) => {
  // プリフライト対応
  Object.entries(COMMON_CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1) ?url=… かパスで /http(s)://… を取る
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let rawUrl   = reqUrl.searchParams.get('url');
  if (!rawUrl) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) rawUrl = p;
  }
  if (!rawUrl) {
    res.writeHead(400, {'Content-Type':'text/plain'});
    return res.end('Missing ?url=… or /http(s)://… in path');
  }

  // 2) ユーザーがパス（マウント）付きで渡していればそれを使う
  const userUrl = new URL(rawUrl);
  const base    = userUrl.origin;
  let mount     = '';
  if (userUrl.pathname && userUrl.pathname !== '/') {
    // そのまま使う（例: /stream）
    mount = userUrl.pathname + userUrl.search;
  }

  // 3) マウント未設定なら自動検出する
  (async () => {
    if (!mount) {
      // 3a) Icecast？ → /status-json.xsl で探す
      try {
        const stat = await fetch(`${base}/status-json.xsl`).then(r => r.json());
        let src = stat.icestats.source;
        if (Array.isArray(src)) src = src[0];
        const listen = new URL(src.listenurl);
        mount = listen.pathname + listen.search;
      } catch {
        // 3b) Shoutcast マウント候補を試す
        for (let m of SC_CANDIDATES) {
          if (await probeMount(base, m)) {
            mount = m;
            break;
          }
        }
        // 3c) それでもなければ古典的フォールバック
        if (!mount) mount = '/;';
      }
    }

    // 4) 実際のストリーム URL
    const streamUrl = `${base}${mount}`;

    // 5) クライアント向けヘッダー
    res.writeHead(200, {
      ...COMMON_CORS,
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // 6) 上流 Shoutcast/Icecast へ転送するヘッダー
    const upstreamHeaders = {
      // Shoutcast は必ずメタデータリクエストを
      'Icy-MetaData': '1',
      // 一部サーバで必須の UA
      'User-Agent':   'WinampMPEG/5.09'
    };
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    // 7) icy で取得→パイプ
    const icyReq = icyGet(streamUrl, { headers: upstreamHeaders }, icyRes => {
      icyRes.on('metadata', () => {});
      icyRes.pipe(res);
    });

    icyReq.on('error', err => {
      // 8) icy が壊れる場合は TCP GET フォールバック
      console.warn('icyGet failed, TCP fallback:', err);
      const u2 = new URL(streamUrl);
      const sock = net.connect(u2.port || 80, u2.hostname, () => {
        sock.write(`GET ${u2.pathname + u2.search}\r\n\r\n`);
        sock.pipe(res);
      });
      sock.on('error', () => res.destroy());
    });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Universal proxy listening on http://${HOST}:${PORT}`);
});

// -------------------
// probeMount: 最初の1バイトだけ取って audio/* なら OK とみなす
function probeMount(origin, mount) {
  return new Promise(resolve => {
    const u      = new URL(origin + mount);
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
