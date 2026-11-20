import { useEffect, useState } from 'react';
import type { BearbeitungsverlaufDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useChatZusatz, verlaufZeigen } from '../../state/angeheftet.js';
import { zeitLang } from './NachrichtenInfoSheet.js';

/**
 * „Bearbeitungsverlauf“: was vorher dastand, mit Zeit – für alle im Chat.
 * Bearbeiten soll nichts still umschreiben können; wer wissen will, was sich
 * geändert hat, sieht hier jede frühere Fassung.
 */
export function BearbeitungsverlaufSheet() {
  const message = useChatZusatz((state) => state.verlaufFuer);
  const [verlauf, setVerlauf] = useState<BearbeitungsverlaufDto | null>(null);
  const [fehler, setFehler] = useState(false);
  useEffect(() => {
    setVerlauf(null);
    setFehler(false);
    if (!message) return undefined;
    let aktiv = true;
    api.messages
      .bearbeitungen(message.id)
      .then((geladen) => aktiv && setVerlauf(geladen))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [message?.id]);

  return (
    <Sheet open={message != null} onClose={() => verlaufZeigen(null)} title="Bearbeitungsverlauf">
      {fehler ? (
        <p className="msg-action-hint">Der Verlauf liess sich nicht laden.</p>
      ) : !verlauf ? (
        <Spinner label="Verlauf wird geladen" />
      ) : (
        <ol className="msg-verlauf-liste">
          <li className="msg-verlauf-eintrag msg-verlauf-aktuell">
            <span className="msg-verlauf-zeit">Aktuell · {zeitLang(verlauf.aktuell.am)}</span>
            <span className="msg-verlauf-text">{verlauf.aktuell.body ?? <em>ohne Text</em>}</span>
          </li>
          {[...verlauf.items].reverse().map((fassung, index) => (
            <li key={`${fassung.am}-${index}`} className="msg-verlauf-eintrag">
              <span className="msg-verlauf-zeit">Bis {zeitLang(fassung.am)}</span>
              <span className="msg-verlauf-text">{fassung.body ?? <em>ohne Text</em>}</span>
            </li>
          ))}
          <li className="msg-verlauf-eintrag msg-verlauf-gesendet">
            <span className="msg-verlauf-zeit">Gesendet {zeitLang(verlauf.gesendetAm)}</span>
          </li>
        </ol>
      )}
    </Sheet>
  );
}
