import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ANHANG_REITER,
  ANHANG_REITER_TEXT,
  formatBytes,
  formatDuration,
  type AnhangEintragDto,
  type AnhangReiter,
  type AttachmentDto,
  type ConversationDto,
  type ExportAdresseDto,
  type LinkEintragDto,
} from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { request } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { senderName } from '../messenger/helpers.js';
import { abspielen, namenFuer } from '../player/spieler.js';
import { Lightbox } from './Lightbox.js';
import { errorMessage, mediaDownloadSrc, mediaSrc } from './helpers.js';
import { istHd } from './fotoQualitaet.js';

type Eintrag = AnhangEintragDto | LinkEintragDto;

export const anhaengeApi = {
  liste: (chat: string, art: AnhangReiter, vor?: string | null) =>
    request<{ items: Eintrag[]; nextCursor?: string | null }>(
      'GET',
      `/conversations/${chat}/anhaenge`,
      { query: { art, vor: vor ?? undefined, limit: 60 } },
    ),
  export: (chat: string, mitMedien: boolean) =>
    request<ExportAdresseDto>('POST', `/conversations/${chat}/export`, {
      body: { mitMedien, zeitzoneVersatz: new Date().getTimezoneOffset() },
    }),
};

function datum(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

interface Stand {
  items: Eintrag[];
  weiter: string | null;
  laedt: boolean;
  fertig: boolean;
}

const LEER: Stand = { items: [], weiter: null, laedt: false, fertig: false };

/**
 * Medien, Dokumente, Links und Sprachnachrichten eines Chats – in Reitern.
 *
 * Der Server liefert nur, was diese Person im Verlauf sieht (Verlaufsgrenze,
 * geleert, gelöscht, einmal ansehbar ausgenommen). Fotos lassen sich in der
 * Lightbox durchblättern; jeder Eintrag springt auf Wunsch zu seiner
 * Nachricht.
 */
export function MedienUebersicht({
  conversation,
  open,
  onClose,
  onSprung,
}: {
  conversation: ConversationDto;
  open: boolean;
  onClose: () => void;
  /** Wird vor dem Sprung zur Nachricht gerufen (etwa um die Chat-Info zu schliessen). */
  onSprung?: () => void;
}) {
  const navigate = useNavigate();
  const [reiter, setReiter] = useState<AnhangReiter>('medien');
  const [staende, setStaende] = useState<Record<AnhangReiter, Stand>>({
    medien: LEER,
    dokumente: LEER,
    links: LEER,
    audio: LEER,
  });
  const [bild, setBild] = useState<number | null>(null);
  const [video, setVideo] = useState<AttachmentDto | null>(null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  const staendeRef = useRef(staende);
  staendeRef.current = staende;

  const laden = useCallback(
    async (art: AnhangReiter, neu: boolean) => {
      const vor = neu ? null : staendeRef.current[art].weiter;
      setStaende((alt) => ({ ...alt, [art]: { ...(neu ? LEER : alt[art]), laedt: true } }));
      try {
        const seite = await anhaengeApi.liste(conversation.id, art, vor);
        setStaende((alt) => ({
          ...alt,
          [art]: {
            items: neu ? seite.items : [...alt[art].items, ...seite.items],
            weiter: seite.nextCursor ?? null,
            laedt: false,
            fertig: !seite.nextCursor,
          },
        }));
      } catch (fehler) {
        toast(errorMessage(fehler, 'Konnte nicht geladen werden'), 'error');
        setStaende((alt) => ({ ...alt, [art]: { ...alt[art], laedt: false } }));
      }
    },
    [conversation.id],
  );

  // Beim Öffnen frisch laden; die anderen Reiter erst, wenn man sie ansieht.
  useEffect(() => {
    if (!open) return;
    setStaende({ medien: LEER, dokumente: LEER, links: LEER, audio: LEER });
    setBild(null);
    setVideo(null);
  }, [open, conversation.id]);

  useEffect(() => {
    if (!open) return;
    const stand = staende[reiter];
    if (!stand.laedt && !stand.fertig && stand.items.length === 0) void laden(reiter, true);
    // Nur bei Reiterwechsel/Öffnen – nicht bei jedem neuen Stand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reiter]);

  function springen(messageId: string) {
    onSprung?.();
    onClose();
    navigate(`/chats/${conversation.id}?m=${messageId}`);
  }

  function tastenImReiter(ereignis: KeyboardEvent<HTMLButtonElement>) {
    const index = ANHANG_REITER.indexOf(reiter);
    let ziel: number | null = null;
    if (ereignis.key === 'ArrowRight') ziel = (index + 1) % ANHANG_REITER.length;
    if (ereignis.key === 'ArrowLeft')
      ziel = (index - 1 + ANHANG_REITER.length) % ANHANG_REITER.length;
    if (ereignis.key === 'Home') ziel = 0;
    if (ereignis.key === 'End') ziel = ANHANG_REITER.length - 1;
    if (ziel === null) return;
    ereignis.preventDefault();
    const art = ANHANG_REITER[ziel];
    setReiter(art);
    tabs.current[art]?.focus();
  }

  const stand = staende[reiter];
  const medien = staende.medien.items as AnhangEintragDto[];
  const bilder = medien.filter((e) => e.attachment.kind === 'image');

  return (
    <Sheet open={open} onClose={onClose} title="Medien, Links und Dokumente">
      <div className="mu-reiter" role="tablist" aria-label="Art">
        {ANHANG_REITER.map((art) => (
          <button
            key={art}
            ref={(element) => {
              tabs.current[art] = element;
            }}
            type="button"
            role="tab"
            id={`mu-tab-${art}`}
            aria-selected={reiter === art}
            aria-controls="mu-panel"
            tabIndex={reiter === art ? 0 : -1}
            className={reiter === art ? 'mu-tab is-active' : 'mu-tab'}
            onClick={() => setReiter(art)}
            onKeyDown={tastenImReiter}
          >
            {ANHANG_REITER_TEXT[art]}
          </button>
        ))}
      </div>

      <div id="mu-panel" role="tabpanel" aria-labelledby={`mu-tab-${reiter}`} className="mu-panel">
        {stand.items.length === 0 && stand.laedt && <Spinner label="Wird geladen …" />}
        {stand.items.length === 0 && !stand.laedt && stand.fertig && (
          <p className="muted mu-leer">
            {reiter === 'medien'
              ? 'Keine Fotos und Videos'
              : reiter === 'dokumente'
                ? 'Keine Dokumente'
                : reiter === 'links'
                  ? 'Keine Links'
                  : 'Keine Sprachnachrichten'}
          </p>
        )}

        {reiter === 'medien' && medien.length > 0 && (
          <ul className="mu-raster" aria-label="Fotos und Videos">
            {medien.map((eintrag) => {
              const anhang = eintrag.attachment;
              const istBild = anhang.kind === 'image';
              return (
                <li key={anhang.id} className="mu-kachel">
                  <button
                    type="button"
                    className="mu-kachel-knopf"
                    aria-label={`${istBild ? 'Foto' : 'Video'} vom ${datum(eintrag.createdAt)} öffnen`}
                    onClick={() =>
                      istBild
                        ? setBild(bilder.findIndex((b) => b.attachment.id === anhang.id))
                        : setVideo(anhang)
                    }
                  >
                    {anhang.previewDataUrl && (
                      <img
                        className="mu-vorschau"
                        src={anhang.previewDataUrl}
                        alt=""
                        aria-hidden="true"
                      />
                    )}
                    {istBild && (
                      <img
                        className="mu-bild"
                        src={mediaSrc(anhang)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    {!istBild && (
                      <span className="mu-video-marke" aria-hidden="true">
                        ▶ {anhang.durationMs ? formatDuration(anhang.durationMs) : ''}
                      </span>
                    )}
                    {istBild && istHd(anhang.width, anhang.height) && (
                      <span className="media-hd-abzeichen media-tile-hd" aria-hidden="true">
                        HD
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="mu-sprung"
                    aria-label="Zur Nachricht springen"
                    title="Zur Nachricht"
                    onClick={() => springen(eintrag.messageId)}
                  >
                    ↗
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {reiter === 'dokumente' && (
          <ul className="mu-liste">
            {(stand.items as AnhangEintragDto[]).map((eintrag) => (
              <li key={eintrag.attachment.id} className="mu-zeile">
                <span className="mu-symbol" aria-hidden="true">
                  📄
                </span>
                <span className="mu-text">
                  <a
                    href={mediaDownloadSrc(eintrag.attachment)}
                    className="truncate mu-titel"
                    download
                  >
                    {eintrag.attachment.fileName ?? 'Datei'}
                  </a>
                  <span className="muted mu-unter">
                    {formatBytes(eintrag.attachment.size)} · {datum(eintrag.createdAt)} ·{' '}
                    {senderName(conversation, eintrag.senderId)}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Zur Nachricht springen"
                  onClick={() => springen(eintrag.messageId)}
                >
                  ↗
                </button>
              </li>
            ))}
          </ul>
        )}

        {reiter === 'links' && (
          <ul className="mu-liste">
            {(stand.items as LinkEintragDto[]).map((eintrag, index) => (
              <li key={`${eintrag.messageId}-${index}`} className="mu-zeile">
                <span className="mu-symbol" aria-hidden="true">
                  🔗
                </span>
                <span className="mu-text">
                  <a
                    href={eintrag.url}
                    className="truncate mu-titel"
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    {eintrag.url.replace(/^https?:\/\//i, '')}
                  </a>
                  <span className="muted mu-unter truncate">
                    {datum(eintrag.createdAt)} · {senderName(conversation, eintrag.senderId)} ·{' '}
                    {eintrag.text}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Zur Nachricht springen"
                  onClick={() => springen(eintrag.messageId)}
                >
                  ↗
                </button>
              </li>
            ))}
          </ul>
        )}

        {reiter === 'audio' && (
          <ul className="mu-liste">
            {(stand.items as AnhangEintragDto[]).map((eintrag) => (
              <li key={eintrag.attachment.id} className="mu-zeile">
                <button
                  type="button"
                  className="icon-btn mu-abspielen"
                  aria-label={`Sprachnachricht von ${senderName(conversation, eintrag.senderId)} abspielen`}
                  onClick={() =>
                    void abspielen({
                      conversationId: conversation.id,
                      messageId: eintrag.messageId,
                      attachment: eintrag.attachment,
                      ...namenFuer(conversation.id, eintrag.senderId),
                    }).catch(() => toast('Kann nicht abgespielt werden', 'error'))
                  }
                >
                  ▶
                </button>
                <span className="mu-text">
                  <span className="mu-titel">{senderName(conversation, eintrag.senderId)}</span>
                  <span className="muted mu-unter">
                    {eintrag.attachment.durationMs
                      ? formatDuration(eintrag.attachment.durationMs)
                      : formatBytes(eintrag.attachment.size)}{' '}
                    · {datum(eintrag.createdAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Zur Nachricht springen"
                  onClick={() => springen(eintrag.messageId)}
                >
                  ↗
                </button>
              </li>
            ))}
          </ul>
        )}

        {stand.items.length > 0 && !stand.fertig && (
          <button
            type="button"
            className="btn btn-block"
            disabled={stand.laedt}
            onClick={() => void laden(reiter, false)}
          >
            {stand.laedt ? 'Wird geladen …' : 'Mehr laden'}
          </button>
        )}
      </div>

      {bild !== null && bilder.length > 0 && (
        <Lightbox
          items={bilder.map((b) => b.attachment)}
          index={Math.max(0, bild)}
          onClose={() => setBild(null)}
        />
      )}
      {video && (
        <div className="mu-video" role="dialog" aria-modal="true" aria-label="Video">
          <video src={mediaSrc(video)} controls autoPlay playsInline className="mu-video-element" />
          <button type="button" className="btn" onClick={() => setVideo(null)} autoFocus>
            Schliessen
          </button>
        </div>
      )}
    </Sheet>
  );
}

/** „Chat exportieren“ – mit oder ohne Medien; der Browser lädt das ZIP selbst. */
export function ChatExport({ conversation }: { conversation: ConversationDto }) {
  const [offen, setOffen] = useState(false);
  const [mitMedien, setMitMedien] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  async function exportieren() {
    setLaeuft(true);
    try {
      const { url } = await anhaengeApi.export(conversation.id, mitMedien);
      // Ein Anker statt `fetch`: Der Browser lädt im Strom auf die Platte,
      // ein Export mit Medien muss nie ganz in den Arbeitsspeicher.
      const anker = document.createElement('a');
      anker.href = url;
      anker.rel = 'noopener';
      anker.download = '';
      document.body.append(anker);
      anker.click();
      anker.remove();
      toast('Der Export wird heruntergeladen', 'success');
      setOffen(false);
    } catch (fehler) {
      toast(errorMessage(fehler, 'Export fehlgeschlagen'), 'error');
    } finally {
      setLaeuft(false);
    }
  }

  if (!offen) {
    return (
      <button type="button" className="btn btn-block" onClick={() => setOffen(true)}>
        📤 Chat exportieren
      </button>
    );
  }
  return (
    <div className="stack mu-export" role="group" aria-label="Chat exportieren">
      <p style={{ margin: 0 }}>
        Eine ZIP-Datei mit dem Verlauf als <code>chat.txt</code> – so, wie du ihn siehst.
      </p>
      <label className="row" style={{ gap: 'var(--space-2)' }}>
        <input
          type="checkbox"
          checked={mitMedien}
          onChange={(e) => setMitMedien(e.target.checked)}
        />
        <span>Mit Fotos, Videos und Dateien (bis 2 GB)</span>
      </label>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button type="button" className="btn" onClick={() => setOffen(false)} disabled={laeuft}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={() => void exportieren()}
          disabled={laeuft}
          autoFocus
        >
          {laeuft ? 'Wird vorbereitet …' : 'Exportieren'}
        </button>
      </div>
    </div>
  );
}
