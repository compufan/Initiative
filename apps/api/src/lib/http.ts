import type { FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import { validationError } from './errors.js';

/** Validate a request body/query/params, converting Zod issues into AppError. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function parseBody<T extends ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  return parse(schema, request.body ?? {});
}

export function parseQuery<T extends ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  return parse(schema, request.query ?? {});
}

export function parseParams<T extends ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  return parse(schema, request.params ?? {});
}

/** JSON-safe ISO string for values coming out of Postgres. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Group rows by a key – used to hydrate one-to-many relations in one query. */
export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
