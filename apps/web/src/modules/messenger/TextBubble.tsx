import { Fragment, useState, type ReactNode } from 'react';
import { formatierungParsen, hatFormatierung, type FormatKnoten } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { useSuchbegriff } from './suchbegriff.js';

const URL_PATTERN = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/gi;

function href(match: string): string {
  return match.startsWith('www.') ? `https://${match}` : match;
}

/** Trailing punctuation should stay outside the link ("… siehe example.com."). */
function splitTrailing(match: string): [string, string] {
  const trailing = /[.,;:!?)\]]+$/.exec(match);
  if (!trailing) return [match, ''];
  return [match.slice(0, match.length - trailing[0].length), trailing[0]];
}

/**
 * Den Suchbegriff markieren – ohne regulären Ausdruck aus Nutzereingabe
 * (Sonderzeichen wie `(` oder `*` wären sonst Syntax). Gross-/Kleinschreibung
 * egal, wie die Suche.
 */
function mitTreffern(text: string, begriff: string | null, schluessel: string): ReactNode[] {
  if (!begriff) return [text];
  const klein = text.toLocaleLowerCase('de');
  const nadel = begriff.toLocaleLowerCase('de');
  const aus: ReactNode[] = [];
  let ab = 0;
  let stelle = klein.indexOf(nadel);
  // Nur wenn die Kleinschreibung die Länge nicht ändert (sonst verrutschen die
  // Stellen, etwa beim türkischen İ) – dann eben ohne Markierung.
  if (klein.length !== text.length) return [text];
  while (stelle >= 0 && nadel.length > 0) {
    if (stelle > ab) aus.push(text.slice(ab, stelle));
    aus.push(
      <mark key={`${schluessel}-${stelle}`} className="msg-treffer">
        {text.slice(stelle, stelle + nadel.length)}
      </mark>,
    );
    ab = stelle + nadel.length;
    stelle = klein.indexOf(nadel, ab);
  }
  if (ab < text.length) aus.push(text.slice(ab));
  return aus;
}

function withLinks(text: string, begriff: string | null = null): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  URL_PATTERN.lastIndex = 0;
  let match = URL_PATTERN.exec(text);
  while (match) {
    const [url, trailing] = splitTrailing(match[0]);
    if (match.index > lastIndex) {
      nodes.push(...mitTreffern(text.slice(lastIndex, match.index), begriff, `t${lastIndex}`));
    }
    if (url.length > 0) {
      nodes.push(
        <a key={`link-${key}`} href={href(url)} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
      key += 1;
    }
    if (trailing) nodes.push(trailing);
    lastIndex = match.index + match[0].length;
    match = URL_PATTERN.exec(text);
  }
  if (lastIndex < text.length) nodes.push(...mitTreffern(text.slice(lastIndex), begriff, `t${lastIndex}`));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

/**
 * Ein Spoiler: verdeckt, bis man ihn antippt (oder mit Enter/Leertaste
 * aufdeckt). Für Vorlesehilfen ist der Inhalt bis dahin verborgen, sonst
 * läse sie vor, was Sehende nicht sehen sollen.
 */
function Spoiler({ children }: { children: ReactNode }) {
  const [offen, setOffen] = useState(false);
  if (offen) return <span className="msg-spoiler msg-spoiler-offen">{children}</span>;
  return (
    <span
      className="msg-spoiler"
      role="button"
      tabIndex={0}
      aria-label="Spoiler – antippen zum Aufdecken"
      onClick={(event) => {
        event.stopPropagation();
        setOffen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setOffen(true);
        }
      }}
    >
      <span aria-hidden="true">{children}</span>
    </span>
  );
}

/** Formatierungsknoten als React-Elemente – nie als HTML. */
function knotenRendern(knoten: FormatKnoten[], begriff: string | null, pfad = 'k'): ReactNode[] {
  return knoten.map((k, index) => {
    const schluessel = `${pfad}-${index}`;
    switch (k.art) {
      case 'text':
        return <Fragment key={schluessel}>{withLinks(k.text, begriff)}</Fragment>;
      case 'mono':
        return (
          <code key={schluessel} className="msg-mono">
            {mitTreffern(k.text, begriff, schluessel)}
          </code>
        );
      case 'block':
        return (
          <pre key={schluessel} className="msg-block">
            <code>{mitTreffern(k.text, begriff, schluessel)}</code>
          </pre>
        );
      case 'fett':
        return <strong key={schluessel}>{knotenRendern(k.kinder, begriff, schluessel)}</strong>;
      case 'kursiv':
        return <em key={schluessel}>{knotenRendern(k.kinder, begriff, schluessel)}</em>;
      case 'durch':
        return <s key={schluessel}>{knotenRendern(k.kinder, begriff, schluessel)}</s>;
      case 'spoiler':
        return <Spoiler key={schluessel}>{knotenRendern(k.kinder, begriff, schluessel)}</Spoiler>;
    }
  });
}

/** Text mit Formatierung, Links und markiertem Suchbegriff. */
export function FormatierterText({ text, begriff = null }: { text: string; begriff?: string | null }) {
  if (!hatFormatierung(text)) return <>{withLinks(text, begriff)}</>;
  return <>{knotenRendern(formatierungParsen(text), begriff)}</>;
}

/**
 * Number of visible emoji when the whole message is nothing but emoji.
 * Returns 0 as soon as letters, digits or more than three emoji are involved.
 */
function emojiOnlyCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return 0;
  if (!/\p{Extended_Pictographic}/u.test(trimmed)) return 0;
  if (/[\p{L}\p{N}]/u.test(trimmed)) return 0;
  let count = 0;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });
    for (const segment of segmenter.segment(trimmed)) {
      if (segment.segment.trim().length > 0) count += 1;
    }
  } else {
    count = [...trimmed].filter((char) => char.trim().length > 0 && char !== '️').length;
  }
  return count > 0 && count <= 3 ? count : 0;
}

/** Default chat bubble: links, line breaks and oversized emoji-only messages. */
export function TextBubble({ message, isMine }: MessageRendererProps) {
  const tone = isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs';
  const begriff = useSuchbegriff(message.conversationId);

  if (message.deletedAt) {
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

  const body = message.body ?? '';
  if (body.trim().length === 0) {
    /*
     * Zwei verschiedene Fälle, die hier zusammenlaufen.
     *
     * `TextBubble` ist auch der Rückfall für eine Nachrichtenart, die diese
     * Fassung nicht kennt (siehe `rendererFor` in MessageBubble). Bei einem
     * Text ohne Inhalt ist „Leere Nachricht" die Wahrheit; bei einer
     * unbekannten Art ist sie eine Lüge – dort steckt der ganze Inhalt in
     * Anhängen und Zusatzfeldern, die diese Fassung nur nicht zu deuten weiss.
     *
     * Angezeigt wird trotzdem nichts davon, und das ist Absicht: Bei `rezept`
     * zum Beispiel liegt das UNBEARBEITETE Original bei, und es zu zeigen
     * hiesse, etwas anderes zu zeigen, als der Absender gesehen hat (siehe
     * MESSAGE_TYPES im gemeinsamen Paket). Zu sagen, dass hier etwas ist,
     * kostet dagegen nichts.
     */
    const unbekannt = message.type !== 'text';
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>
          {unbekannt
            ? 'Diese Nachricht kann diese Fassung der App nicht anzeigen'
            : 'Leere Nachricht'}
        </em>
      </div>
    );
  }

  const emoji = emojiOnlyCount(body);
  if (emoji > 0) {
    return (
      <div className="msg-emoji-only" style={{ fontSize: emoji === 1 ? '2.9rem' : '2.4rem' }}>
        {body.trim()}
      </div>
    );
  }

  return (
    <div className={`msg-bubble ${tone}`}>
      <FormatierterText text={body} begriff={begriff} />
    </div>
  );
}
