import React from "react";
import { render } from "react-dom";

import App from "./App";
import registerServiceWorker from "./registerServiceWorker";

import configureStore from './configureStore';
import { default_store } from './reducers';


const { store, persistor } = configureStore(default_store)

const renderApp = () => render(
	<App store={store} persistor={persistor} />,
	document.getElementById("root")
);


// https://redux.js.org/recipes/configuringyourstore
if (process.env.NODE_ENV !== 'production' && module.hot) {
  module.hot.accept('./App', () => {
    renderApp()
  })
} else {
  registerServiceWorker();
}

renderApp()
