import { useEffect, useMemo, useState } from 'react';
import {
  GRANTABLE_LEVELS,
  type CollectionDto,
  type CollectionGrantDto,
  type ConversationDto,
  type GrantableLevel,
  type UserDto,
} from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
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
  const [grants, setGrants] = useState<CollectionGrantDto[]>([]);
  const [chats, setChats] = useState<ConversationDto[]>([]);
  const [suche, setSuche] = useState('');
  const [treffer, setTreffer] = useState<UserDto[]>([]);
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

  useEffect(() => {
    const begriff = suche.trim();
    if (begriff.length < 2) {
      setTreffer([]);
      return undefined;
    }
    // Kurz warten, statt bei jedem Tastendruck zu fragen.
    const zeit = setTimeout(() => {
      void api.users
        .search(begriff)
        .then((ergebnis) => setTreffer(ergebnis.items))
        .catch(() => setTreffer([]));
    }, 250);
    return () => clearTimeout(zeit);
  }, [suche]);

  const chatName = useMemo(() => {
    const namen = new Map(chats.map((chat) => [chat.id, chat.title ?? 'Chat']));
    return (id: string) => namen.get(id) ?? 'Chat';
  }, [chats]);

  async function vergeben(ziel: { userId?: string; conversationId?: string }) {
    setBusy(true);
    try {
      const neu = await api.collections.grant(collection.id, { ...ziel, level: stufe });
      setGrants((liste) => [
        ...liste.filter(
          (eintrag) =>
            !(eintrag.userId && eintrag.userId === ziel.userId) &&
            !(eintrag.conversationId && eintrag.conversationId === ziel.conversationId),
        ),
        neu,
      ]);
      setSuche('');
      setTreffer([]);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Freigeben fehlgeschlagen');
    } finally {
      setBusy(false);
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
                      : (grant.userId ?? 'Unbekannt')}
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
                <legend>Neu vergeben – die Stufe gilt für den nächsten Eintrag</legend>
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

              <div className="field">
                <label htmlFor="fil-share-search">Person suchen</label>
                <input
                  id="fil-share-search"
                  className="input"
                  type="search"
                  value={suche}
                  placeholder="Name oder Benutzername"
                  onChange={(event) => setSuche(event.target.value)}
                />
              </div>
              {treffer.length > 0 && (
                <ul className="list">
                  {treffer.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        className="list-row"
                        disabled={busy}
                        onClick={() => void vergeben({ userId: person.id })}
                      >
                        <span aria-hidden="true">👤</span>
                        <span className="truncate">
                          {person.displayName} · @{person.username}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

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
                      <span className="truncate">{chat.title ?? 'Chat'}</span>
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
