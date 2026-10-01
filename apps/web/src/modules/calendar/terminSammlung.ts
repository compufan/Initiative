import {
  allowsLevel,
  LIMITS,
  type AccessLevel,
  type CalendarEventDto,
  type CollectionDto,
  type CollectionGrantDto,
  type ConversationDto,
  type CreateCollectionInput,
  type GrantableLevel,
} from '@initiative/shared';
import { ApiError } from '../../lib/api.js';

/**
 * Die Sammlung zum Termin: Anlegen, Verknüpfen, Freigeben – und die Rechnung,
 * wer danach hineinkommt.
 *
 * Alles rein und mit einspeisbaren Diensten, damit es ohne Browser prüfbar
 * ist. Der Server hat dafür keine eigene Route; der Zug besteht aus drei
 * Aufrufen, die einzeln scheitern können, und dieses Wissen steht hier an
 * einer Stelle statt verstreut in Klickbehandlern.
 */

export const NEUE_SAMMLUNG = 'Neue Sammlung';

/** Die Stufen, die sich Eingeladenen geben lassen – `own` gäbe die Verwaltung aus der Hand. */
export type TerminStufe = 'view' | 'edit';

/** … in der Wortwahl von „Teilen“. */
export const ZUGRIFF_TEXT: Record<TerminStufe, string> = {
  view: 'ansehen',
  edit: 'ansehen und ändern',
};

const STUFE_KURZ: Record<AccessLevel, string> = {
  none: 'kein Zugriff',
  view: 'ansehen',
  edit: 'ändern',
  own: 'Besitzer',
};

export function stufeKurz(stufe: AccessLevel): string {
  return STUFE_KURZ[stufe];
}

/**
 * Der Vorschlag für den Namen: der Termintitel.
 *
 * Der darf 160 Zeichen lang sein, der Name einer Sammlung nur 120 – ungekürzt
 * wäre das Feld schon beim Öffnen zu lang. Gezählt wird nach Zeichen, nicht
 * nach UTF-16-Einheiten wie bei `slice`, damit kein Emoji in der Mitte
 * durchgeschnitten wird.
 */
export function standardName(titel: string): string {
  const gekuerzt = Array.from(titel.trim()).slice(0, LIMITS.collectionNameMax).join('').trim();
  return gekuerzt || NEUE_SAMMLUNG;
}

/**
 * Hat der Server das Verknüpfen endgültig abgelehnt?
 *
 * 4xx heisst „so nicht, und ein zweites Mal wird es nicht besser“ – 403 (kein
 * Recht), 404 (Termin weg), 409. Ausgenommen sind 408 und 429: Sie sagen nur
 * „jetzt nicht“. Alles andere (kein Netz, Zeitüberschreitung, 5xx) lässt offen,
 * ob die Anfrage angekommen ist – und eine Sammlung, die der Server vielleicht
 * doch schon verknüpft hat, darf nicht weggeräumt werden.
 */
export function istEndgueltig(fehler: unknown): boolean {
  return (
    fehler instanceof ApiError &&
    fehler.status >= 400 &&
    fehler.status < 500 &&
    fehler.status !== 408 &&
    fehler.status !== 429
  );
}

/**
 * Hat der Server womöglich doch gearbeitet, obwohl keine Antwort kam?
 *
 * Bei einer Zeitüberschreitung ist die Anfrage hinausgegangen – ob die
 * Sammlung entstanden ist, weiss niemand. „Keine Verbindung“ meint dagegen
 * meist, dass sie gar nicht erst loskam.
 */
export function istUnklar(fehler: unknown): boolean {
  return (
    fehler instanceof ApiError &&
    fehler.status === 0 &&
    fehler.details instanceof DOMException &&
    fehler.details.name === 'TimeoutError'
  );
}

export interface Beteiligte {
  id: string;
  name: string;
}

/** Was der Anwender im Blatt gesehen und bestätigt hat – eine Momentaufnahme. */
export interface TerminSammlungPlan {
  terminId: string;
  /** Schon geprüft; hier wird nur noch getrimmt. */
  name: string;
  parentId: string | null;
  stufe: TerminStufe;
  personen: Beteiligte[];
}

export interface TerminSammlungDienste {
  anlegen: (body: CreateCollectionInput) => Promise<CollectionDto>;
  verknuepfen: (terminId: string, sammlungId: string) => Promise<CalendarEventDto>;
  freigeben: (sammlungId: string, userId: string, stufe: GrantableLevel) => Promise<unknown>;
  verwerfen: (sammlungId: string) => Promise<unknown>;
}

export interface Fortschritt {
  schritt: 'anlegen' | 'verknuepfen' | 'freigeben';
  erledigt: number;
  gesamt: number;
}

export type ZugErgebnis =
  | {
      art: 'fertig';
      sammlung: CollectionDto;
      termin: CalendarEventDto;
      nichtFreigegeben: Beteiligte[];
    }
  /** Nichts ist entstanden, nichts zu räumen. */
  | { art: 'nichtAngelegt'; fehler: unknown }
  | {
      art: 'nichtVerknuepft';
      sammlung: CollectionDto;
      fehler: unknown;
      /** Der Server hat ausdrücklich abgelehnt – ein neuer Versuch lohnt nicht. */
      endgueltig: boolean;
      /** Die angelegte Sammlung wurde wieder entfernt. */
      aufgeraeumt: boolean;
    };

/**
 * Schritt 2 und 3: verknüpfen, dann freigeben.
 *
 * Verknüpfen kommt VOR dem Freigeben: Das Verknüpfen hat der Anwender
 * verlangt, ein Freigabefehler ist nachholbar und sichtbar, ein verlorenes
 * Verknüpfen nicht.
 */
async function verknuepfenUndFreigeben(
  plan: TerminSammlungPlan,
  sammlung: CollectionDto,
  dienste: TerminSammlungDienste,
  beiFortschritt?: (stand: Fortschritt) => void,
): Promise<ZugErgebnis> {
  beiFortschritt?.({ schritt: 'verknuepfen', erledigt: 0, gesamt: 1 });
  let termin: CalendarEventDto;
  try {
    termin = await dienste.verknuepfen(plan.terminId, sammlung.id);
  } catch (fehler) {
    const endgueltig = istEndgueltig(fehler);
    // Nur bei einer ausdrücklichen Absage aufräumen. Bei „keine Antwort“ hat
    // der Server vielleicht doch verknüpft – dann zeigte der Termin auf eine
    // gelöschte Sammlung.
    const aufgeraeumt = endgueltig ? await verwerfen(sammlung, dienste) : false;
    return { art: 'nichtVerknuepft', sammlung, fehler, endgueltig, aufgeraeumt };
  }

  /*
   * Nacheinander, und ein Fehler bricht NICHT ab.
   *
   * Scheitert die zweite von drei Personen, sind die erste und – nach dem
   * Versuch – die dritte trotzdem freigegeben. Ein stiller Teilerfolg wäre
   * schlimmer als ein sichtbarer; deshalb die Liste der Gescheiterten.
   */
  const nichtFreigegeben: Beteiligte[] = [];
  for (const [index, person] of plan.personen.entries()) {
    beiFortschritt?.({ schritt: 'freigeben', erledigt: index, gesamt: plan.personen.length });
    try {
      await dienste.freigeben(sammlung.id, person.id, plan.stufe);
    } catch {
      nichtFreigegeben.push(person);
    }
  }
  return { art: 'fertig', sammlung, termin, nichtFreigegeben };
}

/**
 * Anlegen, verknüpfen, freigeben – in dieser Reihenfolge.
 *
 * Kein `conversationId` und keine Chat-Stufe: Rechte gehen an die gewählten
 * PERSONEN. Eine Chat-Freigabe liesse auch Abgewählte und später
 * Dazugekommene hinein. `memberLevel: 'none'` steht nur da, damit die Absicht
 * ausdrücklich ist.
 */
export async function sammlungAnlegenUndVerknuepfen(
  plan: TerminSammlungPlan,
  dienste: TerminSammlungDienste,
  beiFortschritt?: (stand: Fortschritt) => void,
): Promise<ZugErgebnis> {
  beiFortschritt?.({ schritt: 'anlegen', erledigt: 0, gesamt: 1 });
  let sammlung: CollectionDto;
  try {
    sammlung = await dienste.anlegen({
      name: plan.name.trim(),
      ...(plan.parentId ? { parentId: plan.parentId } : {}),
      memberLevel: 'none',
    });
  } catch (fehler) {
    return { art: 'nichtAngelegt', fehler };
  }
  return verknuepfenUndFreigeben(plan, sammlung, dienste, beiFortschritt);
}

/**
 * „Erneut verknüpfen“ nach einem Verknüpfen ohne Antwort: legt nichts zweites
 * an, wiederholt nur Schritt 2 und 3. Das Verknüpfen ist wiederholbar – es
 * setzt dieselbe Kennung, auch wenn es beim ersten Mal doch angekommen war.
 */
export function nochmalVerknuepfen(
  plan: TerminSammlungPlan,
  sammlung: CollectionDto,
  dienste: TerminSammlungDienste,
  beiFortschritt?: (stand: Fortschritt) => void,
): Promise<ZugErgebnis> {
  return verknuepfenUndFreigeben(plan, sammlung, dienste, beiFortschritt);
}

/** Die angelegte Sammlung wieder entfernen. `true`, wenn das gelang. */
export async function verwerfen(
  sammlung: CollectionDto,
  dienste: Pick<TerminSammlungDienste, 'verwerfen'>,
): Promise<boolean> {
  try {
    await dienste.verwerfen(sammlung.id);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */

/** Ein Glied der Kette von der obersten sichtbaren Sammlung bis zur gemeinten. */
export interface KettenGlied {
  sammlung: Pick<CollectionDto, 'id' | 'createdBy' | 'conversationId' | 'memberLevel'>;
  /** `null`, wenn die Rechte nicht zu laden waren – dann zählt nichts davon. */
  grants: CollectionGrantDto[] | null;
}

type Chats = Pick<ConversationDto, 'id' | 'members'>[];

function mitgliederVon(chats: Chats, chatId: string): Set<string> | null {
  const chat = chats.find((eintrag) => eintrag.id === chatId);
  return chat ? new Set(chat.members.map((mitglied) => mitglied.userId)) : null;
}

export interface ZugriffsLage {
  /** Je Person die höchste BELEGTE Stufe – `none`, wenn keine zu belegen ist. */
  stufen: Map<string, AccessLevel>;
  /** Wer nicht hineinkommt, in der Reihenfolge der Eingabe. */
  fehlend: string[];
}

/**
 * Wer kommt in die Sammlung hinein?
 *
 * Es zählt nur, was BELEGT ist: ein ausdrückliches Recht an die Person, ein
 * Recht an einen Chat, dessen Mitglieder man kennt, die Stufe für den
 * Herkunftschat (`memberLevel`, nicht `none`) und der Ersteller – an der
 * Sammlung selbst und an jedem sichtbaren Elternordner. Ist ein Chat nicht
 * bekannt oder ein Elternordner unsichtbar, kann sich die Rechnung also nur
 * in Richtung „fehlt“ irren, nie in Richtung „hat Zugriff“. Ein überflüssiges
 * Freigeben ist harmlos, ein behauptetes „hat Zugriff“ wäre es nicht.
 *
 * Man selbst fehlt nie – wer den Termin verwaltet, hat die Sammlung ja in
 * der Hand.
 */
export function zugriffsLage(eingabe: {
  personen: string[];
  ich: string;
  kette: KettenGlied[];
  chats: Chats;
}): ZugriffsLage {
  const { personen, ich, kette, chats } = eingabe;
  const stufen = new Map<string, AccessLevel>();

  for (const person of personen) {
    if (person === ich) continue;
    let stufe: AccessLevel = 'none';
    const heben = (neu: AccessLevel) => {
      if (allowsLevel(neu, stufe)) stufe = neu;
    };

    for (const glied of kette) {
      const { sammlung, grants } = glied;
      if (sammlung.createdBy === person) heben('own');
      for (const recht of grants ?? []) {
        // Ein Recht an einer einzelnen Datei öffnet nicht die Sammlung.
        if (recht.itemId !== null) continue;
        if (recht.userId === person) heben(recht.level);
        else if (recht.conversationId && mitgliederVon(chats, recht.conversationId)?.has(person)) {
          heben(recht.level);
        }
      }
      if (
        sammlung.conversationId &&
        sammlung.memberLevel !== 'none' &&
        mitgliederVon(chats, sammlung.conversationId)?.has(person)
      ) {
        heben(sammlung.memberLevel);
      }
    }
    stufen.set(person, stufe);
  }

  return {
    stufen,
    fehlend: [...stufen].filter(([, stufe]) => stufe === 'none').map(([id]) => id),
  };
}

export type Erbe =
  | { art: 'person'; userId: string; stufe: AccessLevel }
  | { art: 'chat'; conversationId: string; stufe: AccessLevel };

/**
 * Wer an dieser Sammlung schon Zugriff hat – und damit auch an dem, was man
 * darunter anlegt.
 *
 * Ein Unterordner erbt, was am Elternordner vergeben ist, mit derselben
 * Stufe, auch `own`. Wer „Familie“ geteilt hat, teilt auch
 * „Familie › Wochenende“ mit denselben Leuten. Ohne diese Auskunft wäre
 * „Unterordner“ eine stille Rechteausweitung in der anderen Richtung.
 *
 * Je Person bzw. Chat die höchste Stufe; Personen vor Chats.
 */
export function erbtVon(kette: KettenGlied[]): Erbe[] {
  const personen = new Map<string, AccessLevel>();
  const chats = new Map<string, AccessLevel>();
  const heben = (karte: Map<string, AccessLevel>, schluessel: string, stufe: AccessLevel) => {
    const bisher = karte.get(schluessel) ?? 'none';
    if (allowsLevel(stufe, bisher)) karte.set(schluessel, stufe);
  };

  for (const { sammlung, grants } of kette) {
    if (sammlung.createdBy) heben(personen, sammlung.createdBy, 'own');
    for (const recht of grants ?? []) {
      if (recht.itemId !== null) continue;
      if (recht.userId) heben(personen, recht.userId, recht.level);
      else if (recht.conversationId) heben(chats, recht.conversationId, recht.level);
    }
    if (sammlung.conversationId && sammlung.memberLevel !== 'none') {
      heben(chats, sammlung.conversationId, sammlung.memberLevel);
    }
  }

  return [
    ...[...personen].map(([userId, stufe]): Erbe => ({ art: 'person', userId, stufe })),
    ...[...chats].map(([conversationId, stufe]): Erbe => ({ art: 'chat', conversationId, stufe })),
  ];
}

/* ------------------------------------------------------------------------ */

/**
 * Was das Blatt in Klartext unter die Personenliste schreibt.
 *
 * Wer mit welcher Stufe hineinkommt, soll vor dem Tipp dastehen – kein
 * Recht geht an jemanden, der nicht in diesem Satz genannt ist.
 */
export function zusammenfassung(eingabe: {
  eingeladene: number;
  gewaehlt: Beteiligte[];
  stufe: TerminStufe;
}): string {
  const { eingeladene, gewaehlt, stufe } = eingabe;
  if (eingeladene === 0) return 'Sonst ist noch niemand eingeladen.';
  if (gewaehlt.length === 0) {
    return 'Nur du hast Zugriff. Die Eingeladenen sehen den Link, kommen aber nicht hinein.';
  }
  const namen = gewaehlt.map((person) => person.name).join(', ');
  const wer = gewaehlt.length === 1 ? 'bekommt 1 Person' : `bekommen ${gewaehlt.length} Personen`;
  return `Ausser dir ${wer} Zugriff (${ZUGRIFF_TEXT[stufe]}): ${namen}.`;
}

/** Die Zeile „Zugriff der Eingeladenen“ im Abschnitt Sammlung. */
export function zugriffSatz(gesamt: number, fehlend: string[]): string {
  if (gesamt === 0) return 'Ausser dir ist niemand eingeladen.';
  if (fehlend.length === 0) {
    return gesamt === 1
      ? 'Die eingeladene Person kommt hinein.'
      : `Alle ${gesamt} Eingeladenen kommen hinein.`;
  }
  const namen = fehlend.join(', ');
  if (gesamt === 1) return `Die eingeladene Person kommt nicht hinein: ${namen}.`;
  if (fehlend.length === gesamt) {
    return `Keiner der ${gesamt} Eingeladenen kommt hinein: ${namen}.`;
  }
  return `${fehlend.length} von ${gesamt} Eingeladenen kommen nicht hinein: ${namen}.`;
}
