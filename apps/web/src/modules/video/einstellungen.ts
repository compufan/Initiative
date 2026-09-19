import { isEngineEnabled } from '../stickers/engines/settings.js';

/**
 * Wie genau über ein ganzes Video hinweg freigestellt wird.
 *
 * # Warum das nicht dieselbe Wahl ist wie beim Foto
 *
 * Beim Foto läuft das Netz EINMAL. Ob das eine Sekunde dauert oder drei,
 * merkt kaum jemand. Über fünfzig Bilder wird aus demselben Unterschied eine
 * Minute gegen anderthalb Stunden – und drei der vier Zahlen unten sind
 * nachgemessen, nicht geschätzt:
 *
 * | Netz              | je Bild | 50 Bilder |
 * | ----------------- | ------- | --------- |
 * | „Person"          |   36 ms |     1,8 s |
 * | u2netp            |  1,6 s  |      80 s |
 * | BiRefNet (Grafik) |  2,0 s  |     100 s |
 * | BiRefNet (Proz.)  |  295 s  |  über 4 h |
 *
 * u2netp wurde später in `e2e/videoFreistellen.spec.ts` noch einmal gemessen
 * und kam dort auf 2,18 s. Unten steht deshalb die grössere Zahl: Eine
 * Schätzung, die zu kurz ausfällt, ärgert; eine, die zu lang ausfällt, wird
 * angenehm überholt.
 *
 * Die Reihenfolge der Liste unten richtet sich nach der GÜTE, nicht nach dem
 * Preis. Das ist kein Versehen: BiRefNet auf einer Grafikeinheit ist schneller
 * als u2netp auf dem Prozessor und trotzdem das bessere Netz. Gebraucht wird
 * die Reihenfolge für den Rückfall in `gueteWaehlen` – und der soll zur
 * nächstschlechteren Güte führen, nicht zur nächstbilligeren.
 *
 * Die letzte Zeile ist der Grund, warum „Sehr genau" ohne taugliche
 * Grafikeinheit GAR NICHT angeboten wird – und zwar mit einem Satz, der das
 * sagt, statt mit einem abgeblendeten Knopf. Ein abgeblendeter Knopf lässt
 * jeden rätseln, ob das Gerät zu alt ist oder die App kaputt.
 *
 * # Warum nicht jedes Bild durchs Netz muss
 *
 * Weil sich zwischen zwei Bildern bei zehn je Sekunde wenig ändert. Das Netz
 * läuft auf jedem n-ten Bild, dazwischen schiebt `verfolgung.ts` die Maske
 * mit – für rund 10 ms statt 1,6 s. Bei „Person" ist der Abstand trotzdem 1:
 * Ein Netzlauf kostet dort 36 ms und ist damit kaum teurer als das Schieben,
 * und jedes Bild frisch gerechnet sitzt genauer.
 */

export type VideoGuete = 'schnell' | 'genau' | 'sehr-genau';

export interface GueteInfo {
  readonly key: VideoGuete;
  readonly titel: string;
  readonly beschreibung: string;
  /** Welches Verfahren aus `engines/` gemeint ist. */
  readonly netz: 'person' | 'object' | 'birefnet';
  /** Jedes wievielte Bild durch das Netz geht. 1 heisst: jedes. */
  readonly schluesselAbstand: number;
  /** Die längere Kante, auf der gerechnet und geschrieben wird. */
  readonly kante: number;
  /** Was ein Netzlauf gemessen kostet, in Millisekunden. */
  readonly jeNetzlaufMs: number;
  /** Ob es ohne taugliche Grafikeinheit sinnlos ist. */
  readonly brauchtGrafik: boolean;
}

export const VIDEO_GUETEN: readonly GueteInfo[] = [
  {
    key: 'schnell',
    titel: 'Schnell',
    beschreibung:
      'Erkennt Menschen. Läuft auf jedem Gerät und ist in Sekunden fertig – an Haaren und Fingern aber grob.',
    netz: 'person',
    schluesselAbstand: 1,
    kante: 320,
    jeNetzlaufMs: 36,
    brauchtGrafik: false,
  },
  {
    key: 'genau',
    titel: 'Genau',
    beschreibung:
      'Stellt auch Gegenstände frei und trifft die Kante deutlich besser. Braucht keine Grafikeinheit, dafür etwa eine Minute je zehn Sekunden Film.',
    netz: 'object',
    schluesselAbstand: 4,
    kante: 384,
    jeNetzlaufMs: 2200,
    brauchtGrafik: false,
  },
  {
    key: 'sehr-genau',
    titel: 'Sehr genau',
    beschreibung:
      'Das grosse Netz – Haare, Zäune, Brillenbügel. Braucht zwingend eine Grafikeinheit und den grössten Download.',
    netz: 'birefnet',
    schluesselAbstand: 4,
    /*
     * 512 und nicht 384: BiRefNet rechnet intern auf 512 × 512. Kleiner
     * hineinzugeben heisst, das Bild erst zu verkleinern und dann vom Netz
     * wieder hochrechnen zu lassen – die feine Kante, für die es überhaupt
     * gewählt wurde, wäre dahin.
     */
    kante: 512,
    jeNetzlaufMs: 2000,
    brauchtGrafik: true,
  },
] as const;

export const GUETE_VORGABE: VideoGuete = 'schnell';

/**
 * Die Obergrenze für die Zahl der Bilder.
 *
 * 150 bei zehn Bildern je Sekunde sind fünfzehn Sekunden Film. Die Grenze
 * steht nicht wegen der Dateigrösse – die meldet die Schätzung längst vorher –
 * sondern wegen der Wartezeit: Bei „Genau" wären 150 Bilder schon gut
 * anderthalb Minuten, und darüber hinaus wird aus einer Spielerei eine
 * Sitzung.
 */
export const MAX_BILDER = 150;

/**
 * Wie viele Bildpunkte gleichzeitig im Speicher liegen dürfen.
 *
 * Neunzig Millionen Punkte sind als RGBA rund 360 MB – und das ist kein
 * vorsichtiger Wert, sondern ein grosszügiger: `videoBilderLesen` hält alle
 * Bilder unkomprimiert, und daneben liegt noch die Leinwand, auf der
 * gezeichnet wird.
 *
 * Bei 640 × 360 reicht das für weit mehr als die 150 Bilder, die ohnehin die
 * Grenze sind. Bei 1280 × 720 für 97, bei 1920 × 1080 für 43 – und genau das
 * soll in der Oberfläche stehen, statt dass der Browser den Reiter wegwirft.
 */
export const PUNKTE_DECKEL = 90_000_000;

export function maxBilderFuer(breite: number, hoehe: number): number {
  const punkte = Math.max(1, breite * hoehe);
  return Math.max(1, Math.min(MAX_BILDER, Math.floor(PUNKTE_DECKEL / punkte)));
}

const KEY = 'initiative.video-qualitaet';

export function gueteFinden(key: string): GueteInfo {
  return VIDEO_GUETEN.find((guete) => guete.key === key) ?? VIDEO_GUETEN[0];
}

export function readVideoGuete(): VideoGuete {
  try {
    return gueteFinden(localStorage.getItem(KEY) ?? '').key;
  } catch {
    // Privater Modus oder gesperrter Speicher – dann eben die Vorgabe.
    return GUETE_VORGABE;
  }
}

export function writeVideoGuete(guete: VideoGuete): VideoGuete {
  try {
    localStorage.setItem(KEY, guete);
  } catch {
    /* nicht speicherbar – gilt dann nur für diese Sitzung */
  }
  return guete;
}

export interface Machbarkeit {
  readonly moeglich: boolean;
  /** Warum nicht – ein ganzer Satz, den man anzeigen kann. */
  readonly grund?: string;
}

/**
 * Ob diese Güte hier und jetzt wirklich läuft.
 *
 * Gibt einen SATZ zurück und kein `false`: Wer „Sehr genau" nicht bekommt,
 * soll lesen können, woran es liegt und was stattdessen hilft.
 */
export function gueteMoeglich(guete: GueteInfo, grafikTauglich: boolean): Machbarkeit {
  if (guete.brauchtGrafik && !grafikTauglich) {
    return {
      moeglich: false,
      grund:
        'Dieses Gerät hat keine Grafikeinheit, die das grosse Netz rechnen kann. Auf dem Prozessor dauerte ein einziges Bild rund fünf Minuten – für ein ganzes Video wären das Stunden. Nimm „Genau“; der Unterschied zeigt sich vor allem an Haaren.',
    };
  }
  if (!isEngineEnabled(guete.netz)) {
    return {
      moeglich: false,
      grund: `Das Verfahren dahinter ist in den Einstellungen abgeschaltet. Unter „Aussehen“ lässt es sich wieder einschalten.`,
    };
  }
  return { moeglich: true };
}

/**
 * Die beste Güte, die hier wirklich läuft – oder `null`.
 *
 * Der Rückfall geht nach UNTEN und nie nach oben: Aus „Sehr genau" ohne
 * Grafikeinheit wird „Genau", aus „Schnell" wird nie „Genau". Sonst lüde
 * jemand, der ausdrücklich das Schnelle gewählt hat, ungefragt vier Megabyte.
 */
export function gueteWaehlen(gewuenscht: VideoGuete, grafikTauglich: boolean): GueteInfo | null {
  const start = VIDEO_GUETEN.findIndex((guete) => guete.key === gewuenscht);
  for (let i = Math.max(0, start); i >= 0; i -= 1) {
    if (gueteMoeglich(VIDEO_GUETEN[i], grafikTauglich).moeglich) return VIDEO_GUETEN[i];
  }
  return null;
}

/* ---------- Wie lange es dauert ---------- */

/*
 * Alle vier Zahlen sind gemessen, keine davon geraten:
 *
 * – Ein Bild aus dem Video holen: 75 ms bei 1280 × 720 in Chromium (50 Bilder
 *   in 3,76 s). Es hängt am Dekodieren und am Sprung, nicht an der Zielgrösse.
 * – Die Maske schieben: rund 10 ms, siehe `verfolgung.ts`.
 * – Das GIF schreiben: 2866 ms für 50 Bilder à 512 × 512, also 57 ms je Bild,
 *   und das skaliert mit der FLÄCHE.
 * – Der Netzlauf: steht je Güte oben.
 *
 * Die Summe ist trotzdem nur eine Hausnummer – ein älteres Telefon rechnet
 * langsamer als der Rechner, auf dem gemessen wurde. Deshalb steht sie in der
 * Oberfläche als „rund" und neben einem Abbrechen-Knopf.
 */
const JE_BILD_LESEN_MS = 75;
const JE_BILD_SCHIEBEN_MS = 10;
const JE_BILD_SCHREIBEN_MS = 57;
const GEMESSEN_KANTE = 512;

export function dauerSchaetzenMs(bilder: number, guete: GueteInfo, freistellen: boolean): number {
  const flaeche = (guete.kante * guete.kante) / (GEMESSEN_KANTE * GEMESSEN_KANTE);
  let summe = bilder * (JE_BILD_LESEN_MS + JE_BILD_SCHREIBEN_MS * flaeche);
  if (freistellen) {
    const laeufe = Math.ceil(bilder / guete.schluesselAbstand);
    summe += laeufe * guete.jeNetzlaufMs + (bilder - laeufe) * JE_BILD_SCHIEBEN_MS;
  }
  return Math.round(summe);
}

/**
 * Wie sich die Arbeit auf die drei Abschnitte verteilt – als Anteile, die
 * sich zu eins summieren.
 *
 * Damit der Balken NICHT lügt. Ein Balken, der jeden Abschnitt gleich breit
 * macht, steht bei „Genau" zwischen 33 % und 66 % minutenlang still, während
 * das Netz rechnet, und rauscht danach in Sekunden durch – und jeder, der das
 * sieht, hält die App für hängengeblieben. Gewichtet nach den gemessenen
 * Zeiten läuft er gleichmässig.
 */
export interface Phasen {
  readonly lesen: number;
  readonly freistellen: number;
  readonly schreiben: number;
}

export function phasenGewichte(bilder: number, guete: GueteInfo, freistellen: boolean): Phasen {
  const flaeche = (guete.kante * guete.kante) / (GEMESSEN_KANTE * GEMESSEN_KANTE);
  const lesen = bilder * JE_BILD_LESEN_MS;
  const schreiben = bilder * JE_BILD_SCHREIBEN_MS * flaeche;
  let frei = 0;
  if (freistellen) {
    const laeufe = Math.ceil(bilder / guete.schluesselAbstand);
    frei = laeufe * guete.jeNetzlaufMs + (bilder - laeufe) * JE_BILD_SCHIEBEN_MS;
  }
  const summe = lesen + schreiben + frei;
  if (summe <= 0) return { lesen: 1, freistellen: 0, schreiben: 0 };
  return { lesen: lesen / summe, freistellen: frei / summe, schreiben: schreiben / summe };
}

/** „rund 40 Sekunden" – eine Angabe, die man vor dem Antippen lesen kann. */
export function dauerText(ms: number): string {
  if (ms < 20_000) return 'ein paar Sekunden';
  if (ms < 90_000) return `rund ${Math.round(ms / 10_000) * 10} Sekunden`;
  const minuten = Math.round(ms / 60_000);
  return `rund ${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'}`;
}
