/**
 * Spielerprofile für die Tests von Pressen (kein Teil der App).
 *
 * Ein Bot entscheidet in festen Abständen anhand des Zustands, welche Tasten
 * er hält, und erzeugt damit genau die Ereignisse, die auch ein Mensch
 * erzeugen würde. So misst die Balance-Prüfung die echte Simulation und nicht
 * ausgedachte Zahlen.
 */
import {
  DT_MS,
  GLAS_BESCHLEUNIGUNG,
  MAX_TICKS,
  MUND_X,
  kippSchwelle,
  neuerZustand,
  simBis,
  ergebnisVon,
  type Eingabe,
  type LaufErgebnis,
  type Taste,
} from './pressen-sim.js';

export interface Profil {
  /** Grad über der Kippschwelle, die der Bot beim Gießen anstrebt. */
  zielUeber: number;
  /** Gießt schon beim Anfahren (hastig), statt erst über dem Mund. */
  sofort: boolean;
  /** Alle so viele Schritte schaut der Bot hin (menschliche Reaktion). */
  blickAlleTicks: number;
  /** Schritte, bis er nach „Glas leer“ klickt. */
  klickNachTicks: number;
}

export const HASTIG: Profil = {
  zielUeber: 200,
  sofort: true,
  blickAlleTicks: 5,
  klickNachTicks: 12,
};
export const AUSGEWOGEN: Profil = {
  zielUeber: 12,
  sofort: false,
  blickAlleTicks: 5,
  klickNachTicks: 14,
};
export const VORSICHTIG: Profil = {
  zielUeber: 2,
  sofort: false,
  blickAlleTicks: 5,
  klickNachTicks: 14,
};

export function botLauf(
  profil: Profil,
  verzoegerungMs = 0,
): { ergebnis: LaufErgebnis | null; eingaben: Eingabe[] } {
  const eingaben: Eingabe[] = [];
  let z = neuerZustand();
  const haelt: Record<Taste, boolean> = { links: false, rechts: false, neigen: false };
  const setze = (was: Taste, unten: boolean, tick: number) => {
    if (haelt[was] === unten) return;
    haelt[was] = unten;
    eingaben.push({ t: tick * DT_MS + 1, was, unten });
  };
  let klickTick: number | null = null;
  let geklickt = false;

  while (!z.fertig && z.tick < MAX_TICKS) {
    const k = z.tick;
    if (k % profil.blickAlleTicks === 0) {
      // Wer weiß, dass die Tasten hinterherhinken, hält früher an.
      const halt =
        z.x + (z.vx * verzoegerungMs) / 1000 + (z.vx * Math.abs(z.vx)) / (2 * GLAS_BESCHLEUNIGUNG);
      const fehl = MUND_X - halt;
      setze('rechts', fehl > 10, k);
      setze('links', fehl < -10, k);
      const ueberMund = Math.abs(z.x - MUND_X) < 25 && Math.abs(z.vx) < 120;
      const soll =
        (ueberMund || profil.sofort) && z.neigung < kippSchwelle(z.fuellung) + profil.zielUeber;
      setze('neigen', soll && z.fuellung > 0, k);
    }
    if (z.leerTick != null && klickTick == null) klickTick = z.leerTick + profil.klickNachTicks;
    if (klickTick != null && k >= klickTick && !geklickt) {
      geklickt = true;
      eingaben.push({ t: k * DT_MS + 1, was: 'abstellen' });
    }
    z = simBis(z, eingaben, verzoegerungMs, k + 1);
  }
  return { ergebnis: ergebnisVon(z), eingaben };
}
