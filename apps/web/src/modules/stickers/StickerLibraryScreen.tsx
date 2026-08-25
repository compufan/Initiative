import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { LIMITS, type StickerDto, type StickerPackDto } from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { errorMessage, stickerAufsGeraet, stickerSrc } from './helpers.js';
import { StickerStudio } from './StickerStudio.js';

type Tab = 'mine' | 'discover';

interface PromptState {
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function PackGrid({
  stickers,
  onPick,
}: {
  stickers: StickerDto[];
  onPick?: (sticker: StickerDto) => void;
}) {
  if (stickers.length === 0) {
    return <p className="stk-hint">Dieses Paket hat noch keine Sticker.</p>;
  }
  return (
    <div className="stk-grid">
      {stickers.map((sticker) => (
        <button
          key={sticker.id}
          type="button"
          className="stk-cell"
          onClick={() => onPick?.(sticker)}
          aria-label={onPick ? 'Sticker bearbeiten' : 'Sticker'}
          disabled={!onPick}
        >
          <img src={stickerSrc(sticker.url)} alt="" loading="lazy" decoding="async" />
        </button>
      ))}
    </div>
  );
}

function PackHeader({ pack, actions }: { pack: StickerPackDto; actions?: ReactNode }) {
  return (
    <div className="row row-between">
      <div style={{ minWidth: 0 }}>
        <strong className="truncate">{pack.name}</strong>
        <div className="muted" style={{ fontSize: '0.8rem' }}>
          {pack.stickerCount} Sticker
          {pack.isPublic ? ' · öffentlich' : ' · privat'}
        </div>
      </div>
      {actions}
    </div>
  );
}

/** `/sticker` – own packs, installed packs and the public directory. */
export function StickerLibraryScreen() {
  const myId = useMyId();
  const [tab, setTab] = useState<Tab>('mine');
  const [packs, setPacks] = useState<StickerPackDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [discovered, setDiscovered] = useState<StickerPackDto[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [stickerAction, setStickerAction] = useState<{
    pack: StickerPackDto;
    sticker: StickerDto;
  } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [laedtHerunter, setLaedtHerunter] = useState(false);

  async function aufsGeraet(url: string) {
    setLaedtHerunter(true);
    try {
      const weg = await stickerAufsGeraet(url);
      if (weg === 'geladen') toast('Sticker gespeichert.', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setLaedtHerunter(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const { items } = await api.stickers.packs();
      setPacks(items);
    } catch (error) {
      toast(errorMessage(error, 'Pakete konnten nicht geladen werden'), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'discover') return undefined;
    const term = query.trim();
    setDiscovering(true);
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.stickers.discover(term.length > 0 ? term : undefined);
        setDiscovered(items);
      } catch (error) {
        toast(errorMessage(error, 'Öffentliche Pakete konnten nicht geladen werden'), 'error');
      } finally {
        setDiscovering(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tab, query]);

  function replacePack(pack: StickerPackDto) {
    setPacks((current) => {
      const index = current.findIndex((item) => item.id === pack.id);
      if (index < 0) return [...current, pack];
      const next = current.slice();
      next[index] = pack;
      return next;
    });
    setDiscovered((current) =>
      current.map((item) => (item.id === pack.id ? { ...pack, stickers: item.stickers } : item)),
    );
  }

  function openPrompt(state: PromptState) {
    setPromptValue(state.value);
    setPrompt(state);
  }

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast(errorMessage(error, fallback), 'error');
    } finally {
      setBusy(false);
    }
  }

  const own = packs.filter((pack) => pack.ownerId === myId);
  const installed = packs.filter((pack) => pack.ownerId !== myId);

  function createPack() {
    openPrompt({
      title: 'Neues Paket',
      label: 'Name',
      value: '',
      confirmLabel: 'Anlegen',
      onSubmit: (value) => {
        const name = value.trim();
        if (name.length === 0) return;
        setPrompt(null);
        void run(async () => {
          const pack = await api.stickers.createPack({ name });
          replacePack(pack);
          toast('Paket angelegt', 'success');
        }, 'Paket konnte nicht angelegt werden');
      },
    });
  }

  function renamePack(pack: StickerPackDto) {
    openPrompt({
      title: 'Paket umbenennen',
      label: 'Name',
      value: pack.name,
      confirmLabel: 'Speichern',
      onSubmit: (value) => {
        const name = value.trim();
        if (name.length === 0) return;
        setPrompt(null);
        void run(async () => {
          replacePack(await api.stickers.updatePack(pack.id, { name }));
        }, 'Paket konnte nicht umbenannt werden');
      },
    });
  }

  function togglePublic(pack: StickerPackDto) {
    void run(async () => {
      replacePack(await api.stickers.updatePack(pack.id, { isPublic: !pack.isPublic }));
      toast(pack.isPublic ? 'Paket ist wieder privat' : 'Paket ist jetzt öffentlich', 'success');
    }, 'Sichtbarkeit konnte nicht geändert werden');
  }

  function deletePack(pack: StickerPackDto) {
    setConfirm({
      title: 'Paket löschen',
      description: `„${pack.name}“ und alle enthaltenen Sticker werden gelöscht. Das lässt sich nicht rückgängig machen.`,
      confirmLabel: 'Löschen',
      onConfirm: () => {
        setConfirm(null);
        void run(async () => {
          await api.stickers.deletePack(pack.id);
          setPacks((current) => current.filter((item) => item.id !== pack.id));
          setDiscovered((current) => current.filter((item) => item.id !== pack.id));
          toast('Paket gelöscht', 'success');
        }, 'Paket konnte nicht gelöscht werden');
      },
    });
  }

  function setCover(pack: StickerPackDto, sticker: StickerDto) {
    setStickerAction(null);
    void run(async () => {
      replacePack(await api.stickers.updatePack(pack.id, { coverStickerId: sticker.id }));
      toast('Cover gesetzt', 'success');
    }, 'Cover konnte nicht gesetzt werden');
  }

  function deleteSticker(pack: StickerPackDto, sticker: StickerDto) {
    setStickerAction(null);
    setConfirm({
      title: 'Sticker löschen',
      description:
        'Der Sticker verschwindet aus dem Paket. Bereits gesendete Nachrichten bleiben leer.',
      confirmLabel: 'Löschen',
      onConfirm: () => {
        setConfirm(null);
        void run(async () => {
          await api.stickers.removeSticker(pack.id, sticker.id);
          const stickers = pack.stickers.filter((item) => item.id !== sticker.id);
          replacePack({
            ...pack,
            stickers,
            stickerCount: stickers.length,
            coverUrl: pack.coverUrl === sticker.url ? (stickers[0]?.url ?? null) : pack.coverUrl,
          });
          toast('Sticker gelöscht', 'success');
        }, 'Sticker konnte nicht gelöscht werden');
      },
    });
  }

  function install(pack: StickerPackDto) {
    void run(async () => {
      const updated = await api.stickers.install(pack.id);
      replacePack(updated);
      toast('Paket installiert', 'success');
    }, 'Paket konnte nicht installiert werden');
  }

  function uninstall(pack: StickerPackDto) {
    void run(async () => {
      await api.stickers.uninstall(pack.id);
      setPacks((current) => current.filter((item) => item.id !== pack.id));
      setDiscovered((current) =>
        current.map((item) => (item.id === pack.id ? { ...item, installed: false } : item)),
      );
      toast('Paket entfernt', 'info');
    }, 'Paket konnte nicht entfernt werden');
  }

  return (
    <Screen
      title="Sticker"
      back="/chats"
      actions={
        <button
          type="button"
          className="icon-btn"
          aria-label="Sticker erstellen"
          onClick={() => setStudioOpen(true)}
        >
          ✏️
        </button>
      }
    >
      <div className="stk-tabs-inline" role="tablist" aria-label="Sticker-Bereiche">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mine'}
          className={`stk-tab-inline ${tab === 'mine' ? 'is-active' : ''}`}
          onClick={() => setTab('mine')}
        >
          Meine Pakete
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'discover'}
          className={`stk-tab-inline ${tab === 'discover' ? 'is-active' : ''}`}
          onClick={() => setTab('discover')}
        >
          Entdecken
        </button>
      </div>

      {tab === 'mine' && (
        <>
          <div className="stk-btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setStudioOpen(true)}>
              ✏️ Sticker erstellen
            </button>
            <button type="button" className="btn" onClick={createPack} disabled={busy}>
              ＋ Neues Paket
            </button>
          </div>

          {loading && <Spinner label="Pakete werden geladen …" />}

          {!loading && own.length === 0 && installed.length === 0 && (
            <EmptyState
              emoji="🌟"
              title="Noch keine Pakete"
              description="Erstelle deinen ersten Sticker – daraus entsteht automatisch ein Paket."
            />
          )}

          {own.map((pack) => (
            <section className="card stack" key={pack.id}>
              <PackHeader pack={pack} />
              <PackGrid
                stickers={pack.stickers}
                onPick={(sticker) => setStickerAction({ pack, sticker })}
              />
              <div className="stk-btn-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => renamePack(pack)}
                  disabled={busy}
                >
                  Umbenennen
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${pack.isPublic ? 'stk-chip-active' : ''}`}
                  onClick={() => togglePublic(pack)}
                  disabled={busy}
                >
                  {pack.isPublic ? 'Öffentlich' : 'Privat'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => deletePack(pack)}
                  disabled={busy}
                >
                  Löschen
                </button>
              </div>
              {pack.stickerCount >= LIMITS.stickersPerPackMax && (
                <p className="stk-hint">
                  Dieses Paket ist voll ({LIMITS.stickersPerPackMax} Sticker).
                </p>
              )}
            </section>
          ))}

          {installed.length > 0 && (
            <>
              <h2 className="stk-section-title">Installierte Pakete</h2>
              {installed.map((pack) => (
                <section className="card stack" key={pack.id}>
                  <PackHeader
                    pack={pack}
                    actions={
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => uninstall(pack)}
                        disabled={busy}
                      >
                        Entfernen
                      </button>
                    }
                  />
                  <PackGrid stickers={pack.stickers} />
                </section>
              ))}
            </>
          )}
        </>
      )}

      {tab === 'discover' && (
        <>
          <input
            className="input"
            type="search"
            inputMode="search"
            placeholder="Öffentliche Pakete suchen"
            aria-label="Öffentliche Pakete suchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {discovering && <Spinner label="Wird gesucht …" />}

          {!discovering && discovered.length === 0 && (
            <EmptyState
              emoji="🔍"
              title="Nichts gefunden"
              description="Es gibt noch keine passenden öffentlichen Pakete."
            />
          )}

          {discovered.map((pack) => (
            <section className="card stack" key={pack.id}>
              <PackHeader
                pack={pack}
                actions={
                  <button
                    type="button"
                    className={pack.installed ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
                    onClick={() => (pack.installed ? uninstall(pack) : install(pack))}
                    disabled={busy}
                  >
                    {pack.installed ? 'Entfernen' : 'Installieren'}
                  </button>
                }
              />
              <PackGrid stickers={pack.stickers} />
            </section>
          ))}
        </>
      )}

      {stickerAction && (
        <Sheet open onClose={() => setStickerAction(null)} title="Sticker">
          <div className="stk-save-preview">
            <img
              src={stickerSrc(stickerAction.sticker.url)}
              alt=""
              width={128}
              height={128}
              loading="lazy"
            />
          </div>
          <button
            type="button"
            className="btn btn-block"
            onClick={() => setCover(stickerAction.pack, stickerAction.sticker)}
          >
            Als Cover festlegen
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={laedtHerunter}
            onClick={() => void aufsGeraet(stickerAction.sticker.url)}
          >
            {laedtHerunter ? '…' : '⬇ Aufs Handy speichern'}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => deleteSticker(stickerAction.pack, stickerAction.sticker)}
          >
            Sticker löschen
          </button>
        </Sheet>
      )}

      {prompt && (
        <Sheet open onClose={() => setPrompt(null)} title={prompt.title}>
          <div className="field">
            <label htmlFor="stk-prompt">{prompt.label}</label>
            <input
              id="stk-prompt"
              className="input"
              autoFocus
              value={promptValue}
              maxLength={LIMITS.stickerPackNameMax}
              onChange={(event) => setPromptValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') prompt.onSubmit(promptValue);
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => prompt.onSubmit(promptValue)}
            disabled={promptValue.trim().length === 0}
          >
            {prompt.confirmLabel}
          </button>
        </Sheet>
      )}

      {confirm && (
        <Sheet open onClose={() => setConfirm(null)} title={confirm.title} variant="modal">
          <p className="muted" style={{ marginTop: 0 }}>
            {confirm.description}
          </p>
          <div className="stk-btn-row">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Abbrechen
            </button>
            <button type="button" className="btn btn-danger" onClick={confirm.onConfirm}>
              {confirm.confirmLabel}
            </button>
          </div>
        </Sheet>
      )}

      {studioOpen && (
        <StickerStudio
          onClose={() => setStudioOpen(false)}
          onSaved={(pack) => {
            replacePack(pack);
            setStudioOpen(false);
          }}
        />
      )}
    </Screen>
  );
}
