import { createRoot } from 'react-dom/client';

import App from "./App";
import { migrateFromReduxPersist } from "./stores/prefs";

// Older builds (create-react-app) may have left a service worker behind
navigator.serviceWorker?.getRegistrations().then(registrations => {
  registrations.forEach(registration => registration.unregister())
})

// Favorites, private milestones... used to be stored elsewhere
migrateFromReduxPersist();

const root = createRoot(document.getElementById('root'));
root.render(<App/>);
