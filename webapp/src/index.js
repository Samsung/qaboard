import 'react-app-polyfill/ie11';
import 'react-app-polyfill/stable';
import './polyfills'; // other polyfills

import React from "react";
import {createRoot} from 'react-dom/client';

import App from "./App";
import * as serviceWorker from './serviceWorker';

import configureStore from './configureStore';
import { default_store } from './reducers';

import posthog from 'posthog-js'
import * as Sentry from "@sentry/react";
// https://docs.sentry.io/platforms/javascript/guides/react/configuration/integrations/react-router/
// https://docs.sentry.io/platforms/javascript/guides/react/features/react-router/
// TODO: migrate to react-router-v6, then improve the sentry integration
//       https://reactrouter.com/en/main/upgrading/v5#upgrade-to-react-router-v6
//       it make require moving to hooks in many places, so at this stage nextjs might make more sense...
import history from "./history";
import { BrowserTracing } from "@sentry/tracing";

const { store, persistor } = configureStore(default_store)



const renderApp = () => {
  const root = createRoot(document.getElementById('root'));
  root.render(<App store={store} persistor={persistor} />);  
};


if (process.env.NODE_ENV === 'production' && (process.env.REACT_APP_POSTHOG_TOKEN ?? '' !== '')) {
  posthog.init(process.env.REACT_APP_POSTHOG_TOKEN, { api_host: process.env.REACT_APP_POSTHOG_HOST })
}

if (process.env.NODE_ENV === 'production' && (process.env.REACT_APP_SENTRY_DSN ?? '' !== '')) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    integrations: [
      new Sentry.BrowserTracing({
        routingInstrumentation: Sentry.reactRouterV5Instrumentation(history),
      }),
      new Sentry.Replay(),
    ],
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    tracesSampleRate: 1.0,
    // Set `tracePropagationTargets` to control for which URLs distributed tracing should be enabled
    tracePropagationTargets: [/^https:\/\/qa\/api/, /.*transchip.com/],
    // Capture Replay for 10% of all sessions,
    // plus for 100% of sessions with an error
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
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
