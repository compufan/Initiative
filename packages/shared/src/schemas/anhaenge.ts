import type { AttachmentDto } from './media.js';

/**
 * Medienübersicht je Chat (`GET /conversations/{id}/anhaenge`) und Export
 * (`POST /conversations/{id}/export`). Server: `apps/api/src/services/anhaenge.rs`.
 *
 * Sichtbar ist, was die fragende Person im Verlauf sieht: ab ihrer
 * Verlaufsgrenze (auch nach „Chat leeren“), ohne Gelöschtes, Abgelaufenes und
 * ohne einmal ansehbare Fotos/Videos.
 */
export const ANHANG_REITER = ['medien', 'dokumente', 'links', 'audio'] as const;
export type AnhangReiter = (typeof ANHANG_REITER)[number];

export const ANHANG_REITER_TEXT: Record<AnhangReiter, string> = {
  medien: 'Medien',
  dokumente: 'Dokumente',
  links: 'Links',
  audio: 'Sprachnachrichten',
};

export interface AnhangEintragDto {
  messageId: string;
  senderId: string | null;
  createdAt: string;
  attachment: AttachmentDto;
}

export interface LinkEintragDto {
  messageId: string;
  senderId: string | null;
  createdAt: string;
  url: string;
  /** Der Text der Nachricht drumherum, gekürzt. */
  text: string;
}

export interface ExportAdresseDto {
  /** Fünf Minuten gültig; der Browser lädt das ZIP selbst herunter. */
  url: string;
  gueltigBis: string;
}

/** Wie viele Medien ein Export höchstens enthält (Server: `EXPORT_MEDIEN_MAX`). */
export const EXPORT_MEDIEN_MAX_BYTES = 2 * 1024 * 1024 * 1024;
