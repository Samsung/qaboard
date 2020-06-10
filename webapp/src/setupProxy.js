// https://create-react-app.dev/docs/proxying-api-requests-in-development/
// https://github.com/chimurai/http-proxy-middleware
const { createProxyMiddleware } = require('http-proxy-middleware');

// by default we assume you run QA-Board on localhost
let QABOARD_SERVER_URL= process.env.REACT_APP_QABOARD_HOST || "http://localhost:5151";
// the api server doesn't serve the static content
let REACT_APP_QABOARD_API_HOST= process.env.REACT_APP_QABOARD_API_HOST || QABOARD_SERVER_URL;


module.exports = function(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: REACT_APP_QABOARD_API_HOST,
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
}
