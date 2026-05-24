/* config-overrides.js */
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

module.exports = function override(config, env) {
  if (!config.plugins) {
    config.plugins = [];
  }

  config.plugins.push(
    new MonacoWebpackPlugin()
  );

  // console.log(config.plugins)
  // the names of the plugins could change in the future..
  // you debug the changes easily with console.log statements
  config.plugins.forEach(plugin => {
    if (plugin.constructor.name === "GenerateSW") {
      plugin.config.navigateFallbackBlacklist = [
        /^\/s\/.*/,
        /^\/api\/.*/,
        /^\/admin\/.*/,
        /^\/docs\/.*/,
        /^\/blog\/.*/,
        /^\/piwik\.js/,
        /^\/piwik\.php/,
      ];
      // console.log(plugin.config)
    }
  });
  // console.log(config.plugins.filter(plugin => plugin.constructor.name === "GenerateSW"))
  return config;
};

/* Add jest config for react-app-rewired */
module.exports.jest = function(config) {
  return {
    ...config,
    transformIgnorePatterns: [
      "/node_modules/(?!(d3-scale-chromatic|d3-interpolate|d3-color|d3-format|d3-time|d3-array|d3-scale|d3-contour|d3-hierarchy|d3-path|d3-shape|quick-lru|mathjs|fraction.js|complex.js|typed-function|decimal.js)/)"
    ],
    moduleNameMapper: {
      "^mathjs/number$": require.resolve("mathjs/number"),  // force correct resolution
    },
  };
};