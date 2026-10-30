/**
 * Spielerprofile für die Tests von Pressen (kein Teil der App).
 *
 * Ein Bot entscheidet in festen Abständen anhand des Zustands, welche Tasten
 * er hält, und erzeugt damit genau die Ereignisse, die auch ein Mensch
 * erzeugen würde. So misst die Balance-Prüfung die echte Simulation und nicht
 * ausgedachte Zahlen.
 *
 * Der Regler arbeitet wie ein Mensch, der das Glas „im Gefühl“ hat: Er
 * schätzt, wo der Strahl landen würde, wünscht sich daraus ein Tempo
 * (Fehler mal Verstärkung) und drückt oder lässt gleiten, je nachdem, ob er
 * dem Wunschtempo hinterherhinkt oder darüber liegt. Gegengehalten wird nur,
 * wenn das Glas deutlich zu schnell ist.
 */
import {
  DT_MS,
  FALLZEIT_S,
  MAX_TICKS,
  MUND_HALB_X,
  MUND_HALB_Y,
  MUND_X,
  MUND_Y,
  STRAHL_GRUNDWEITE,
  STRAHL_WEITE_PRO_GRAD,
  ergebnisVon,
  kippSchwelle,
  neuerZustand,
  physikFuer,
  simBis,
  type Eingabe,
  type LaufErgebnis,
  type Physik,
  type SimZustand,
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
  /** Wunschtempo je Einheit Fehler (1/s) – größer = ungeduldiger. */
  verstaerkung: number;
  /** Ab diesem Tempounterschied (Einheiten/s) greift er zur Taste. */
  schwelle: number;
  /** Anteil der Mundgröße, innerhalb dessen er gießt (1 = bis zum Rand). */
  gussFenster: number;
  /** Ab so vielen Einheiten vor dem Ziel neigt er schon bis knapp unter die Schwelle. */
  vorneigen: number;
  /**
   * Menschliche Trägheit: Der Bot sieht den Zustand von vor so vielen Schritten
   * (Wahrnehmung + Entschluss) und schätzt den jetzigen daraus.
   */
  reaktionTicks: number;
  /** Anteil der Tasten-Verzögerung (Malus), den er einkalkuliert (0 bis 1). */
  vorhalt: number;
  /** Bleibt bei der Höhe (y) des Startplatzes: nur links/rechts, wie ohne die zweite Achse. */
  ohneTiefe?: boolean;
}

export const HASTIG: Profil = {
  zielUeber: 60,
  sofort: false,
  blickAlleTicks: 5,
  klickNachTicks: 12,
  verstaerkung: 0.8,
  schwelle: 20,
  gussFenster: 1.6,
  vorneigen: 400,
  reaktionTicks: 8,
  vorhalt: 0.5,
};
export const AUSGEWOGEN: Profil = {
  zielUeber: 20,
  sofort: false,
  blickAlleTicks: 5,
  klickNachTicks: 14,
  verstaerkung: 0.8,
  schwelle: 12,
  gussFenster: 0.9,
  vorneigen: 160,
  reaktionTicks: 8,
  vorhalt: 0.8,
};
export const VORSICHTIG: Profil = {
  zielUeber: 6,
  sofort: false,
  blickAlleTicks: 5,
  klickNachTicks: 14,
  verstaerkung: 0.8,
  schwelle: 12,
  gussFenster: 0.5,
  vorneigen: 160,
  reaktionTicks: 8,
  vorhalt: 0.8,
};

export function botLauf(
  profil: Profil,
  verzoegerungMs = 0,
  driftSeed = 0,
): { ergebnis: LaufErgebnis | null; eingaben: Eingabe[] } {
  const eingaben: Eingabe[] = [];
  let z = neuerZustand();
  const haelt: Record<Taste, boolean> = {
    links: false,
    rechts: false,
    hoch: false,
    runter: false,
    neigen: false,
  };
  const setze = (was: Taste, unten: boolean, tick: number) => {
    if (haelt[was] === unten) return;
    haelt[was] = unten;
    eingaben.push({ t: tick * DT_MS + 1, was, unten });
  };
  const achse = (
    fehler: number,
    v: number,
    minus: Taste,
    plus: Taste,
    tick: number,
    physik: Physik,
  ) => {
    // Wohin das Glas gleiten würde, wenn man jetzt losließe: Tempo durch
    // Dämpfung. Liegt das Ziel dahinter, drücken; davor, gegenhalten; sonst
    // gleiten lassen. `verstaerkung` skaliert die Gleitstrecke (Gefühl für die
    // Trägheit), `schwelle` ist die Toleranz in Einheiten.
    const gleit = (v * profil.verstaerkung) / (physik.daempfung * 2.2);
    const rest = fehler - gleit;
    setze(plus, rest > profil.schwelle, tick);
    setze(minus, rest < -profil.schwelle, tick);
  };

  let klickTick: number | null = null;
  let geklickt = false;
  const verlauf: SimZustand[] = [];
  const physik = physikFuer(verzoegerungMs);

  while (!z.fertig && z.tick < MAX_TICKS) {
    const k = z.tick;
    verlauf.push(z);
    if (k % profil.blickAlleTicks === 0) {
      // Gesehen wird der Zustand von vor `reaktionTicks`; daraus schätzt der
      // Bot den jetzigen und die Verzögerung der Tasten dazu.
      const alt = verlauf[Math.max(0, verlauf.length - 1 - profil.reaktionTicks)]!;
      const voraus = (profil.reaktionTicks * DT_MS + verzoegerungMs * profil.vorhalt) / 1000;
      const sx = alt.x + alt.vx * voraus;
      const sy = alt.y + alt.vy * voraus;
      const schwelleGrad = kippSchwelle(alt.fuellung);
      const ueberSoll = profil.sofort ? 0 : profil.zielUeber;
      const reichweite = STRAHL_GRUNDWEITE + STRAHL_WEITE_PRO_GRAD * Math.min(ueberSoll, 40);
      // Wo das Glas stehen muss, damit der Strahl (samt mitfliegender
      // Geschwindigkeit) im Mund landet.
      const fehlerX = MUND_X - (sx + alt.vx * FALLZEIT_S);
      const fehlerY = MUND_Y + reichweite - (sy + alt.vy * FALLZEIT_S);
      if (!profil.sofort || alt.fuellung > 0) {
        achse(fehlerX, alt.vx, 'links', 'rechts', k, physik);
        // Auch beim Gießen gilt: y wächst nach unten, also „runter“ = plus.
        if (!profil.ohneTiefe) achse(fehlerY, alt.vy, 'hoch', 'runter', k, physik);
      }

      const naheX = Math.abs(fehlerX) < MUND_HALB_X * profil.gussFenster;
      const naheY = profil.ohneTiefe || Math.abs(fehlerY) < MUND_HALB_Y * profil.gussFenster;
      const ausgerichtet = naheX && naheY && Math.abs(alt.vx) < 90 && Math.abs(alt.vy) < 90;
      const entfernung = Math.hypot(fehlerX, fehlerY);
      let sollNeigung: number;
      if (profil.sofort || ausgerichtet) {
        sollNeigung = schwelleGrad + profil.zielUeber;
      } else if (entfernung < profil.vorneigen) {
        sollNeigung = schwelleGrad - 4;
      } else {
        sollNeigung = 0;
      }
      // Die Drehung läuft nach: der Bot nimmt die Taste etwas früher weg.
      const vorhalt = alt.neigung + alt.neigungV * (0.12 + voraus);
      setze('neigen', alt.fuellung > 0 && vorhalt < sollNeigung, k);
    }
    if (z.leerTick != null && klickTick == null) klickTick = z.leerTick + profil.klickNachTicks;
    if (klickTick != null && k >= klickTick && !geklickt) {
      geklickt = true;
      eingaben.push({ t: k * DT_MS + 1, was: 'abstellen' });
    }
    z = simBis(z, eingaben, verzoegerungMs, k + 1, driftSeed);
  }
  return { ergebnis: ergebnisVon(z), eingaben };
}
