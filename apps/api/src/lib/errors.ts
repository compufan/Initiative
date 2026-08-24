import type { ZodError } from 'zod';

/** Every expected failure is expressed as an AppError; the error handler in
 *  `app.ts` turns it into the `{ error: { code, message } }` envelope. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Ungültige Anfrage', details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Nicht angemeldet') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Kein Zugriff') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Nicht gefunden') => new AppError(404, 'not_found', message);
export const conflict = (message = 'Konflikt', details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const tooLarge = (message = 'Datei zu groß') =>
  new AppError(413, 'payload_too_large', message);
export const unsupportedMedia = (message = 'Dateityp nicht unterstützt') =>
  new AppError(415, 'unsupported_media_type', message);
export const tooManyRequests = (message = 'Zu viele Anfragen') =>
  new AppError(429, 'rate_limited', message);

export function validationError(error: ZodError): AppError {
  return new AppError(
    422,
    'validation_failed',
    'Eingabe konnte nicht verarbeitet werden',
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}
