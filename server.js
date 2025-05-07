/*
 * server.js
 * CORS Anywhere ベース + Icy-Metadata ストリップ + Basic 認証
 * ブラウザには純粋な音声データのみを送信
 */

const corsAnywhere = require('cors-anywhere');
const http = require('http');
const { Transform } = require('stream');

// 環境変数からホストとポート
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 8080;
// 認証情報（必要に応じて設定）
const STREAM_USER = process.env.STREAM_USER || '';
const STREAM_PASS = process.env.STREAM_PASS || '';

// Icy-Metadata をストリップする Transform ストリーム生成関数
function createIcyStrippingStream(metaInt) {
  let bytesUntilMeta = metaInt;
  let metadataBytesRemaining = 0;
  return new Transform({
    transform(chunk, _, callback) {
      const buffers = [];
      let offset = 0;
      while (offset < chunk.length) {
        if (metadataBytesRemaining > 0) {
          // メタデータ部をスキップ
          const skip = Math.min(metadataBytesRemaining, chunk.length - offset);
          offset += skip;
          metadataBytesRemaining -= skip;
        } else {
          // 音声データ部をバッファ
          const copyLen = Math.min(bytesUntilMeta, chunk.length - offset);
          buffers.push(chunk.slice(offset, offset + copyLen));
          offset += copyLen;
          bytesUntilMeta -= copyLen;
          if (bytesUntilMeta === 0) {
            // メタデータ長バイトを読み取り
            const lengthByte = chunk[offset];
            offset += 1;
            metadataBytesRemaining = lengthByte * 16;
            bytesUntilMeta = metaInt;
          }
        }
      }
      this.push(Buffer.concat(buffers));
      callback();
    }
  });
}

// CORS-Anywhere サーバー生成
const server = corsAnywhere.createServer({
  originWhitelist: [], // 全オリジン許可
  setHeaders: { 'Access-Control-Allow-Origin': '*' },
  removeHeaders: ['cookie', 'cookie2'],
});

// リクエスト送信時ヘッダー調整
server.on('proxyReq', (proxyReq) => {
  // Icy-Metadata 要求
  proxyReq.setHeader('Icy-MetaData', '1');
  // Basic 認証ヘッダー
  if (STREAM_USER && STREAM_PASS) {
    const auth = Buffer.from(`${STREAM_USER}:${STREAM_PASS}`).toString('base64');
    proxyReq.setHeader('Authorization', `Basic ${auth}`);
  }
});

// レスポンス受信時にメタデータをストリップ
server.on('proxyRes', (proxyRes, req, res) => {
  const metaIntHeader = proxyRes.headers['icy-metaint'];
  if (metaIntHeader) {
    const metaInt = parseInt(metaIntHeader, 10);
    // ヘッダー調整
    delete proxyRes.headers['icy-metaint'];
    delete proxyRes.headers['content-length'];
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // ストリッピングしてクライアントに伝送
    const stripper = createIcyStrippingStream(metaInt);
    proxyRes.pipe(stripper).pipe(res);
  }
});

// HTTP サーバー起動
http.createServer((req, res) => server.emit('request', req, res))
  .listen(port, host, () => console.log(`Proxy running on ${host}:${port}`));
