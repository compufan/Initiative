/** Shared limits and enumerations. Client and server both validate against these. */

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;
export const REALTIME_PATH = '/ws';
export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  /*
   * Ein Foto mit seiner Bearbeitung als ANWEISUNG daneben.
   *
   * Eigener Typ und nicht `image` mit einem Merker: Wer den Typ nicht kennt,
   * soll gar nichts zeigen statt das unbearbeitete Original – siehe
   * `rezept.ts` im Fotoeditor. Ein Merker, den ein Leser übersieht, hiesse
   * genau das Gegenteil dessen, was der Absender gesehen hat.
   */
  'rezept',
  'poll',
  'event',
  'game',
  'system',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file', 'sticker'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const RSVP_STATUSES = ['yes', 'no', 'maybe', 'pending'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const POLL_KINDS = ['choice', 'date'] as const;
export type PollKind = (typeof POLL_KINDS)[number];

/** Date polls use a three-state vote, choice polls only ever store `yes`. */
export const VOTE_VALUES = ['yes', 'no', 'maybe'] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

export const GAME_STATUSES = ['open', 'active', 'finished', 'aborted'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 32,
  displayNameMax: 64,
  bioMax: 280,
  messageBodyMax: 8000,
  /**
   * Wie groß die Zusatzangaben einer gesendeten Nachricht als JSON sein dürfen –
   * `MESSAGE_METADATA_MAX` im Server.
   */
  messageMetadataMax: 4096,
  conversationTitleMax: 80,
  pollQuestionMax: 300,
  pollOptionMax: 120,
  pollOptionsMax: 30,
  eventTitleMax: 160,
  eventDescriptionMax: 4000,
  /** Wie lang der Ort eines Termins sein darf – `EVENT_LOCATION_MAX` im Server. */
  eventLocationMax: 300,
  /** Länge des Wiederholungsschutz-Schlüssels beim Anlegen eines Termins. */
  eventClientIdMax: 64,
  /**
   * Wie viele Personen ein Termin höchstens einlädt – `EINLADUNGEN_MAX` in
   * `apps/api/src/constants.rs`. Der Client prüft vorab, der Server entscheidet.
   */
  einladungenMax: 200,
  /** In wie viele Gruppenchats eine Einladung höchstens als Karte kommt. */
  einladungGruppenMax: 10,
  /**
   * Erinnern an ausstehende Antworten – `ERINNERN_*` in `apps/api/src/constants.rs`.
   * Der Abstand schützt den Empfänger, der die Einstellung nicht beeinflusst:
   * höchstens zweimal am Tag, höchstens zehnmal im Ganzen.
   */
  erinnernNachStdMin: 12,
  erinnernNachStdMax: 720,
  erinnernAnzahlMax: 10,
  /** So kurz vor dem Beginn wird nicht mehr erinnert – die Antwort hilft der Planung dann nicht mehr. */
  erinnernReserveStd: 2,
  stickerPackNameMax: 60,
  /**
   * Wie lang die Tonspur eines Stickers hoechstens sein darf.
   *
   * Acht Sekunden, dieselbe Zahl wie `TON_MAX_MS` in `apps/api/src/constants.rs`.
   * Ein Sticker ist eine Geste: angetippt, gesagt, vorbei. Was laenger dauert,
   * ist eine Sprachnachricht.
   */
  stickerTonMaxMs: 8_000,
  stickersPerPackMax: 120,
  collectionNameMax: 120,
  collectionDescriptionMax: 2000,
  collectionItemTitleMax: 200,
  collectionItemNoteMax: 2000,
  /** Wie tief Ordner ineinander liegen dürfen. */
  collectionDepthMax: 8,
  attachmentsPerMessage: 10,
  messagePageSize: 50,
  messagePageSizeMax: 100,
  /** Inline preview (tiny JPEG data URL) shipped with image/video attachments. */
  previewDataUrlMax: 32_000,
  /**
   * Obergrenzen je Art – die der Server beim Anlegen eines Uploads prüft.
   *
   * Datei und Video dürfen 4 GiB haben (`GROSS_UPLOAD_MAX` in
   * `apps/api/src/constants.rs`, dort per `UPLOAD_MAX_BYTES` einstellbar; ein
   * Rust-Test vergleicht beide Seiten). So gross geht es nur in Stücken
   * (`stueckGroesse`, `lib/stueckUpload.ts`); der Weg in einer Anfrage hat
   * weiter die kleinen Grenzen aus `direktUploadMax`.
   */
  maxUploadBytes: {
    image: 25 * 1024 * 1024,
    video: 4 * 1024 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
    file: 4 * 1024 * 1024 * 1024,
    /*
     * Vier statt zwei Megabyte: Bewegung kostet Bytes, und ein bewegter
     * Sticker mit zwanzig Teilbildern sprengt zwei Megabyte mühelos. Vier
     * ist immer noch klein genug, dass eine Paketübersicht mit 120 Stickern
     * kein Mobilfunkvolumen verbrennt.
     */
    sticker: 4 * 1024 * 1024,
  } as Record<AttachmentKind, number>,
  /**
   * Die alten Grenzen des Weges in EINER Anfrage (`max_upload_bytes` im
   * Server). Der puffert die ganze Datei im Arbeitsspeicher des Servers und
   * bleibt deshalb klein; alles darüber geht in Stücken.
   */
  direktUploadMax: {
    image: 25 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
    file: 100 * 1024 * 1024,
    sticker: 4 * 1024 * 1024,
  } as Record<AttachmentKind, number>,
  /** Wie gross ein Stück beim Hochladen in Stücken ist – `STUECK_GROESSE` im Server. */
  stueckGroesse: 8 * 1024 * 1024,
  /**
   * Ab welcher Grösse in Stücken hochgeladen wird.
   *
   * Darunter ist eine Anfrage schneller als drei (anlegen, Stück, abschliessen)
   * und ein Abriss kostet wenig. Darüber lohnt das Fortsetzen.
   */
  stueckUploadAb: 32 * 1024 * 1024,
} as const;

export const ALLOWED_MIME: Record<AttachmentKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
  audio: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav'],
  /*
   * GIF ist dazugekommen, damit bewegte Sticker überhaupt möglich sind.
   *
   * Ein animiertes WebP trägt denselben Typ wie ein ruhendes, war also nie
   * gesperrt – gescheitert ist es an etwas anderem: Wer ein bewegtes Bild in
   * den Editor gab, bekam ein Standbild, weil eine Leinwand nur ein Teilbild
   * aufnimmt. Bewegt bleibt es nur, wenn die Datei UNVERÄNDERT durchgereicht
   * wird, und dafür muss ihr Typ erlaubt sein.
   */
  sticker: ['image/webp', 'image/png', 'image/gif'],
  file: [],
};

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥'] as const;

/** Feature modules shipped with the app. New modules simply extend this list. */
export const CORE_MODULE_KEYS = ['messenger', 'calendar', 'games'] as const;
