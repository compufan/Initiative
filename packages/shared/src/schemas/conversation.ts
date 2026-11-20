import { z } from 'zod';
import {
  CONVERSATION_TYPES,
  LIMITS,
  MEMBER_ROLES,
  type ConversationType,
  type MemberRole,
} from '../constants.js';
import type { UserDto } from './user.js';
import type { MessageDto } from './message.js';

export interface ConversationMemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  nickname: string | null;
  lastReadMessageId: string | null;
  /**
   * Ab wann dieses Mitglied den Verlauf sieht; `null` heisst „von Anfang an".
   * Wer neu dazukommt, sieht ab dem Beitritt – alles davor gibt es nur auf
   * Antrag, dem alle anderen zustimmen müssen.
   */
  siehtAb: string | null;
  user: UserDto;
}

/** Ein Antrag, den Verlauf vor dem eigenen Beitritt sehen zu dürfen. */
export interface VerlaufsantragDto {
  id: string;
  conversationId: string;
  antragsteller: string;
  status: 'offen' | 'angenommen' | 'abgelehnt' | 'zurueckgezogen';
  /** Wer noch nicht abgestimmt hat – aus der heutigen Mitgliederliste. */
  offenBei: string[];
  zugestimmt: string[];
  abgelehnt: string[];
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  /** For direct chats the title is derived from the counterpart on the client. */
  title: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: ConversationMemberDto[];
  lastMessage: MessageDto | null;
  unreadCount: number;
  /**
   * Ob vor der eigenen Grenze noch Nachrichten liegen, die man nicht sieht.
   * Nur dann lohnt ein Antrag – `siehtAb` steht auch beim Gründer, der nichts
   * zu beantragen hat.
   */
  verdeckterVerlauf: boolean;
  mutedUntil: string | null;
  /** Whether the viewer archived this conversation. */
  archived: boolean;
  /** Beschreibung der Gruppe (höchstens `BESCHREIBUNG_MAX` Zeichen). */
  description: string | null;
  /** Schalter der Gruppe; im Direktchat immer die Voreinstellung. */
  settings: GruppenEinstellungen;
  /** Angeheftet seit – je Betrachter; `null` heisst nicht angeheftet. */
  pinnedAt: string | null;
  /** „Als ungelesen markiert“ – je Betrachter, fällt beim Lesen. */
  markedUnread: boolean;
  /** „Chat geleert“ bis hierhin – je Betrachter. */
  clearedUntil: string | null;
  /** Mitteilungen dieses Chats – je Betrachter. */
  notifyLevel: NotifyLevel;
  /** Ob Mitteilungen dieses Chats den Text zeigen – je Betrachter. */
  notifyPreview: boolean;
  /** Hintergrund dieses Chats (Kennung aus `HINTERGRUENDE`) – je Betrachter. */
  hintergrund: Hintergrund | null;
  /** Selbstlöschende Nachrichten: Lebensdauer in Sekunden, `null` aus. */
  selbstloeschenS?: number | null;
  /** Ungelesene Nachrichten, die mich erwähnen (auch „@alle“) – je Betrachter. */
  ungeleseneErwaehnungen?: number;
}

/** Schalter einer Gruppe (`conversations.settings`). */
export interface GruppenEinstellungen {
  /** Nur Admins (und der Besitzer) dürfen schreiben. */
  nurAdminsSenden: boolean;
  /** Nur Admins dürfen Titel, Bild und Beschreibung ändern. */
  nurAdminsInfo: boolean;
  /** Sekunden zwischen zwei Nachrichten je Mitglied; 0 = aus. */
  langsamerModus: number;
}

export const DEFAULT_GRUPPEN_EINSTELLUNGEN: GruppenEinstellungen = {
  nurAdminsSenden: false,
  nurAdminsInfo: true,
  langsamerModus: 0,
};

/**
 * Die neueren Felder eines Chats mit ihren Voreinstellungen – für Testdaten
 * und für Stände, die ein älterer Server liefert.
 */
export const CHAT_VOREINSTELLUNGEN: Pick<
  ConversationDto,
  | 'description'
  | 'settings'
  | 'pinnedAt'
  | 'markedUnread'
  | 'clearedUntil'
  | 'notifyLevel'
  | 'notifyPreview'
  | 'hintergrund'
> = {
  description: null,
  settings: DEFAULT_GRUPPEN_EINSTELLUNGEN,
  pinnedAt: null,
  markedUnread: false,
  clearedUntil: null,
  notifyLevel: 'alle',
  notifyPreview: true,
  hintergrund: null,
};

/** Die Stufen des langsamen Modus in Sekunden – dieselben wie im Server. */
export const LANGSAM_STUFEN = [0, 10, 30, 60, 300, 900, 3600] as const;

/** Länge der Gruppenbeschreibung – dieselbe Grenze wie Migration 0037. */
export const BESCHREIBUNG_MAX = 512;

/** Höchstens so viele angeheftete Chats. */
export const ANGEHEFTET_MAX = 5;

export const NOTIFY_LEVELS = ['alle', 'erwaehnungen', 'aus'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

/** Die Hintergründe eines Chats – dieselbe Liste wie `HINTERGRUENDE` im Server. */
export const HINTERGRUENDE = [
  'sand',
  'salbei',
  'himmel',
  'flieder',
  'nacht',
  'punkte',
  'wellen',
  'karo',
] as const;
export type Hintergrund = (typeof HINTERGRUENDE)[number];

/** Ein Einladungslink einer Gruppe (nur Admins sehen ihn). */
export interface EinladungslinkDto {
  id: string;
  token: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  /** Beitritt nur nach Freigabe durch einen Admin. */
  freigabe: boolean;
  createdAt: string;
}

/** Was ein Einladungslink vor dem Beitritt zeigt – ohne jeden Inhalt. */
export interface BeitrittVorschauDto {
  title: string | null;
  avatarUrl: string | null;
  description: string | null;
  memberCount: number;
  freigabe: boolean;
  schonMitglied: boolean;
  /** Nur gesetzt, wenn schon Mitglied. */
  conversationId: string | null;
  anfrageOffen: boolean;
}

export interface BeitrittErgebnis {
  status: 'beigetreten' | 'angefragt' | 'mitglied';
  conversationId?: string;
}

export interface BeitrittsanfrageDto {
  id: string;
  user: UserDto;
  createdAt: string;
}

/** Ein eigener Ordner der Chatliste. */
export interface ChatOrdnerDto {
  id: string;
  name: string;
  position: number;
  chats: string[];
}

export const ORDNER_NAME_MAX = 40;
export const ORDNER_MAX = 10;

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.conversationTitleMax).nullable().optional(),
  avatarAttachmentId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(BESCHREIBUNG_MAX).nullable().optional(),
  settings: z
    .object({
      nurAdminsSenden: z.boolean(),
      nurAdminsInfo: z.boolean(),
      langsamerModus: z
        .number()
        .int()
        .refine((wert) => (LANGSAM_STUFEN as readonly number[]).includes(wert)),
    })
    .partial()
    .optional(),
  mutedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  markedUnread: z.boolean().optional(),
  notifyLevel: z.enum(NOTIFY_LEVELS).optional(),
  notifyPreview: z.boolean().optional(),
  hintergrund: z.enum(HINTERGRUENDE).nullable().optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const createConversationSchema = z
  .object({
    type: z.enum(CONVERSATION_TYPES).default('direct'),
    title: z.string().trim().min(1).max(LIMITS.conversationTitleMax).optional(),
    memberIds: z.array(z.string().uuid()).min(1).max(200),
    avatarAttachmentId: z.string().uuid().optional(),
  })
  .refine((v) => v.type !== 'direct' || v.memberIds.length === 1, {
    message: 'direct conversations need exactly one counterpart',
    path: ['memberIds'],
  });
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const addMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(100),
});

export const updateMemberSchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  nickname: z.string().trim().max(LIMITS.displayNameMax).nullable().optional(),
});

export const markReadSchema = z.object({ messageId: z.string().uuid() });
