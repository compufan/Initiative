import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
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
    if (registration) nachNeuerFassungSehen(registration);
  },
});

/**
 * Regelmäßig nachsehen, ob es eine neue Fassung gibt.
 *
 * Der Browser prüft das von sich aus nur beim Laden der Seite. In einem
 * Browser-Tab passiert das ständig – als installierte App aber praktisch nie:
 * Die liegt tage- oder wochenlang im App-Umschalter und wird nur ein- und
 * ausgeblendet, ohne je neu zu laden. Genau so kam es dazu, dass eine behobene
 * Sache im Browser sichtbar war und in der installierten App nicht.
 *
 * Zwei Anlässe zum Nachsehen, und der zweite ist der wichtigere:
 *
 * 1. Alle 30 Minuten, solange die App vorn ist.
 * 2. Immer dann, wenn sie wieder nach vorn geholt wird. Das ist der Moment, in
 *    dem jemand sie benutzen will – und der einzige, den eine installierte App
 *    zuverlässig erlebt.
 *
 * Beides fragt nur nach; ob wirklich neu geladen wird, entscheidet weiterhin
 * der Anwender über das Band oben. Ein Chat, in den gerade jemand tippt, soll
 * nicht unter den Fingern verschwinden.
 */
function nachNeuerFassungSehen(registration: ServiceWorkerRegistration) {
  const ABSTAND = 30 * 60 * 1000;
  let zuletzt = Date.now();

  const nachsehen = () => {
    zuletzt = Date.now();
    // Ohne Netz scheitert das – dann eben beim nächsten Anlass.
    void registration.update().catch(() => {});
  };

  window.setInterval(nachsehen, ABSTAND);

  document.addEventListener('visibilitychange', () => {
    // Nicht bei jedem Umschalten: Wer zwischen zwei Apps hin- und herwischt,
    // soll keine Anfrage je Wisch auslösen.
    if (document.visibilityState === 'visible' && Date.now() - zuletzt > 60_000) nachsehen();
  });

  window.addEventListener('online', nachsehen);
}
