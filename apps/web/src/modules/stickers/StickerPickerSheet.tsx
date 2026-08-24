import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StickerDto, StickerPackDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps } from '../types.js';
import { errorMessage, readRecentStickers, rememberSticker, stickerSrc } from './helpers.js';
import { StickerStudio } from './StickerStudio.js';

const RECENT_TAB = 'recent';

/** Sticker keyboard: recents first, then every installed pack. */
export function StickerPickerSheet({ conversationId, onClose }: ComposerActionProps) {
  const navigate = useNavigate();
  const [packs, setPacks] = useState<StickerPackDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState<string>(RECENT_TAB);
  const [recent, setRecent] = useState<string[]>(() => readRecentStickers());
  const [studioOpen, setStudioOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const sentTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (sentTimer.current != null) window.clearTimeout(sentTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { items } = await api.stickers.packs();
        if (!alive) return;
        setPacks(items);
        setFailed(false);
      } catch (error) {
        if (!alive) return;
        setFailed(true);
        toast(errorMessage(error, 'Sticker konnten nicht geladen werden'), 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const byId = useMemo(() => {
    const map = new Map<string, StickerDto>();
    for (const pack of packs) for (const sticker of pack.stickers) map.set(sticker.id, sticker);
    return map;
  }, [packs]);

  const recentStickers = useMemo(
    () => recent.map((id) => byId.get(id)).filter((sticker): sticker is StickerDto => !!sticker),
    [recent, byId],
  );

  // Falls back to the first pack as soon as there is nothing recent to show.
  useEffect(() => {
    if (loading) return;
    if (active === RECENT_TAB && recentStickers.length === 0 && packs.length > 0) {
      setActive(packs[0].id);
    }
  }, [loading, active, recentStickers.length, packs]);

  const visible: StickerDto[] =
    active === RECENT_TAB
      ? recentStickers
      : (packs.find((pack) => pack.id === active)?.stickers ?? []);

  async function send(sticker: StickerDto) {
    try {
      await useChat.getState().sendMessage(conversationId, {
        type: 'sticker',
        metadata: { stickerId: sticker.id },
      });
      setRecent(rememberSticker(sticker.id));
      setSent(sticker.id);
      if (sentTimer.current != null) window.clearTimeout(sentTimer.current);
      sentTimer.current = window.setTimeout(() => setSent(null), 600);
    } catch (error) {
      toast(errorMessage(error, 'Sticker konnte nicht gesendet werden'), 'error');
    }
  }

  function mergePack(pack: StickerPackDto) {
    setPacks((current) => {
      const index = current.findIndex((item) => item.id === pack.id);
      if (index < 0) return [...current, pack];
      const next = current.slice();
      next[index] = pack;
      return next;
    });
    setActive(pack.id);
  }

  if (studioOpen) {
    return (
      <StickerStudio
        onClose={() => setStudioOpen(false)}
        onSaved={(pack) => {
          mergePack(pack);
          setStudioOpen(false);
        }}
      />
    );
  }

  return (
    <Sheet open onClose={onClose} title="Sticker">
      {loading && <Spinner label="Sticker werden geladen …" />}

      {!loading && packs.length === 0 && (
        <EmptyState
          emoji="🌟"
          title={failed ? 'Sticker nicht verfügbar' : 'Noch keine Sticker'}
          description={
            failed
              ? 'Die Pakete konnten nicht geladen werden. Prüfe deine Verbindung.'
              : 'Erstelle deinen ersten eigenen Sticker oder installiere ein öffentliches Paket.'
          }
        />
      )}

      {!loading && packs.length > 0 && (
        <>
          <div className="stk-packs" role="tablist" aria-label="Sticker-Pakete">
            {recentStickers.length > 0 && (
              <button
                type="button"
                role="tab"
                aria-selected={active === RECENT_TAB}
                className={`stk-pack-tab ${active === RECENT_TAB ? 'is-active' : ''}`}
                onClick={() => setActive(RECENT_TAB)}
                title="Zuletzt benutzt"
              >
                <span aria-hidden="true">🕘</span>
                <span className="stk-pack-name truncate">Zuletzt</span>
              </button>
            )}
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                role="tab"
                aria-selected={active === pack.id}
                className={`stk-pack-tab ${active === pack.id ? 'is-active' : ''}`}
                onClick={() => setActive(pack.id)}
                title={pack.name}
              >
                {pack.coverUrl ? (
                  <img
                    src={stickerSrc(pack.coverUrl)}
                    alt=""
                    width={28}
                    height={28}
                    loading="lazy"
                  />
                ) : (
                  <span aria-hidden="true">🌟</span>
                )}
                <span className="stk-pack-name truncate">{pack.name}</span>
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              emoji="✨"
              title="Dieses Paket ist noch leer"
              description="Erstelle einen Sticker und lege ihn in diesem Paket ab."
            />
          ) : (
            <div className="stk-grid">
              {visible.map((sticker) => (
                <button
                  key={sticker.id}
                  type="button"
                  className={`stk-cell ${sent === sticker.id ? 'is-sent' : ''}`}
                  onClick={() => void send(sticker)}
                  aria-label={sticker.emoji ? `Sticker ${sticker.emoji} senden` : 'Sticker senden'}
                >
                  <img src={stickerSrc(sticker.url)} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="stk-btn-row">
        <button type="button" className="btn btn-primary" onClick={() => setStudioOpen(true)}>
          ✏️ Sticker erstellen
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose();
            navigate('/sticker');
          }}
        >
          ⚙️ Pakete verwalten
        </button>
      </div>
    </Sheet>
  );
}
