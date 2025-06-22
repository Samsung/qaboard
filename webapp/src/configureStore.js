// https://redux.js.org/recipes/configuringyourstore
import { createStore, applyMiddleware } from 'redux'
import { compose } from 'redux'
import { thunk } from 'redux-thunk'

// https://github.com/rt2zz/redux-persist
import { persistStore, persistReducer } from 'redux-persist'
import localForage from "localforage";
// import storage from 'redux-persist/lib/storage' // defaults to localStorage for web and AsyncStorage for react-native
// import autoMergeLevel2 from 'redux-persist/lib/stateReconciler/autoMergeLevel2';

import * as Sentry from "@sentry/react";

import { composeWithDevTools } from 'redux-devtools-extension/developmentOnly'
import loggerMiddleware from './middleware/logger'
import monitorReducersEnhancer from './enhancers/monitorReducers'

import { rootReducer } from './reducers'


// https://github.com/rt2zz/redux-persist/blob/master/src/types.js#L13-L27
const persistConfig = {
  key: 'root',
  transforms: [
  ],
  storage: localForage,
  whitelist: [
    'projects',
    'tuning',
    'user',
    // we may not want to store any of the commit.$id.batches.outputs.
    // TODO: look into
    // https://github.com/rt2zz/redux-persist
    // https://github.com/edy/redux-persist-transform-filter
    // 'commits',
  ],
  blacklist: ['selected'],
  // stateReconciler: autoMergeLevel2,
}

const sentryReduxEnhancer = Sentry.createReduxEnhancer({});


export default function configureStore(preloadedState) {
  let is_production = process.env.NODE_ENV === 'production'
  // let is_production = false

  let middlewares = is_production ? [thunk] : [loggerMiddleware, thunk]
  let middlewareEnhancer = applyMiddleware(...middlewares)
  let enhancers = is_production ? [middlewareEnhancer] : [middlewareEnhancer, monitorReducersEnhancer]
  let composedEnhancers = (is_production || !window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) ? compose(...enhancers, sentryReduxEnhancer) : composeWithDevTools(...enhancers)

  const persistedReducer = persistReducer(persistConfig, rootReducer)
  const store = createStore(persistedReducer, preloadedState, composedEnhancers)

  if (process.env.NODE_ENV !== 'production' && module.hot) {
    module.hot.accept('./reducers', () =>
      store.replaceReducer(persistedReducer)
    )
  }

  let persistor = persistStore(store)

  return {store, persistor}
}
