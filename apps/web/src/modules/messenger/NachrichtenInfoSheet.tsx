import { useEffect, useState } from 'react';
import type { ConversationDto, NachrichteninfoDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import type { ChatMessage } from '../../state/chat.js';
import { senderName } from './helpers.js';

/** Datum und Uhrzeit, kurz – „heute 14:05“, „gestern 09:12“, sonst mit Datum. */
export function zeitLang(iso: string | null): string {
  if (!iso) return 'Zeit unbekannt';
  const zeit = new Date(iso);
  const heute = new Date();
  const gestern = new Date();
  gestern.setDate(heute.getDate() - 1);
  const uhr = zeit.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (zeit.toDateString() === heute.toDateString()) return `heute ${uhr}`;
  if (zeit.toDateString() === gestern.toDateString()) return `gestern ${uhr}`;
  return `${zeit.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })} ${uhr}`;
}

/**
 * „Gelesen von / Zugestellt an“ einer eigenen Nachricht.
 *
 * Die Zeiten sind die, zu denen der Stand der Person die Nachricht
 * überschritt (Migration 0040) – auf die Meldung des Geräts genau. Wer
 * Lesebestätigungen ausgeschaltet hat (oder wenn man sie selbst aus hat, im
 * Einzelchat), steht nur unter „Zugestellt“.
 */
export function NachrichtenInfoSheet({
  message,
  conversation,
  onClose,
}: {
  message: ChatMessage | null;
  conversation: ConversationDto | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={message != null} onClose={onClose} title="Nachrichteninfo">
      {message && <Inhalt message={message} conversation={conversation} />}
    </Sheet>
  );
}

function Inhalt({
  message,
  conversation,
}: {
  message: ChatMessage;
  conversation: ConversationDto | null;
}) {
  const [info, setInfo] = useState<NachrichteninfoDto | null>(null);
  const [fehler, setFehler] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.messages
      .info(message.id)
      .then((geladen) => aktiv && setInfo(geladen))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [message.id]);

  if (fehler) return <p className="muted">Die Info liess sich gerade nicht laden.</p>;
  if (!info) return <Spinner label="Info wird geladen" />;

  const abschnitt = (titel: string, symbol: string, eintraege: { userId: string; am?: string | null }[], mitZeit: boolean) => (
    <section className="stack info-abschnitt" aria-label={titel}>
      <h3 className="info-titel">
        <span aria-hidden="true" className={symbol === '✓✓' && titel.startsWith('Gelesen') ? 'msg-haken msg-haken-gelesen' : 'msg-haken'}>
          {symbol}
        </span>{' '}
        {titel}
      </h3>
      {eintraege.length === 0 ? (
        <p className="muted">Noch niemand</p>
      ) : (
        <ul className="list">
          {eintraege.map((eintrag) => (
            <li key={eintrag.userId} className="list-row info-zeile">
              <span className="truncate">{senderName(conversation, eintrag.userId)}</span>
              {mitZeit && <span className="faint">{zeitLang(eintrag.am ?? null)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="stack">
      <p className="muted">Gesendet {zeitLang(message.createdAt)}</p>
      {abschnitt('Gelesen von', '✓✓', info.gelesen, true)}
      {abschnitt('Zugestellt an', '✓✓', info.zugestellt, true)}
      {info.ausstehend.length > 0 &&
        abschnitt(
          'Noch nicht zugestellt',
          '✓',
          info.ausstehend.map((userId) => ({ userId })),
          false,
        )}
    </div>
  );
}
