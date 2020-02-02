/// Will be uncecessary after this PR is merged.
// https://github.com/facebook/docusaurus/pull/2224/files
const admonitions = require('remark-admonitions');



// https://commons.wikimedia.org/wiki/File:Twemoji_1f429.svg
const logo = {
  alt: 'QA-Board Logo',
  src: 'img/twemoji_poodle.svg',
  href: 'https://github.com/Samsung/qaboard',
}

// See https://docusaurus.io/docs/site-config for all the possible site configuration options.
var config = {
  title: 'QA-Board',
  tagline: "Visualize and compare algorithm results. Optimize parameters. Share results and track progress.",
  // You may provide arbitrary config keys to be used as needed by your
  // template. For example, if you need your repo's URL...
  // repoUrl: 'https://gitlab-srv/common-infrastructure/qatools',

  // scripts: [
  // Add custom scripts here that would be placed in <script> tags.
  //'https://buttons.github.io/buttons.js'
  // ],

  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',

  themeConfig: {
    // image: 'img/twemoji_poodle.svg',
    footer: {
      logo,
      copyright: "Made with ❤️ at Samsung. Apache 2.0 License. Build with Docusaurus.",
    },
    navbar: {
      title: 'QA-Board',
      logo,
      hideOnScroll: true,
      links: [
        {to: 'docs/introduction', label: 'Docs', position: 'left'},
        {
          href: 'https://github.com/samsung/qaboard',
          label: 'GitHub.com',
          position: 'right',
        },
      ],
    },
    // removes "active" color on parent sidebar categories :|
    // sidebarCollapsible: false,
  },
};


config = {
  ...config,
  presets: [
    [
      '@docusaurus/preset-classic',
      {
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
          // only accepts 1 field :|
          // customCss: [
          //   require.resolve('./src/css/custom.css'),
          //   require.resolve('remark-admonitions/styles/infima.css'),
          // ],
        },
        // blog: {
        //   remarkPlugins: [admonitions],
        // },
        docs: {
          path: 'docs',
          routeBasePath: 'docs',
          sidebarPath: require.resolve('./sidebars.js'),
          remarkPlugins: [admonitions],

          editUrl: 'http://gitlab-srv/common-infrastructure/qatools/edit/master/website/',
          // Show documentation's last contributor's name.
          // enableUpdateBy: true,
          // Show documentation's last update time.
          // enableUpdateTime: true,
        
        },
      },
    ],
  ],
}



const publish_github_samsung_private = process.env.PUBLISH === 'github_samsung_private' 
const publish_github_samsung_public  = process.env.PUBLISH === 'github_samsung_public' 
if (!publish_github_samsung_private && !publish_github_samsung_public) {
  config = {
    ...config,
    url: 'http://qa-docs', // Your website URL
    baseUrl: '/', // Base URL for your project */
  }
} else {
  if (publish_github_samsung_private) {
    config = {
      ...config,
      url: 'https://github.sec.samsung.net',
      baseUrl: '/pages/arthur-flam/qatools/',
      githubHost: 'github.sec.samsung.net',
      organizationName: 'arthur-flam',
      projectName: 'qatools',
    
    }  
  }
  if (publish_github_samsung_public) {
    config = {
      ...config,
      url: 'https://samsung.github.io',
      baseUrl: '/qaboard/',
      githubHost: 'github.com',
      organizationName: 'Samsung',
      projectName: 'qaboard',
        }  
  }
}

module.exports = config;
