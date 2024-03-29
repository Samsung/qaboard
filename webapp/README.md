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
npm start
#=> listenning on port 3000
``` 
By default the application will proxy API requests to *http://localhost:5151*. If you prefer something else (e.g. a development server, the production server...), set

```bash
# bash-style environment variables
export REACT_APP_QABOARD_HOST=http://your-server:port
# proxy just for for /api
export REACT_APP_QABOARD_API_HOST=http://your-server:port
```

The backend's [README](../backend) explains how to start a full dev server.


## How does it work?
- This project was started with [Create React App](https://github.com/facebookincubator/create-react-app). [Go to their README](https://github.com/facebookincubator/create-react-app/blob/master/packages/react-scripts/template/README.md) to learn a lot about the dev environment (package manager, testing, proxying, formatting, linting, compilation, javascript features...)
- What is the tech stack?
  * Components: [react](https://reactjs.org/)
  * UI/CSS framework: [blueprint](http://blueprintjs.com)
  * Visualization: we leverage quality libraries like [plotly](https://plot.ly/javascript/), the [Monaco Editor](https://microsoft.github.io/monaco-editor/), or [ThreeJS](https://threejs.org/)...
- What is the entrypoint?
  * *index.js* directly loads *./src/App.js*
  * Different URL routes are mapped to be rendered by different components

## Development
- You can change in *src/setupProxy.js* which backend the application should talk to (defaults to production, *http://qa:5001*). It is useful if the features you are developping require backend API changes.
- It's best to install the [react developper tools](https://chrome.google.com/webstore/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi), maybe even the [redux DevTools](https://chrome.google.com/webstore/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd).

## Main components
- *CiCommitList.js*: lists the latests commits for a given project
- *CiCommitResults.js*: lists the outputs for a given commit
- *viewers/OutputCard.js*: wraps the output visualizations (images, pointclouds, 6dof....)

## Data model
It comes straight from the backend API and flows down the components tree.

> Take a look at the react developper tools to investigate what happens.

Basically it's `project > commit > batch > output`, with lots of metadata. **TODO:** spec it!


## Contributing
Help is welcome!
