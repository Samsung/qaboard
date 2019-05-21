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

const siteConfig = {
  title: 'qatools', // Title for your website.
  tagline: 'QA + Algorithms',
  url: 'http://qa-docs', // Your website URL
  baseUrl: '/', // Base URL for your project */
  // url: 'https://qa', // Your website URL
  // baseUrl: '/docs', // Base URL for your project */
  // For github.io type URLs, you would set the url and baseUrl like:
  //   url: 'https://facebook.github.io',
  //   baseUrl: '/test-site/',

  // Used for publishing and more
  projectName: 'qatools',
  organizationName: 'Samsung',
  // For top-level user or org sites, the organization is still the same.
  // e.g., for the https://JoelMarcey.github.io site, it would be set like...
  //   organizationName: 'JoelMarcey'

  // For no header links in the top nav bar -> headerLinks: [],
  headerLinks: [
    {doc: 'introduction', label: 'Docs'},
  //  {doc: 'doc4', label: 'API'},
    {page: 'help', label: 'Help'},
  //  {blog: true, label: 'Blog'},
  ],

  // If you have users set above, you add it here:
  users,

  /* path to images for header/footer */
  // https://commons.wikimedia.org/wiki/File:Twemoji_1f429.svg
  headerIcon: 'img/twemoji_poodle.svg',
  footerIcon: 'img/twemoji_poodle.svg',
  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',


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
  copyright: `Samsung ©${new Date().getFullYear()}`,

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

  // Show documentation's last contributor's name.
  // enableUpdateBy: true,

  // Show documentation's last update time.
  // enableUpdateTime: true,

  // You may provide arbitrary config keys to be used as needed by your
  // template. For example, if you need your repo's URL...
  repoUrl: 'https://gitlab-srv/common-infrastructure/qatools',
};

module.exports = siteConfig;
