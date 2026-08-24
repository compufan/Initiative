/**
 * iCalendar (RFC 5545) serialisation.
 *
 * Used for two things: a per-user subscription feed (`webcal://…/calendar.ics`)
 * that iOS, Android and Outlook can subscribe to, and single-event downloads
 * ("zum Kalender hinzufügen") straight from a chat bubble.
 */

export interface IcsEventInput {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string | Date;
  endsAt: string | Date;
  allDay?: boolean;
  rrule?: string | null;
  url?: string | null;
  organizerEmail?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  reminderMinutes?: number[];
}

export interface IcsCalendarOptions {
  name: string;
  description?: string;
  /** Refresh hint for subscribing clients, ISO-8601 duration. */
  refreshInterval?: string;
  domain?: string;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function toUtcStamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

function toDateStamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.getUTCFullYear().toString() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate());
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 requires lines to be folded at 75 octets. */
function fold(line: string): string {
  if (line.length <= 74) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    chunks.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return chunks.join('\r\n');
}

export function buildIcsEvent(event: IcsEventInput, domain = 'initiative.app'): string[] {
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${event.id}@${domain}`,
    `DTSTAMP:${toUtcStamp(event.updatedAt ?? event.createdAt ?? new Date())}`,
  ];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toDateStamp(event.startsAt)}`);
    const end = event.endsAt instanceof Date ? new Date(event.endsAt) : new Date(event.endsAt);
    // DTEND is exclusive for all-day events.
    end.setUTCDate(end.getUTCDate() + 1);
    lines.push(`DTEND;VALUE=DATE:${toDateStamp(end)}`);
  } else {
    lines.push(`DTSTART:${toUtcStamp(event.startsAt)}`);
    lines.push(`DTEND:${toUtcStamp(event.endsAt)}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.url) lines.push(`URL:${escapeText(event.url)}`);
  if (event.rrule) lines.push(`RRULE:${event.rrule.replace(/^RRULE:/i, '')}`);
  if (event.organizerEmail) lines.push(`ORGANIZER:mailto:${event.organizerEmail}`);

  for (const minutes of event.reminderMinutes ?? []) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(event.title)}`,
      `TRIGGER:-PT${minutes}M`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT');
  return lines;
}

export function buildIcsCalendar(events: IcsEventInput[], options: IcsCalendarOptions): string {
  const domain = options.domain ?? 'initiative.app';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Initiative//Kalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name)}`,
    `NAME:${escapeText(options.name)}`,
  ];
  if (options.description) {
    lines.push(`X-WR-CALDESC:${escapeText(options.description)}`);
    lines.push(`DESCRIPTION:${escapeText(options.description)}`);
  }
  if (options.refreshInterval) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${options.refreshInterval}`);
    lines.push(`X-PUBLISHED-TTL:${options.refreshInterval}`);
  }
  for (const event of events) lines.push(...buildIcsEvent(event, domain));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Google Calendar "add event" deep link – handy on Android and desktop. */
export function googleCalendarUrl(event: IcsEventInput): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toUtcStamp(event.startsAt)}/${toUtcStamp(event.endsAt)}`,
  });
  if (event.description) params.set('details', event.description);
  if (event.location) params.set('location', event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
