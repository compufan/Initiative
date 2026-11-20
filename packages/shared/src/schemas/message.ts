import { z } from 'zod';
import { LIMITS, MESSAGE_TYPES, type MessageType } from '../constants.js';
import type { AttachmentDto } from './media.js';
import type { PollDto } from './poll.js';
import type { CalendarEventDto } from './calendar.js';
import type { GameSessionDto } from './game.js';
import type { StickerDto } from './sticker.js';

export interface ReactionDto {
  emoji: string;
  userIds: string[];
}

/**
 * Structured extras for non-text messages. Everything is optional so that
 * additional message types introduced by future modules stay backwards
 * compatible with older clients (they fall back to rendering `body`).
 */
export interface MessageMetadata {
  stickerId?: string;
  pollId?: string;
  eventId?: string;
  /**
   * Eine Termin-Karte, die der Erinnerungsdienst gesendet hat; `nummer` zählt je Person.
   * `art: 'vorab'` ist die „Erinnerung vor dem Termin“ (nummer 1, `minuten` vor dem
   * Beginn); ohne `art` ist es die Erinnerung an eine ausstehende Antwort.
   */
  erinnerung?: { nummer: number; art?: 'vorab'; minuten?: number };
  gameSessionId?: string;
  forwardedFrom?: { conversationId: string; messageId: string };
  /**
   * Weitergeleitet – vom Server gesetzt (`/messages/{id}/weiterleiten`), nie
   * vom Client. `von` ist der Name des ersten Absenders, wenn die Herkunft
   * gezeigt werden soll; fehlt er, steht nur „Weitergeleitet“.
   */
  weitergeleitet?: { von?: string };
  /** System messages: machine readable event describing what happened. */
  system?: { kind: string; actorId?: string; targetIds?: string[]; value?: string };
  /** Free-form space reserved for feature modules. Never dropped by the server. */
  module?: Record<string, unknown>;
  /** Erwähnte Personen (Kennungen) – nur Mitglieder des Chats, höchstens 50. */
  mentions?: string[];
  /** „@alle“ – nur Admins in Gruppen, vom Server gebremst. */
  mentionsAlle?: boolean;
  /** Einmal ansehbares Foto/Video: keine Adresse, keine Vorschau. */
  einmalAnsehen?: boolean;
  /** Vom Server je Betrachter: ob ICH es geöffnet habe, wie viele andere. */
  einmalStatus?: { ichGeoeffnet: boolean; geoeffnet: number };
  /** Link-Vorschau – vom Absender erzeugt, Bild aus dem eigenen Speicher. */
  linkVorschau?: LinkVorschau;
  /** Kontaktkarte (Art `contact`): die geteilte Person. */
  kontakt?: { userId: string };
  /** Vom Server je Betrachter: das Profil der geteilten Person (oder null). */
  kontaktProfil?: KontaktProfil | null;
  /** Standort (Art `location`), einmalig oder live. */
  standort?: Standort;
}

export interface LinkVorschau {
  url: string;
  titel?: string | null;
  beschreibung?: string | null;
  seite?: string | null;
  bildId?: string | null;
  /** Vom Server ergänzt: das Bild im eigenen Medienspeicher. */
  bildUrl?: string | null;
}

export interface KontaktProfil {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  accent: string;
}

export interface Standort {
  lat: number;
  lon: number;
  /** Genauigkeit in Metern. */
  genauigkeit?: number;
  adresse?: string;
  /**
   * Live-Freigabe. Beim Senden nur `minuten` (15 oder 60); Ende (`bis`) und
   * letzte Aktualisierung setzt der Server.
   */
  live?: { minuten: number; bis?: string; aktualisiert?: string; beendet?: string };
}

/** Eine geplante Nachricht („Später senden“) – nur der Absender sieht sie. */
export interface GeplantDto {
  id: string;
  conversationId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  body: string | null;
  attachmentIds: string[];
  replyToId: string | null;
  metadata: MessageMetadata;
  sendenUm: string;
  zeitzone: string;
  status: 'geplant' | 'sendet' | 'gesendet' | 'fehlgeschlagen';
  fehler: string | null;
  messageId: string | null;
  createdAt: string;
}

/** Bearbeitungsverlauf einer Nachricht: frühere Fassungen und die aktuelle. */
export interface BearbeitungsverlaufDto {
  items: { body: string | null; am: string }[];
  aktuell: { body: string | null; am: string };
  gesendetAm: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string | null;
  type: MessageType;
  body: string | null;
  attachments: AttachmentDto[];
  replyToId: string | null;
  replyTo: MessageSnippet | null;
  metadata: MessageMetadata;
  reactions: ReactionDto[];
  clientId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** Selbstlöschend: ab hier ist die Nachricht fort. */
  expiresAt?: string | null;
  /** Expanded entities so a chat renders in a single round trip. */
  poll?: PollDto;
  event?: CalendarEventDto;
  game?: GameSessionDto;
  sticker?: StickerDto;
}

/** Was „tippt …“ gerade tut: schreiben oder eine Sprachnachricht aufnehmen. */
export type TippArt = 'text' | 'audio';

/** Der Entwurf eines Chats, wie der Server ihn geräteübergreifend hält. */
export interface EntwurfDto {
  conversationId: string;
  text: string | null;
  replyToId: string | null;
  updatedAt: string | null;
}

/** Gelesen- und Zustellstand eines Mitglieds, wie der Betrachter ihn sehen darf. */
export interface StandDto {
  userId: string;
  gelesen: string | null;
  zugestellt: string | null;
}

/** „Gelesen von / Zugestellt an“ einer eigenen Nachricht. */
export interface NachrichteninfoDto {
  gelesen: { userId: string; am: string | null }[];
  zugestellt: { userId: string; am: string | null }[];
  ausstehend: string[];
}

/** Suchfilter des Server-Suchendpunkts. */
export type SuchArt = 'medien' | 'links' | 'dateien' | 'audio';

export interface MessageSnippet {
  id: string;
  senderId: string | null;
  type: MessageType;
  body: string | null;
  attachmentKind: string | null;
  deletedAt: string | null;
}

export const messageMetadataSchema: z.ZodType<MessageMetadata> = z.object({
  stickerId: z.string().uuid().optional(),
  pollId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  erinnerung: z
    .object({
      nummer: z.number().int().min(1).max(100),
      art: z.literal('vorab').optional(),
      minuten: z.number().int().min(1).max(60 * 24 * 14).optional(),
    })
    .optional(),
  gameSessionId: z.string().uuid().optional(),
  forwardedFrom: z
    .object({ conversationId: z.string().uuid(), messageId: z.string().uuid() })
    .optional(),
  weitergeleitet: z.object({ von: z.string().max(200).optional() }).optional(),
  system: z
    .object({
      kind: z.string().max(64),
      actorId: z.string().uuid().optional(),
      targetIds: z.array(z.string().uuid()).max(100).optional(),
      value: z.string().max(500).optional(),
    })
    .optional(),
  module: z.record(z.unknown()).optional(),
});

/**
 * Was ein Client beim Senden in `metadata` mitgeben darf – eine Positivliste.
 *
 * Alles andere setzt der Server selbst: `system` (Systemzeilen), `eventId` und
 * `erinnerung` (Termin-Karten), `pollId`, `gameSessionId`. Nähme er sie vom
 * Client an, ließe sich etwa eine Systemzeile im Namen eines anderen fälschen.
 * Unbekannte Schlüssel lehnt der Server ab (`modules/messages.rs`).
 */
export type ClientMessageMetadata = Pick<
  MessageMetadata,
  'stickerId' | 'forwardedFrom' | 'module' | 'mentions' | 'mentionsAlle' | 'einmalAnsehen' | 'kontakt'
> & {
  linkVorschau?: Omit<LinkVorschau, 'bildUrl'>;
  standort?: Standort;
};

export const clientMessageMetadataSchema: z.ZodType<ClientMessageMetadata> = z
  .object({
    stickerId: z.string().uuid().optional(),
    forwardedFrom: z
      .object({ conversationId: z.string().uuid(), messageId: z.string().uuid() })
      .strict()
      .optional(),
    module: z.record(z.unknown()).optional(),
    mentions: z.array(z.string().uuid()).max(LIMITS.erwaehnungenMax).optional(),
    mentionsAlle: z.literal(true).optional(),
    einmalAnsehen: z.literal(true).optional(),
    kontakt: z.object({ userId: z.string().uuid() }).strict().optional(),
    linkVorschau: z
      .object({
        url: z.string().url().max(2048),
        titel: z.string().max(200).nullable().optional(),
        beschreibung: z.string().max(300).nullable().optional(),
        seite: z.string().max(100).nullable().optional(),
        bildId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .optional(),
    standort: z
      .object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        genauigkeit: z.number().min(0).max(100_000).optional(),
        adresse: z.string().max(300).optional(),
        live: z.object({ minuten: z.union([z.literal(15), z.literal(60)]) }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((wert) => JSON.stringify(wert).length <= LIMITS.messageMetadataMax, {
    message: 'Zusatzangaben sind zu groß',
  });

export const sendMessageSchema = z
  .object({
    type: z.enum(MESSAGE_TYPES).default('text'),
    body: z.string().max(LIMITS.messageBodyMax).nullable().optional(),
    attachmentIds: z.array(z.string().uuid()).max(LIMITS.attachmentsPerMessage).optional(),
    replyToId: z.string().uuid().nullable().optional(),
    /** „Ohne Ton senden“: Mitteilung leise, Chat trotzdem ungelesen. */
    silent: z.boolean().optional(),
    /** Idempotency key generated by the client; re-sends return the same message. */
    // Ohne Doppelpunkt: Der gehört den Schlüsseln, die der Server vergibt.
    clientId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^:]+$/)
      .optional(),
    metadata: clientMessageMetadataSchema.optional(),
  })
  .refine(
    (v) =>
      (v.body != null && v.body.trim().length > 0) ||
      (v.attachmentIds?.length ?? 0) > 0 ||
      v.metadata?.stickerId != null ||
      v.metadata?.standort != null ||
      v.metadata?.kontakt != null,
    { message: 'message needs a body, an attachment or a referenced entity' },
  );
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  // Bildunterschriften dürfen leer werden; Text nicht (prüft der Server).
  body: z.string().max(LIMITS.messageBodyMax),
  mentions: z.array(z.string().uuid()).max(LIMITS.erwaehnungenMax).optional(),
});

export const geplantSchema = z.object({
  type: z.enum(['text', 'image', 'video', 'audio', 'file']).default('text'),
  body: z.string().max(LIMITS.messageBodyMax).nullable().optional(),
  attachmentIds: z.array(z.string().uuid()).max(LIMITS.attachmentsPerMessage).optional(),
  replyToId: z.string().uuid().nullable().optional(),
  metadata: clientMessageMetadataSchema.optional(),
  sendenUm: z.string().datetime({ offset: true }),
  zeitzone: z.string().max(64).optional(),
});

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(16),
});

export const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.messagePageSizeMax).optional(),
  before: z.string().uuid().optional(),
  after: z.string().uuid().optional(),
});

export const searchMessagesSchema = z.object({
  q: z.string().trim().max(200).optional(),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  art: z.enum(['medien', 'links', 'dateien', 'audio']).optional(),
  senderId: z.string().uuid().optional(),
  before: z.string().uuid().optional(),
});

export const weiterleitenSchema = z.object({
  conversationIds: z.array(z.string().uuid()).min(1).max(20),
  /** Mit Herkunft („Weitergeleitet von Anna“) oder ohne. */
  herkunft: z.boolean().default(true),
  clientId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^:]+$/)
    .optional(),
});

export const entwurfSchema = z.object({
  text: z.string().max(LIMITS.messageBodyMax).nullable(),
  replyToId: z.string().uuid().nullable().optional(),
  /** Wann das Gerät geschrieben hat; der neueste Stand gewinnt. */
  stand: z.string().datetime({ offset: true }),
});
