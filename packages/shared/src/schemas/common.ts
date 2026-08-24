import { z } from 'zod';

export const uuidSchema = z.string().uuid();
/** ISO-8601 timestamp, offsets allowed (clients send local offsets). */
export const isoDateSchema = z.string().datetime({ offset: true });
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: uuidSchema.optional(),
  after: uuidSchema.optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** Uniform error envelope returned by every failing endpoint. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface Page<T> {
  items: T[];
  /** Cursor to pass as `before` for the next (older) page; null when exhausted. */
  nextCursor: string | null;
}
