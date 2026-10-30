/**
 * Die Grenze des Medienspeichers im Service Worker (`initiative-media-v1`).
 *
 * # Warum es eine braucht
 *
 * Der Arbeiter legt jedes Bild, jedes Video und jede Datei ab, die einmal
 * angesehen wurde – „cache first", weil Medien sich nach dem Hochladen nie
 * mehr ändern. Gelöscht wurde dort nie etwas. Wer ein Jahr lang in einer
 * Gruppe Videos bekommt, trägt sie alle im Telefon, bis der Browser beim
 * Speicherdruck den GANZEN Ursprung räumt – Anmeldung, Entwürfe und
 * Postausgang eingeschlossen. Lieber räumen wir selbst, und zwar das, was am
 * längsten keiner mehr angesehen hat.
 *
 * # Warum hier und nicht in `sw.ts`
 *
 * Die Auswahl ist reine Rechnerei und lässt sich ohne Browser prüfen; der
 * Arbeiter liefert nur die Einträge und führt das Löschen aus.
 */

/** Höchstens so viele Medien im Speicher. */
export const MEDIEN_HOECHSTZAHL = 300;

/** Und zusammen höchstens so viele Bytes – 300 MB. */
export const MEDIEN_HOECHSTBYTES = 300 * 1024 * 1024;

/**
 * Frühestens so lange nach einem Schreiben wird aufgeräumt.
 *
 * Ein Chat voller Bilder legt beim Durchscrollen Dutzende in wenigen Sekunden
 * ab. Nach jedem einzelnen alle Einträge zu zählen, kostete mehr als das
 * Ablegen selbst; gesammelt reicht ein Durchgang. Kurz genug, dass der
 * Arbeiter in der Zeit nicht schlafen geht – siehe `waitUntil` in `sw.ts`.
 */
export const MEDIEN_AUFRAEUMEN_ABSTAND_MS = 5_000;

export interface VorratEintrag {
  url: string;
  bytes: number;
  /** Zuletzt gebraucht (Ablegen oder Treffer), Millisekunden seit 1970. 0 = unbekannt. */
  zuletzt: number;
}

export interface VorratGrenzen {
  hoechstzahl: number;
  hoechstbytes: number;
}

export const MEDIEN_GRENZEN: VorratGrenzen = {
  hoechstzahl: MEDIEN_HOECHSTZAHL,
  hoechstbytes: MEDIEN_HOECHSTBYTES,
};

/**
 * Welche Einträge gehen müssen, damit beide Grenzen wieder halten.
 *
 * Die am längsten nicht gebrauchten zuerst (LRU). Bei gleicher Zeit – etwa
 * den Altbeständen von vor dieser Grenze, die alle `0` tragen – gehen die
 * grösseren zuerst: Ein einziges altes Video macht mehr Platz als zwanzig
 * Vorschaubilder, und wer es wieder braucht, lädt es eben nach.
 */
export function verdraengen(
  eintraege: readonly VorratEintrag[],
  grenzen: VorratGrenzen = MEDIEN_GRENZEN,
): string[] {
  let anzahl = eintraege.length;
  let bytes = eintraege.reduce((summe, e) => summe + Math.max(0, e.bytes), 0);
  if (anzahl <= grenzen.hoechstzahl && bytes <= grenzen.hoechstbytes) return [];

  const reihe = [...eintraege].sort((a, b) => a.zuletzt - b.zuletzt || b.bytes - a.bytes);
  const weg: string[] = [];
  for (const eintrag of reihe) {
    if (anzahl <= grenzen.hoechstzahl && bytes <= grenzen.hoechstbytes) break;
    weg.push(eintrag.url);
    anzahl -= 1;
    bytes -= Math.max(0, eintrag.bytes);
  }
  return weg;
}

/**
 * Fasst viele Aufrufe in einen späteren Lauf zusammen.
 *
 * Der erste Aufruf plant `aufgabe` in `abstandMs`; alle weiteren bis dahin
 * bekommen DENSELBEN Lauf (dasselbe Versprechen) und planen nichts Neues. Das
 * Versprechen geht im Arbeiter an `event.waitUntil`, damit der Browser ihn
 * nicht vor dem Lauf schlafen legt. Hat der Lauf schon begonnen, plant ein
 * neuer Aufruf einen weiteren – das Neue soll ja mitgezählt werden –, der
 * aber erst nach dem laufenden beginnt.
 */
export function gedrosselt(
  aufgabe: () => Promise<void>,
  abstandMs: number,
  planen: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
): () => Promise<void> {
  let geplant: Promise<void> | null = null;
  // Nie zwei Läufe gleichzeitig: Beide läsen dieselben Einträge und löschten
  // doppelt, oder einer schriebe die Buchführung des anderen über.
  let laeuft: Promise<void> = Promise.resolve();
  return () => {
    if (geplant) return geplant;
    geplant = new Promise<void>((fertig) => {
      planen(() => {
        // Ab hier gilt der Lauf als begonnen: Ein Aufruf jetzt plant den
        // nächsten, statt sich an diesen zu hängen.
        geplant = null;
        laeuft = laeuft.then(() => aufgabe().catch(() => {}));
        void laeuft.then(fertig);
      }, abstandMs);
    });
    return geplant;
  };
}
