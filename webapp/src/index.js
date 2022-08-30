import 'react-app-polyfill/ie11';
import 'react-app-polyfill/stable';
import './polyfills'; // other polyfills

import React from "react";
import { render } from "react-dom";

import App from "./App";
import * as serviceWorker from './serviceWorker';

import configureStore from './configureStore';
import { default_store } from './reducers';

import * as Sentry from "@sentry/react";
import { BrowserTracing } from "@sentry/tracing";

const { store, persistor } = configureStore(default_store)

const renderApp = () => render(
	<App store={store} persistor={persistor} />,
	document.getElementById("root")
);

if (process.env.NODE_ENV === 'production' && (process.env.REACT_APP_SENTRY_DSN?? '' !== '')) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    integrations: [new BrowserTracing()],

    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: 0.2,
  });
}

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
