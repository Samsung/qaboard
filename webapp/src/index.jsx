import { createRoot } from 'react-dom/client';

import App from "./App";
import configureStore from './configureStore';
import { default_store } from './reducers';

const { store, persistor } = configureStore(default_store)

// Older builds (create-react-app) may have left a service worker behind
navigator.serviceWorker?.getRegistrations().then(registrations => {
  registrations.forEach(registration => registration.unregister())
})

const root = createRoot(document.getElementById('root'));
root.render(<App store={store} persistor={persistor} />);
