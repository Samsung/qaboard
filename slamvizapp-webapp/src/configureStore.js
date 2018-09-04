// https://redux.js.org/recipes/configuringyourstore
import { createStore, applyMiddleware } from 'redux'
// import { compose } from 'redux'
import thunkMiddleware from 'redux-thunk'
import { composeWithDevTools } from 'redux-devtools-extension'

import loggerMiddleware from './middleware/logger'
import monitorReducersEnhancer from './enhancers/monitorReducers'

import { rootReducer } from './reducers'


export default function configureStore(preloadedState) {
  if (process.env.NODE_ENV !== 'production') {
    const middlewares = [loggerMiddleware, thunkMiddleware]
  } else {
    const middlewares = [thunkMiddleware]
  }
  const middlewareEnhancer = applyMiddleware(...middlewares)
  if (process.env.NODE_ENV !== 'production') {
    const enhancers = [middlewareEnhancer, monitorReducersEnhancer]
    const composedEnhancers = compose(...enhancers)
  } else {
    enhancers = [middlewareEnhancer]
    composedEnhancers = composeWithDevTools(...enhancers)
  }

  const store = createStore(rootReducer, preloadedState, composedEnhancers)

  if (process.env.NODE_ENV !== 'production' && module.hot) {
    module.hot.accept('./reducers', () =>
      store.replaceReducer(rootReducer)
    )
  }

  return store
}
