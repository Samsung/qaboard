# QA-Board's Website and Docs
This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

### Usage with docker
To open a shell in the docker environment (add your site's overlay if you have one, e.g. `-f deployments/sirc/sirc.yml`): 
```bash
# to just build:
# docker compose -f docker-compose.yml -f development.yml build website
docker compose -f docker-compose.yml -f development.yml run -p6051:3000 --entrypoint /bin/sh website
```

Now you can do all the commands of the regular setup:

```
/website $ npm run docusaurus start -- --host 0.0.0.0 --no-open --poll
```

### Installation
To install:

```bash
yarn
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server:

```bash
$ yarn start
#=> without docker, listens to http://localhost:3000/qaboard/docs
#=> with dockeer    listens to http://localhost:6051/docs
QABOARD_DOCS_FOR_WEBAPP

# To host the docs at /docs not /qaboard/docs:
export QABOARD_DOCS_FOR_WEBAPP=1

# if you do not use docker, where it's preconfigured,
# when doing dev you often will want to use
NODE_TLS_REJECT_UNAUTHORIZED=0 CHOKIDAR_USEPOLLING=true DANGEROUSLY_DISABLE_HOST_CHECK=true HOST=0.0.0.0 PORT=3001 yarn start --host 0.0.0.0
```


### Site docs
`site-docs/<site>/` holds pages for the users of one site (e.g. how to install its site package). They are only built
into that site's web app: set `QABOARD_SITE=<site>` (e.g. in its env file, it's a build arg of the `website` image).
They get their own navbar item (the `label` in `site-docs/<site>/_site.json`), and `<SiteInstructions />` links to them
from the public pages. To preview them:
```bash
QABOARD_SITE=sirc yarn start
```

### Screenshots and clips
Pages show the web app with `<Shot id="commit/image-sbs" />`, `<Clip id="commit/image-diff" />` and
`<Compare before="..." after="..." />`, no import needed. The ids come from `docs-media/shots.yaml`, the published files
from `media.json` (see `docs-media/README.md` and `STYLE.md`). A shot that isn't published yet shows as a placeholder.

- `yarn start` loads the media from the bucket's public URL (`base_url` in `media.json`).
- `yarn build` downloads the media the pages use into `.media-cache/`, and serves them with the site.
- `QABOARD_MEDIA=placeholder yarn build` needs no network access; `QABOARD_MEDIA_BASE_URL=<mirror>` downloads from a
  mirror instead.
- `QABOARD_MEDIA_STRICT=1 yarn build` fails on shots that aren't published yet and on unused ones.

The build fails on unknown shot ids.

### Stack tabs and repository files
- `<StackPicker />` sets every stack-dependent tab group at once (`<Tabs groupId="server" queryString>`): the
  groups and values are in `src/components/stack.ts`, and the build checks the tabs against it (`plugins/stack`).
  See `STYLE.md`.
- `<RepoFile path="charts/qaboard/kind.yaml" />` shows a file of the repository in a code block. It's imported at
  build time (`plugins/snippets`), so the docs show the file as it is. CI configurations no CI of ours runs live in
  `snippets/` and are shown with `untested`.
- The website's docker image is built from the repository's root, and only gets the files listed in
  `Dockerfile.dockerignore`: add a file there before showing it.

### Command commands
#### Build

```
$ yarn build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

#### Deployment

The Website workflow (`.github/workflows/website.yml`) deploys `master` to GitHub Pages (repository Settings > Pages >
Source: GitHub Actions). The Algolia crawler updates the search index every day; to update it right after a deploy,
the workflow also starts a crawl when these repository secrets are set, from the Algolia dashboard's Crawler pages:
- `ALGOLIA_CRAWLER_ID`: the id in the crawler's URL, `crawler.algolia.com/admin/crawlers/<id>/...`
- `ALGOLIA_CRAWLER_USER_ID` and `ALGOLIA_CRAWLER_API_KEY`: Crawler > Settings (the key shows only right after you
  regenerate it, and regenerating it breaks whatever uses the old one)

The crawler's configuration lives in the Algolia dashboard. To group the results by docs section (Get started, User
guide, Project integration, Admin) and leave out what's the same on every page, its `recordExtractor` starts with:

```js
recordExtractor: ({ $, helpers }) => {
  // Headings' "#" links, tab labels, and what the docs mark data-nosearch (e.g. <RepoFile>'s footer)
  $('.hash-link, [role="tab"], [data-nosearch]').remove();
  // The docs section (src/components/DocsSwitcher), else the active navbar item ("Release notes", "Blog")
  const lvl0 =
    $('nav[aria-label="Docs sections"] a[aria-current]').attr('data-section') ||
    $('.navbar__item.navbar__link--active').last().text() ||
    'Documentation';
  return helpers.docsearch({
    recordProps: {
      lvl0: { selectors: '', defaultValue: lvl0 },
      // ...the rest as in DocSearch's Docusaurus template
```

#### Search engines and AI assistants
Google says its AI Overviews and AI Mode need nothing more than pages it can index
([AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)). The public site's
build gives search engines and AI assistants what they read (the docs built into the web app get none of it, and are
`noindex`):
- `trailingSlash: true`: GitHub Pages redirects `/docs/page` to `/docs/page/`, so links, canonical URLs, the sitemap and
  the structured data use the URL that's served.
- `sitemap.xml` lists the pages, without tags, archives and pagination, with each page's last commit as `<lastmod>`
  (the workflow checks out the whole history for it). Docs pages show the same date as "Last updated".
- The landing page describes QA-Board in schema.org JSON-LD (`SoftwareApplication`, in `src/pages/index.tsx`). Docs
  pages carry breadcrumbs, release notes a `BlogPosting` (Docusaurus's, with the trailing slash added by
  `src/components/structuredData.ts`). Only facts the pages show: no ratings, no prices.
- `llms.txt` ([llmstxt.org](https://llmstxt.org)) lists every docs page by audience with its `description`, for coding
  agents (`plugins/llms-txt`). Pages' `description` is also what search results show: one sentence on what the reader
  can do, under about 160 characters (results cut the rest).
- The landing page's tabs keep every tab's text in the HTML, `hidden` until picked: crawlers don't click.

To see how Google indexes the site and what people search to find it, add a **URL prefix** property for
`https://samsung.github.io/qaboard/` in [Search Console](https://search.google.com/search-console) and choose the
**HTML tag** method. The maintainers' token is the default in `docusaurus.config.ts`; another one goes in the repository
variable `QABOARD_GOOGLE_SITE_VERIFICATION` (Settings > Secrets and variables > Actions > Variables). Run the Website
workflow on `master`, click **Verify**, and submit `sitemap.xml`. [Bing Webmaster Tools](https://www.bing.com/webmasters) (Bing's index also serves Microsoft
Copilot) can import the property from Search Console, or verify with its own tag in
`QABOARD_BING_SITE_VERIFICATION`. Keep the tags: the property stays verified only while the tag is there. Without a
token, the build adds no tag.
