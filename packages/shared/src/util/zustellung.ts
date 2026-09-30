/**
 * Wohin eine Termin-Einladung geht – die Spiegelung von `planen` in
 * `apps/api/src/services/einladen.rs`.
 *
 * Die Oberfläche zeigt vor dem Senden, wohin die Einladung geht, und der Server
 * entscheidet danach. Rechnen beide anders, steht in der Vorschau etwas, das
 * nicht geschieht. Darum lesen beide Tests dieselbe Datei
 * (`testdaten/zustellung.json`).
 *
 * Die Regeln:
 *
 * - Einzelkarten für jede eingeladene Person, wenn `senden && einzelchats`.
 * - Eine Gruppenkarte für jeden **ausdrücklich gewählten** Gruppenchat, wenn
 *   `senden` und alle Mitglieder (ausser dem Ersteller) eingeladen sind. Nie in
 *   einen nicht gewählten Gruppenchat, auch wenn zufällig alle seine Mitglieder
 *   eingeladen sind: Sonst postete „alle einladen“ in jeden Gruppenchat.
 */

export interface ZustellungWunsch {
  /** `false`: niemand bekommt eine Karte oder Benachrichtigung; nur Kalender. */
  senden: boolean;
  /** Karte in die Einzelchats. */
  einzelchats: boolean;
  /** Gruppenchats, in die die Karte soll – in Auswahlreihenfolge. */
  gruppen: readonly string[];
}

export interface ZustellungPlan {
  /** Gruppenchats, in die die Karte gestellt wird. */
  gruppen: string[];
  /** Gewünschte Gruppenchats, in denen nicht alle eingeladen sind – mit den Fehlenden. */
  ausgelassen: { chat: string; fehlend: string[] }[];
  /** Personen mit Einzelkarte (ohne Ersteller). */
  einzel: string[];
}

/**
 * Rechnet aus Wunsch und Einladungsliste, wohin die Karten gehen.
 *
 * `mitglieder` kennt für jeden gewünschten Gruppenchat dessen Mitglieder. Ein
 * Chat ohne weitere Mitglieder als den Ersteller zählt als „alle eingeladen“.
 */
export function zustellungPlanen(
  ersteller: string,
  personen: readonly string[],
  wunsch: ZustellungWunsch,
  mitglieder: Readonly<Record<string, readonly string[]>>,
): ZustellungPlan {
  if (!wunsch.senden) return { gruppen: [], ausgelassen: [], einzel: [] };

  const eingeladen = new Set<string>();
  const reihenfolge: string[] = [];
  for (const person of personen) {
    if (person !== ersteller && !eingeladen.has(person)) {
      eingeladen.add(person);
      reihenfolge.push(person);
    }
  }

  const gesehen = new Set<string>();
  const gruppen: string[] = [];
  const ausgelassen: { chat: string; fehlend: string[] }[] = [];
  for (const chat of wunsch.gruppen) {
    if (gesehen.has(chat)) continue;
    gesehen.add(chat);
    const fehlend = (mitglieder[chat] ?? []).filter(
      (person) => person !== ersteller && !eingeladen.has(person),
    );
    if (fehlend.length === 0) gruppen.push(chat);
    else ausgelassen.push({ chat, fehlend });
  }

  return { gruppen, ausgelassen, einzel: wunsch.einzelchats ? reihenfolge : [] };
}
