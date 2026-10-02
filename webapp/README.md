# webapp
Web frontend for QA-Board.

## Setting up a development environment
- [install nodejs](https://nodejs.org)

- Depending on your proxies you may need to....
```
# npm config set strict-ssl false
# On Windows:
# set NODE_TLS_REJECT_UNAUTHORIZED=0
# On Windows, to deal with various errors, you may also have to delete the file package-lock.json
```

- Install the third-party packages and run the application:
```bash
cd webapp
npm install
npm start          # dev server with hot reload, on port 3000
npm test           # unit tests (vitest), in watch mode
npm run lint       # oxlint
npm run build      # production bundle, in build/
npm run analyze    # production bundle + build/stats.html to see what's inside
npm run e2e        # Playwright smoke tests, on the production build with a mocked API
``` 
By default the application will proxy API requests to *http://localhost:5151*. If you prefer something else (e.g. a development server, the production server...), set

```bash
# bash-style environment variables
export REACT_APP_QABOARD_HOST=http://your-server:port
# proxy just for for /api
export REACT_APP_QABOARD_API_HOST=http://your-server:port
```
(those names come from when we used create-react-app, they are read by *vite.config.js*)

The backend's [README](../backend) explains how to start a full dev server.


:::tip
To connect which backend you connect to (e.g. not localhost but maybe the production backend), edit _webapp/vite.config.js_.
:::

## How does it work?
- The toolchain is [Vite](https://vite.dev) (dev server and bundler), [Vitest](https://vitest.dev) (tests) and [oxlint](https://oxc.rs) (linting). Files with JSX use the `.jsx` extension.
- What is the tech stack?
  * Components: [react](https://reactjs.org/)
  * UI/CSS framework: [blueprint](http://blueprintjs.com)
  * Visualization: we leverage quality libraries like [plotly](https://plot.ly/javascript/), the [Monaco Editor](https://microsoft.github.io/monaco-editor/), or [ThreeJS](https://threejs.org/)...
- What is the entrypoint?
  * *index.html* loads *src/index.jsx*, which renders *src/App.jsx*
  * Pages (*src/routes.js*) and heavy libraries (plotly, monaco) are loaded on demand
  * Different URL routes are mapped to be rendered by different components

## Development
- You can change in *vite.config.js* which backend the application should talk to (defaults to *http://localhost:5151*). It is useful if the features you are developping require backend API changes.
- It's best to install the [react developper tools](https://chrome.google.com/webstore/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi), maybe even the [redux DevTools](https://chrome.google.com/webstore/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd).

## Main components
- *CiCommitList.jsx*: lists the latests commits for a given project
- *CiCommitResults.jsx*: lists the outputs for a given commit
- *viewers/OutputCard.jsx*: wraps the output visualizations (images, pointclouds, 6dof....)

## Data model
It comes straight from the backend API and flows down the components tree.

> Take a look at the react developper tools to investigate what happens.

Basically it's `project > commit > batch > output`, with lots of metadata. **TODO:** spec it!


## Contributing
Known follow-ups are tracked in [TODO.md](TODO.md).

Help is welcome!
