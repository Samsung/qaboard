// https://redux.js.org/recipes/configuringyourstore
import { createStore, applyMiddleware } from 'redux'
import { compose } from 'redux'
import thunkMiddleware from 'redux-thunk'
import { composeWithDevTools } from 'redux-devtools-extension'

import loggerMiddleware from './middleware/logger'
import monitorReducersEnhancer from './enhancers/monitorReducers'

import { rootReducer } from './reducers'


export default function configureStore(preloadedState) {
  let is_prod = process.env.NODE_ENV === 'production'

  let middlewares = is_prod ? [thunkMiddleware] : [loggerMiddleware, thunkMiddleware]
  let middlewareEnhancer = applyMiddleware(...middlewares)
  let enhancers = is_prod ? [middlewareEnhancer] : [middlewareEnhancer, monitorReducersEnhancer]
  let composedEnhancers = is_prod ? compose(...enhancers) : composeWithDevTools(...enhancers)
  const store = createStore(rootReducer, preloadedState, composedEnhancers)

  if (process.env.NODE_ENV !== 'production' && module.hot) {
    module.hot.accept('./reducers', () =>
      store.replaceReducer(rootReducer)
    )
  }

  return store
}
