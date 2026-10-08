// https://redux.js.org/recipes/configuringyourstore
import { createStore, applyMiddleware } from 'redux'
import { compose as reduxCompose } from 'redux'
import { thunk } from 'redux-thunk'

// https://github.com/rt2zz/redux-persist
import { persistStore, persistReducer } from 'redux-persist'
import localForage from "localforage";
// import storage from 'redux-persist/lib/storage' // defaults to localStorage for web and AsyncStorage for react-native
// import autoMergeLevel2 from 'redux-persist/lib/stateReconciler/autoMergeLevel2';

import * as Sentry from "@sentry/react";

import { rootReducer } from './reducers'
import { dateRangesTransform } from './dateRange'


// https://github.com/rt2zz/redux-persist/blob/master/src/types.js#L13-L27
const persistConfig = {
  key: 'root',
  transforms: [
    dateRangesTransform,
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
  // https://github.com/reduxjs/redux-devtools/tree/main/extension#11-basic-store
  const compose = (!import.meta.env.PROD && window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) || reduxCompose
  const enhancers = compose(applyMiddleware(thunk), sentryReduxEnhancer)

  const persistedReducer = persistReducer(persistConfig, rootReducer)
  const store = createStore(persistedReducer, preloadedState, enhancers)
  const persistor = persistStore(store)
  return {store, persistor}
}
