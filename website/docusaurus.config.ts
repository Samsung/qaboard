import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import fs from 'fs';
import path from 'path';

// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion
const is_for_webapp = process.env.QABOARD_DOCS_FOR_WEBAPP === "true"

// Docs for the users of one site, in site-docs/<site>/, only built into that site's web app (QABOARD_SITE, see the Dockerfile).
// site-docs/<site>/_site.json gives its name and its navbar label. Without QABOARD_SITE, nothing changes.
type Site = {id: string, name: string, label: string, path: string}
function loadSite(id?: string): Site | null {
  if (!id)
    return null
  const site_dir = path.join(__dirname, 'site-docs', id)
  if (!/^[a-z0-9_-]+$/.test(id) || !fs.existsSync(site_dir)) {
    console.warn(`[WARNING] QABOARD_SITE=${id}: no docs in site-docs/${id}/, building without site docs`)
    return null
  }
  const meta = JSON.parse(fs.readFileSync(path.join(site_dir, '_site.json'), 'utf8'))
  return {id, name: meta.name ?? id, label: meta.label ?? `At ${meta.name ?? id}`, path: site_dir}
}
const site = loadSite(process.env.QABOARD_SITE)

// The maintainers' contact, for teams who want help to get started (the landing page's "Get in touch", the footer, the
// announcement bar). Not in the builds for a site's own web app: its users get help from their site's admins.
const contact = site ? null : 'arthur@fl.am'

// The public website (samsung.github.io/qaboard), not the docs built into a web app: only it gets the search engines'
// verification tags, structured data and llms.txt. See website/README.md, "Search engines and AI assistants"
const is_public_site = !is_for_webapp && !site
// Search Console and Bing Webmaster Tools verify the site with a <meta> tag. The tokens are public (they're in every
// page): Google's is the maintainers' property for samsung.github.io/qaboard/, the repository variables override them
// in the Website workflow. Unset, no tag
const siteVerifications = [
  {name: 'google-site-verification', content: process.env.QABOARD_GOOGLE_SITE_VERIFICATION || 'uvzYbXRgph40vlzupFah6u0HTrc-ucIsqe2kJFijN58'},
  {name: 'msvalidate.01', content: process.env.QABOARD_BING_SITE_VERIFICATION},
].filter(({content}) => is_public_site && content)

import {themes as prismThemes} from 'prism-react-renderer';

// Screenshots and clips (<Shot>, <Clip>, <Compare>): see docs-media/README.md and plugins/media/
const {mediaStaticDirectories, socialCardImage} = require('./plugins/media/config');
const mediaRemark = require('./plugins/media/remark');
// Repository files in code blocks (<RepoFile path="...">): see plugins/snippets/
const repoFileRemark = require('./plugins/snippets/remark');

// Docs URLs, relative to the baseUrl. For the web app, the docs are served at the root of the /docs/ baseUrl
const docsPath = (id: string) => is_for_webapp ? `/${id}` : `/docs/${id}`

// Pages that moved or were removed: their old URLs are in search engines, bookmarks, and old versions of the web app
const redirects = [
  {from: 'backend-admin/host-upgrades', to: 'backend-admin/deployment#host-maintenance'},
  {from: 'backend-admin/getting-SSL-certiticates-from-IT', to: 'deploy#using-ssl--hosting-behind-a-reverse-proxy'},
  {from: 'dag-pipelines', to: 'batches-running-on-multiple-inputs'},
  {from: 'tuning-workflows', to: 'tuning-from-the-webapp#other-tuning-workflows'},
  // the page's file name, linked by the web app's LSF hints (the anchor is kept)
  {from: 'lsf-cluster-integration', to: 'lsf-integration'},
  // The product tour became the user guide's walkthrough
  {from: 'tour', to: 'user-guide/first-review'},
  // Merged into visualizations
  {from: 'creating-and-viewing-outputs-files', to: 'visualizations#output-files'},
].map(({from, to}) => ({from: docsPath(from), to: docsPath(to)}))

// The mark: a new run (solid) laid over its reference (outlined). The favicons in img/favicon/ and webapp/public/ are
// made from it, with thicker strokes at 16 and 32 px
const logo = {
  alt: 'QA-Board',
  src: '/img/qaboard-logo.svg',
  srcDark: '/img/qaboard-logo-dark.svg',
}


/** @type {import('@docusaurus/types').Config} */
let config: Config = {
  title: 'QA-Board',
  customFields: {is_for_webapp, contact, ...(site ? {site: {id: site.id, name: site.name, label: site.label}} : {})},
  tagline: "Tests tell you it runs. QA-Board shows you it's better.",
  url: 'https://samsung.github.io',
  // GitHub Pages redirects /docs/page to /docs/page/ (its folder): use that URL in links, canonical URLs and the sitemap,
  // so that search engines index the URL that's served. The web app serves its docs build itself: no change there
  trailingSlash: is_for_webapp ? undefined : true,
  // The docs inside a web app copy the public site: keep them out of search engines, in case a server is public
  noIndex: is_for_webapp,
  headTags: [
    ...siteVerifications.map(attributes => ({tagName: 'meta', attributes})),
    // The llms.txt that lists every page (plugins/llms-txt), as the llms.txt proposal suggests
    ...(is_public_site ? [{tagName: 'link', attributes: {rel: 'describedby', type: 'text/markdown', href: '/qaboard/llms.txt'}}] : []),
  ],
  onBrokenLinks: 'throw',
  future: {
    // Docusaurus Faster: Rspack, SWC and LightningCSS (@docusaurus/faster), the default in Docusaurus v4
    faster: true,
    // The v4 changes we're ready for. Not yet: mdx1CompatDisabledByDefault (our pages use `{#id}` heading ids and
    // `:::tip Title` admonitions), useCssCascadeLayers and siteStorageNamespacing (resets readers' saved theme and tabs)
    v4: {
      fasterByDefault: true,
      removeLegacyPostBuildHeadAttribute: true,
    },
  },
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  // https://realfavicongenerator.net/
  favicon: 'img/favicon/favicon-32x32.png',
  projectName: 'qaboard', // Usually your repo name.
  organizationName: 'Samsung',
  baseUrl: '/qaboard/',
  deploymentBranch: 'gh-pages',
  // In local mode (builds), the media downloaded from website/media.json, served at <baseUrl>media/
  // The JSON schemas of qaboard.yaml and the batch files, for editors: <baseUrl>qaboard.schema.json, <baseUrl>batches.schema.json
  staticDirectories: ['static', '../qaboard/schemas', ...mediaStaticDirectories()],

  presets: [
    [
      'classic', {
        docs: {
          // In the web app (at /docs) the docs are the site's root
          routeBasePath: is_for_webapp ? '/' : 'docs',
          sidebarPath: './sidebars.ts',
          remarkPlugins: [mediaRemark, repoFileRemark],
          // Please change this to your repo.
          editUrl: 'https://github.com/Samsung/qaboard/edit/master/website/docs',
          // "Last updated on" at the bottom of each page, and the sitemap's <lastmod>, from git. The Website workflow
          // checks out the whole history for it: in a shallow clone, every page would get the last commit's date.
          // Not in the web app's image, built without git
          showLastUpdateTime: !is_for_webapp,
        },
        blog: {
          showReadingTime: true,
          remarkPlugins: [mediaRemark, repoFileRemark],
          // Please change this to your repo.
          editUrl: 'https://github.com/Samsung/qaboard/edit/master/website/blog',
        },
        pages: {
          remarkPlugins: [mediaRemark, repoFileRemark],
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
        sitemap: {
          // Google ignores changefreq and priority, and uses lastmod when it's accurate (the docs' last commit)
          lastmod: 'date',
          changefreq: null,
          priority: null,
          // Lists of links, not pages people search for: tags, authors, archives, pagination, the search page
          ignorePatterns: ['/qaboard/blog/tags/**', '/qaboard/blog/authors/**', '/qaboard/*/archive/**', '/qaboard/release-notes/page/**', '/qaboard/search/**'],
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    ['@docusaurus/plugin-client-redirects', {redirects}],
    // Downloads the media the pages use (or not, see QABOARD_MEDIA), and checks the shot ids. PNG masters only for `png`
    ['./plugins/media', {png: ['landing/social-card']}],
    // Checks the stack picker's tabs (src/components/stack.ts)
    './plugins/stack',
    // `import text from '<file>?raw'`, for <RepoFile>
    './plugins/snippets',
    // The latest release note's highlights, for the landing page
    './plugins/latest-release-note',
    // <baseUrl>llms.txt: the docs pages by audience, with their description, for coding agents and LLM tools
    ...(is_public_site ? [['./plugins/llms-txt', {
      title: 'QA-Board',
      summary: "QA-Board is an open-source (Apache 2.0), self-hosted quality tracking platform. Every change runs on a test set, and QA-Board puts its outputs (images, videos, point clouds, plots, flame graphs, benchmarks, test reports, logs) and metrics next to a reference's, for the people and the coding agents who review it.",
      details: [
        'The `qa` command line (the `qaboard` Python package) wraps your code, runs it on batches of inputs, locally, on clusters or in CI, and saves the results. The server (Docker Compose or a Helm chart) stores them, and its web app compares every commit with the reference branch or a milestone.',
        'Coding agents: to set up QA-Board or integrate a project, read [Integrate with a coding agent](https://samsung.github.io/qaboard/docs/agents/) first, then the quickstart. The source code is at https://github.com/Samsung/qaboard. The JSON schemas of qaboard.yaml and the batch files are under Optional.',
      ],
      // The sidebars, one per audience (sidebars.ts), as in the navbar
      sections: [
        {sidebar: 'start', label: 'Get started: where to start, try it, use cases'},
        {sidebar: 'userGuide', label: 'User guide: reviewing results in the web app'},
        {sidebar: 'docs', label: "Project integration: sending a project's results with qa, qaboard.yaml, runners, CI"},
        {sidebar: 'admin', label: 'Admin: running the server'},
      ],
      optional: [
        {title: 'qaboard.yaml JSON schema', href: 'qaboard.schema.json', description: "The project configuration's schema, for editors and agents"},
        {title: 'Batch files JSON schema', href: 'batches.schema.json', description: 'The schema of the batch files qa batch runs'},
        {title: 'Metrics file JSON schema', href: 'metrics.schema.json', description: 'The schema of qa/metrics.yaml, which describes the metrics runs return'},
        {title: 'Release notes', href: 'release-notes/', description: "What's new, month by month"},
      ],
    }]] : []),
    // site-docs/<site>/, with an autogenerated sidebar (no sidebarPath)
    ...(site ? [['@docusaurus/plugin-content-docs', {id: 'site', path: site.path, routeBasePath: 'site', remarkPlugins: [mediaRemark, repoFileRemark]}]] : []),
    [
      // The release notes, also shown in the web app's "What's new" panel. See CLAUDE.md
      '@docusaurus/plugin-content-blog', {
        id: 'release-notes',
        path: 'release-notes',
        routeBasePath: 'release-notes',
        blogTitle: 'QA-Board release notes',
        blogDescription: "What's new in QA-Board: highlights and changes, month by month",
        blogSidebarTitle: 'All release notes',
        blogSidebarCount: 'ALL',
        postsPerPage: 10,
        showReadingTime: false,
        onUntruncatedBlogPosts: 'ignore',
        remarkPlugins: is_for_webapp ? [require('./src/remark/docs-links.js')] : [],
        editUrl: 'https://github.com/Samsung/qaboard/edit/master/website/release-notes',
        feedOptions: {
          type: 'all',
          title: 'QA-Board release notes',
          description: "What's new in QA-Board",
          limit: 24,
        },
      },
    ],
  ],

  themeConfig: {
      // The social card (docs-media/shots/landing.spec.ts: landing/social-card) once it's published, else the old one
      image: socialCardImage(__dirname) ?? "img/share-github.png",
      docs: {
        sidebar: {hideable: true},
      },
      navbar: {
        title: 'QA-Board',
        logo,
        hideOnScroll: true,
        items: [
          // The landing page (src/pages/index.tsx), in both builds: /qaboard/ and, for the web app, /docs/
          {to: '/', label: 'Product', position: 'left', activeBaseRegex: '^/(qaboard|docs)/?$'},
          // Get started, then one sidebar per audience: people looking at results, project integration, server admins
          {
            type: 'dropdown',
            label: 'Docs',
            // Where to start: one section per job, the same as the landing page's entry points
            to: '/docs/get-started/overview',
            position: 'left',
            items: [
              {type: 'docSidebar', sidebarId: 'start', label: 'Get started'},
              {type: 'docSidebar', sidebarId: 'userGuide', label: 'User guide: look at results'},
              {type: 'docSidebar', sidebarId: 'docs', label: "Project integration: send your project's results"},
              {type: 'docSidebar', sidebarId: 'admin', label: 'Admin: run the server'},
            ],
          },
          ...(site ? [{type: 'docSidebar', docsPluginId: 'site', sidebarId: 'defaultSidebar', label: site.label, position: 'left'} as const] : []),
          // The generated index of the "Use cases" category (sidebars.ts)
          {to: '/docs/use-cases', label: 'Use cases', position: 'left'},
          // Where QA-Board is going: a docs page outside the sidebars, for every audience
          {type: 'doc', docId: 'roadmap', label: 'Roadmap', position: 'left'},
          {to: '/release-notes', label: 'Release notes', position: 'left'},
          {
            to: '/blog',
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
            title: 'Get started',
            items: [
              {label: 'Where to start', to: '/docs/get-started/overview'},
              {label: 'Quickstart', to: '/docs/get-started/quickstart'},
              {label: 'Your project on QA-Board', to: '/docs/get-started/tutorial'},
              {label: 'Your first review', to: '/docs/user-guide/first-review'},
              {label: 'Use cases', to: '/docs/use-cases'},
            ],
          },
          {
            title: 'Docs',
            items: [
              {label: 'User guide', to: '/docs/user-guide/overview'},
              {label: 'Project integration', to: '/docs/introduction'},
              {label: 'With a coding agent', to: '/docs/agents'},
              {label: 'Server admin', to: '/docs/deploy'},
            ],
          },
          {
            title: "What's new",
            items: [
              {label: 'Release notes', to: '/release-notes'},
              {label: 'RSS feed', href: 'pathname:///release-notes/rss.xml'},
              {label: 'Roadmap', to: '/docs/roadmap'},
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
              ...(contact ? [{label: 'Get in touch', to: '/#get-in-touch'}] : []),
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
        additionalLanguages: ['nginx', 'bash', 'python'],
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
      announcementBar: {
        // A new id shows the bar again to readers who closed the old one
        id: contact ? 'get-started-with-us' : 'supportus',
        content: contact
          ? `Setting up QA-Board for your team? Write to the maintainers: <a href="mailto:${contact}?subject=QA-Board">${contact}</a>`
          : 'If you like QA-Board, give it a star on <a target="_blank" rel="noopener noreferrer" href="https://github.com/Samsung/qaboard">GitHub</a>.',
        backgroundColor: '#1064d3',
        textColor: 'white',
      },
      algolia: {
        appId: 'Q9000IO3JM',
        apiKey: '7a265918a0d970f8f3f36e7fbb70f720',
        indexName: 'samsung_qaboard',
        replaceSearchResultPathname: !is_for_webapp ? undefined : {
          from: '/qaboard/docs/', // or as RegExp: /\/docs\//
          to: '/',
        },
      }
    } satisfies Preset.ThemeConfig,
};


if (is_for_webapp) {
  // build for the app at /docs
  config = {
    ...config,
    url: process.env.QABOARD_URL as string,
    baseUrl: '/docs/',
  }
}

module.exports = config;
