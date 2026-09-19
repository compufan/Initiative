/**
 * Ton lesen, zuschneiden, verzerren, schreiben.
 *
 * Die Klammer um `wav.ts`, `stille.ts` und `profile.ts`. Hier steht das
 * Einzige, was ohne Browser nicht zu haben ist – ein `OfflineAudioContext` –
 * und deshalb steht alles Rechenbare woanders, wo es sich prüfen lässt.
 *
 * # Warum „offline" und nicht in Echtzeit
 *
 * `OfflineAudioContext` rechnet so schnell, wie die Maschine kann, statt im
 * Takt der Uhr. Eine Sprachnachricht von fünf Minuten ist damit in wenigen
 * Sekunden fertig. Der naheliegende Weg über `MediaRecorder` an einem
 * `MediaStreamAudioDestinationNode` bräuchte fünf Minuten – siehe den Kopf
 * von `wav.ts`.
 *
 * # Wo der Schnitt wirklich passiert
 *
 * In `quelle.start(0, beginn, dauer)`. Die beiden letzten Zahlen sind kein
 * Anzeigebereich, sondern der Ausschnitt des Puffers, den die Quelle
 * überhaupt abspielt – was davor und danach liegt, kommt nie in die Kette und
 * steht nie in der Datei.
 */

import {
  KLANGPROFILE,
  begrenzerKurve,
  nachklang,
  profilFinden,
  profilKette,
  reglerKette,
} from './profile.js';
import type { ProfilName, Regler } from './profile.js';
import { ZIEL_RATE, dezimieren, nachMono, wavSchreiben } from './wav.js';

export { KLANGPROFILE };

/** Der Ton, wie ihn die Werkstatt in der Hand hält. */
export interface Tonquelle {
  /** Ein Kanal, schon gemischt – siehe `nachMono`. */
  werte: Float32Array<ArrayBufferLike>;
  rate: number;
  /** Gesamtlänge in Sekunden. */
  dauer: number;
}

export interface Fassung {
  profil: ProfilName;
  regler: Regler;
  /** Anfang des Ausschnitts in Sekunden. */
  beginn: number;
  /** Ende des Ausschnitts in Sekunden. */
  ende: number;
}

function audioKlasse(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/**
 * Eine Datei zu Zahlen machen.
 *
 * Mischt sofort auf einen Kanal und lässt den Originalpuffer fallen: Fünf
 * Minuten Stereo bei 48 kHz sind rund 115 MB Float32, und auf einem älteren
 * Telefon stirbt die Seite daran, bevor irgendetwas zu sehen war.
 *
 * Der Fehler bekommt einen Satz, den man lesen kann. `decodeAudioData` benutzt
 * die Dekodierer des Browsers, und die sind verschieden – eine `.ogg` scheitert
 * auf einem iPhone, wo sie anderswo läuft. Ein stilles Leerergebnis wäre hier
 * das Schlimmste: Die Werkstatt zeigte eine leere Welle und niemand wüsste,
 * warum.
 */
export async function tonLesen(blob: Blob): Promise<Tonquelle> {
  const Ctor = audioKlasse();
  if (!Ctor) throw new Error('Dieser Browser kann keinen Ton verarbeiten.');
  const ctx = new Ctor();
  try {
    let puffer: AudioBuffer;
    try {
      puffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      throw new Error(
        'Diese Tondatei lässt sich hier nicht öffnen. Versuch es mit MP3, M4A oder WAV.',
      );
    }
    const kanaele: Float32Array[] = [];
    for (let k = 0; k < puffer.numberOfChannels; k += 1) kanaele.push(puffer.getChannelData(k));
    return {
      werte: nachMono(kanaele),
      rate: puffer.sampleRate,
      dauer: puffer.duration,
    };
  } finally {
    void ctx.close();
  }
}

/**
 * Aus einer Fassung eine Datei.
 *
 * Gibt den Blob, seinen Typ und die Dauer zurück – die Dauer ist hier EXAKT
 * bekannt (`laenge / rate`), anders als bei einer Aufnahme aus dem
 * `MediaRecorder`, deren Kopf oft gar keine Länge trägt und deren
 * `audio.duration` dann `Infinity` liefert.
 */
export async function tonRendern(
  quelle: Tonquelle,
  fassung: Fassung,
): Promise<{ blob: Blob; mime: string; dauerMs: number }> {
  const profil = profilFinden(fassung.profil);
  const beginn = Math.max(0, Math.min(fassung.beginn, quelle.dauer));
  const ende = Math.max(beginn, Math.min(fassung.ende, quelle.dauer));
  const ausschnitt = Math.max(0.01, ende - beginn);

  /*
   * Das Tempo aus Profil UND Tonhöhenregler in EINEN Faktor.
   *
   * Die Spezifikation rechnet `playbackRate * 2^(detune/1200)`; beide Werte
   * getrennt zu setzen ändert daran nichts. Also wird der Faktor hier einmal
   * gebildet – und weil er die Länge der Ausgabe bestimmt, muss das VOR dem
   * Anlegen des Kontextes geschehen.
   */
  const tempo = profil.tempo * Math.pow(2, fassung.regler.tonhoehe / 12);
  const schwanz = nachklang(fassung.profil, fassung.regler);
  const zielDauer = ausschnitt / tempo + schwanz;

  /*
   * Die Zielrate in einem Versuch setzen.
   *
   * iOS Safari liess für `OfflineAudioContext` lange nur 44100 Hz zu. Ob das
   * in den aktuellen Fassungen noch gilt, lässt sich von hier aus nicht
   * feststellen – also wird es versucht und bei einem Fehler die Rate der
   * Quelle genommen. Eine grössere Datei ist ein hinnehmbarer Preis; eine
   * Ausnahme mitten im Speichern nicht.
   */
  let rate = ZIEL_RATE;
  let ctx: OfflineAudioContext;
  const OfflineCtor =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : (window as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error('Dieser Browser kann keinen Ton verarbeiten.');
  try {
    ctx = new OfflineCtor(1, Math.ceil(zielDauer * rate), rate);
  } catch {
    rate = quelle.rate;
    ctx = new OfflineCtor(1, Math.ceil(zielDauer * rate), rate);
  }

  const eingang = ctx.createBuffer(1, quelle.werte.length, quelle.rate);
  // `set` statt `copyToChannel`: Letzteres verlangt einen nicht geteilten
  // Puffer, und was aus `getChannelData` kommt, ist dem Typ nach beides.
  eingang.getChannelData(0).set(quelle.werte);
  const knoten = ctx.createBufferSource();
  knoten.buffer = eingang;
  knoten.playbackRate.value = tempo;

  const nachProfil = profilKette(ctx, knoten, fassung.profil);
  const nachReglern = reglerKette(ctx, nachProfil, fassung.regler);

  /*
   * Zwei Bremsen am Ende, und beide werden gebraucht.
   *
   * Der Kompressor nimmt die Dynamik zurück – das ist die musikalische
   * Bremse, sie macht laute Stellen leiser, ohne dass man ein Eingreifen
   * hört. Was er NICHT kann, ist ein Deckel sein: Er hat eine Anlaufzeit, und
   * bei einem Verhältnis von 20 bleiben aus 20 dB über der Schwelle immer
   * noch 1 dB übrig.
   *
   * Deshalb dahinter der Begrenzer. Seine Kennlinie kann durch ihre Form
   * keinen Wert über eins liefern, ganz gleich, was hineingeht – und ohne
   * ihn klemmt `wavSchreiben` hart, was man als Kratzen hört. Gemessen lagen
   * ohne ihn beim Profil „Megafon" 303 von 33 600 Werten am Anschlag.
   */
  const bremse = ctx.createDynamicsCompressor();
  bremse.threshold.value = -6;
  bremse.ratio.value = 12;
  bremse.knee.value = 6;
  bremse.attack.value = 0.002;
  bremse.release.value = 0.1;
  const deckel = ctx.createWaveShaper();
  deckel.curve = begrenzerKurve();
  deckel.oversample = '4x';
  nachReglern.connect(bremse).connect(deckel).connect(ctx.destination);

  knoten.start(0, beginn, ausschnitt);
  const fertig = await ctx.startRendering();

  let werte: Float32Array<ArrayBufferLike> = fertig.getChannelData(0);
  // Gab der Browser eine höhere Rate als gewünscht, jetzt noch heruntersetzen.
  if (rate > ZIEL_RATE) {
    werte = dezimieren(werte, rate, ZIEL_RATE);
    rate = ZIEL_RATE;
  }
  return {
    blob: wavSchreiben([werte], rate),
    mime: 'audio/wav',
    dauerMs: Math.round((werte.length / rate) * 1000),
  };
}

/**
 * Ob an einer Fassung überhaupt etwas geändert wurde.
 *
 * Die Frage entscheidet, ob neu geschrieben wird – und damit, ob aus 400 kB
 * Opus 14 MB WAV werden. Sie gehört deshalb an genau eine Stelle und nicht in
 * jeden Aufrufer.
 */
export function fassungBeruehrt(fassung: Fassung, quelle: Tonquelle): boolean {
  if (fassung.profil !== 'ohne') return true;
  const r = fassung.regler;
  if (r.tonhoehe !== 0 || r.verzerrung !== 0 || r.tiefen !== 0 || r.hoehen !== 0 || r.hall !== 0) {
    return true;
  }
  // Ein Zehntel Toleranz: Griffe treffen nie exakt den Anfang, und ein
  // Neuschreiben wegen drei Millisekunden wäre reine Verschwendung.
  return fassung.beginn > 0.1 || quelle.dauer - fassung.ende > 0.1;
}
