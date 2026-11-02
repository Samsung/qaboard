// Repository files shown in the docs (<RepoFile path="...">, see ./remark.js): `import text from './file.yaml?raw'`
// gives the file's content as a string, and webpack rebuilds the page when the file changes.
module.exports = function qaboardSnippetsPlugin() {
  return {
    name: 'qaboard-snippets',
    configureWebpack() {
      return {
        module: {
          rules: [{resourceQuery: /^\?raw$/, type: 'asset/source'}],
        },
      };
    },
  };
};
