/**
 * Nach einer neuen Fassung der App sehen – von allein und auf Knopfdruck.
 *
 * Der Browser prüft das von sich aus nur beim Laden der Seite. In einem
 * Browser-Tab passiert das ständig – als installierte App aber praktisch nie:
 * Die liegt tage- oder wochenlang im App-Umschalter und wird nur ein- und
 * ausgeblendet, ohne je neu zu laden. Genau so kam es dazu, dass eine behobene
 * Sache im Browser sichtbar war und in der installierten App nicht.
 *
 * Eigenes Modul und nicht in `main.tsx`, weil sonst ein Kreis entstünde:
 * `main` rendert `App`, `App` enthält die Einstellungen, und die brauchen den
 * Knopf. ESM kommt damit zurecht, aber es ist die Art von Abhängigkeit, die
 * beim nächsten Umbau jemandem auf die Füsse fällt.
 */

let anmeldung: ServiceWorkerRegistration | null = null;

export function anmeldungMerken(registration: ServiceWorkerRegistration): void {
  anmeldung = registration;
}

/**
 * Regelmässig nachsehen. Zwei Anlässe, und der zweite ist der wichtigere:
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
export function nachNeuerFassungSehen(registration: ServiceWorkerRegistration): void {
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

/**
 * Von Hand nachsehen.
 *
 * Das automatische Nachsehen oben reicht im Alltag – aber nicht, wenn man
 * gerade auf eine bestimmte Änderung wartet und wissen will, ob sie schon da
 * ist. Dann will man einen Knopf und keine halbe Stunde Geduld.
 *
 * Rückgabe: `true`, wenn danach etwas zum Aktualisieren bereitliegt. Das
 * Anwenden macht weiterhin das Band oben – hier wird nur gefragt.
 */
export async function nachUpdateSuchen(): Promise<boolean> {
  if (!anmeldung) return false;
  await anmeldung.update();

  // `update()` kommt zurück, sobald der Browser die Datei geholt hat. Ein
  // gefundener neuer Arbeiter braucht danach noch einen Moment, bis er von
  // `installing` auf `waiting` steht – ohne dieses Warten meldete der Knopf
  // „nichts Neues“, und eine Sekunde später erschiene das Band.
  if (anmeldung.waiting) return true;
  const neuer = anmeldung.installing;
  if (!neuer) return false;

  return new Promise<boolean>((fertig) => {
    const aufraeumen = () => neuer.removeEventListener('statechange', horcher);
    const horcher = () => {
      if (neuer.state === 'installed') {
        aufraeumen();
        fertig(true);
      } else if (neuer.state === 'redundant') {
        // Passiert, wenn die Installation scheitert – etwa weil das Netz
        // mitten im Laden wegbricht.
        aufraeumen();
        fertig(false);
      }
    };
    neuer.addEventListener('statechange', horcher);

    // Nicht ewig hängen bleiben, wenn gar nichts mehr passiert.
    window.setTimeout(() => {
      aufraeumen();
      fertig(anmeldung?.waiting != null);
    }, 15_000);
  });
}
