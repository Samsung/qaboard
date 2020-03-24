// https://create-react-app.dev/docs/proxying-api-requests-in-development/
// https://github.com/chimurai/http-proxy-middleware
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://qa:5001', // prod
      // target: 'http://qa:9002', // dev-staging
      changeOrigin: true,
    })
  );
  app.use(
    '/s',
    createProxyMiddleware({
      target: 'http://qa',
      changeOrigin: true,
    })
  );


  app.use(
    '/fcgi-bin/',
    createProxyMiddleware({
      target: 'https://qa:8186',
      changeOrigin: true,
      secure: false,
    })
  );


 app.use(
    '/iiif/2',
    createProxyMiddleware({
      target: 'https://qa:8183',
      changeOrigin: true,
      secure: false,
    })
  );


};