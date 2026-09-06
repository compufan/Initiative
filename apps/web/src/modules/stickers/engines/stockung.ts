/**
 * Wie lange die Oberfläche stillsteht, während gerechnet wird.
 *
 * Der Umzug von „Hohe Qualität“ in einen eigenen Arbeiter sollte genau EINE
 * Sache bewirken: dass die App währenddessen bedienbar bleibt. Ob das auf
 * einem echten Telefon eintritt, war bisher nicht zu beantworten – im
 * Container hier gibt es keine Grafikeinheit, und die Zeiten aus dem Arbeiter
 * (`ladeMs`, `laufMs`) sagen darüber nichts: Sie messen die RECHNUNG, nicht
 * die Bedienbarkeit.
 *
 * Gemessen wird deshalb das, was der Anwender merkt: der längste Abstand
 * zwischen zwei Bildern. Ein Browser ruft `requestAnimationFrame` etwa alle
 * 16 ms auf. Blockiert etwas den Hauptfaden, bleiben die Aufrufe aus – die
 * Lücke IST die Stockung, in Millisekunden, so wie sie sich anfühlt.
 *
 * Erwartung, an der sich der Umbau messen lassen muss: im Arbeiter bleibt die
 * längste Lücke im Bereich weniger Bilder (unter ~100 ms), im Hauptfaden geht
 * sie gegen die gesamte Rechenzeit.
 *
 * `uhr` und `naechstesBild` kommen von aussen, damit sich das hier ohne
 * Browser prüfen lässt – und weil `Date.now` in Tests nicht taugt.
 */
export interface Stockungsmesser {
  /** Beendet die Messung und liefert die längste Lücke in Millisekunden. */
  beenden(): number;
}

export interface Umgebung {
  uhr: () => number;
  naechstesBild: (rueckruf: () => void) => number;
  abbrechen: (kennung: number) => void;
  /** Ist das Dokument gerade nicht zu sehen? */
  versteckt: () => boolean;
  /** Auf Wechsel der Sichtbarkeit horchen; gibt die Abmeldung zurück. */
  sichtbarkeitBeobachten: (rueckruf: () => void) => () => void;
}

/** Die echte Umgebung des Browsers – oder `null`, wo es keine gibt. */
export function browserUmgebung(): Umgebung | null {
  if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') {
    return null;
  }
  return {
    uhr: () => performance.now(),
    naechstesBild: (rueckruf) => requestAnimationFrame(() => rueckruf()),
    abbrechen: (kennung) => cancelAnimationFrame(kennung),
    versteckt: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    sichtbarkeitBeobachten: (rueckruf) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', rueckruf);
      return () => document.removeEventListener('visibilitychange', rueckruf);
    },
  };
}

/**
 * Fängt an zu messen.
 *
 * Ohne Umgebung (Arbeiter, Test ohne Browser, sehr alter Browser) wird nicht
 * gemessen und `beenden` gibt 0 zurück. Eine 0 heisst also „nicht gemessen“,
 * nicht „keine Stockung“ – wer sie anzeigt, muss das unterscheiden.
 */
export function stockungMessen(umgebung: Umgebung | null): Stockungsmesser {
  if (!umgebung) return { beenden: () => 0 };

  let laengste = 0;
  let zuletzt = umgebung.uhr();
  let laeuft = true;
  let kennung = 0;
  /*
   * War das Fenster zwischendurch weg, ist die Messung wertlos.
   *
   * Der Browser ruft `requestAnimationFrame` für ein nicht gezeichnetes
   * Dokument gar nicht mehr auf – im Hintergrund, bei gesperrtem Bildschirm,
   * in einer anderen App. Die Auszeit sähe hier aus wie eine Blockade und
   * wäre die längste von allen. Bei einem Lauf über eine Minute ist das
   * Wegschalten aber der Normalfall, und die Zeile unter dem Sticker
   * behauptete dann „längste Stockung 50 s" für einen Arbeiter, der die
   * Oberfläche kein einziges Bild lang aufgehalten hat.
   *
   * Verworfen statt geschätzt: 0 heisst hier ohnehin schon „nicht gemessen",
   * und `messungText` verschweigt die Zeile dann. Eine fehlende Auskunft ist
   * besser als eine falsche – zumal genau diese Zahl die Frage beantworten
   * soll, ob der Umbau etwas gebracht hat.
   */
  let unbrauchbar = umgebung.versteckt();
  const abmelden = umgebung.sichtbarkeitBeobachten(() => {
    if (umgebung.versteckt()) unbrauchbar = true;
  });

  const schritt = () => {
    if (!laeuft) return;
    const jetzt = umgebung.uhr();
    const luecke = jetzt - zuletzt;
    if (luecke > laengste) laengste = luecke;
    zuletzt = jetzt;
    kennung = umgebung.naechstesBild(schritt);
  };
  kennung = umgebung.naechstesBild(schritt);

  return {
    beenden() {
      if (!laeuft) return unbrauchbar ? 0 : Math.round(laengste);
      laeuft = false;
      umgebung.abbrechen(kennung);
      abmelden();
      if (unbrauchbar || umgebung.versteckt()) {
        unbrauchbar = true;
        return 0;
      }
      /*
       * Die letzte Lücke zählt mit.
       *
       * Sie ist sogar die wichtigste: Wenn der Hauptfaden bis zum Schluss
       * blockiert war, kam nach der letzten Blockade gar kein Bild mehr, und
       * ohne diese Zeile bliebe genau die längste Stockung ungemessen.
       */
      const luecke = umgebung.uhr() - zuletzt;
      if (luecke > laengste) laengste = luecke;
      return Math.round(laengste);
    },
  };
}

/** Eine Messung, wie sie danach angezeigt wird. */
export interface Messung {
  weg: 'arbeiter' | 'hauptfaden';
  /** Wie lange das Modell zu laden brauchte. 0, wenn es schon da war. */
  ladeMs: number;
  /** Reine Rechenzeit. */
  laufMs: number;
  /** Längste Lücke zwischen zwei Bildern. 0 heisst „nicht gemessen“. */
  stockungMs: number;
}

let letzte: Messung | null = null;

export function messungMerken(messung: Messung): void {
  letzte = messung;
}

export function letzteMessung(): Messung | null {
  return letzte;
}

/** Für Tests: den Merker leeren. */
export function messungenVergessen(): void {
  letzte = null;
}

/** Eine Zahl in Sekunden, wenn sie gross ist – sonst in Millisekunden. */
function zeit(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Der Satz, der unter dem Sticker steht.
 *
 * Er ist bewusst nicht geschönt: Steht dort eine Stockung von zwei Sekunden,
 * hat der Umbau auf diesem Gerät nichts gebracht, und das soll man lesen
 * können, ohne die Entwicklerkonsole eines Telefons zu öffnen.
 */
export function messungText(messung: Messung): string {
  const teile = [
    messung.weg === 'arbeiter' ? 'im Arbeiter' : 'im Hauptfaden',
    `gerechnet ${zeit(messung.laufMs)}`,
  ];
  if (messung.ladeMs > 0) teile.push(`geladen ${zeit(messung.ladeMs)}`);
  if (messung.stockungMs > 0) {
    teile.push(`längste Stockung der Oberfläche ${zeit(messung.stockungMs)}`);
  }
  return teile.join(', ');
}
