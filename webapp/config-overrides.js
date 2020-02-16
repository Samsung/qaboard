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
}
