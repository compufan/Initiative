/**
 * Die Zurück-Taste des Handys schliesst den obersten offenen Dialog.
 *
 * Auf einem Handy ist Zurück die Geste für „einen Schritt zurück“, und ein
 * offener Dialog IST ein Schritt. Ohne das ist die Taste eine Falle: Man tippt
 * auf Plus, will das Blatt wieder loswerden, drückt Zurück – und steht in der
 * Chatübersicht, während der halb ausgefüllte Termin weg ist.
 *
 * # Warum das zentral steht und nicht in jedem Dialog
 *
 * Der erste Versuch legte den Verlaufseintrag im Dialog selbst an und nahm ihn
 * beim Schliessen zurück. Das ging an zwei Stellen schief, und beide sind
 * lehrreich:
 *
 * 1. React führt im Entwicklungsmodus jeden Effekt absichtlich zweimal aus –
 *    auf, zu, wieder auf. Der zurückgenommene Eintrag traf als `popstate`
 *    nachträglich ein und schloss das gerade geöffnete Blatt sofort wieder.
 *
 * 2. Beim Wechsel von einem Blatt zum nächsten („Mehr hinzufügen“ → „Foto“)
 *    schliesst das erste und öffnet das zweite im selben Zug. Das erste nahm
 *    dabei den Eintrag des zweiten weg – und schloss damit das Blatt, das
 *    gerade erst aufgegangen war. Vier Browser-Tests haben das gefunden.
 *
 * Beide Fälle haben dieselbe Wurzel: Ein einzelner Dialog kann nicht wissen,
 * ob nach ihm noch einer offen ist. Also führt eine Stelle Buch.
 *
 * # Wie es funktioniert
 *
 * Es gibt **genau einen** Verlaufseintrag, solange irgendein Dialog offen ist –
 * nicht einen je Dialog. Der Abgleich zwischen „wie viele sind offen“ und „liegt
 * ein Eintrag“ geschieht aufgeschoben und zusammengefasst, sodass ein Wechsel
 * im selben Durchgang gar nicht erst auffällt.
 */

type Schliesser = () => void;

const stapel: Schliesser[] = [];
let eintragLiegt = false;
let abgleichGeplant = false;

const KENNUNG = 'initiativeDialog';

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    // Unser Eintrag ist damit fort – ob wir ihn selbst zurückgenommen haben
    // oder der Anwender gedrückt hat, ist an dieser Stelle einerlei.
    eintragLiegt = false;
    const oben = stapel[stapel.length - 1];
    // Nur den obersten schliessen. Liegt darunter noch einer, legt der
    // Abgleich gleich einen frischen Eintrag nach.
    if (oben) oben();
  });
}

/**
 * Einen offenen Dialog anmelden. Gibt die Abmeldung zurück.
 *
 * `schliesser` wird gerufen, wenn die Zurück-Taste diesen Dialog trifft.
 */
export function dialogAnmelden(schliesser: Schliesser): () => void {
  stapel.push(schliesser);
  abgleichen();
  return () => {
    const index = stapel.lastIndexOf(schliesser);
    if (index >= 0) stapel.splice(index, 1);
    abgleichen();
  };
}

function abgleichen(): void {
  if (abgleichGeplant || typeof window === 'undefined') return;
  abgleichGeplant = true;
  // Ein Wimpernschlag Aufschub. In dieser Zeit hat sich ein Wechsel von einem
  // Blatt zum nächsten – und Reacts doppelter Effektlauf – längst erledigt,
  // und es bleibt genau eine Änderung übrig statt eines Hin und Her.
  window.setTimeout(() => {
    abgleichGeplant = false;
    const gebraucht = stapel.length > 0;
    if (gebraucht && !eintragLiegt) {
      window.history.pushState({ [KENNUNG]: true }, '');
      eintragLiegt = true;
    } else if (!gebraucht && eintragLiegt) {
      eintragLiegt = false;
      // Nur zurück, wenn unser Eintrag noch obenauf liegt.
      //
      // Manche Dialoge schliessen sich UND navigieren im selben Zug – „Neuer
      // Chat“ etwa öffnet danach den Chat. Dann hat die App über unseren
      // Eintrag einen eigenen gelegt, und ein blindes `back()` würde nicht
      // unseren wegräumen, sondern die Navigation zurücknehmen: Der Chat ging
      // auf und sofort wieder zu. Genau das haben zehn Browser-Tests gemeldet.
      //
      // Bleibt unser Eintrag in so einem Fall unter der neuen Seite liegen,
      // ist das harmlos: Er zeigt auf dieselbe Adresse wie die Seite davor,
      // ein Zurück landet also dort, wo der Anwender es erwartet.
      const stand = window.history.state as Record<string, unknown> | null;
      if (stand?.[KENNUNG]) window.history.back();
    }
  }, 0);
}

/** Nur für Tests: den Buchführungsstand zurücksetzen. */
export function dialogVerlaufZuruecksetzen(): void {
  stapel.length = 0;
  eintragLiegt = false;
}
