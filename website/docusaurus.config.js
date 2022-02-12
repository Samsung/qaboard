// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion
const publish_github_samsung_private = process.env.PUBLISH === 'github_samsung_private' 
const publish_github_samsung_public  = process.env.PUBLISH === 'github_samsung_public' 
const is_for_webapp = process.env.QABOARD_DOCS_FOR_WEBAPP === "true"
// console.log("is_for_webapp", is_for_webapp)
// console.log("publish_github_samsung_private", publish_github_samsung_private)
// console.log("publish_github_samsung_public", publish_github_samsung_public)

const lightCodeTheme = require('prism-react-renderer/themes/github');
const darkCodeTheme = require('prism-react-renderer/themes/dracula');

const logo = {
  alt: 'QA-Board Logo',
  // https://commons.wikimedia.org/wiki/File:Twemoji_1f429.svg
  src: '/img/twemoji_poodle.svg',
}


/** @type {import('@docusaurus/types').Config} */
let config = {
  title: 'QA-Board',
  tagline: "Algorithm engineering is hard enough.<br/>Don't waste time with logistics.",
  url: 'https://samsung.github.io',
  onBrokenLinks: 'warn', // log
  onBrokenMarkdownLinks: 'warn',
  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',
  projectName: 'qaboard', // Usually your repo name.
  organizationName: 'Samsung',
  baseUrl: '/qaboard/',
  deploymentBranch: 'gh-pages',

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          // Please change this to your repo.
          editUrl: 'https://github.com/Samsung/qaboard/edit/master/website/docs',
        },
        blog: {
          showReadingTime: true,
          // Please change this to your repo.
          editUrl: 'https://github.com/Samsung/qaboard/edit/master/website/blog',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/share.jpg",
      hideableSidebar: true,
      navbar: {
        title: 'QA-Board',
        logo,
        hideOnScroll: true,
        items: [
          {docId: 'introduction', label: 'Docs', type: 'doc', position: 'left'},
          {
            // link to other docs, or href links...
            // type: 'doc', docId: 'intro',
            href: 'https://github.com/Samsung/qaboard',
            position: 'left',
            label: 'Source',
          },
          {
            href: 'https://samsung.github.io/qaboard/blog',
            position: 'left',
            label: 'Blog',
          },
          {
            href: 'https://github.com/Samsung/qaboard',
            position: 'right',
            className: 'header-github-link',
            'aria-label': 'GitHub repository',
          }
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Introduction',
                to: '/docs/introduction',
              },
            ],
          },
          // {
          //   title: 'Community',
          //   items: [
          //     {
          //       label: 'Stack Overflow',
          //       href: 'https://stackoverflow.com/questions/tagged/docusaurus',
          //     },
          //     {
          //       label: 'Discord',
          //       href: 'https://discordapp.com/invite/docusaurus',
          //     },
          //     {
          //       label: 'Twitter',
          //       href: 'https://twitter.com/docusaurus',
          //     },
          //   ],
          // },
          {
            title: 'More',
            items: [
              {
                label: 'Blog',
                to: '/blog',
              },
              {
                label: 'GitHub',
                href: 'https://github.com/Samsung/qaboard',
              },
            ],
          },
        ],
        copyright: "Made with ❤️ at Samsung. Apache 2.0 License. Built with Docusaurus.",
      },
      prism: {
        additionalLanguages: ['nginx'],
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
      announcementBar: {
        id: 'supportus',
        content: '⭐️ If you like QA-Board, give it a star on <a target="_blank" rel="noopener noreferrer" href="https://github.com/Samsung/qaboard">GitHub</a>! ⭐️',
        backgroundColor: '#1064d3',
        textColor: 'white',
      },
      algolia: {
        appId: 'Q9000IO3JM',
        apiKey: '7a265918a0d970f8f3f36e7fbb70f720',
        indexName: 'samsung_qaboard',
      }
    }),
};


if (is_for_webapp) {
  // build for the app at /docs
  config = {
    ...config,
    url: process.env.QABOARD_URL,
    baseUrl: '/docs/',
  }
  config.presets[0][1].docs.routeBasePath = '/';
} else {
  if (publish_github_samsung_private) {
    config = {
      ...config,
      url: 'https://github.sec.samsung.net',
      baseUrl: '/pages/arthur-flam/qaboard/',
      githubHost: 'github.sec.samsung.net',
      organizationName: 'arthur-flam',
    }
  }
}

module.exports = config;
