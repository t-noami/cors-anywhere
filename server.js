// server.js
import * as http      from 'http';
import * as https     from 'https';
import { get as icyGet } from 'icy';
import net            from 'net';
import { URL }        from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast の mount 候補
const SC_CANDIDATES = ['/?sid=1', '/;', '/stream', ''];

// CORS ヘッダーを共通でセット
const COMMON_CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
  'Access-Control-Expose-Headers':'Content-Length, Content-Range'
};

const server = http.createServer((req, res) => {
  // プリフライト(OPTIONS)
  Object.entries(COMMON_CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1) ?url=… かパスで URL を取得
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

  // 2) ユーザー指定 mount があれば取り込む
  const u0 = new URL(rawUrl);
  const base = u0.origin;
  let mount = '';
  if (u0.pathname !== '/') {
    mount = u0.pathname + u0.search;
  }

  // 3) mount 未指定なら自動検出
  (async () => {
    if (!mount) {
      // 3a) Icecast? → ルートの status-json.xsl
      try {
        const stat = await fetch(`${base}/status-json.xsl`);
        if (stat.ok) {
          const json = await stat.json();
          let src = json.icestats.source;
          if (Array.isArray(src)) src = src[0];
          const listen = new URL(src.listenurl);
          mount = listen.pathname + listen.search;
        }
      } catch {}
      // 3b) Shoutcast mount 候補を GET+Range で試す
      if (!mount) {
        for (let m of SC_CANDIDATES) {
          if (await probeMount(base, m)) {
            mount = m;
            break;
          }
        }
      }
      // 3c) 最終フォールバック
      if (!mount) mount = '/;';
    }

    const streamUrl = base + mount;

    // 4) クライアント向けヘッダー
    res.writeHead(200, {
      ...COMMON_CORS,
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // 5) Shoutcast か Icecast か判別
    const isShoutcast = mount.startsWith('/;') || mount.startsWith('/?sid');

    if (isShoutcast) {
      // ── Shoutcast: icy モジュール + TCPフォールバック ──
      const headers = {
        'Icy-MetaData':'1',
        'User-Agent':'WinampMPEG/5.09',
        ...(req.headers.range ? { Range: req.headers.range } : {})
      };
      const icyReq = icyGet(streamUrl, { headers }, icyRes => {
        icyRes.on('metadata', ()=>{});
        icyRes.pipe(res);
      });
      icyReq.on('error', _ => {
        // TCP fallback (HTTP/0.9)
        const u2 = new URL(streamUrl);
        const sk = net.connect(u2.port||80, u2.hostname, ()=> {
          sk.write(`GET ${u2.pathname + u2.search}\r\n\r\n`);
          sk.pipe(res);
        });
        sk.on('error', ()=>res.destroy());
      });

    } else {
      // ── Icecast: http/https モジュールで HTTP/1.0 GET ──
      const u2 = new URL(streamUrl);
      const client = u2.protocol === 'https:' ? https : http;
      const req2 = client.request({
        hostname: u2.hostname,
        port:     u2.port|| (u2.protocol==='https:'?443:80),
        path:     u2.pathname + u2.search,
        method:   'GET',
        headers:  {
          // Icecast に不要なヘッダーは送らない
          ...(req.headers.range ? { Range: req.headers.range } : {})
        }
      }, up => {
        // http.ClientResponse (Readable)
        up.pipe(res);
      });
      req2.on('error', ()=>res.destroy());
      req2.end();
    }
  })();
});

server.listen(PORT, HOST, ()=> {
  console.log(`Listening on http://${HOST}:${PORT}`);
});

// probeMount: 最初の1バイトだけ GET して audio/* なら OK
function probeMount(origin, mount) {
  return new Promise(resolve => {
    const u = new URL(origin + mount);
    const client = u.protocol==='https:'? https: http;
    const r = client.request({
      hostname: u.hostname,
      port:     u.port||(u.protocol==='https:'?443:80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  {
        'Range':'bytes=0-1',
        'Icy-MetaData':'1',
        'User-Agent':'WinampMPEG/5.09'
      },
      timeout: 3000
    }, res2 => {
      const ct = (res2.headers['content-type']||'');
      const ok = (res2.statusCode===200||res2.statusCode===206)
              && ct.startsWith('audio/');
      res2.destroy();
      resolve(ok);
    });
    r.on('error',   ()=>resolve(false));
    r.on('timeout', ()=>{ r.destroy(); resolve(false); });
    r.end();
  });
}
