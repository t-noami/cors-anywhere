// server.js
const cors_proxy = require('cors-anywhere');
const host       = process.env.HOST || '0.0.0.0';
const port       = process.env.PORT || 8080;
const parseEnvList = env => env ? env.split(',') : [];

// ブラック／ホワイトリスト
const originBlacklist = parseEnvList(process.env.CORSANYWHERE_BLACKLIST);
const originWhitelist = parseEnvList(process.env.CORSANYWHERE_WHITELIST);

// レートリミット（任意）
const checkRateLimit = require('./lib/rate-limit')(process.env.CORSANYWHERE_RATELIMIT);

const server = cors_proxy.createServer({
  originBlacklist,
  originWhitelist,
  requireHeader: [],           // 認証ヘッダー不要
  checkRateLimit,
  removeHeaders: [
    'cookie', 'cookie2',
    'x-request-start', 'x-request-id',
    'via', 'connect-time', 'total-route-time',
  ],
  redirectSameOrigin: true,
  httpProxyOptions: { xfwd: false },
  // setHeaders は削除
});

// バックエンドへのリクエストヘッダーを書き換えたい場合
server.on('proxyReq', (proxyReq, req, res, options) => {
  proxyReq.setHeader('Accept', 'audio/mpeg');
});

// ブラウザ向けレスポンスに必須の CORS ヘッダーを付与
server.on('proxyRes', (proxyRes, req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
});

server.listen(port, host, () => {
  console.log(`CORS proxy running on http://${host}:${port}`);
});
