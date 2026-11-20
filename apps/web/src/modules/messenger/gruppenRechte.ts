/**
 * Wer in einer Gruppe was darf – dieselbe Rangordnung wie im Server
 * (`modules::conversations`: `rang`, `darf_moderieren`, `nur_unter_mir`).
 *
 * Die Oberfläche zeigt nur an, was erlaubt ist; entschieden wird im Server.
 * Stehen beide Regeln an einer Stelle nebeneinander, fällt eine Abweichung
 * beim Lesen auf – und `gruppenRechte.test.ts` hält sie fest.
 */
import type { ConversationDto, ConversationMemberDto, MemberRole } from '@initiative/shared';

/** Besitzer über Admin über Mitglied. Unbekanntes zählt wie ein Mitglied. */
export function rang(rolle: MemberRole | string | undefined): number {
  return rolle === 'owner' ? 3 : rolle === 'admin' ? 2 : 1;
}

function ich(chat: ConversationDto, myId: string): ConversationMemberDto | undefined {
  return chat.members.find((mitglied) => mitglied.userId === myId);
}

export function istGruppe(chat: ConversationDto): boolean {
  return chat.type === 'group';
}

/** Moderieren gibt es nur in Gruppen und ab Admin. */
export function darfModerieren(chat: ConversationDto, myId: string): boolean {
  return istGruppe(chat) && rang(ich(chat, myId)?.role) >= 2;
}

/** Titel, Bild, Beschreibung: Admins – oder alle, wenn der Schalter es erlaubt. */
export function darfInfoAendern(chat: ConversationDto, myId: string): boolean {
  if (!istGruppe(chat) || !ich(chat, myId)) return false;
  return darfModerieren(chat, myId) || !chat.settings.nurAdminsInfo;
}

/** Darf ich in diese Gruppe schreiben? (Nur die Gruppenregel – Sperren prüft der Server.) */
export function darfSchreiben(chat: ConversationDto, myId: string): boolean {
  if (!istGruppe(chat)) return true;
  return !chat.settings.nurAdminsSenden || darfModerieren(chat, myId);
}

export interface MitgliedAktionen {
  spitzname: boolean;
  zumAdmin: boolean;
  adminEntziehen: boolean;
  besitzUebergeben: boolean;
  entfernen: boolean;
}

/**
 * Was ich mit diesem Mitglied tun darf.
 *
 * * Andere ändern oder entfernen nur Moderatoren, und nur, wer unter ihnen
 *   steht – Admins also keine Admins und nie den Besitzer.
 * * Ernennen geht bis zum eigenen Rang; Besitz nur als Übergabe durch den
 *   Besitzer.
 * * Den eigenen Spitznamen darf jeder setzen, die eigene Rolle niemand.
 */
export function mitgliedAktionen(
  chat: ConversationDto,
  myId: string,
  zielId: string,
): MitgliedAktionen {
  const keine: MitgliedAktionen = {
    spitzname: false,
    zumAdmin: false,
    adminEntziehen: false,
    besitzUebergeben: false,
    entfernen: false,
  };
  const meins = ich(chat, myId);
  const ziel = chat.members.find((mitglied) => mitglied.userId === zielId);
  if (!istGruppe(chat) || !meins || !ziel) return keine;
  if (zielId === myId) return { ...keine, spitzname: true };
  if (!darfModerieren(chat, myId)) return keine;
  const unterMir = rang(ziel.role) < rang(meins.role);
  return {
    spitzname: unterMir,
    zumAdmin: unterMir && ziel.role === 'member',
    adminEntziehen: unterMir && ziel.role === 'admin',
    besitzUebergeben: meins.role === 'owner',
    entfernen: unterMir,
  };
}

/** Lesbare Dauer für den langsamen Modus. */
export function langsamText(sekunden: number): string {
  if (sekunden <= 0) return 'Aus';
  if (sekunden % 3600 === 0) return `${sekunden / 3600} h`;
  if (sekunden % 60 === 0) return `${sekunden / 60} min`;
  return `${sekunden} s`;
}
