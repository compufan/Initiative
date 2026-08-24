/**
 * Time-sortable identifiers (UUID v7).
 *
 * Every entity in Initiative uses a UUID v7 primary key: the leading 48 bits are
 * a millisecond timestamp, so IDs sort chronologically. That lets the API use
 * keyset pagination ("give me messages with id < cursor") without an extra
 * ordering column and keeps message ordering stable across clients.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Generate a UUID v7 string (lowercase, hyphenated). */
export function uuidv7(timestamp: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Math.max(0, Math.floor(timestamp)));

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const h = (i: number) => HEX[bytes[i]!]!;
  return (
    h(0) +
    h(1) +
    h(2) +
    h(3) +
    '-' +
    h(4) +
    h(5) +
    '-' +
    h(6) +
    h(7) +
    '-' +
    h(8) +
    h(9) +
    '-' +
    h(10) +
    h(11) +
    h(12) +
    h(13) +
    h(14) +
    h(15)
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Extract the embedded creation timestamp of a UUID v7 (ms since epoch). */
export function uuidv7Timestamp(id: string): number | null {
  if (!isUuid(id)) return null;
  const hex = id.replace(/-/g, '').slice(0, 12);
  const value = Number.parseInt(hex, 16);
  return Number.isNaN(value) ? null : value;
}

/** Short, human friendly invite/join code (unambiguous alphabet). */
export function inviteCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
