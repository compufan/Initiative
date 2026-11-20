import { useEffect, useMemo, useState } from 'react';
import type { ClientMessageMetadata, GeplantDto } from '@initiative/shared';
import { messagePreview } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { geplantLaden, useChatZusatz } from '../../state/angeheftet.js';

const KEINE: GeplantDto[] = [];

/** `datetime-local` braucht Ortszeit ohne Zone: „2026-11-20T18:30“. */
export function ortszeitFeld(datum: Date): string {
  const zwei = (n: number) => String(n).padStart(2, '0');
  return `${datum.getFullYear()}-${zwei(datum.getMonth() + 1)}-${zwei(datum.getDate())}T${zwei(
    datum.getHours(),
  )}:${zwei(datum.getMinutes())}`;
}

function zeitzone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zeitText(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Vorschläge wie in anderen Messengern: heute Abend, morgen früh. */
function vorschlaege(jetzt: Date): { label: string; wann: Date }[] {
  const abend = new Date(jetzt);
  abend.setHours(18, 0, 0, 0);
  const morgen = new Date(jetzt);
  morgen.setDate(morgen.getDate() + 1);
  morgen.setHours(8, 0, 0, 0);
  const aus: { label: string; wann: Date }[] = [];
  if (abend.getTime() - jetzt.getTime() > 5 * 60_000) aus.push({ label: 'Heute 18:00', wann: abend });
  aus.push({ label: 'Morgen 8:00', wann: morgen });
  return aus;
}

/**
 * „Später senden“: Datum und Uhrzeit wählen für den Text, der gerade in der
 * Eingabezeile steht. Gesendet wird vom Server zum Zeitpunkt – auch wenn
 * dieses Gerät dann aus ist.
 */
export function PlanenSheet({
  conversationId,
  entwurf,
  onClose,
  onGeplant,
}: {
  conversationId: string;
  entwurf: { body: string; replyToId: string | null; metadata: ClientMessageMetadata } | null;
  onClose: () => void;
  onGeplant: () => void;
}) {
  const [wann, setWann] = useState(() => ortszeitFeld(new Date(Date.now() + 60 * 60_000)));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (entwurf) setWann(ortszeitFeld(new Date(Date.now() + 60 * 60_000)));
  }, [entwurf]);
  const jetzt = useMemo(() => new Date(), [entwurf]);

  async function planen() {
    if (!entwurf) return;
    const zeitpunkt = new Date(wann);
    if (Number.isNaN(zeitpunkt.getTime()) || zeitpunkt.getTime() < Date.now() + 60_000) {
      toast('Wähle einen Zeitpunkt in der Zukunft', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.messages.planen(conversationId, {
        type: 'text',
        body: entwurf.body,
        replyToId: entwurf.replyToId,
        ...(Object.keys(entwurf.metadata).length > 0 ? { metadata: entwurf.metadata } : {}),
        sendenUm: zeitpunkt.toISOString(),
        zeitzone: zeitzone(),
      });
      toast(`Geplant für ${zeitText(zeitpunkt.toISOString())}`, 'success');
      void geplantLaden(conversationId);
      onGeplant();
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Planen hat nicht geklappt', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={entwurf != null} onClose={onClose} title="Später senden">
      {entwurf && (
        <div className="stack">
          <p className="msg-geplant-vorschau">{messagePreview({ type: 'text', body: entwurf.body })}</p>
          <div className="msg-geplant-schnell" role="group" aria-label="Schnellauswahl">
            {vorschlaege(jetzt).map((v) => (
              <button
                key={v.label}
                type="button"
                className="btn btn-sm"
                onClick={() => setWann(ortszeitFeld(v.wann))}
              >
                {v.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Datum und Uhrzeit</span>
            <input
              className="input"
              type="datetime-local"
              value={wann}
              min={ortszeitFeld(new Date(Date.now() + 60_000))}
              onChange={(event) => setWann(event.target.value)}
            />
          </label>
          <p className="msg-action-hint">
            Der Server sendet die Nachricht zum Zeitpunkt – auch wenn dein Gerät dann aus ist.
            Zeitzone: {zeitzone()}.
          </p>
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void planen()}>
            🕒 Planen
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Die Liste „Geplant“ eines Chats: Text und Zeit ändern, sofort senden,
 * löschen. Nur der Absender sieht sie.
 */
export function GeplantListeSheet({
  conversationId,
  open,
  onClose,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
}) {
  const liste = useChatZusatz((state) => state.geplant[conversationId] ?? KEINE);
  const [bearbeitet, setBearbeitet] = useState<{ id: string; body: string; wann: string } | null>(
    null,
  );
  useEffect(() => {
    if (open) void geplantLaden(conversationId);
  }, [open, conversationId]);

  async function ausfuehren(arbeit: () => Promise<unknown>, erfolg: string) {
    try {
      await arbeit();
      toast(erfolg, 'success');
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Hat nicht geklappt', 'error');
    } finally {
      void geplantLaden(conversationId);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Geplante Nachrichten">
      {liste.length === 0 ? (
        <p className="msg-action-hint">Keine geplanten Nachrichten in diesem Chat.</p>
      ) : (
        <ul className="list msg-geplant-liste">
          {liste.map((eintrag) => (
            <li key={eintrag.id} className="msg-geplant-eintrag">
              {bearbeitet?.id === eintrag.id ? (
                <div className="stack">
                  <label className="field">
                    <span>Text</span>
                    <textarea
                      className="textarea"
                      value={bearbeitet.body}
                      rows={3}
                      onChange={(event) => setBearbeitet({ ...bearbeitet, body: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Datum und Uhrzeit</span>
                    <input
                      className="input"
              type="datetime-local"
                      value={bearbeitet.wann}
                      onChange={(event) => setBearbeitet({ ...bearbeitet, wann: event.target.value })}
                    />
                  </label>
                  <div className="msg-geplant-knoepfe">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        const ziel = bearbeitet;
                        setBearbeitet(null);
                        void ausfuehren(
                          () =>
                            api.messages.geplantAendern(ziel.id, {
                              ...(eintrag.type === 'text' || ziel.body.trim()
                                ? { body: ziel.body }
                                : {}),
                              sendenUm: new Date(ziel.wann).toISOString(),
                              zeitzone: zeitzone(),
                            }),
                          'Geändert',
                        );
                      }}
                    >
                      Speichern
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setBearbeitet(null)}>
                      Abbrechen
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="msg-geplant-kopf">
                    <span aria-hidden="true">{eintrag.status === 'fehlgeschlagen' ? '⚠️' : '🕒'}</span>
                    <strong>{zeitText(eintrag.sendenUm)}</strong>
                    {eintrag.status === 'sendet' && <small>wird gesendet …</small>}
                  </div>
                  <p className="msg-geplant-text">
                    {eintrag.body ??
                      messagePreview({ type: eintrag.type, body: null })}
                    {eintrag.attachmentIds.length > 0 && eintrag.body ? ' 📎' : ''}
                  </p>
                  {eintrag.status === 'fehlgeschlagen' && (
                    <p className="msg-geplant-fehler" role="alert">
                      Nicht gesendet: {eintrag.fehler}
                    </p>
                  )}
                  <div className="msg-geplant-knoepfe">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={eintrag.status === 'sendet'}
                      onClick={() =>
                        void ausfuehren(() => api.messages.geplantJetzt(eintrag.id), 'Gesendet')
                      }
                    >
                      Jetzt senden
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={eintrag.status === 'sendet'}
                      onClick={() =>
                        setBearbeitet({
                          id: eintrag.id,
                          body: eintrag.body ?? '',
                          wann: ortszeitFeld(new Date(eintrag.sendenUm)),
                        })
                      }
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={eintrag.status === 'sendet'}
                      onClick={() =>
                        void ausfuehren(() => api.messages.geplantLoeschen(eintrag.id), 'Gelöscht')
                      }
                    >
                      Löschen
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
