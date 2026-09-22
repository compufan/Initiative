import { describe, expect, it } from 'vitest';

import {
  KLANGPROFILE,
  REGLER_NEUTRAL,
  ausschnittGrenze,
  begrenzerKurve,
  hallImpuls,
  kennlinie,
  nachklang,
  profilFinden,
  reglerNeutral,
} from './profile.js';
import type { ProfilName } from './profile.js';

/**
 * Die Prüfungen für die Klangprofile.
 *
 * Was hier NICHT geprüft wird: wie es klingt. Dafür bräuchte es einen
 * Audiokontext, und die Prüfungen dieses Projektes laufen ohne Browser.
 * Geprüft wird deshalb das Rechenbare – die Kennlinie, der Hallimpuls, die
 * Länge des Nachklangs – und die Liste selbst, denn eine Kachelreihe mit einem
 * Namen, den `profilFinden` nicht kennt, führte stillschweigend zu „ohne".
 */

describe('Die Liste der Profile', () => {
  it('beginnt mit „ohne" und hat eindeutige Namen', () => {
    expect(KLANGPROFILE[0].name).toBe('ohne');
    const namen = KLANGPROFILE.map((profil) => profil.name);
    expect(new Set(namen).size).toBe(namen.length);
  });

  it('gibt jedem Profil einen Titel, ein Zeichen und einen Satz', () => {
    // Die Kacheln zeigen alles drei. Fehlt eines, steht dort eine Lücke –
    // und zwar erst im Bild, nicht beim Übersetzen.
    for (const profil of KLANGPROFILE) {
      expect(profil.titel.length, profil.name).toBeGreaterThan(0);
      expect(profil.zeichen.length, profil.name).toBeGreaterThan(0);
      expect(profil.beschreibung.length, profil.name).toBeGreaterThan(8);
    }
  });

  it('hält das Tempo in einem Bereich, der die Sprache nicht zerstört', () => {
    // Unter 0,5 klingt Sprache wie ein Tonband mit leerer Batterie, über 2
    // versteht man kein Wort mehr.
    for (const profil of KLANGPROFILE) {
      expect(profil.tempo, profil.name).toBeGreaterThanOrEqual(0.5);
      expect(profil.tempo, profil.name).toBeLessThanOrEqual(2);
    }
  });

  it('findet jedes Profil und fällt sonst auf „ohne" zurück', () => {
    for (const profil of KLANGPROFILE) {
      expect(profilFinden(profil.name).name).toBe(profil.name);
    }
    expect(profilFinden('gibt-es-nicht' as ProfilName).name).toBe('ohne');
  });
});

describe('kennlinie', () => {
  it('ist bei Stärke null die Gerade – also ohne Wirkung', () => {
    const kurve = kennlinie(0, 5);
    expect(Array.from(kurve).map((wert) => Number(wert.toFixed(6)))).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  it('bleibt in den Grenzen und läuft von −1 nach +1', () => {
    for (const staerke of [1, 4, 18, 40]) {
      const kurve = kennlinie(staerke, 257);
      expect(kurve[0], `Stärke ${staerke}`).toBeCloseTo(-1, 5);
      expect(kurve[256], `Stärke ${staerke}`).toBeCloseTo(1, 5);
      for (const wert of kurve) expect(Math.abs(wert)).toBeLessThanOrEqual(1.0000001);
    }
  });

  it('steigt durchgehend – eine Kennlinie mit einem Knick klingt kaputt', () => {
    /*
     * Eine Kennlinie, die irgendwo wieder fällt, ordnet laute Stellen leisen
     * zu. Das ist kein Übersteuern mehr, sondern ein Fehler, den man als
     * Kratzen hört.
     */
    const kurve = kennlinie(12, 512);
    for (let i = 1; i < kurve.length; i += 1) {
      expect(kurve[i], `an ${i}`).toBeGreaterThanOrEqual(kurve[i - 1]);
    }
  });

  it('drückt zusammen, statt hart abzuschneiden', () => {
    // Der Unterschied zu einem harten Abschneiden: Bei halbem Ausschlag ist
    // schon deutlich mehr Verstärkung da, und bei vollem bleibt es bei eins.
    const kurve = kennlinie(8, 1025);
    const halb = kurve[768]; // entspricht x = +0.5
    expect(halb).toBeGreaterThan(0.5);
    expect(halb).toBeLessThan(1);
  });
});

describe('begrenzerKurve', () => {
  it('kann durch ihre Form keinen Wert ueber eins liefern', () => {
    /*
     * Die Zusicherung, um die es geht – und sie gilt fuer JEDEN Eingang.
     *
     * Ein `DynamicsCompressorNode` allein reicht dafuer nicht: Er hat eine
     * Anlaufzeit, und bei einem Verhaeltnis von 20 bleiben aus 20 dB ueber
     * der Schwelle immer noch 1 dB uebrig. Gemessen lagen ohne diesen
     * Begrenzer beim Profil „Megafon" 303 von 33 600 Werten am Anschlag – und
     * am Anschlag klemmt `wavSchreiben` hart, was man als Kratzen hoert.
     */
    const kurve = begrenzerKurve(4096);
    for (const wert of kurve) expect(Math.abs(wert)).toBeLessThan(1);
  });

  it('laesst normale Lautstaerken unveraendert durch', () => {
    /*
     * Ein Begrenzer, den man bei Sprache hoert, ist ein Fehler. Bis zum Knick
     * ist die Kurve deshalb die GERADE – und das laesst sich nachrechnen.
     */
    const punkte = 2049;
    const kurve = begrenzerKurve(punkte);
    for (let i = 0; i < punkte; i += 1) {
      const x = (i * 2) / (punkte - 1) - 1;
      if (Math.abs(x) <= 0.65) expect(kurve[i], `bei ${x.toFixed(3)}`).toBeCloseTo(x, 6);
    }
  });

  it('steigt durchgehend und ist punktsymmetrisch', () => {
    // Punktsymmetrisch, weil ein Begrenzer, der oben anders wirkt als unten,
    // eine Gleichspannung erzeugt – und die hoert man als Knacken beim Start.
    const punkte = 2049;
    const kurve = begrenzerKurve(punkte);
    for (let i = 1; i < punkte; i += 1) expect(kurve[i]).toBeGreaterThanOrEqual(kurve[i - 1]);
    for (let i = 0; i < punkte; i += 1) {
      expect(kurve[i], `an ${i}`).toBeCloseTo(-kurve[punkte - 1 - i], 6);
    }
  });
});

describe('hallImpuls', () => {
  /** Ein winziger Ersatz für einen Audiokontext – mehr braucht die Funktion nicht. */
  function kontext(rate = 24_000) {
    return {
      sampleRate: rate,
      createBuffer(kanaele: number, laenge: number) {
        const daten = Array.from({ length: kanaele }, () => new Float32Array(laenge));
        return {
          numberOfChannels: kanaele,
          length: laenge,
          sampleRate: rate,
          getChannelData: (k: number) => daten[k],
        };
      },
    } as unknown as BaseAudioContext;
  }

  it('klingt ab, statt gleich laut zu bleiben', () => {
    /*
     * Das ist der ganze Sinn: Ein Hall, der nicht abklingt, ist Rauschen.
     * Geprüft wird über die Energie im ersten gegen das letzte Zehntel.
     */
    const puffer = hallImpuls(kontext(), 1, 4, () => 0.75);
    const kanal = puffer.getChannelData(0);
    const teil = Math.floor(kanal.length / 10);
    let vorn = 0;
    let hinten = 0;
    for (let i = 0; i < teil; i += 1) vorn += Math.abs(kanal[i]);
    for (let i = kanal.length - teil; i < kanal.length; i += 1) hinten += Math.abs(kanal[i]);
    expect(hinten).toBeLessThan(vorn * 0.1);
  });

  it('gibt beiden Kanälen UNTERSCHIEDLICHES Rauschen', () => {
    /*
     * Mit demselben Rauschen links und rechts käme der Hall aus einem Punkt –
     * also gar nicht wie ein Raum. Hier wird der Zufall mitgezählt, damit die
     * Prüfung nicht selbst würfelt.
     */
    let n = 0;
    const puffer = hallImpuls(kontext(), 0.1, 4, () => {
      n += 1;
      return (n % 97) / 97;
    });
    const links = puffer.getChannelData(0);
    const rechts = puffer.getChannelData(1);
    let gleich = 0;
    for (let i = 0; i < links.length; i += 1) if (links[i] === rechts[i]) gleich += 1;
    expect(gleich).toBeLessThan(links.length / 2);
  });

  it('trifft die verlangte Länge', () => {
    expect(hallImpuls(kontext(24_000), 0.5, 4, () => 0.5).length).toBe(12_000);
  });
});

describe('nachklang', () => {
  it('gibt jedem hallenden Profil Zeit über das Ende hinaus', () => {
    /*
     * Ein `OfflineAudioContext` bekommt seine Länge beim Anlegen und lässt
     * sich danach nicht verlängern. Wer den Nachklang vergisst, schneidet den
     * Hall mitten ab – genau dort, wo er am auffälligsten ist.
     */
    expect(nachklang('halle', REGLER_NEUTRAL)).toBeGreaterThan(1.5);
    expect(nachklang('unterwasser', REGLER_NEUTRAL)).toBeGreaterThan(1);
    expect(nachklang('megafon', REGLER_NEUTRAL)).toBeGreaterThan(0);
  });

  it('gibt einem trockenen Profil keine zusätzliche Zeit', () => {
    // Sonst hinge an jeder Sprachnachricht eine Sekunde Stille.
    expect(nachklang('ohne', REGLER_NEUTRAL)).toBe(0);
    expect(nachklang('telefon', REGLER_NEUTRAL)).toBe(0);
  });

  it('beachtet auch den Hallregler, nicht nur das Profil', () => {
    // Der Regler wirkt unabhängig vom Profil – wer ihn übersieht, schneidet
    // bei „Telefon plus Hall" den Nachklang ab.
    expect(nachklang('telefon', { ...REGLER_NEUTRAL, hall: 0.8 })).toBeGreaterThan(1);
  });
});

describe('ausschnittGrenze', () => {
  it('zieht den Nachhall ab, statt ihn zu vergessen', () => {
    /*
     * `tonRendern` legt den Rechenkontext auf `ausschnitt / tempo +
     * nachklang` an. Bei acht erlaubten Sekunden und „Halle" (2,2 s) blieben
     * ohne Abzug 10,2 Sekunden Datei stehen – während die Anzeige acht
     * behauptet und der Server nur die ZAHL auf acht klemmt. Der Sticker
     * klänge zwei Sekunden länger, als er von sich sagt.
     */
    expect(ausschnittGrenze(8, 1, nachklang('halle', REGLER_NEUTRAL))).toBeCloseTo(5.8, 6);
  });

  it('lässt ein trockenes Profil die volle Länge', () => {
    expect(ausschnittGrenze(8, 1, nachklang('ohne', REGLER_NEUTRAL))).toBe(8);
  });

  it('rechnet das Tempo ein – und zwar in die richtige Richtung', () => {
    /*
     * Bei „Tief" wird die Datei LÄNGER als der Ausschnitt, der Ausschnitt
     * darf also kürzer sein. Bei „Hoch" umgekehrt. Wer den Faktor verkehrt
     * herum anwendet, bekommt bei „Tief" eine Datei von zweiundzwanzig
     * Sekunden.
     */
    expect(ausschnittGrenze(8, 0.72, 0)).toBeCloseTo(5.76, 6);
    expect(ausschnittGrenze(8, 1.48, 0)).toBeCloseTo(11.84, 6);
  });

  it('lässt auch dann etwas übrig, wenn der Hall länger ist als die Grenze', () => {
    // Ein Profil, das man gar nicht mehr benutzen kann, ist schlimmer als
    // eines mit wenig Spielraum – ein Regler auf null sagt nichts.
    expect(ausschnittGrenze(2, 1, 5)).toBe(0.5);
  });

  it('bleibt für jedes Profil unter der Grenze, wenn man sie ausreizt', () => {
    /*
     * Die eigentliche Zusage, und sie gilt für alle neun Profile: Wer den
     * Ausschnitt bis an die Grenze zieht, bekommt eine Datei, die höchstens
     * so lang ist wie erlaubt. Gerechnet wird mit derselben Formel wie in
     * `tonRendern`.
     */
    const erlaubt = 8;
    for (const eintrag of KLANGPROFILE) {
      for (const hall of [0, 0.8]) {
        const regler = { ...REGLER_NEUTRAL, hall };
        const schwanz = nachklang(eintrag.name, regler);
        const ausschnitt = ausschnittGrenze(erlaubt, eintrag.tempo, schwanz);
        const datei = ausschnitt / eintrag.tempo + schwanz;
        // Nur der Mindestrest darf darüber liegen – und dann steht es auch so
        // in der Oberfläche.
        const grenze = Math.max(erlaubt, 0.5 + schwanz);
        expect(
          datei,
          `${eintrag.name} mit Hall ${hall}: ${datei.toFixed(2)} s`,
        ).toBeLessThanOrEqual(grenze + 1e-9);
      }
    }
  });
});

describe('reglerNeutral', () => {
  it('erkennt, dass nichts angefasst wurde', () => {
    // Daran hängt, ob neu geschrieben wird – und damit, ob aus 400 kB Opus
    // 14 MB WAV werden.
    expect(reglerNeutral(REGLER_NEUTRAL)).toBe(true);
    for (const schluessel of ['tonhoehe', 'verzerrung', 'tiefen', 'hoehen', 'hall'] as const) {
      expect(reglerNeutral({ ...REGLER_NEUTRAL, [schluessel]: 1 }), schluessel).toBe(false);
    }
  });
});
