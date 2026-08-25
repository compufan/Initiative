import { z } from 'zod';
import { LIMITS } from '../constants.js';
import type { AttachmentDto } from './media.js';

/**
 * Dateien & Sammlungen.
 *
 * Eine Sammlung ist ein Ordner; Ordner dürfen ineinander liegen. Darin liegen
 * dieselben Anhänge, die auch im Chat verschickt werden – eine Datei bekommt
 * dort einen zweiten Platz, sie wird nicht noch einmal hochgeladen.
 */

/** Was jemand mit einem Eintrag tun darf, aufsteigend. */
export const ACCESS_LEVELS = ['none', 'view', 'edit', 'own'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Nur diese Stufen lassen sich vergeben – „kein Zugriff“ heisst: kein Eintrag. */
export const GRANTABLE_LEVELS = ['view', 'edit', 'own'] as const;
export type GrantableLevel = (typeof GRANTABLE_LEVELS)[number];

/** Was für alle im zugehörigen Chat gilt. „own“ wäre hier sinnlos. */
export const MEMBER_LEVELS = ['none', 'view', 'edit'] as const;
export type MemberLevel = (typeof MEMBER_LEVELS)[number];

const RANG: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, own: 3 };

/**
 * Reicht die Stufe für das Verlangte?
 *
 * Dieselbe Reihenfolge wie im Server (`services/permissions.rs`). Die App
 * fragt damit nur, ob sie einen Knopf anzeigt – entschieden wird es auf dem
 * Server, nie hier.
 */
export function allowsLevel(have: AccessLevel, needed: AccessLevel): boolean {
  return RANG[have] >= RANG[needed];
}

export interface CollectionDto {
  id: string;
  parentId: string | null;
  /** Aus welchem Chat die Sammlung stammt. */
  conversationId: string | null;
  name: string;
  description: string | null;
  color: string | null;
  /** Was jemand darf, der im zugehörigen Chat ist. */
  memberLevel: MemberLevel;
  createdBy: string | null;
  /** Was **ich** hier darf. */
  myLevel: AccessLevel;
  /** Dateien direkt darin, ohne Unterordner. */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItemDto {
  id: string;
  collectionId: string;
  addedBy: string | null;
  title: string | null;
  note: string | null;
  /** Aus welcher Nachricht die Datei kam – für den Sprung zurück in den Chat. */
  messageId: string | null;
  sortKey: number;
  myLevel: AccessLevel;
  attachment: AttachmentDto;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionGrantDto {
  id: string;
  collectionId: string | null;
  itemId: string | null;
  userId: string | null;
  conversationId: string | null;
  level: GrantableLevel;
  grantedBy: string | null;
  createdAt: string;
}

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.collectionNameMax),
  parentId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  description: z.string().max(LIMITS.collectionDescriptionMax).optional(),
  color: z.string().max(32).optional(),
  memberLevel: z.enum(MEMBER_LEVELS).optional(),
});
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.collectionNameMax).optional(),
  description: z.string().max(LIMITS.collectionDescriptionMax).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  memberLevel: z.enum(MEMBER_LEVELS).optional(),
});
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export const addCollectionItemSchema = z.object({
  attachmentId: z.string().uuid(),
  title: z.string().max(LIMITS.collectionItemTitleMax).optional(),
  note: z.string().max(LIMITS.collectionItemNoteMax).optional(),
  messageId: z.string().uuid().optional(),
});
export type AddCollectionItemInput = z.infer<typeof addCollectionItemSchema>;

export const updateCollectionItemSchema = z.object({
  title: z.string().max(LIMITS.collectionItemTitleMax).nullable().optional(),
  note: z.string().max(LIMITS.collectionItemNoteMax).nullable().optional(),
  sortKey: z.number().int().optional(),
  collectionId: z.string().uuid().optional(),
});
export type UpdateCollectionItemInput = z.infer<typeof updateCollectionItemSchema>;

/**
 * Ein Recht vergeben – entweder an eine Person oder an alle in einem Chat,
 * nie an beides. Der Server prüft dasselbe noch einmal.
 */
export const grantCollectionSchema = z
  .object({
    userId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    level: z.enum(GRANTABLE_LEVELS),
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.conversationId), {
    message: 'Entweder eine Person oder ein Chat – nicht beides',
    path: ['userId'],
  });
export type GrantCollectionInput = z.infer<typeof grantCollectionSchema>;

/** Ein Knoten im Ordnerbaum, wie ihn die App aus der flachen Liste baut. */
export interface CollectionNode {
  collection: CollectionDto;
  children: CollectionNode[];
  /** Wie tief der Knoten liegt – 0 für die oberste Ebene. */
  depth: number;
}

/**
 * Baut aus der flachen Liste den Baum.
 *
 * Ordner, deren Elternteil nicht in der Liste steht, landen oben. Das ist
 * kein Fehlerfall, sondern der Normalfall: Man kann Zugriff auf einen
 * Unterordner haben, ohne den darüber sehen zu dürfen.
 */
export function buildCollectionTree(collections: CollectionDto[]): CollectionNode[] {
  const bekannt = new Set(collections.map((entry) => entry.id));
  const kinder = new Map<string | null, CollectionDto[]>();

  for (const collection of collections) {
    const elternteil =
      collection.parentId && bekannt.has(collection.parentId) ? collection.parentId : null;
    const liste = kinder.get(elternteil);
    if (liste) liste.push(collection);
    else kinder.set(elternteil, [collection]);
  }

  const sortiert = (liste: CollectionDto[]) =>
    [...liste].sort((a, b) => a.name.localeCompare(b.name, 'de'));

  // Iterativ statt rekursiv: bei einem beschädigten Datensatz mit einem
  // Zyklus liefe die Rekursion ewig, hier bricht `gesehen` das ab.
  const gesehen = new Set<string>();
  function baue(elternteil: string | null, depth: number): CollectionNode[] {
    return sortiert(kinder.get(elternteil) ?? [])
      .filter((collection) => !gesehen.has(collection.id))
      .map((collection) => {
        gesehen.add(collection.id);
        return { collection, children: baue(collection.id, depth + 1), depth };
      });
  }
  return baue(null, 0);
}
