// https://create-react-app.dev/docs/proxying-api-requests-in-development/
// https://github.com/chimurai/http-proxy-middleware
const proxy = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/api',
    proxy({
      target: 'http://qa:5001', // prod
      // target: 'http://qa:9002', // dev-staging
      changeOrigin: true,
    })
  );
  app.use(
    '/s',
    proxy({
      target: 'http://qa',
      changeOrigin: true,
    })
  );


  app.use(
    '/fcgi-bin/',
    proxy({
      target: 'https://qa:8186',
      changeOrigin: true,
      secure: false,
    })
  );


 app.use(
    '/iiif/2',
    proxy({
      target: 'https://qa:8183',
      changeOrigin: true,
      secure: false,
    })
  );


};