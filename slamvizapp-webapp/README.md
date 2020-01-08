# slamvizapp-webapp
Web application to display results from various algorithmic projects.

## Setting up a development environment
- [install nodejs](https://nodejs.org)

```
# depending on your proxies you may need to....
# npm config set strict-ssl false
# For windows:
# set NODE_TLS_REJECT_UNAUTHORIZED=0
# You may also have to delete the file package-lock.json
npm install
npm start
#=> listenning on port 3000
``` 

Also:
- You can change in *src/setupProxy.js* which backend the application should talk to (default: qa:5001). It is useful if you are developping on the backend (for example on: planet31:9002).
- It's best to install the react developper tools.

## How does it work?
- This project was bootstrapped with [Create React App](https://github.com/facebookincubator/create-react-app). [Go to their README](https://github.com/facebookincubator/create-react-app/blob/master/packages/react-scripts/template/README.md) to learn a lot about the dev environment (package manager, testing, proxying, formatting, linting, compilation, javascript features...)
- What is the tech stack?
  * Components: [react](https://reactjs.org/)
  * UI/CSS framework: [blueprint](http://blueprintjs.com)
  * Visualization: mainly [plotly](https://plot.ly/javascript/)
- What is the entrypoint?
  * *index.js* directly loads *./src/App.js*
  * Different URL routes are mapped to be rendered by different components

## Main components
- *CiCommitList.js*: lists the latests commits for a given project
- *CiCommitResults.js*: lists the outputs for a given commit
- *OutputCard.js*: custom output visualization (images, pointclouds, 6dof....)

## Data model
It comes straight from the backend API and flows down the components tree.

Take a look at the react developper tools to be sure of what happens.


## Contributing
Help is welcome!
