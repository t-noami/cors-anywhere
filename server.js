// server.js — Universal ICY/HTTP proxy (Shoutcast v1/v2 & Icecast 対応)
//
// Render などの無料ホスティングでも動作する軽量版
//   * ?url=...  または  /http://… 形式でリクエスト
//   * Content‑Type が無い Shoutcast v1 も許可
//   * CORS ＆ Range 対応（ブラウザ再生用）
//
// 必要パッケージ: `npm i icy`

import http             from 'http';
import { get as icyGet} from 'icy';
import { URL }          from 'url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8080;

/* ------------------------------------------
 * 取り出したいターゲット URL を決定
 * ----------------------------------------*/
function getTargetURL(req) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // ① ?url=https://… 優先
  let target = reqUrl.searchParams.get('url');

  // ② /https://… 形式
  if (!target) {
    const p = decodeURIComponent(reqUrl.pathname.slice(1));
    if (p.startsWith('http://') || p.startsWith('https://')) target = p;
  }
  return target;
}

/* ------------------------------------------
 * メイン HTTP サーバ
 * ----------------------------------------*/
const server = http.createServer((req, res) => {
  const target = getTargetURL(req);
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing ?url=...  or  /http(s)://…');
  }

  /* ---- 上流 (ICY) へ接続 ---- */
  const icyReq = icyGet(
    target,
    { headers: { 'Icy-MetaData': '1', 'User-Agent': 'ICY-Proxy' } },
    icyRes => {
      /* ---- オーディオ判定 ---- */
      const ct = (icyRes.headers['content-type'] || '').toLowerCase();
      const looksLikeAudio =
        !ct ||                                // Shoutcast v1 はヘッダー無し
        ct.startsWith('audio') ||
        ct === 'application/octet-stream' ||  // AAC 鯖が出すことがある
        ('icy-name' in icyRes.headers);       // icy-* があれば実質オーディオ

      if (!looksLikeAudio) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        icyRes.destroy();
        return res.end('Upstream is not audio');
      }

      /* ---- ここで初めてクライアントにヘッダー ---- */
      res.writeHead(200, {
        'Content-Type': icyRes.headers['content-type'] || 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Icy-MetaData',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      });

      icyRes.on('metadata', () => {}); // メタデータは無視
      icyRes.pipe(res);
    }
  );

  icyReq.on('error', err => {
    console.error('ICY upstream error:', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.destroy();
  });
});

/* ------------------------------------------
 * 起動
 * ----------------------------------------*/
server.listen(PORT, HOST, () =>
  console.log(`Universal ICY proxy running on http://${HOST}:${PORT}`)
);
