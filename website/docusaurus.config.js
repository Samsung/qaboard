const publish_github_samsung_private = process.env.PUBLISH === 'github_samsung_private' 
const publish_github_samsung_public  = process.env.PUBLISH === 'github_samsung_public' 
const is_for_webapp = !publish_github_samsung_private && !publish_github_samsung_public

// See https://docusaurus.io/docs/site-config for all the possible site configuration options.
const logo = {
  alt: 'QA-Board Logo',
  // https://commons.wikimedia.org/wiki/File:Twemoji_1f429.svg
  src: 'img/twemoji_poodle.svg',
  href: 'https://github.com/Samsung/qaboard',
}

var config = {
  title: 'QA-Board',
  tagline: "Algorithm engineering is hard enough.<br/>Don't waste time with logistics.",
  // You may provide arbitrary config keys to be used as needed by your
  // template. For example, if you need your repo's URL...

  // scripts: [
  // Add custom scripts here that would be placed in <script> tags.
  //'https://buttons.github.io/buttons.js'
  // ],

  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',
  customFields: {
    description:
      'Visualize and compare algorithm results. Optimize parameters. Share results and track progress.',
  },

  themeConfig: {
    // announcementBar: {
    //   id: 'supportus',
    //   backgroundColor: '',
    //   textColor: '',
    //   content: '⭐️ If you like QA-Board, give it a star on <a target="_blank" rel="noopener noreferrer" href="https://github.com/Samsung/qaboard">GitHub</a>! ⭐️',
    // },
    prism: {
      additionalLanguages: ['nginx'],
      theme: require('prism-react-renderer/themes/github'),
      darkTheme: require('prism-react-renderer/themes/dracula'),
    },
    footer: {
      logo,
      copyright: "Made with ❤️ at Samsung. Apache 2.0 License. Build with Docusaurus.",
    },
    navbar: {
      title: 'QA-Board',
      logo,
      hideOnScroll: true,
      items: [
        {to: is_for_webapp ? '/introduction' : 'docs/introduction', label: 'Docs', position: 'left'},
        {
          href: 'https://github.com/Samsung/qaboard',
          position: 'left',
          label: 'Source',
        },
        {
          href: 'https://github.com/Samsung/qaboard',
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    // removes "active" color on parent sidebar categories :|
    // sidebarCollapsible: false,
  },
};

if (publish_github_samsung_public) {
  config.themeConfig.algolia = {
    apiKey: '4cb9a8cb80c2445a36b52bbb504db331',
    indexName: 'samsung_qaboard',
    algoliaOptions: {
      // facetFilters: [`version:${versions[0]}`],
    },
  }
}


config = {
  ...config,
  plugins: [require.resolve('docusaurus-lunr-search')],
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
          // remarkPlugins: [admonitions],

          // Show documentation's last contributor's name.
          // enableUpdateBy: true,
          // Show documentation's last update time.
          // enableUpdateTime: true,
        
        },
      },
    ],
  ],
}



if (is_for_webapp) {
  // build for the app at /docs
  config = {
    ...config,
    url: 'https://qa', // Your website URL
    baseUrl: '/docs/', // Base URL for your project */
  }
  config.presets[0][1].docs.routeBasePath = '/';
  config.presets[0][1].docs.editUrl = 'http://gitlab-srv/common-infrastructure/qaboard/edit/master/website';
  // console.log(config.presets[0][1].docs)
} else {
  if (publish_github_samsung_private) {
    config = {
      ...config,
      url: 'https://github.sec.samsung.net',
      baseUrl: '/pages/arthur-flam/qaboard/',
      githubHost: 'github.sec.samsung.net',
      organizationName: 'arthur-flam',
      projectName: 'qaboard',
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
    config.presets[0][1].docs.editUrl = 'https://github.com/Samsung/qaboard/edit/master/website/';
  }
}

module.exports = config;
