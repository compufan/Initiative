/**
 * Gruppenverwaltung, Einladungslinks, Chatliste je Person, Sperren, Meldungen
 * und Geräteliste.
 *
 * Eine eigene Datei neben `api.ts`: Sie gehört zu genau diesen Funktionen und
 * benutzt denselben `request` (Token, Erneuerung, Fehlertexte) – der Vertrag
 * bleibt an einer Stelle je Funktion statt in einer Datei, an der alle
 * gleichzeitig schreiben.
 */
import type {
  BeitrittErgebnis,
  BeitrittVorschauDto,
  BeitrittsanfrageDto,
  ChatOrdnerDto,
  ConversationDto,
  EinladungslinkDto,
  MeldeGrund,
  MeldeStatus,
  MeldungDto,
  SitzungDto,
  UserDto,
} from '@initiative/shared';
import { request } from './api.js';

interface Liste<T> {
  items: T[];
}

export const verwaltung = {
  gruppe: {
    /** Gruppeninfo, Schalter und alles Persönliche – ein PATCH. */
    aendern: (id: string, body: Record<string, unknown>) =>
      request<ConversationDto>('PATCH', `/conversations/${id}`, { body }),
    mitglied: (id: string, userId: string, body: Record<string, unknown>) =>
      request<ConversationDto>('PATCH', `/conversations/${id}/members/${userId}`, { body }),
    entfernen: (id: string, userId: string) =>
      request<void>('DELETE', `/conversations/${id}/members/${userId}`),
  },
  links: {
    liste: (id: string) =>
      request<Liste<EinladungslinkDto>>('GET', `/conversations/${id}/einladungen`),
    anlegen: (
      id: string,
      body: { gueltigStunden?: number | null; maxUses?: number | null; freigabe: boolean },
    ) => request<EinladungslinkDto>('POST', `/conversations/${id}/einladungen`, { body }),
    zurueckziehen: (id: string, linkId: string) =>
      request<void>('DELETE', `/conversations/${id}/einladungen/${linkId}`),
    anfragen: (id: string) =>
      request<Liste<BeitrittsanfrageDto>>('GET', `/conversations/${id}/anfragen`),
    entscheiden: (id: string, anfrageId: string, annehmen: boolean) =>
      request<void>('POST', `/conversations/${id}/anfragen/${anfrageId}`, {
        body: { annehmen },
      }),
    vorschau: (token: string) =>
      request<BeitrittVorschauDto>('GET', `/beitritt/${encodeURIComponent(token)}`),
    beitreten: (token: string) =>
      request<BeitrittErgebnis>('POST', `/beitritt/${encodeURIComponent(token)}`),
  },
  liste: {
    leeren: (id: string) => request<ConversationDto>('POST', `/conversations/${id}/leeren`),
    ausblenden: (id: string) => request<void>('POST', `/conversations/${id}/ausblenden`),
    angeheftetOrdnen: (ids: string[]) =>
      request<void>('PUT', '/conversations/angeheftet', { body: { ids } }),
    ordner: () => request<Liste<ChatOrdnerDto>>('GET', '/chat-ordner'),
    ordnerAnlegen: (body: { name: string; chats: string[] }) =>
      request<ChatOrdnerDto>('POST', '/chat-ordner', { body }),
    ordnerAendern: (id: string, body: { name?: string; chats?: string[]; position?: number }) =>
      request<ChatOrdnerDto>('PATCH', `/chat-ordner/${id}`, { body }),
    ordnerLoeschen: (id: string) => request<void>('DELETE', `/chat-ordner/${id}`),
  },
  sperren: {
    liste: () => request<Liste<UserDto>>('GET', '/blockiert'),
    blockieren: (userId: string) => request<void>('PUT', `/users/${userId}/block`),
    freigeben: (userId: string) => request<void>('DELETE', `/users/${userId}/block`),
    melden: (body: { userId?: string; messageId?: string; grund: MeldeGrund; freitext?: string }) =>
      request<void>('POST', '/meldungen', { body }),
    meldungen: (status?: MeldeStatus) =>
      request<Liste<MeldungDto>>('GET', '/admin/meldungen', { query: { status } }),
    meldungBearbeiten: (id: string, body: { status?: MeldeStatus; notiz?: string }) =>
      request<MeldungDto>('PATCH', `/admin/meldungen/${id}`, { body }),
  },
  sitzungen: {
    liste: () => request<Liste<SitzungDto>>('GET', '/auth/sitzungen'),
    beenden: (id: string) => request<void>('DELETE', `/auth/sitzungen/${id}`),
    andereBeenden: () => request<{ beendet: number }>('POST', '/auth/sitzungen/andere'),
  },
};
