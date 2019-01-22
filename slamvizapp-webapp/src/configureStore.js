// https://redux.js.org/recipes/configuringyourstore
import { createStore, applyMiddleware } from 'redux'
import { compose } from 'redux'
import thunkMiddleware from 'redux-thunk'

// https://github.com/rt2zz/redux-persist
import { persistStore, persistReducer } from 'redux-persist'
import localForage from "localforage";
// import storage from 'redux-persist/lib/storage' // defaults to localStorage for web and AsyncStorage for react-native
// import autoMergeLevel2 from 'redux-persist/lib/stateReconciler/autoMergeLevel2';

import { composeWithDevTools } from 'redux-devtools-extension'
import loggerMiddleware from './middleware/logger'
import monitorReducersEnhancer from './enhancers/monitorReducers'

import { rootReducer } from './reducers'


// https://github.com/rt2zz/redux-persist/blob/master/src/types.js#L13-L27
const persistConfig = {
  key: 'root',
  storage: localForage,
  whitelist: [
    // 'commits',
    'projects',
  ],
  blacklist: ['selected'],
  // stateReconciler: autoMergeLevel2,
}


export default function configureStore(preloadedState) {
  let is_prod = process.env.NODE_ENV === 'production'

  let middlewares = is_prod ? [thunkMiddleware] : [loggerMiddleware, thunkMiddleware]
  let middlewareEnhancer = applyMiddleware(...middlewares)
  let enhancers = is_prod ? [middlewareEnhancer] : [middlewareEnhancer, monitorReducersEnhancer]
  let composedEnhancers = is_prod ? compose(...enhancers) : composeWithDevTools(...enhancers)

  // filter(['commits', 'projects'])
  // merge X levels...
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
