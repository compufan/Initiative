/**
 * Klangprofile und Regler – die Verzerrung, aus eingebauten Bausteinen.
 *
 * # Warum ohne Bibliothek
 *
 * Weil die Web Audio API die Effekte schon mitbringt. Ein Telefonklang ist ein
 * Hochpass, ein Tiefpass und ein bisschen Übersteuerung; ein Roboter ist eine
 * Multiplikation mit einem Sinus. `Tone.js` (MIT) wäre lizenzrechtlich in
 * Ordnung und trotzdem überflüssig – die ganze Datei hier ist kürzer als die
 * Einbindung wäre, und sie lädt nichts nach.
 *
 * # Warum die Effekte in die DATEI gerechnet werden und nicht beim Abspielen
 *
 * Die Alternative wäre, nur die Einstellungen mitzuschicken und beim Abspielen
 * anzuwenden. Das spart Bytes und ist genau der Fehler, gegen den in diesem
 * Projekt schon einmal ein eigener Nachrichtentyp erfunden wurde: Wer den Typ
 * nicht kennt, soll gar nichts zeigen statt das Original. Ein Abspieler, der
 * die Einstellungen nicht kennt, spielte hier die UNVERZERRTE Stimme ab – also
 * das Gegenteil dessen, was die Absenderin wollte, und zwar ohne Vorwarnung.
 *
 * # Warum der Hall gerechnet und nicht geladen wird
 *
 * Ein `ConvolverNode` braucht eine Impulsantwort. Die gibt es fertig als
 * Aufnahmen echter Räume – jede mit einem Urheber und einer Lizenz, die zu
 * prüfen wäre. Exponentiell abklingendes Rauschen ist kein echter Raum, klingt
 * für einen Sticker aber gut genug und gehört niemandem.
 */

/** Die fünf Regler, die unabhängig vom Profil wirken. */
export interface Regler {
  /**
   * Tonhöhe in Halbtönen, −12 … +12.
   *
   * Ändert auch das TEMPO, und das ist keine Nachlässigkeit, sondern die
   * Spezifikation: `computedPlaybackRate = playbackRate * 2^(detune/1200)`.
   * Beide Werte bilden EINEN Faktor. Tonhöhe ohne Tempo bräuchte einen selbst
   * geschriebenen Überlappungs-Dehner; bis es den gibt, sagt die Beschriftung
   * im Editor, was passiert.
   */
  tonhoehe: number;
  /** Übersteuerung, 0 … 40. */
  verzerrung: number;
  /** Tiefen, −12 … +12 dB. */
  tiefen: number;
  /** Höhen, −12 … +12 dB. */
  hoehen: number;
  /** Hallanteil, 0 … 1. */
  hall: number;
}

export const REGLER_NEUTRAL: Regler = {
  tonhoehe: 0,
  verzerrung: 0,
  tiefen: 0,
  hoehen: 0,
  hall: 0,
};

export function reglerNeutral(regler: Regler): boolean {
  return (
    regler.tonhoehe === 0 &&
    regler.verzerrung === 0 &&
    regler.tiefen === 0 &&
    regler.hoehen === 0 &&
    regler.hall === 0
  );
}

/**
 * Die Kennung eines Klangprofils.
 *
 * `ohne` ist ausdrücklich eines davon und nicht `null`: So gibt es genau einen
 * Weg, „keine Verzerrung" auszudrücken, und die Kachelreihe im Editor braucht
 * keinen Sonderfall.
 */
export type ProfilName =
  | 'ohne'
  | 'telefon'
  | 'radio'
  | 'megafon'
  | 'roboter'
  | 'tief'
  | 'hoch'
  | 'halle'
  | 'unterwasser';

/**
 * Was ein Profil ausserdem am Abspieltempo dreht.
 *
 * Steht getrennt, weil es NICHT in der Knotenkette hängt: Tempo und Tonhöhe
 * gehören an die Quelle, und die baut `rendern.ts`. Die Länge der Ausgabe
 * hängt davon ab, also muss sie vorher bekannt sein.
 */
export interface ProfilTempo {
  /** Faktor auf `playbackRate`. 1 heisst unverändert. */
  tempo: number;
}

export interface Profil extends ProfilTempo {
  name: ProfilName;
  /** Was auf der Kachel steht. */
  titel: string;
  zeichen: string;
  /** Ein Satz, der sagt, wonach es klingt. */
  beschreibung: string;
}

export const KLANGPROFILE: Profil[] = [
  { name: 'ohne', titel: 'Ohne', zeichen: '○', beschreibung: 'So, wie es aufgenommen wurde.', tempo: 1 },
  {
    name: 'telefon',
    titel: 'Telefon',
    zeichen: '☎',
    beschreibung: 'Schmal und blechern, wie aus der Leitung.',
    tempo: 1,
  },
  {
    name: 'radio',
    titel: 'Radio',
    zeichen: '📻',
    beschreibung: 'Mittenbetont und gleichmässig laut.',
    tempo: 1,
  },
  {
    name: 'megafon',
    titel: 'Megafon',
    zeichen: '📢',
    beschreibung: 'Hart übersteuert, mit kurzem Nachschlag.',
    tempo: 1,
  },
  {
    name: 'roboter',
    titel: 'Roboter',
    zeichen: '🤖',
    beschreibung: 'Metallisch, ohne menschliche Tonhöhe.',
    tempo: 1,
  },
  { name: 'tief', titel: 'Tief', zeichen: '🐻', beschreibung: 'Tiefer und langsamer.', tempo: 0.72 },
  { name: 'hoch', titel: 'Hoch', zeichen: '🐿', beschreibung: 'Höher und schneller.', tempo: 1.48 },
  { name: 'halle', titel: 'Halle', zeichen: '⛪', beschreibung: 'Weiter Raum mit Nachhall.', tempo: 1 },
  {
    name: 'unterwasser',
    titel: 'Unterwasser',
    zeichen: '🌊',
    beschreibung: 'Dumpf und schwankend.',
    tempo: 1,
  },
];

export function profilFinden(name: ProfilName): Profil {
  return KLANGPROFILE.find((profil) => profil.name === name) ?? KLANGPROFILE[0];
}

/**
 * Die Kennlinie für den `WaveShaperNode`.
 *
 * Ein weiches Übersteuern nach `tanh`, nicht das harte Abschneiden bei ±1.
 * Hartes Abschneiden erzeugt scharfe Ecken in der Kurve, und Ecken sind im
 * Ohr ein Zischen, das über den ganzen Frequenzbereich reicht. `tanh` biegt
 * stattdessen um – es klingt nach Röhre statt nach Fehler.
 *
 * `staerke` 0 gibt die Gerade zurück, also keine Wirkung.
 */
export function kennlinie(staerke: number, punkte = 1024): Float32Array<ArrayBuffer> {
  // `<ArrayBuffer>` ausdrücklich: `WaveShaperNode.curve` nimmt nur einen
  // Puffer, der NICHT geteilt ist (`SharedArrayBuffer` ist ausgeschlossen),
  // und seit TypeScript 5.7 steht das auch im Typ.
  const kurve = new Float32Array(punkte);
  const k = Math.max(0, staerke);
  for (let i = 0; i < punkte; i += 1) {
    const x = (i * 2) / (punkte - 1) - 1;
    kurve[i] = k <= 0 ? x : Math.tanh(k * x) / Math.tanh(k);
  }
  return kurve;
}

/**
 * Die Kennlinie eines BEGRENZERS: unten die Gerade, oben ein weicher Deckel.
 *
 * # Warum es den zusätzlich zum Kompressor braucht
 *
 * Weil ein `DynamicsCompressorNode` keinen Deckel hat. Er senkt, was über der
 * Schwelle liegt, aber erstens braucht er dafür eine Anlaufzeit (die ersten
 * Millisekunden eines Knalls gehen durch), und zweitens bleibt auch danach
 * etwas übrig: Bei einem Verhältnis von 20 werden aus 20 dB über der Schwelle
 * immer noch 1 dB – also mehr als voller Ausschlag.
 *
 * Gemessen war das kein theoretischer Einwand: Beim Profil „Megafon" lagen
 * 303 von 33 600 Werten am Anschlag, bei allen Reglern auf Anschlag 553. Am
 * Anschlag klemmt `wavSchreiben` hart, und hartes Klemmen hört man als
 * Kratzen.
 *
 * # Warum diese Form
 *
 * Bis `KNICK` ist die Kurve die Gerade – normale Sprache läuft also
 * unverändert durch, und der Begrenzer ist nicht zu hören. Darüber biegt sie
 * mit `tanh` um und erreicht selbst bei vollem Eingang nur etwa 0,93. Ein
 * Wert über eins ist damit ausgeschlossen, und zwar nicht durch eine Prüfung,
 * sondern durch die Form der Funktion.
 */
const KNICK = 0.7;

export function begrenzerKurve(punkte = 2048): Float32Array<ArrayBuffer> {
  const kurve = new Float32Array(punkte);
  for (let i = 0; i < punkte; i += 1) {
    const x = (i * 2) / (punkte - 1) - 1;
    const betrag = Math.abs(x);
    const y =
      betrag <= KNICK ? betrag : KNICK + (1 - KNICK) * Math.tanh((betrag - KNICK) / (1 - KNICK));
    kurve[i] = Math.sign(x) * y;
  }
  return kurve;
}

/**
 * Eine Impulsantwort für den Hall: Rauschen, das exponentiell abklingt.
 *
 * `dauer` in Sekunden, `abfall` je höher desto kürzer der Nachhall. Zwei
 * Kanäle mit UNABHÄNGIGEM Rauschen – mit demselben Rauschen links und rechts
 * klänge der Hall wie aus einem Punkt, also gar nicht wie ein Raum.
 */
export function hallImpuls(
  ctx: BaseAudioContext,
  dauer: number,
  abfall: number,
  zufall: () => number = Math.random,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const laenge = Math.max(1, Math.floor(dauer * rate));
  const puffer = ctx.createBuffer(2, laenge, rate);
  for (let k = 0; k < 2; k += 1) {
    const kanal = puffer.getChannelData(k);
    for (let i = 0; i < laenge; i += 1) {
      kanal[i] = (zufall() * 2 - 1) * Math.exp((-abfall * i) / laenge);
    }
  }
  return puffer;
}

/** Ein Filter mit einem Handgriff angelegt. */
function filter(
  ctx: BaseAudioContext,
  art: BiquadFilterType,
  frequenz: number,
  q?: number,
  gain?: number,
): BiquadFilterNode {
  const knoten = ctx.createBiquadFilter();
  knoten.type = art;
  knoten.frequency.value = frequenz;
  if (q !== undefined) knoten.Q.value = q;
  if (gain !== undefined) knoten.gain.value = gain;
  return knoten;
}

function former(ctx: BaseAudioContext, staerke: number): WaveShaperNode {
  const knoten = ctx.createWaveShaper();
  knoten.curve = kennlinie(staerke);
  knoten.oversample = '4x';
  return knoten;
}

/** Eine Kette in Reihe schalten und ihr Ende zurückgeben. */
function reihe(erstes: AudioNode, weitere: AudioNode[]): AudioNode {
  let ende = erstes;
  for (const knoten of weitere) {
    ende.connect(knoten);
    ende = knoten;
  }
  return ende;
}

/**
 * Einen Hall parallel dazumischen.
 *
 * Nass und trocken nebeneinander statt hintereinander: Ein Hall, durch den
 * ALLES läuft, macht die Stimme matschig. Was man will, ist das Original plus
 * eine Spur Raum darunter.
 */
function mitHall(
  ctx: BaseAudioContext,
  eingang: AudioNode,
  nass: number,
  dauer: number,
  abfall: number,
  vorlaufMs = 0,
): AudioNode {
  const summe = ctx.createGain();
  const trocken = ctx.createGain();
  trocken.gain.value = 1 - nass * 0.4;
  eingang.connect(trocken).connect(summe);

  const hall = ctx.createConvolver();
  hall.buffer = hallImpuls(ctx, dauer, abfall);
  const nassPegel = ctx.createGain();
  nassPegel.gain.value = nass;
  if (vorlaufMs > 0) {
    // Eine Vorverzögerung macht den Raum GRÖSSER, ohne den Hall länger zu
    // machen: Das Ohr liest den Abstand zwischen Ton und erstem Echo als
    // Entfernung zur Wand.
    const warten = ctx.createDelay(1);
    warten.delayTime.value = vorlaufMs / 1000;
    eingang.connect(warten).connect(hall).connect(nassPegel).connect(summe);
  } else {
    eingang.connect(hall).connect(nassPegel).connect(summe);
  }
  return summe;
}

/**
 * Die Knotenkette eines Profils.
 *
 * Bekommt den Eingang, gibt das Ende zurück. Der Aufrufer verbindet das Ende
 * mit dem Ziel – so lässt sich dieselbe Kette im `OfflineAudioContext` zum
 * Schreiben und im normalen `AudioContext` zum Vorhören benutzen, ohne dass
 * hier irgendetwas davon weiss.
 */
export function profilKette(
  ctx: BaseAudioContext,
  eingang: AudioNode,
  name: ProfilName,
): AudioNode {
  switch (name) {
    case 'telefon':
      /*
       * Die Bandbreite eines Telefons ist 300 bis 3400 Hz, und das ist keine
       * gewählte Zahl, sondern die des Fernsprechnetzes. Die Anhebung bei
       * 1800 Hz macht daraus das, was man erwartet: den Hörer am Ohr.
       */
      return reihe(eingang, [
        filter(ctx, 'highpass', 300, 0.7),
        filter(ctx, 'lowpass', 3400, 0.7),
        filter(ctx, 'peaking', 1800, 1.2, 6),
        former(ctx, 4),
      ]);

    case 'radio': {
      const kompressor = ctx.createDynamicsCompressor();
      // Radio klingt vor allem deshalb nach Radio, weil alles gleich laut ist.
      kompressor.threshold.value = -30;
      kompressor.ratio.value = 12;
      kompressor.knee.value = 0;
      kompressor.attack.value = 0.003;
      kompressor.release.value = 0.15;
      return reihe(eingang, [
        filter(ctx, 'highpass', 180, 0.7),
        filter(ctx, 'lowpass', 5500, 0.7),
        filter(ctx, 'peaking', 3000, 1, 5),
        filter(ctx, 'lowshelf', 150, undefined, -4),
        kompressor,
      ]);
    }

    case 'megafon': {
      const verzoegerung = ctx.createDelay(1);
      verzoegerung.delayTime.value = 0.035;
      const rueckfuehrung = ctx.createGain();
      rueckfuehrung.gain.value = 0.22;
      const band = reihe(eingang, [
        filter(ctx, 'bandpass', 1200, 0.9),
        former(ctx, 18),
      ]);
      const summe = ctx.createGain();
      band.connect(summe);
      /*
       * Der Nachschlag läuft im Kreis: Ausgang → Verzögerung → Dämpfung →
       * zurück in die Verzögerung. Die Dämpfung MUSS unter eins bleiben, sonst
       * schaukelt sich die Schleife auf, bis nur noch Rauschen herauskommt.
       */
      band.connect(verzoegerung);
      verzoegerung.connect(rueckfuehrung).connect(verzoegerung);
      verzoegerung.connect(summe);
      return summe;
    }

    case 'roboter': {
      /*
       * Ein Ringmodulator, gebaut aus einem `GainNode`.
       *
       * Der Trick: `gain.value` wird auf null gesetzt, und ein Oszillator
       * wird auf den PARAMETER `gain` gelegt. Die Spezifikation addiert den
       * Wert des Parameters und alles, was auf ihn zeigt – der Verstärkungs-
       * faktor ist damit der Sinus selbst, und ein Verstärker mit einem
       * Sinus als Faktor IST eine Multiplikation zweier Signale.
       *
       * Das ist der einzige Weg zu einer echten Multiplikation, ohne ein
       * eigenes Worklet zu schreiben.
       */
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const oszillator = ctx.createOscillator();
      oszillator.frequency.value = 55;
      oszillator.connect(ring.gain);
      oszillator.start();
      eingang.connect(ring);
      return reihe(ring, [filter(ctx, 'bandpass', 1200, 1.4), former(ctx, 8)]);
    }

    case 'tief':
      // Das Tempo macht `rendern.ts` an der Quelle – hier nur die Farbe.
      return reihe(eingang, [
        filter(ctx, 'lowshelf', 220, undefined, 7),
        filter(ctx, 'lowpass', 5000, 0.7),
      ]);

    case 'hoch':
      return reihe(eingang, [
        filter(ctx, 'highshelf', 3500, undefined, 4),
        filter(ctx, 'highpass', 200, 0.7),
      ]);

    case 'halle':
      return mitHall(ctx, eingang, 0.42, 2, 4, 25);

    case 'unterwasser': {
      const tiefpass = filter(ctx, 'lowpass', 600, 5);
      /*
       * Das Schwanken kommt von einem langsamen Oszillator auf der
       * Grenzfrequenz. Ohne ihn klänge es nur dumpf; das „Unterwasser" steckt
       * in der Bewegung.
       */
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.35;
      const tiefe = ctx.createGain();
      tiefe.gain.value = 220;
      lfo.connect(tiefe).connect(tiefpass.frequency);
      lfo.start();
      eingang.connect(tiefpass);
      return mitHall(ctx, tiefpass, 0.25, 1.2, 6);
    }

    case 'ohne':
    default:
      return eingang;
  }
}

/**
 * Die Regler hinter das Profil hängen.
 *
 * Erst das Profil, dann die Regler: So bleibt „Telefon plus ein bisschen mehr
 * Tiefen" das, was jemand erwartet. Andersherum hätte der Tiefpass des
 * Telefons die Tiefen gleich wieder abgeschnitten.
 *
 * Die Tonhöhe fehlt hier – sie gehört an die Quelle, siehe `Regler.tonhoehe`.
 */
export function reglerKette(
  ctx: BaseAudioContext,
  eingang: AudioNode,
  regler: Regler,
): AudioNode {
  let ende = eingang;
  if (regler.verzerrung > 0) ende = reihe(ende, [former(ctx, regler.verzerrung)]);
  if (regler.tiefen !== 0) {
    ende = reihe(ende, [filter(ctx, 'lowshelf', 180, undefined, regler.tiefen)]);
  }
  if (regler.hoehen !== 0) {
    ende = reihe(ende, [filter(ctx, 'highshelf', 3500, undefined, regler.hoehen)]);
  }
  if (regler.hall > 0) ende = mitHall(ctx, ende, regler.hall * 0.6, 1.6, 5, 15);
  return ende;
}

/**
 * Wie lange der Nachhall über das Ende hinaus klingt, in Sekunden.
 *
 * Wird gebraucht, BEVOR gerechnet wird: Ein `OfflineAudioContext` bekommt
 * seine Länge beim Anlegen und lässt sich danach nicht mehr verlängern. Wer
 * das übersieht, schneidet den Hall mitten ab – und zwar genau dann, wenn er
 * am auffälligsten ist.
 */
export function nachklang(name: ProfilName, regler: Regler): number {
  let sekunden = 0;
  if (name === 'halle') sekunden = 2.2;
  if (name === 'unterwasser') sekunden = Math.max(sekunden, 1.4);
  if (name === 'megafon') sekunden = Math.max(sekunden, 0.4);
  if (regler.hall > 0) sekunden = Math.max(sekunden, 1.8);
  return sekunden;
}
