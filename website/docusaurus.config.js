/**
 * Copyright (c) 2017-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See https://docusaurus.io/docs/site-config for all the possible
// site configuration options.

// List of projects/orgs using your project for the users page.
const users = [
  {
    caption: 'Arthur Flam',
    // You will need to prepend the image path with your baseUrl
    // if it is not '/', like: '/test-site/img/docusaurus.svg'.
    // image: '/img/docusaurus.svg',
    image: '/img/twemoji_poodle.svg',
    infoLink: 'https://shapescience.xyz',
    pinned: true,
  },
];

var siteConfig = {
  title: 'QA-Board', // Title for your website.
  // tagline: "Easily organize, visualize and compare and share your algorithms' results.",
  tagline: "Visualize and compare algorithm results. Optimize parameters. Share results and track progress.",

  // Used for publishing and more
  githubHost: 'github.sec.samsung.net',
  organizationName: 'arthur-flam',
  projectName: 'qatools',

  // For no header links in the top nav bar -> headerLinks: [],
  headerLinks: [
    {doc: 'introduction', label: 'Docs'},
  //  {doc: 'doc4', label: 'API'},
    {page: 'help', label: 'Help'},
    {blog: true, label: 'Blog'},
  ],

  // If you have users set above, you add it here:
  users,

  /* path to images for header/footer */
  // https://commons.wikimedia.org/wiki/File:Twemoji_1f429.svg
  headerIcon: 'img/twemoji_poodle.svg',
  footerIcon: 'img/twemoji_poodle.svg',
  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',

  docsSideNavCollapsible: false,
  scrollToTop: true,

  /* Colors for website */
  colors: {
    primaryColor: '#233c8c',
    secondaryColor: '#1ed720',
  },

  /* Custom fonts for website */
  /*
  fonts: {
    myFont: [
      "Times New Roman",
      "Serif"
    ],
    myOtherFont: [
      "-apple-system",
      "system-ui"
    ]
  },
  */

  // This copyright info is used in /core/Footer.js and blog RSS/Atom feeds.
  copyright: "Made with ❤️ at Samsung. Apache 2.0 License",

  highlight: {
    // Highlight.js theme to use for syntax highlighting in code blocks.
    theme: 'default',
  },

  // Add custom scripts here that would be placed in <script> tags.
  scripts: [
    //'https://buttons.github.io/buttons.js'
   ],

  // On page navigation for the current documentation page.
  onPageNav: 'separate',
  // No .html extensions for paths.
  cleanUrl: true,

  // Open Graph and Twitter card images.
  ogImage: 'img/twemoji_poodle.svg',
  twitterImage: 'img/twemoji_poodle.svg',

  markdownPlugins: [
    // Highlight admonitions.
    require('remarkable-admonitions')({ icon: 'svg-inline' }),
    // require('remarkable-emoji')
  ],

  editUrl: 'http://gitlab-srv/common-infrastructure/qatools/edit/master/docs/',
  // Show documentation's last contributor's name.
  // enableUpdateBy: true,

  // Show documentation's last update time.
  // enableUpdateTime: true,

  // You may provide arbitrary config keys to be used as needed by your
  // template. For example, if you need your repo's URL...
  repoUrl: 'https://gitlab-srv/common-infrastructure/qatools',
};

const deploy_korea = process.env.PUBLISH === 'korea' 
if (!deploy_korea) {
  siteConfig = {
    ...siteConfig,
    url: 'http://qa-docs', // Your website URL
    baseUrl: '/', // Base URL for your project */
  }
} else {
  // CODE-GITHUB
  siteConfig = {
    ...siteConfig,
    url: 'https://github.sec.samsung.net',
    baseUrl: '/pages/arthur-flam/qatools/',
  }

}

  // For github.io type URLs, you would set the url and baseUrl like:



module.exports = siteConfig;
