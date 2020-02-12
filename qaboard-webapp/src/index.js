import 'react-app-polyfill/ie11';
import 'react-app-polyfill/stable';
import './polyfills'; // other polyfills

import React from "react";
import { render } from "react-dom";

import App from "./App";
import * as serviceWorker from './serviceWorker';

import configureStore from './configureStore';
import { default_store } from './reducers';


const { store, persistor } = configureStore(default_store)

const renderApp = () => render(
	<App store={store} persistor={persistor} />,
	document.getElementById("root")
);


if (process.env.NODE_ENV !== 'production' && module.hot) {
  // https://www.npmjs.com/package/why-did-you-update
  // const { whyDidYouUpdate } = require('why-did-you-update');
  // whyDidYouUpdate(React);
 
 // https://redux.js.org/recipes/configuringyourstore
  module.hot.accept('./App', () => {
    renderApp()
  })
} else {
  serviceWorker.unregister();
}

renderApp()
