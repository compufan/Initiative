import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { AusgabenScreen } from './AusgabenScreen.js';
import './styles.css';

/**
 * Ausgaben.
 *
 * Wer hat ausgelegt, wer schuldet wem wie viel – und wie gibt man es zurück.
 * Alles rechnet in Cent; Fließkomma wäre bei Geld die falsche Zahlenart.
 *
 * Zahlungswege bewusst ohne PayPal-Geschäftskonto: Der persönliche
 * PayPal.Me-Link genügt, und über diese App läuft ohnehin kein Geld.
 */
export default defineWebModule({
  key: 'expenses',
  title: 'Ausgaben',
  description: 'Ausgaben teilen, Salden sehen und unkompliziert zurückzahlen.',
  nav: [{ path: '/ausgaben', label: 'Ausgaben', icon: '🧾', order: 35 }],
  routes: [{ path: '/ausgaben', element: createElement(AusgabenScreen) }],
});
