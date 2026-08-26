import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { anmeldungMerken, nachNeuerFassungSehen } from './lib/aktualisieren.js';
import { useUi } from './state/ui.js';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker never reloads the app behind the user's back – the update
// banner asks first (a chat you are typing in should not vanish).
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    useUi.getState().setSwUpdate(() => {
      void updateSW(true);
    });
  },
  onOfflineReady() {
    useUi.getState().toast('Initiative ist offline verfügbar', 'success');
  },
  onRegisteredSW(_url, registration) {
    if (registration) {
      anmeldungMerken(registration);
      nachNeuerFassungSehen(registration);
    }
  },
});
