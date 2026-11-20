import type { ConversationDto, ErwaehnbarePerson, MessageMetadata } from '@initiative/shared';
import { ALLE_KENNUNG } from '@initiative/shared';
import { memberName } from './helpers.js';
import { darfModerieren, istGruppe } from './gruppenRechte.js';

/**
 * Wer sich in diesem Chat erwähnen lässt: alle Mitglieder unter dem Namen,
 * den ich für sie sehe (Spitzname vor Anzeigename), mit Benutzernamen für die
 * Suche. In einer Gruppe, in der ich Admin bin, dazu „@alle“.
 */
export function erwaehnbare(
  conversation: ConversationDto | null,
  myId: string,
): ErwaehnbarePerson[] {
  if (!conversation) return [];
  const personen: ErwaehnbarePerson[] = conversation.members.map((member) => ({
    userId: member.userId,
    name: memberName(member),
    username: member.user.username,
  }));
  if (istGruppe(conversation) && darfModerieren(conversation, myId)) {
    personen.push({ userId: ALLE_KENNUNG, name: 'alle', username: 'alle' });
  }
  return personen;
}

/** Die Erwähnten einer Nachricht mit ihren Namen – für die Darstellung. */
export function erwaehnteIn(
  metadata: MessageMetadata | undefined,
  conversation: ConversationDto | null,
): ErwaehnbarePerson[] {
  const ids = metadata?.mentions ?? [];
  if (ids.length === 0 || !conversation) return [];
  const aus: ErwaehnbarePerson[] = [];
  for (const id of ids) {
    const member = conversation.members.find((m) => m.userId === id);
    if (!member) continue;
    // Beide Namen: Geschrieben wurde der des Absenders (sein Spitzname für
    // die Person kann ein anderer sein), gezeigt wird, was im Text steht.
    aus.push({ userId: id, name: memberName(member) });
    if (member.user.displayName !== memberName(member)) {
      aus.push({ userId: id, name: member.user.displayName });
    }
  }
  return aus;
}
