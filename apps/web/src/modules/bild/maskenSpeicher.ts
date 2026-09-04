/**
 * Der Zwischenspeicher zwischen Dokument und Renderer.
 *
 * Er beantwortet eine einzige Frage, und von ihr hängt ab, ob die Regler
 * eines Bereichs bedienbar sind: **Muss die Maske neu gerastert werden?**
 *
 * Fast nie. Wer an „Belichtung“ zieht, ändert die Maske nicht – aber ohne
 * diesen Speicher rasterte jedes Bild alle Teile aller Bereiche neu. Bei
 * einem 1024er Raster und vier Bereichen sind das über drei Millionen
 * Rasterpunkte je Bild, für ein Ergebnis, das sich nicht geändert hat.
 *
 * Zwei Ebenen, weil es zwei verschiedene „unverändert“ gibt:
 *
 * 1. **Je Teil**, verglichen über `teilSchluessel`. Diese Ebene überlebt,
 *    dass `docKopie` bei jedem Rückgängig-Schritt neue Teilobjekte anlegen
 *    *könnte* – verglichen wird der Inhalt, nicht die Identität.
 * 2. **Je `teile`-Feld**, verglichen über die Objektidentität (`WeakMap`).
 *    Ändert sich nur ein Regler, ist das Feld dasselbe Objekt, und das
 *    gefaltete Ergebnis steht sofort bereit. `docKopie` reicht `teile`
 *    ausdrücklich per Referenz weiter, genau dafür.
 *
 * Modulzustand, aber ohne DOM – also unter vitest prüfbar. Das ist kein
 * Zufall: Ein Zwischenspeicher, der zu viel behält, liefert altes Bild ohne
 * jede Fehlermeldung, und dagegen hilft nur eine Prüfung.
 */

import {
  MASKEN_KANTE,
  felderFalten,
  naechsteMarke,
  rasterFuer,
  strichStempeln,
  teilBauen,
  teilSchluessel,
  type Raster,
} from './maske.js';
import type { Bereich, BildDoc, Maskenteil, PinselTeil, Bereichston } from './doc.js';
import { farbNeutral, istNeutral, tonSchluessel, type Anpassung } from './ton.js';

/** Eine fertig gerasterte Maske. `stand` steigt, sobald sich `feld` ändert. */
export interface Maskenfeld {
  raster: Raster;
  feld: Uint8Array;
  /**
   * Die Ersatzidentität des Feldes.
   *
   * Ein `Uint8Array` lässt sich nicht in einen Schlüsselstring schreiben – er
   * würde zu `[object Object]`, und der Merkzettel des Renderers lieferte
   * fortan alte Bildpunkte, ohne dass irgendwo etwas kaputt aussähe.
   */
  stand: number;
}

export interface GerechneterBereich {
  id: string;
  maske: Maskenfeld;
  anpassung: Bereichston;
}

export interface Szene {
  bereiche: GerechneterBereich[];
  schluessel: string;
}

/** Zählwerk für die Prüfungen: wie oft wirklich gerechnet wurde. */
export const zaehler = { teile: 0, falten: 0 };

/* ---------- Ebene 1: je Teil ---------- */

interface Teilzettel {
  schluessel: string;
  feld: Uint8Array;
  /** Nur bei Pinselteilen: wieviele Punkte des letzten Strichs schon drin sind. */
  striche: number;
  punkte: number;
}

const teilzettel = new Map<string, Teilzettel>();

/** Die Kennung eines Pinselteils ohne die Länge seines letzten Strichs. */
const teilzettelRumpf = new Map<string, string>();

/** Die Kennung eines Pinselteils OHNE die Länge seines letzten Strichs. */
function pinselRumpf(teil: Maskenteil & PinselTeil): string {
  const bis = teil.striche.length - 1;
  return (
    `${teil.id}|${teil.modus}|${teil.umkehren}|` +
    teil.striche
      .map((s, i) => `${s.breite},${s.haerte},${s.abziehen},${i < bis ? s.punkte.length : 'x'}`)
      .join(';')
  );
}

function feldFuerTeil(teil: Maskenteil, raster: Raster): Uint8Array {
  const schluessel = `${raster.breite}x${raster.hoehe}|${teilSchluessel(teil)}`;
  const alt = teilzettel.get(teil.id);
  if (alt && alt.schluessel === schluessel) return alt.feld;

  /*
   * Ein wachsender Pinselstrich wird fortgeschrieben statt neu gebaut.
   *
   * Das ist der einzige Fall, der während einer Handbewegung sechzigmal in
   * der Sekunde auftritt: Beim Malen kommt je Bild ein Punkt dazu. Alles neu
   * zu stempeln hiesse, einen Strich mit dreihundert Punkten dreihundertmal
   * zu zeichnen.
   *
   * Nur ohne `umkehren`: Ein umgekehrtes Feld lässt sich nicht fortschreiben,
   * weil `strichStempeln` mit `max` arbeitet und die Umkehrung erst danach
   * kommt.
   */
  if (teil.art === 'pinsel' && !teil.umkehren && alt && teil.striche.length > 0) {
    const rumpf = pinselRumpf(teil);
    const letzter = teil.striche[teil.striche.length - 1];
    if (
      alt.schluessel.startsWith(`${raster.breite}x${raster.hoehe}|`) &&
      alt.striche === teil.striche.length &&
      alt.punkte < letzter.punkte.length &&
      teilzettelRumpf.get(teil.id) === rumpf
    ) {
      // `punkte` zählt Koordinatenpaare; `strichStempeln` erwartet den Index
      // des ersten Punktes, ab dem noch gestempelt werden muss. Das ist der
      // vorletzte bekannte – sonst fehlte genau ein Segment.
      strichStempeln(alt.feld, raster, letzter, Math.max(0, alt.punkte / 2 - 1));
      zaehler.teile += 1;
      teilzettel.set(teil.id, {
        schluessel,
        feld: alt.feld,
        striche: teil.striche.length,
        punkte: letzter.punkte.length,
      });
      return alt.feld;
    }
  }

  const feld = teilBauen(teil, raster);
  zaehler.teile += 1;
  const letzter = teil.art === 'pinsel' ? teil.striche[teil.striche.length - 1] : undefined;
  teilzettel.set(teil.id, {
    schluessel,
    feld,
    striche: teil.art === 'pinsel' ? teil.striche.length : 0,
    punkte: letzter ? letzter.punkte.length : 0,
  });
  if (teil.art === 'pinsel') teilzettelRumpf.set(teil.id, pinselRumpf(teil));
  return feld;
}

/* ---------- Ebene 2: je Teileliste ---------- */

const faltzettel = new WeakMap<readonly Maskenteil[], Maskenfeld>();

function maskeFuer(bereich: Bereich, raster: Raster): Maskenfeld {
  const alt = faltzettel.get(bereich.teile);
  if (alt && alt.raster.breite === raster.breite && alt.raster.hoehe === raster.hoehe) {
    return alt;
  }
  // Die Teilfelder kommen aus Ebene 1; gefaltet wird mit derselben Vorschrift
  // wie in `teileFalten`, nur ohne sie noch einmal zu bauen.
  const felder = bereich.teile.map((teil) => feldFuerTeil(teil, raster));
  const feld = felderFalten(bereich.teile, felder, raster.breite * raster.hoehe);
  zaehler.falten += 1;
  const maske: Maskenfeld = { raster, feld, stand: naechsteMarke() };
  faltzettel.set(bereich.teile, maske);
  return maske;
}

/* ---------- die Aussenseite ---------- */

/** Ob ein Bereich überhaupt etwas tut. */
function bereichWirkt(bereich: Bereich): boolean {
  if (!bereich.aktiv) return false;
  if (bereich.teile.length === 0) return false;
  return !farbNeutral(bereich.anpassung) || bereich.anpassung.unschaerfe !== 0;
}

/**
 * Übersetzt das Dokument in das, was der Renderer braucht.
 *
 * Die **einzige** Stelle, an der aussortiert und normiert wird. Beide
 * Renderwege – Grafikeinheit und Prozessor – bekommen dieselbe `Szene`; ein
 * Randfall, den nur einer von beiden kennt, kann so gar nicht entstehen.
 */
export function szeneBauen(doc: BildDoc, breite: number, hoehe: number): Szene {
  const wirksam = doc.bereiche.filter(bereichWirkt);
  if (wirksam.length === 0) return leereSzene(doc.anpassung);
  const raster = rasterFuer(breite, hoehe, MASKEN_KANTE);
  const bereiche = wirksam.map((bereich) => ({
    id: bereich.id,
    maske: maskeFuer(bereich, raster),
    anpassung: bereich.anpassung,
  }));
  return { bereiche, schluessel: szeneSchluessel(doc.anpassung, bereiche) };
}

/**
 * Die Kennung der ganzen Szene.
 *
 * Ohne Bereiche ist sie **Byte für Byte** `tonSchluessel(global)`. Das ist
 * Absicht: Für ein Bild ohne örtliche Anpassungen verhält sich der Merkzettel
 * des Renderers dann genau wie vorher.
 */
export function szeneSchluessel(global: Anpassung, bereiche: GerechneterBereich[]): string {
  const grund = tonSchluessel(global);
  if (bereiche.length === 0) return grund;
  return (
    grund +
    '#' +
    bereiche
      .map(
        (b) =>
          `${b.id}@${b.maske.stand}|` +
          `${b.anpassung.belichtung},${b.anpassung.kontrast},${b.anpassung.lichter},` +
          `${b.anpassung.tiefen},${b.anpassung.schwarz},${b.anpassung.waerme},` +
          `${b.anpassung.toenung},${b.anpassung.saettigung},${b.anpassung.dynamik},` +
          `u:${b.anpassung.unschaerfe}`,
      )
      .join('#')
  );
}

function leereSzene(global: Anpassung): Szene {
  return { bereiche: [], schluessel: tonSchluessel(global) };
}

/**
 * Ob gar nichts zu rechnen ist.
 *
 * Daran hängt mehr als eine gesparte Rechnung: Der Renderer gibt bei „nichts
 * zu tun“ das **Quellbild selbst** zurück, und eine Ebene darüber hängt an
 * genau dieser Objektidentität die Umrechnung der Verpixel-Ausschnitte
 * (`quellSkala`). Ein Bereich, der nur `unschaerfe` setzt, ist deshalb
 * ausdrücklich **nicht** neutral, obwohl seine Farbregler alle auf null
 * stehen.
 */
export function szeneNeutral(a: Anpassung, szene: Szene): boolean {
  return istNeutral(a) && szene.bereiche.length === 0;
}

/** Nur für Prüfungen und den Editorwechsel: alles vergessen. */
export function speicherLeeren(): void {
  teilzettel.clear();
  teilzettelRumpf.clear();
  zaehler.teile = 0;
  zaehler.falten = 0;
}
