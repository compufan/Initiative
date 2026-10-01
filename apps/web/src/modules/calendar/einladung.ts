import {
  LIMITS,
  zustellungPlanen,
  type CalendarEventDto,
  type ConversationDto,
  type TerminAntwort,
  type UserDto,
  type ZustellungDto,
  type ZustellungPlan,
} from '@initiative/shared';
import { conversationLabel } from './helpers.js';

/**
 * Die Logik hinter dem Feld „Eingeladen“ – ohne React, ohne Netz.
 *
 * Alles, was sich ohne Bildschirm prüfen lässt, steht hier: wer zur Wahl steht,
 * wie die Suche filtert, was „Alle“ und ein Gruppenchat wählen, wohin die
 * Einladung geht (die Vorschau) und was davon an den Server geschickt wird. Die
 * Komponente (`EinladungsWahl.tsx`) zeichnet nur noch. Der Grund: Es gibt im
 * Haus keine Komponententests, und eine Regel wie „der Gruppenchat bekommt nur
 * dann eine Karte, wenn alle Mitglieder eingeladen sind“ darf nicht an der
 * Oberfläche hängen, die man erst im Browser sieht.
 *
 * Ein Gedanke trägt das Ganze: **Personen und Gruppenchats sind zwei getrennte
 * Wahlen.** „Alle“ wählt Personen, keinen Gruppenchat. Ein Gruppenchat steht nur
 * dann als Ziel da, wenn man ihn ausdrücklich gewählt hat. Sonst postete „alle
 * einladen“ in jeden Gruppenchat, in dem zufällig alle Mitglieder dabei sind.
 */

/* ---------- wer zur Wahl steht ---------- */

/**
 * Mehr braucht die Liste von einer Person nicht zu wissen – und mehr soll sie
 * nicht zeigen: kein `bio`, kein `lastSeenAt`. Die Liste verrät damit nichts,
 * was die Suche nicht ohnehin preisgibt.
 */
export interface Kontakt {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
}

/** Ein Gruppenchat, in den die Karte kommen kann. */
export interface Gruppe {
  id: string;
  titel: string;
  /** Die Mitglieder ohne mich. */
  mitglieder: string[];
  /** Alle Mitglieder, mich eingerechnet – so steht es im Chip: „5 von 5“. */
  anzahl: number;
}

/** Wie viele Chats die Liste höchstens durchsucht – so viele zeigt auch die Chatliste. */
const CHATS_MAX = 300;

export function kontaktVon(
  user: Pick<UserDto, 'id' | 'displayName' | 'username' | 'avatarUrl'>,
): Kontakt {
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    avatarUrl: user.avatarUrl,
  };
}

function nachName(a: Kontakt, b: Kontakt): number {
  return (
    a.displayName.localeCompare(b.displayName, 'de', { sensitivity: 'base' }) ||
    a.username.localeCompare(b.username, 'de', { sensitivity: 'base' })
  );
}

/**
 * Die Personen, die ich ohne Suche sehen will: alle, mit denen ich mindestens
 * einen nicht archivierten Chat teile – Gruppe oder Einzel –, ohne mich.
 *
 * Das ist **im Gerät** abgeleitet und kein neuer Endpunkt: Die Mitglieder
 * stehen ohnehin im Chat-Speicher. Es gibt damit auch keine Seite, die
 * nachgeladen werden müsste, und die Liste arbeitet offline. Wer keinen
 * gemeinsamen Chat hat, erscheint nur als Suchtreffer – die Liste öffnet das
 * Verzeichnis des Servers nicht.
 *
 * Alphabetisch nach deutscher Sortierung, ohne Gross-/Kleinschreibung, und
 * **stabil**: Gewählte springen nicht nach oben, sonst wandert die Zeile unter
 * dem Finger weg.
 */
export function kontakteAus(conversations: ConversationDto[], myId: string): Kontakt[] {
  const gesehen = new Map<string, Kontakt>();
  for (const chat of conversations.slice(0, CHATS_MAX)) {
    if (chat.archived) continue;
    for (const mitglied of chat.members) {
      if (mitglied.userId === myId || gesehen.has(mitglied.userId)) continue;
      gesehen.set(mitglied.userId, kontaktVon(mitglied.user));
    }
  }
  return [...gesehen.values()].sort(nachName);
}

/**
 * Mit wem ich schon einen Einzelchat habe – auch einen archivierten.
 *
 * Der Server nimmt einen vorhandenen Einzelchat, archiviert oder nicht; nur für
 * die anderen legt er einen neuen an. Die Vorschau schätzt daraus, wie viele
 * Chats neu entstehen. Ein Einzelchat, den das Gegenüber verlassen hat (nur noch
 * ein Mitglied), zählt nicht – wie auf dem Server.
 */
export function einzelchatMit(conversations: ConversationDto[], myId: string): Set<string> {
  const personen = new Set<string>();
  for (const chat of conversations) {
    if (chat.type !== 'direct' || chat.members.length !== 2) continue;
    if (!chat.members.some((mitglied) => mitglied.userId === myId)) continue;
    const anderer = chat.members.find((mitglied) => mitglied.userId !== myId);
    if (anderer) personen.add(anderer.userId);
  }
  return personen;
}

/** Die Gruppenchats, die zur Wahl stehen: nicht archiviert, mit mindestens einem anderen Mitglied. */
export function gruppenAus(conversations: ConversationDto[], myId: string): Gruppe[] {
  const gruppen: Gruppe[] = [];
  for (const chat of conversations.slice(0, CHATS_MAX)) {
    if (chat.type !== 'group' || chat.archived) continue;
    const mitglieder = chat.members
      .filter((mitglied) => mitglied.userId !== myId)
      .map((mitglied) => mitglied.userId);
    if (mitglieder.length === 0) continue;
    gruppen.push({
      id: chat.id,
      titel: conversationLabel(chat, myId) ?? 'Gruppe',
      mitglieder,
      anzahl: chat.members.length,
    });
  }
  return gruppen.sort((a, b) => a.titel.localeCompare(b.titel, 'de', { sensitivity: 'base' }));
}

/**
 * Die Vorbelegung, wenn der Editor aus einem Chat geöffnet wird (Composer-Aktion
 * „Termin“): Im **Gruppenchat** sind alle Mitglieder gewählt und der Chat steht
 * als Ziel da; im **Einzelchat** ist das Gegenüber gewählt. Alles sichtbar und
 * abwählbar – eine Vorgabe, keine Festlegung.
 */
export function vorbelegung(
  conversations: ConversationDto[],
  chatId: string | null | undefined,
  myId: string,
): Auswahl {
  const chat = chatId ? conversations.find((eintrag) => eintrag.id === chatId) : undefined;
  if (!chat) return niemand();
  const andere = chat.members
    .filter((mitglied) => mitglied.userId !== myId)
    .map((mitglied) => mitglied.userId);
  if (chat.type === 'group') {
    if (andere.length === 0 || andere.length > LIMITS.einladungenMax) return niemand();
    return { personen: andere, gruppen: [chat.id], postenAus: [] };
  }
  return { personen: andere.slice(0, 1), gruppen: [], postenAus: [] };
}

/* ---------- suchen ---------- */

/** Ohne Akzente, ohne Gross-/Kleinschreibung: „Muller“ findet „Müller“. */
export function normalisiert(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase().trim();
}

/**
 * Filtert die Liste sofort, ohne Netz.
 *
 * Jedes Wort der Eingabe muss in Anzeigename oder Benutzername vorkommen, in
 * beliebiger Reihenfolge: „anna ad“ findet „Anna Adler“. Die Reihenfolge der
 * Liste bleibt, wie sie ist.
 */
export function filtern(kontakte: Kontakt[], suche: string): Kontakt[] {
  const woerter = normalisiert(suche).split(/\s+/).filter(Boolean);
  if (woerter.length === 0) return kontakte;
  return kontakte.filter((kontakt) => {
    const heu = normalisiert(`${kontakt.displayName} ${kontakt.username}`);
    return woerter.every((wort) => heu.includes(wort.replace(/^@/, '')));
  });
}

/* ---------- die Wahl ---------- */

export interface Auswahl {
  /** Die gewählten Personen ohne mich, in der Reihenfolge der Wahl. */
  personen: string[];
  /** Die ausdrücklich gewählten Gruppenchats („Chips“), in der Reihenfolge der Wahl. */
  gruppen: string[];
  /**
   * Gruppenchats, bei denen „dort posten“ ausgeschaltet ist. Eine Liste der
   * **Abgeschalteten**, weil der Normalfall „an“ ist – und weil der Schalter
   * dadurch auf seinen letzten Stand zurückspringt, wenn fehlende Mitglieder
   * wieder gewählt werden.
   */
  postenAus: string[];
}

export const LEERE_AUSWAHL: Auswahl = { personen: [], gruppen: [], postenAus: [] };

/** „Niemand“ leert Personen **und** Gruppen-Chips. */
export function niemand(): Auswahl {
  return { personen: [], gruppen: [], postenAus: [] };
}

/** Eine Person an- oder abwählen. */
export function personUmschalten(auswahl: Auswahl, id: string): Auswahl {
  const personen = auswahl.personen.includes(id)
    ? auswahl.personen.filter((wert) => wert !== id)
    : [...auswahl.personen, id];
  return { ...auswahl, personen };
}

/**
 * „Alle“: wählt alle Kontakte – aber höchstens `max`. Wer schon gewählt ist
 * (auch jemand von ausserhalb der Kontakte, über die Suche), bleibt.
 *
 * `abgeschnitten` heisst: Es wären mehr als `max` geworden. Die Oberfläche
 * sperrt „Alle“ dann mit einem Hinweis, statt eine willkürliche Auswahl zu
 * treffen – wer mehr als 200 Kontakte hat, soll einen Gruppenchat oder einzelne
 * Personen wählen. **Wählt keinen Gruppenchat.**
 */
export function alleWaehlen(
  kontakte: Kontakt[],
  auswahl: Auswahl,
  max: number = LIMITS.einladungenMax,
): { auswahl: Auswahl; abgeschnitten: boolean } {
  const personen = [...auswahl.personen];
  const schon = new Set(personen);
  let abgeschnitten = false;
  for (const kontakt of kontakte) {
    if (schon.has(kontakt.id)) continue;
    if (personen.length >= max) {
      abgeschnitten = true;
      break;
    }
    personen.push(kontakt.id);
    schon.add(kontakt.id);
  }
  return { auswahl: { ...auswahl, personen }, abgeschnitten };
}

/**
 * Einen Gruppenchat wählen: Seine Mitglieder (ohne mich) kommen zur Auswahl
 * hinzu, und er steht als Chip da. Danach lassen sich einzelne abwählen – der
 * Chip rechnet live nach, ob noch alle dabei sind.
 *
 * Wer den Chip erneut wählt, entfernt nur den **Chip**; die Personen bleiben
 * gewählt. Wer sie nicht mehr will, wählt sie einzeln ab oder nimmt „Niemand“.
 *
 * `zuViele`: Mit dieser Gruppe wären es mehr als `max` Eingeladene; die Wahl
 * bleibt dann unverändert.
 */
export function gruppeWaehlen(
  auswahl: Auswahl,
  gruppe: Gruppe,
  max: number = LIMITS.einladungenMax,
): { auswahl: Auswahl; zuViele: boolean } {
  if (auswahl.gruppen.includes(gruppe.id)) {
    return { auswahl: gruppeEntfernen(auswahl, gruppe.id), zuViele: false };
  }
  if (auswahl.gruppen.length >= LIMITS.einladungGruppenMax) {
    return { auswahl, zuViele: true };
  }
  const schon = new Set(auswahl.personen);
  const neu = gruppe.mitglieder.filter((id) => !schon.has(id));
  if (auswahl.personen.length + neu.length > max) return { auswahl, zuViele: true };
  return {
    auswahl: {
      ...auswahl,
      personen: [...auswahl.personen, ...neu],
      gruppen: [...auswahl.gruppen, gruppe.id],
    },
    zuViele: false,
  };
}

/** Nimmt den Chip weg; die Personen bleiben. */
export function gruppeEntfernen(auswahl: Auswahl, id: string): Auswahl {
  return {
    ...auswahl,
    gruppen: auswahl.gruppen.filter((wert) => wert !== id),
    postenAus: auswahl.postenAus.filter((wert) => wert !== id),
  };
}

/** Den Schalter „dort posten“ eines Chips umlegen. */
export function postenUmschalten(auswahl: Auswahl, id: string): Auswahl {
  return {
    ...auswahl,
    postenAus: auswahl.postenAus.includes(id)
      ? auswahl.postenAus.filter((wert) => wert !== id)
      : [...auswahl.postenAus, id],
  };
}

export interface GruppenStatus {
  /** Eingeladene Mitglieder, mich eingerechnet: Der Ersteller ist immer dabei. */
  eingeladen: number;
  /** Alle Mitglieder, mich eingerechnet. */
  gesamt: number;
  /** Wer noch fehlt (ohne mich). */
  fehlen: string[];
  /** Sind alle Mitglieder eingeladen, ist die Karte im Gruppenchat möglich. */
  vollstaendig: boolean;
}

/** Rechnet live aus Auswahl und Mitgliederliste – so stimmt der Chip immer. */
export function gruppenStatus(gruppe: Gruppe, personen: readonly string[]): GruppenStatus {
  const dabei = new Set(personen);
  const fehlen = gruppe.mitglieder.filter((id) => !dabei.has(id));
  return {
    eingeladen: gruppe.anzahl - fehlen.length,
    gesamt: gruppe.anzahl,
    fehlen,
    vollstaendig: fehlen.length === 0,
  };
}

/**
 * Gruppenchats, die man mit einem Antippen dazuwählen kann, weil ohnehin alle
 * ihre Mitglieder gewählt sind – und die noch nicht als Chip dastehen. Höchstens
 * drei; mehr wäre eine zweite Liste. Es wird nie von selbst gepostet: Ein
 * Vorschlag ist eine Frage, keine Antwort.
 */
export function vorgeschlageneGruppen(gruppen: Gruppe[], auswahl: Auswahl, max = 3): Gruppe[] {
  const dabei = new Set(auswahl.personen);
  const schon = new Set(auswahl.gruppen);
  return gruppen
    .filter(
      (gruppe) =>
        !schon.has(gruppe.id) &&
        gruppe.mitglieder.length > 0 &&
        gruppe.mitglieder.every((id) => dabei.has(id)),
    )
    .slice(0, max);
}

/** „3 von 12 Personen“ – der Zähler über der Liste. */
export function zaehlerText(gewaehlt: number, moeglich: number): string {
  return `${gewaehlt} von ${moeglich} ${moeglich === 1 ? 'Person' : 'Personen'}`;
}

/* ---------- wohin die Einladung geht ---------- */

export interface ZustellungEingabe {
  senden: boolean;
  einzelchats: boolean;
}

/** Die Gruppenchats, in die gepostet werden soll: gewählt und nicht abgeschaltet. */
export function postendeGruppen(auswahl: Auswahl): string[] {
  return auswahl.gruppen.filter((id) => !auswahl.postenAus.includes(id));
}

/**
 * Rechnet, was der Server tun wird – mit derselben Funktion wie er
 * (`zustellungPlanen`, dieselben Testfälle). Rechneten beide anders, stünde in
 * der Vorschau etwas, das nicht geschieht.
 */
export function planen(
  myId: string,
  auswahl: Auswahl,
  eingabe: ZustellungEingabe,
  gruppen: Gruppe[],
): ZustellungPlan {
  const mitglieder: Record<string, string[]> = {};
  for (const gruppe of gruppen) mitglieder[gruppe.id] = gruppe.mitglieder;
  return zustellungPlanen(
    myId,
    auswahl.personen,
    { ...eingabe, gruppen: postendeGruppen(auswahl) },
    mitglieder,
  );
}

function aufzaehlung(namen: string[], grenze = 3): string {
  if (namen.length <= grenze) {
    if (namen.length <= 1) return namen.join('');
    return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
  }
  return `${namen.slice(0, grenze).join(', ')} und ${namen.length - grenze} weitere`;
}

function mehrzahl(n: number, einzahl: string, mehr: string): string {
  return `${n} ${n === 1 ? einzahl : mehr}`;
}

export interface VorschauEingabe {
  myId: string;
  auswahl: Auswahl;
  eingabe: ZustellungEingabe;
  gruppen: Gruppe[];
  /** Mit wem ich schon einen Einzelchat habe (siehe `einzelchatMit`). */
  einzelchatMit: Set<string>;
  /** Der Name zu einer Kennung. */
  name: (id: string) => string;
}

/**
 * Was die Einladung tun wird – in Sätzen, **vor** dem Senden.
 *
 * Die Zeilen stehen in einer Live-Region (`role="status"`): Wer die Wahl
 * ändert, hört, was sich dadurch ändert. Die Antwort des Servers nennt nachher
 * die genauen Zahlen; hier wird aus den Einzelchats im Speicher geschätzt.
 */
export function vorschau(eingabe: VorschauEingabe): string[] {
  const { auswahl, gruppen, name } = eingabe;
  const personen = auswahl.personen.filter((id) => id !== eingabe.myId);
  const zeilen: string[] = [];

  if (personen.length === 0) {
    zeilen.push('Niemand ist eingeladen – der Termin steht nur in deinem Kalender.');
    return zeilen;
  }

  if (!eingabe.eingabe.senden) {
    zeilen.push(
      'Niemand bekommt eine Nachricht. Die Eingeladenen sehen den Termin nur in ihrem Kalender.',
    );
    if (personen.length > 1) zeilen.push(SICHTBARKEIT);
    return zeilen;
  }

  const plan = planen(eingabe.myId, auswahl, eingabe.eingabe, gruppen);
  const nachId = new Map(gruppen.map((gruppe) => [gruppe.id, gruppe]));

  for (const id of auswahl.gruppen) {
    const titel = nachId.get(id)?.titel ?? 'Gruppe';
    const ausgelassen = plan.ausgelassen.find((eintrag) => eintrag.chat === id);
    if (auswahl.postenAus.includes(id))
      zeilen.push(`Gruppenchat „${titel}“: keine Karte (abgewählt).`);
    else if (ausgelassen) {
      zeilen.push(
        `Gruppenchat „${titel}“: keine Karte – ${aufzaehlung(ausgelassen.fehlend.map(name))} ${ausgelassen.fehlend.length === 1 ? 'fehlt' : 'fehlen'}.`,
      );
    } else zeilen.push(`Gruppenchat „${titel}“: Karte.`);
  }

  if (plan.einzel.length > 0) {
    const neu = plan.einzel.filter((id) => !eingabe.einzelchatMit.has(id)).length;
    zeilen.push(
      neu > 0
        ? `${mehrzahl(plan.einzel.length, 'Einzelchat', 'Einzelchats')}, davon ${neu === 1 ? 'einer' : `${neu}`} neu angelegt.`
        : `${mehrzahl(plan.einzel.length, 'Einzelchat', 'Einzelchats')}.`,
    );
  } else if (!eingabe.eingabe.einzelchats) {
    zeilen.push('Keine Karten in Einzelchats.');
  }

  if (plan.gruppen.length === 0 && plan.einzel.length === 0) {
    zeilen.push(
      'Niemand bekommt eine Karte – die Eingeladenen sehen den Termin nur in ihrem Kalender.',
    );
  } else {
    zeilen.push(
      'Jede Person wird höchstens einmal benachrichtigt, auch wenn die Karte in mehreren Chats steht.',
    );
  }
  if (personen.length > 1) zeilen.push(SICHTBARKEIT);
  return zeilen;
}

const SICHTBARKEIT = 'Alle Eingeladenen sehen, wer eingeladen ist und wie geantwortet wurde.';

/* ---------- Bearbeiten: was sich ändert ---------- */

export function unterschied(
  vorher: readonly string[],
  jetzt: readonly string[],
): { neu: string[]; entfernt: string[] } {
  const war = new Set(vorher);
  const ist = new Set(jetzt);
  return {
    neu: jetzt.filter((id) => !war.has(id)),
    entfernt: vorher.filter((id) => !ist.has(id)),
  };
}

export interface AenderungsEingabe {
  myId: string;
  auswahl: Auswahl;
  eingabe: ZustellungEingabe;
  gruppen: Gruppe[];
  /** Die Eingeladenen vor dem Bearbeiten, ohne den Ersteller. */
  vorher: string[];
  /** Wer davon zugesagt hat (Zusage oder Vielleicht) – wird beim Ausladen genannt. */
  zugesagt: Set<string>;
  /** Die Gruppenchats mit Karte vor dem Bearbeiten; `null`, solange es nicht geladen ist. */
  bestehendeGruppen: string[] | null;
  einzelchatMit: Set<string>;
  name: (id: string) => string;
}

/**
 * Wie `vorschau`, aber für das Bearbeiten: Sie beschreibt den **Unterschied**
 * zum bisherigen Stand – wer neu eingeladen wird, wer ausgeladen, was mit den
 * Gruppenkarten geschieht. Wer nichts an den Einladungen ändert, bekommt keine
 * Zeile: Dann schickt der Editor auch nichts.
 */
export function aenderungsVorschau(eingabe: AenderungsEingabe): string[] {
  const { auswahl, gruppen, name } = eingabe;
  const personen = auswahl.personen.filter((id) => id !== eingabe.myId);
  const { neu, entfernt } = unterschied(eingabe.vorher, personen);
  const zeilen: string[] = [];

  if (neu.length > 0) {
    if (!eingabe.eingabe.senden) {
      zeilen.push(`Neu eingeladen: ${neu.length} – nur im Kalender, ohne Nachricht.`);
    } else {
      const neueChats = neu.filter((id) => !eingabe.einzelchatMit.has(id)).length;
      const ziel = eingabe.eingabe.einzelchats
        ? 'Karte im Einzelchat und Benachrichtigung'
        : 'Benachrichtigung, ohne Karte im Einzelchat';
      zeilen.push(
        `Neu eingeladen: ${neu.length} → ${ziel}${neueChats > 0 ? ` (${neueChats === 1 ? 'ein Einzelchat wird' : `${neueChats} Einzelchats werden`} neu angelegt)` : ''}.`,
      );
    }
  }

  if (entfernt.length > 0) {
    const zugesagt = entfernt.filter((id) => eingabe.zugesagt.has(id));
    let zeile = `Entfernt: ${entfernt.length} → ${entfernt.length === 1 ? 'verliert' : 'verlieren'} den Zugang, ${entfernt.length === 1 ? 'die Karte' : 'die Karten'} im Einzelchat ${entfernt.length === 1 ? 'wird' : 'werden'} gelöscht.`;
    if (zugesagt.length > 0) {
      zeile += ` ${aufzaehlung(zugesagt.map(name))} ${zugesagt.length === 1 ? 'hatte' : 'hatten'} zugesagt.`;
    }
    zeilen.push(zeile);
  }

  if (eingabe.bestehendeGruppen) {
    const soll = new Set(postendeGruppen(auswahl));
    const nachId = new Map(gruppen.map((gruppe) => [gruppe.id, gruppe]));
    const titel = (id: string) => nachId.get(id)?.titel ?? 'Gruppe';

    for (const id of eingabe.bestehendeGruppen) {
      if (!soll.has(id)) zeilen.push(`Die Karte im Gruppenchat „${titel(id)}“ wird gelöscht.`);
    }
    if (eingabe.eingabe.senden) {
      const plan = planen(eingabe.myId, auswahl, eingabe.eingabe, gruppen);
      for (const id of plan.gruppen) {
        if (!eingabe.bestehendeGruppen.includes(id)) {
          zeilen.push(`Gruppenchat „${titel(id)}“: Karte wird gepostet.`);
        }
      }
      for (const eintrag of plan.ausgelassen) {
        if (!eingabe.bestehendeGruppen.includes(eintrag.chat)) {
          zeilen.push(
            `Gruppenchat „${titel(eintrag.chat)}“: keine Karte – ${aufzaehlung(eintrag.fehlend.map(name))} ${eintrag.fehlend.length === 1 ? 'fehlt' : 'fehlen'}.`,
          );
        }
      }
    }
  }
  return zeilen;
}

/**
 * Was der Chip eines schon bestehenden Gruppenchats sagt, wenn inzwischen
 * Mitglieder fehlen: Die Karte bleibt stehen, aber diese Personen sehen darin
 * keinen Termin.
 */
export function bestehendeKarteHinweis(fehlen: string[], name: (id: string) => string): string {
  return `Karte steht bereits – ${aufzaehlung(fehlen.map(name))} ${fehlen.length === 1 ? 'sieht' : 'sehen'} sie nicht als Termin.`;
}

/**
 * Hat sich an Zeit oder Ort etwas geändert? Dann werden alle Eingeladenen
 * benachrichtigt – der Titel zählt nicht. Der Editor sagt es vor dem Speichern.
 */
export function zeitOrtGeaendert(
  vorher: {
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    rrule: string | null;
    location: string | null;
  },
  nachher: {
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    rrule: string | null;
    location: string | null;
  },
): 'zeit' | 'ort' | 'zeitUndOrt' | null {
  const zeit =
    new Date(vorher.startsAt).getTime() !== new Date(nachher.startsAt).getTime() ||
    new Date(vorher.endsAt).getTime() !== new Date(nachher.endsAt).getTime() ||
    vorher.allDay !== nachher.allDay ||
    (vorher.rrule ?? null) !== (nachher.rrule ?? null);
  const ort = (vorher.location?.trim() ?? '') !== (nachher.location?.trim() ?? '');
  if (zeit && ort) return 'zeitUndOrt';
  if (zeit) return 'zeit';
  if (ort) return 'ort';
  return null;
}

/* ---------- was an den Server geht ---------- */

/**
 * Der Satz nach dem Speichern: was der Server aus der Einladung gemacht hat –
 * die Zahlen der Antwort, nicht die der Vorschau (die schätzt nur).
 *
 * Beim Ändern nennt er nur die Einzelchats dieser Anfrage; die Gruppenkarten
 * zeigt `zustellung.gruppen` als Stand, nicht als Ereignis.
 */
export function speichernText(neuerTermin: boolean, zustellung: ZustellungDto | undefined): string {
  const anfang = neuerTermin ? 'Termin erstellt' : 'Termin gespeichert';
  if (!zustellung) return anfang;
  const teile: string[] = [];
  if (neuerTermin && zustellung.gruppen.length > 0) {
    teile.push(
      zustellung.gruppen.length === 1
        ? 'Karte im Gruppenchat'
        : `Karten in ${zustellung.gruppen.length} Gruppenchats`,
    );
  }
  if (zustellung.einzelchats > 0) {
    const neu =
      zustellung.neueEinzelchats > 0 ? `, davon ${zustellung.neueEinzelchats} neu angelegt` : '';
    teile.push(
      `${zustellung.einzelchats} ${zustellung.einzelchats === 1 ? 'Einzelchat' : 'Einzelchats'}${neu}`,
    );
  }
  if (zustellung.ausgelassen.length > 0) {
    teile.push(
      zustellung.ausgelassen.length === 1
        ? 'ein Gruppenchat ohne Karte, weil nicht alle Mitglieder eingeladen sind'
        : `${zustellung.ausgelassen.length} Gruppenchats ohne Karte, weil nicht alle Mitglieder eingeladen sind`,
    );
  }
  let text = teile.length > 0 ? `${anfang} – ${teile.join(', ')}.` : anfang;
  if (zustellung.ausstehend > 0) {
    text += ` ${zustellung.ausstehend === 1 ? 'Eine Einladung konnte' : `${zustellung.ausstehend} Einladungen konnten`} nicht zugestellt werden – auf der Terminseite lässt sich das erneut versuchen.`;
  }
  return text;
}

/**
 * Der Termin aus einer Antwort von Anlegen/Ändern/Ausladen: ohne `zustellung`,
 * das nur die Meldung betrifft und nicht in die Ansichten gehört.
 */
export function terminOhneZustellung(antwort: TerminAntwort): CalendarEventDto {
  const { zustellung: _zustellung, ...termin } = antwort;
  return termin;
}

/** Der Hinweis im Editor, wenn Zeit oder Ort geändert wurden. */
export function zeitOrtHinweis(art: 'zeit' | 'ort' | 'zeitUndOrt'): string {
  const was = art === 'zeit' ? 'Zeit' : art === 'ort' ? 'Ort' : 'Zeit und Ort';
  return `${was} geändert → alle Eingeladenen werden benachrichtigt.`;
}

export interface AnlegenBody {
  attendeeIds: string[];
  zustellung: { senden: boolean; einzelchats: boolean; gruppenChatIds: string[] };
  clientId: string;
}

/**
 * Die Einladungsfelder beim Anlegen.
 *
 * Immer mit `zustellung`: Ohne das Feld gälte der alte Weg – alle Mitglieder
 * eines Chats würden eingeladen, was die Wahl in der Liste zunichte machte. Nie
 * `conversationId` oder `announce`: Mit `zustellung` bestimmen die Gruppenchats
 * den Chat des Termins, und ein zusätzlicher `conversationId` wäre ein Fehler.
 *
 * `clientId` schützt vor dem Doppelsenden (Funkloch, Doppeltipp); der Editor
 * erzeugt sie beim Öffnen und behält sie für alle Wiederholungen derselben
 * Eingabe.
 */
export function anlegenBody(
  auswahl: Auswahl,
  eingabe: ZustellungEingabe,
  clientId: string,
  myId?: string,
): AnlegenBody {
  return {
    attendeeIds: auswahl.personen.filter((id) => id !== myId),
    zustellung: {
      senden: eingabe.senden,
      einzelchats: eingabe.einzelchats,
      gruppenChatIds: postendeGruppen(auswahl),
    },
    clientId,
  };
}

export interface AendernBody {
  attendeeIds?: string[];
  zustellung?: { senden: boolean; einzelchats: boolean; gruppenChatIds?: string[] };
}

function gleich(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const menge = new Set(a);
  return b.every((id) => menge.has(id));
}

/**
 * Die Einladungsfelder beim Ändern – und zwar **nur, was sich geändert hat**.
 *
 * - Wer die Einladungen nicht anfasst, sendet weder `attendeeIds` noch
 *   `zustellung`: keine versehentliche Wirkung, etwa ein Ausladen, weil die Liste
 *   noch nicht geladen war.
 * - `attendeeIds` ist der Sollzustand der Eingeladenen (ohne den Ersteller) und
 *   geht nur mit, wenn sich an den Personen etwas geändert hat.
 * - `gruppenChatIds` ist der Sollzustand der Gruppenkarten und geht **erst mit,
 *   wenn die bestehenden Karten bekannt sind** (`bestehendeGruppen` nicht
 *   `null`) – der Server lässt sie sonst unverändert. Schickte der Editor die
 *   Liste, bevor er weiss, wo der Termin schon steht, wählte er bestehende
 *   Karten versehentlich ab.
 */
export function aendernBody(
  auswahl: Auswahl,
  eingabe: ZustellungEingabe,
  ausgang: { teilnehmer: string[]; gruppen: string[] | null },
  myId?: string,
): AendernBody {
  const personen = auswahl.personen.filter((id) => id !== myId);
  const teilnehmer = ausgang.teilnehmer.filter((id) => id !== myId);
  const personenGeaendert = !gleich(personen, teilnehmer);
  const soll = postendeGruppen(auswahl);
  const gruppenGeaendert = ausgang.gruppen !== null && !gleich(soll, ausgang.gruppen);

  if (!personenGeaendert && !gruppenGeaendert) return {};

  const body: AendernBody = {
    zustellung: { senden: eingabe.senden, einzelchats: eingabe.einzelchats },
  };
  if (personenGeaendert) body.attendeeIds = personen;
  if (gruppenGeaendert) body.zustellung!.gruppenChatIds = soll;
  return body;
}
