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

Using SSH:

```
$ USE_SSH=true yarn deploy
```

Not using SSH:

```
$ GIT_USER=<Your GitHub username> yarn deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
