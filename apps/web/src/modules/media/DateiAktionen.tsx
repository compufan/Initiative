import { useEffect, useMemo, useState } from 'react';
import {
  PRIORITAETEN,
  PRIORITAET_TEXT,
  formatBytes,
  type AttachmentDto,
  type ConversationDto,
  type Prioritaet,
} from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationTitle } from '../messenger/helpers.js';
import { FernsehSheet } from '../fernseher/FernsehSheet.js';
import { ConfirmDialog } from '../profile/ConfirmDialog.js';

interface DateiAktionenProps {
  open: boolean;
  onClose: () => void;
  /** Die betroffenen Dateien – eine oder viele, der Weg ist derselbe. */
  anhaenge: AttachmentDto[];
  /**
   * Wie diese Dateien hier verschwinden. Fehlt der Rückruf, gibt es kein
   * Löschen – im Chat zum Beispiel, wo eine Datei an einer Nachricht hängt
   * und mit ihr gelöscht wird, nicht für sich.
   */
  loeschen?: () => Promise<void>;
  /** Was in der Rückfrage steht. Ohne Angabe eine allgemeine Fassung. */
  loeschText?: string;
  /** Aufräumen nach einer Änderung – neu laden, Auswahl aufheben. */
  onGeaendert?: () => void;
}

/**
 * Was man mit einer geöffneten oder ausgewählten Datei tun kann.
 *
 * Drei Handgriffe, ein Blatt: löschen, in einen Chat weitergeben, Priorität
 * setzen. Absichtlich dieselbe Komponente für eine einzelne Datei und für eine
 * Mehrfachauswahl – der Unterschied ist die Länge einer Liste, nicht die Art
 * der Handlung, und zwei fast gleiche Blätter wären zwei Gelegenheiten, sie
 * unterschiedlich zu bauen.
 *
 * # Weitergeben legt nichts doppelt an
 *
 * „In einem Chat teilen" schickt keine Kopie über die Leitung: Der Server legt
 * eine zweite Zeile auf dieselbe Datei an (siehe `media.rs::in_chat_teilen`).
 * Ein Video von zweihundert Megabyte, dreimal weitergegeben, belegt einmal
 * Platz. Deshalb steht hier auch kein Fortschrittsbalken – es gibt nichts zu
 * übertragen.
 */
export function DateiAktionen({
  open,
  onClose,
  anhaenge,
  loeschen,
  loeschText,
  onGeaendert,
}: DateiAktionenProps) {
  const myId = useMyId();
  const [chats, setChats] = useState<ConversationDto[]>([]);
  const [laedtChats, setLaedtChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loeschFrage, setLoeschFrage] = useState(false);
  /**
   * Der Weg auf den Fernseher, der ohne Chromecast auskommt.
   *
   * Er stand bis hierher nur in der Werkzeugleiste einer Sammlung – nicht bei
   * einem einzelnen Foto und nicht bei einem einzelnen Video. Ein Anwender hat
   * genau das gemeldet. Hier ist der richtige Platz dafür: Dieses Blatt hängt
   * schon an der Lichtbox im Chat und am Betrachter in den Dateien, es kennt
   * die Anhänge, und es ist der Ort, an dem man nachsieht, was mit einer Datei
   * geht.
   */
  const [fernseher, setFernseher] = useState(false);
  /** Welcher Bereich offen ist – sonst wäre das Blatt eine Wand aus Knöpfen. */
  const [bereich, setBereich] = useState<'keiner' | 'prioritaet' | 'chat'>('keiner');

  const anzahl = anhaenge.length;
  const name = anzahl === 1 ? (anhaenge[0]?.fileName ?? 'Diese Datei') : `${anzahl} Dateien`;
  const bytes = anhaenge.reduce((summe, anhang) => summe + anhang.size, 0);

  /**
   * Die gemeinsame Priorität – oder `null`, wenn sie sich unterscheiden.
   *
   * Bei gemischter Auswahl wird KEINE vorausgewählt. Eine hervorgehobene
   * Schaltfläche behauptete sonst, alle stünden auf diesem Wert, und wer
   * daneben tippt, verstellt zwanzig Dateien, ohne es zu merken.
   */
  const gemeinsam = useMemo<Prioritaet | null>(() => {
    if (anhaenge.length === 0) return null;
    const erste = anhaenge[0].prioritaet;
    return anhaenge.every((anhang) => anhang.prioritaet === erste) ? erste : null;
  }, [anhaenge]);

  const ausgelagert = anhaenge.filter((anhang) => anhang.ablage === 'fern').length;
  /*
   * Was sich überhaupt auf einem Fernseher zeigen lässt.
   *
   * Der Server weist eine Liste ab, in der weder Foto noch Video steht – ein
   * Knopf, der zuverlässig eine Fehlermeldung ergibt, ist schlechter als
   * keiner.
   */
  const zeigbar = anhaenge.filter((anhang) => anhang.kind === 'image' || anhang.kind === 'video');

  useEffect(() => {
    if (!open || bereich !== 'chat' || chats.length > 0) return undefined;
    let abgebrochen = false;
    setLaedtChats(true);
    void (async () => {
      try {
        const liste = await api.conversations.list();
        if (!abgebrochen) setChats(liste.items);
      } catch (error) {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Chats nicht ladbar');
      } finally {
        if (!abgebrochen) setLaedtChats(false);
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, [open, bereich, chats.length]);

  // Ein frisch geöffnetes Blatt fängt oben an und nicht dort, wo es zuletzt
  // stand.
  useEffect(() => {
    if (open) setBereich('keiner');
  }, [open]);

  async function prioritaetSetzen(wert: Prioritaet) {
    if (busy) return;
    setBusy(true);
    try {
      const antwort = await api.media.prioritaet(
        anhaenge.map((anhang) => anhang.id),
        wert,
      );
      if (antwort.geaendert === 0) {
        toast('Dazu fehlt dir das Recht.', 'error');
      } else if (antwort.abgelehnt.length > 0) {
        // Die ehrliche Auskunft statt eines pauschalen Hakens: Bei einer
        // gemischten Auswahl geht ein Teil durch und ein Teil nicht.
        toast(
          `${antwort.geaendert} geändert, ${antwort.abgelehnt.length} nicht – dort fehlt dir das Recht.`,
        );
      } else {
        toast(`Priorität: ${PRIORITAET_TEXT[wert].label}.`, 'success');
      }
      onGeaendert?.();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ändern fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function inChat(chat: ConversationDto) {
    if (busy) return;
    setBusy(true);
    try {
      await api.media.teilen(
        anhaenge.map((anhang) => anhang.id),
        chat.id,
      );
      toast(`An „${conversationTitle(chat, myId)}“ geschickt.`, 'success');
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Teilen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function wirklichLoeschen() {
    if (!loeschen || busy) return;
    setBusy(true);
    try {
      await loeschen();
      setLoeschFrage(false);
      onGeaendert?.();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={name} variant="sheet">
        <div className="stack">
          <p className="fil-meta">
            {anzahl === 1 ? formatBytes(bytes) : `${anzahl} Dateien · ${formatBytes(bytes)}`}
            {ausgelagert > 0 && (
              <>
                {' · '}
                <span data-tipp="Diese Datei liegt auf dem grossen Speicher. Sie ist genauso erreichbar wie jede andere – das erste Laden dauert nur einen Moment länger.">
                  {ausgelagert === anzahl
                    ? 'auf dem grossen Speicher'
                    : `${ausgelagert} auf dem grossen Speicher`}
                </span>
              </>
            )}
          </p>

          {/* --- Auf den Fernseher --- */}
          {zeigbar.length > 0 && (
            <button
              type="button"
              className="btn btn-block"
              onClick={() => setFernseher(true)}
              data-tipp="Läuft auf jedem Fernseher mit Browser – auch ohne Chromecast"
            >
              📺 Auf den Fernseher (Code)
            </button>
          )}

          {/* --- Priorität --- */}
          <section className="stack">
            <button
              type="button"
              className="btn btn-block"
              aria-expanded={bereich === 'prioritaet'}
              onClick={() => setBereich(bereich === 'prioritaet' ? 'keiner' : 'prioritaet')}
            >
              ⚖️ Priorität ändern
              {gemeinsam && <span className="fil-meta"> · {PRIORITAET_TEXT[gemeinsam].label}</span>}
            </button>
            {bereich === 'prioritaet' && (
              <div className="stack">
                <p className="fil-hint">
                  Wenn der Platz auf dem Server knapp wird, wandern Dateien auf einen zweiten,
                  grösseren Speicher. In der App ändert sich dadurch nichts – nur das erste Laden
                  dauert länger. Hier steht, welche zuerst dran sind.
                </p>
                {PRIORITAETEN.map((wert) => (
                  <button
                    key={wert}
                    type="button"
                    className={
                      gemeinsam === wert ? 'btn btn-block btn-primary' : 'btn btn-block btn-ghost'
                    }
                    disabled={busy}
                    onClick={() => void prioritaetSetzen(wert)}
                  >
                    <strong>{PRIORITAET_TEXT[wert].label}</strong>
                    <span className="fil-meta"> — {PRIORITAET_TEXT[wert].hinweis}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* --- In einen Chat --- */}
          <section className="stack">
            <button
              type="button"
              className="btn btn-block"
              aria-expanded={bereich === 'chat'}
              onClick={() => setBereich(bereich === 'chat' ? 'keiner' : 'chat')}
            >
              💬 In einem Chat teilen
            </button>
            {bereich === 'chat' && (
              <div className="stack">
                {laedtChats ? (
                  <Spinner label="Chats werden geladen …" />
                ) : chats.length === 0 ? (
                  <p className="fil-hint">Noch kein Chat da, in den das passen würde.</p>
                ) : (
                  <ul className="list">
                    {chats.map((chat) => (
                      <li key={chat.id}>
                        <button
                          type="button"
                          className="list-row"
                          disabled={busy}
                          onClick={() => void inChat(chat)}
                        >
                          <span aria-hidden="true">{chat.type === 'group' ? '👥' : '💬'}</span>
                          <span className="truncate">{conversationTitle(chat, myId)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* --- Löschen --- */}
          {loeschen && (
            <button
              type="button"
              className="btn btn-block btn-danger"
              disabled={busy}
              onClick={() => setLoeschFrage(true)}
            >
              🗑️ {anzahl === 1 ? 'Löschen' : `${anzahl} Dateien löschen`}
            </button>
          )}
        </div>
      </Sheet>

      {fernseher && (
        <FernsehSheet
          open
          onClose={() => setFernseher(false)}
          attachmentIds={zeigbar.map((anhang) => anhang.id)}
          titel={
            zeigbar.length === 1 ? 'Auf den Fernseher' : `${zeigbar.length} Stück auf den Fernseher`
          }
        />
      )}

      {loeschen && (
        <ConfirmDialog
          open={loeschFrage}
          title={anzahl === 1 ? `„${name}“ löschen?` : `${anzahl} Dateien löschen?`}
          description={
            loeschText ??
            'Der Eintrag verschwindet aus dieser Sammlung. Kam die Datei aus einem Chat, bleibt sie dort stehen.'
          }
          confirmLabel="Löschen"
          danger
          busy={busy}
          onCancel={() => setLoeschFrage(false)}
          onConfirm={() => void wirklichLoeschen()}
        />
      )}
    </>
  );
}
