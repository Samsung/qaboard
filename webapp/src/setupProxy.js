// https://create-react-app.dev/docs/proxying-api-requests-in-development/
// https://github.com/chimurai/http-proxy-middleware
const { createProxyMiddleware } = require('http-proxy-middleware');

let QABOARD_SERVER_URL= "http://localhost:5151";
// QABOARD_SERVER_URL_PROD= "https://qa";

module.exports = function(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: QABOARD_SERVER_URL,
      changeOrigin: true,
    })
  );
  app.use(
    '/s',
    createProxyMiddleware({
      target: QABOARD_SERVER_URL,
      changeOrigin: true,
    })
  );
  app.use(
    '/iiif',
    createProxyMiddleware({
      target: QABOARD_SERVER_URL,
      changeOrigin: true,
    })
  );
