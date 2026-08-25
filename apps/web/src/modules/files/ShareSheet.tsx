import { useEffect, useMemo, useState } from 'react';
import {
  GRANTABLE_LEVELS,
  type CollectionDto,
  type CollectionGrantDto,
  type ConversationDto,
  type GrantableLevel,
} from '@initiative/shared';
import { PersonenWahl } from '../../components/PersonenWahl.js';
import { conversationTitle } from '../messenger/helpers.js';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useNamen } from '../../state/leute.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';

interface ShareSheetProps {
  open: boolean;
  onClose: () => void;
  collection: CollectionDto;
}

const STUFEN_TEXT: Record<GrantableLevel, string> = {
  view: 'ansehen',
  edit: 'ansehen und ändern',
  own: 'alles, auch Rechte vergeben',
};

/**
 * Wer darf was mit dieser Sammlung.
 *
 * Zwei Wege: eine einzelne Person, oder alle in einem Chat. Der zweite ist
 * der wichtigere – „alle aus der Familiengruppe“ ist eine Angabe, die auch
 * dann noch stimmt, wenn später jemand dazukommt.
 */
export function ShareSheet({ open, onClose, collection }: ShareSheetProps) {
  const myId = useMyId();
  const [grants, setGrants] = useState<CollectionGrantDto[]>([]);
  const [chats, setChats] = useState<ConversationDto[]>([]);
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [stufe, setStufe] = useState<GrantableLevel>('view');
  const [laedt, setLaedt] = useState(true);
  const [busy, setBusy] = useState(false);

  const darfVergeben = collection.myLevel === 'own';

  useEffect(() => {
    if (!open) return;
    let abgebrochen = false;
    setLaedt(true);
    void (async () => {
      try {
        const [rechte, unterhaltungen] = await Promise.all([
          api.collections.grants(collection.id),
          api.conversations.list(),
        ]);
        if (abgebrochen) return;
        setGrants(rechte.items);
        setChats(unterhaltungen.items);
      } catch (error) {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Laden fehlgeschlagen');
      } finally {
        if (!abgebrochen) setLaedt(false);
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, [open, collection.id]);

  // `chat.title` ist bei einem Direktchat null – mit `?? 'Chat'` hiess dort
  // jeder einzelne woertlich „Chat", und man konnte sie nicht auseinander
  // halten. Der Name entsteht erst aus dem Gegenueber.
  const chatName = useMemo(() => {
    const namen = new Map(chats.map((chat) => [chat.id, conversationTitle(chat, myId)]));
    return (id: string) => namen.get(id) ?? 'Chat';
  }, [chats, myId]);

  // Die Mitglieder des zugehoerigen Chats stehen ohne Suchen zur Wahl. Das ist
  // fast immer der gemeinte Kreis, und ihn abtippen zu muessen, obwohl er
  // bekannt ist, war der eigentliche Umweg an dieser Stelle.
  const ausChat = useMemo(() => {
    const chat = chats.find((eintrag) => eintrag.id === collection.conversationId);
    return (chat?.members ?? []).map((mitglied) => ({
      id: mitglied.userId,
      displayName: mitglied.user.displayName,
    }));
  }, [chats, collection.conversationId]);

  // Ein Recht stand bisher als nackte Kennung in der Liste – eine UUID, mit
  // der niemand etwas anfangen kann.
  const namen = useNamen(
    grants.map((grant) => grant.userId),
    myId,
  );

  function einsortieren(neu: CollectionGrantDto) {
    setGrants((liste) => [
      ...liste.filter(
        (eintrag) =>
          !(eintrag.userId && neu.userId && eintrag.userId === neu.userId) &&
          !(
            eintrag.conversationId &&
            neu.conversationId &&
            eintrag.conversationId === neu.conversationId
          ),
      ),
      neu,
    ]);
  }

  async function vergeben(ziel: { userId?: string; conversationId?: string }) {
    setBusy(true);
    try {
      einsortieren(await api.collections.grant(collection.id, { ...ziel, level: stufe }));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Freigeben fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Mehrere auf einmal freigeben.
   *
   * Nacheinander und mit Zwischenstand: Bricht der dritte von fünf ab, sind
   * die ersten beiden trotzdem vergeben und stehen auch so in der Liste. Ein
   * stiller Teilerfolg wäre schlimmer als ein sichtbarer.
   */
  async function alleVergeben() {
    if (auswahl.length === 0) return;
    setBusy(true);
    const gescheitert: string[] = [];
    for (const userId of auswahl) {
      try {
        einsortieren(await api.collections.grant(collection.id, { userId, level: stufe }));
      } catch {
        gescheitert.push(namen(userId));
      }
    }
    setBusy(false);
    setAuswahl([]);
    if (gescheitert.length === 0) {
      toast(
        auswahl.length === 1 ? 'Recht vergeben.' : `${auswahl.length} Rechte vergeben.`,
        'success',
      );
    } else {
      toast(`Nicht geklappt bei: ${gescheitert.join(', ')}`, 'error');
    }
  }

  async function entziehen(grant: CollectionGrantDto) {
    setBusy(true);
    try {
      await api.collections.revoke(collection.id, grant.id);
      setGrants((liste) => liste.filter((eintrag) => eintrag.id !== grant.id));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Zurücknehmen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={`„${collection.name}“ teilen`}>
      {laedt ? (
        <Spinner label="Rechte werden geladen …" />
      ) : (
        <div className="stack">
          {!darfVergeben && (
            <p className="fil-hint">
              Rechte vergeben darf nur, wem die Sammlung gehört. Du siehst hier, wer bereits Zugriff
              hat.
            </p>
          )}

          {grants.length === 0 ? (
            <p className="fil-hint">
              Bisher hat niemand ein ausdrückliches Recht.
              {collection.conversationId && ' Alle im zugehörigen Chat haben trotzdem Zugriff.'}
            </p>
          ) : (
            <ul className="list">
              {grants.map((grant) => (
                <li key={grant.id} className="fil-grant">
                  <span className="truncate">
                    {grant.conversationId
                      ? `Alle in „${chatName(grant.conversationId)}“`
                      : namen(grant.userId)}
                    {grant.itemId && ' (nur eine Datei)'}
                  </span>
                  <span className="fil-badge">{STUFEN_TEXT[grant.level]}</span>
                  {darfVergeben && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void entziehen(grant)}
                    >
                      Zurücknehmen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {darfVergeben && (
            <>
              <fieldset className="field">
                <legend>Neu vergeben – die Stufe gilt für alle unten Gewählten</legend>
                {GRANTABLE_LEVELS.map((wert) => (
                  <label key={wert} className="fil-radio">
                    <input
                      type="radio"
                      name="grantLevel"
                      checked={stufe === wert}
                      onChange={() => setStufe(wert)}
                    />
                    <span>{STUFEN_TEXT[wert]}</span>
                  </label>
                ))}
              </fieldset>

              <PersonenWahl
                label="Wem die Sammlung freigegeben wird"
                vorschlaege={ausChat}
                gewaehlt={auswahl}
                onChange={setAuswahl}
                zusatz={(id) => {
                  const bestehend = grants.find((eintrag) => eintrag.userId === id);
                  if (!bestehend) return null;
                  // Sonst vergibt man blind ein Recht, das schon besteht – und
                  // wundert sich, dass sich nichts aendert.
                  return <span className="fil-badge">{STUFEN_TEXT[bestehend.level]}</span>;
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={busy || auswahl.length === 0}
                onClick={() => void alleVergeben()}
              >
                {auswahl.length <= 1
                  ? `Freigeben: ${STUFEN_TEXT[stufe]}`
                  : `${auswahl.length} Personen freigeben: ${STUFEN_TEXT[stufe]}`}
              </button>

              <p className="fil-section">Oder alle in einem Chat</p>
              <ul className="list">
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      className="list-row"
                      disabled={busy}
                      onClick={() => void vergeben({ conversationId: chat.id })}
                    >
                      <span aria-hidden="true">{chat.type === 'group' ? '👥' : '💬'}</span>
                      <span className="truncate">{conversationTitle(chat, myId)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
