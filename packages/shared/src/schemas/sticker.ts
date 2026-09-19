import { z } from 'zod';
import { LIMITS } from '../constants.js';

export interface StickerDto {
  id: string;
  packId: string;
  packName: string;
  url: string;
  /**
   * Adresse der Tonspur, falls der Sticker klingt.
   *
   * Optional und nicht Teil des Bildes: Kein Stickerformat traegt eine
   * Tonspur, es sind zwangslaeufig zwei Dateien (siehe Migration 0022).
   */
  tonUrl?: string | null;
  tonDauerMs?: number | null;
  emoji: string | null;
  width: number;
  height: number;
  createdAt: string;
}

export interface StickerPackDto {
  id: string;
  name: string;
  ownerId: string;
  coverUrl: string | null;
  isPublic: boolean;
  /** Whether the viewer added this pack to their keyboard. */
  installed: boolean;
  stickerCount: number;
  stickers: StickerDto[];
  createdAt: string;
}

export const createStickerPackSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.stickerPackNameMax),
  isPublic: z.boolean().default(false),
});

export const updateStickerPackSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.stickerPackNameMax).optional(),
  isPublic: z.boolean().optional(),
  coverStickerId: z.string().uuid().nullable().optional(),
});

export const addStickerSchema = z.object({
  attachmentId: z.string().uuid(),
  emoji: z.string().max(16).nullable().optional(),
  tonAttachmentId: z.string().uuid().optional(),
  tonDauerMs: z.number().int().min(0).max(LIMITS.stickerTonMaxMs).optional(),
});

/** Ton nachtraeglich an einen vorhandenen Sticker haengen. */
export const setzeTonSchema = z.object({
  attachmentId: z.string().uuid(),
  dauerMs: z.number().int().min(0).max(LIMITS.stickerTonMaxMs).optional(),
});
