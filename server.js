import * as http     from 'http';
import * as https    from 'https';
import { get as icyGet } from 'icy';
import net           from 'net';
import { URL }       from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

// Shoutcast のマウント候補（順序を入れ替え）
const SC_CANDIDATES = ['/;?sid=1', '/;', '/stream', ''];

async function detectMount(target) {
  const u0 = new URL(target);
  // 1) Icecast? → ルートの /status-json.xsl を叩く
  try {
    const statUrl = `${u0.origin}/status-json.xsl`;
    const res     = await fetch(statUrl);
    if (res.ok) {
      const json = await res.json();
      let src = json.icestats.source;
      if (Array.isArray(src)) src = src[0];
      const listen = new URL(src.listenurl);
      return listen.pathname + listen.search;
    }
  } catch {
    // Icecast でない or JSON取得失敗 → 次へ
  }

  // 2) Shoutcast マウント候補を順に試す
  for (let m of SC_CANDIDATES) {
    if (await probeMount(u0.origin, m)) {
      return m;
    }
  }

  // 3) 最終フォールバック
  return '/;';
}

function probeMount(origin, mount) {
  return new Promise(resolve => {
    const u = new URL(origin + mount);
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
      const ct = (res.headers['content-type']||'');
      const ok = (res.statusCode===200 || res.statusCode===206)
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
  // CORS + プリフライト
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Icy-MetaData');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ?url=… or /http(s)://… で target
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target   = reqUrl.searchParams.get('url');
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (/^https?:\/\//.test(p)) target = p;
  }
  if (!target) {
    res.writeHead(400, {'Content-Type':'text/plain'});
    return res.end('Missing ?url or /http(s):// in path');
  }

  // マウントを探してストリーミング
  (async () => {
    const mount     = await detectMount(target);
    const streamUrl = target.replace(/\/$/, '') + mount;

    // レスポンスヘッダー
    res.writeHead(200, {
      'Content-Type':      'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // upstream へ渡すヘッダー
    const headers = {
      'Icy-MetaData': '1',
      'User-Agent':   'WinampMPEG/5.09'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    // icy でパイプ
    const icyReq = icyGet(streamUrl, { headers }, icyRes => {
      icyRes.on('metadata', () => {});
      icyRes.pipe(res);
    });
    icyReq.on('error', err => {
      console.warn('icyGet failed, fallback TCP:', err);
      // TCP GET フォールバック
      const u  = new URL(streamUrl);
      const sk = net.connect(u.port||80, u.hostname, () => {
        sk.write(`GET ${u.pathname + u.search}\r\n\r\n`);
        sk.pipe(res);
      });
      sk.on('error', e => res.destroy());
    });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy running on http://${HOST}:${PORT}`);
});
