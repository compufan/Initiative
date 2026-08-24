import { Fragment, type ReactNode } from 'react';
import type { MessageRendererProps } from '../types.js';

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

function withLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  URL_PATTERN.lastIndex = 0;
  let match = URL_PATTERN.exec(text);
  while (match) {
    const [url, trailing] = splitTrailing(match[0]);
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
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
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
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

  if (message.deletedAt) {
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

  const body = message.body ?? '';
  if (body.trim().length === 0) {
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>Leere Nachricht</em>
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

  return <div className={`msg-bubble ${tone}`}>{withLinks(body)}</div>;
}
