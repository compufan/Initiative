import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type StickerPackDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { herunterladen } from '../../lib/herunterladen.js';
import { uploadBlob } from '../../lib/upload.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { errorMessage, firstEmoji, stickerFileName } from './helpers.js';
import { STICKER_SIZE } from './render.js';
import { TonWaehlen } from '../media/TonWaehlen.js';
import type { TonErgebnis } from '../media/TonWerkstatt.js';
import { formatClock, timestampName } from '../media/helpers.js';

const QUICK_EMOJI = ['😀', '😂', '😍', '🥳', '😎', '🤯', '😭', '👍', '🙏', '🔥', '✨', '💜'];

interface SavePackSheetProps {
  blob: Blob;
  mime: string;
  onClose: () => void;
  onSaved: (pack: StickerPackDto) => void;
  /**
   * Das Paket, in das der vorige Sticker ging.
   *
   * Wer eine Reihe Sticker macht, macht sie fast immer für DASSELBE Paket.
   * Ohne diese Vorgabe fängt die Auswahl bei jedem Sticker wieder von vorn
   * an – und beim zehnten hat man neunmal dieselbe Kachel angetippt.
   */
  vorgabePaket?: string | null;
}

/** Second half of the studio: pick a pack (or create one) and upload. */
export function SavePackSheet({ blob, mime, onClose, onSaved, vorgabePaket }: SavePackSheetProps) {
  const myId = useMyId();
  const [packs, setPacks] = useState<StickerPackDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<string>(vorgabePaket ?? 'new');
  const [name, setName] = useState('Meine Sticker');
  const [emoji, setEmoji] = useState('');
  const [saving, setSaving] = useState(false);
  const [laedtHerunter, setLaedtHerunter] = useState(false);
  /** Die Tonspur, falls jemand eine ausgesucht hat. */
  const [ton, setTon] = useState<TonErgebnis | null>(null);
  const [tonOffen, setTonOffen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { items } = await api.stickers.packs();
        if (!active) return;
        const own = items.filter((pack) => pack.ownerId === myId);
        setPacks(own);
        // Die Vorgabe schlägt die Suche nach einem freien Paket: Sie kommt vom
        // Sticker davor, und wer gerade eine Reihe baut, will dort weiter.
        const vorgabe = vorgabePaket
          ? own.find(
              (pack) => pack.id === vorgabePaket && pack.stickerCount < LIMITS.stickersPerPackMax,
            )
          : undefined;
        const usable = vorgabe ?? own.find((pack) => pack.stickerCount < LIMITS.stickersPerPackMax);
        if (usable) setTarget(usable.id);
      } catch (error) {
        if (!active) return;
        toast(errorMessage(error, 'Deine Pakete konnten nicht geladen werden'), 'error');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [myId, vorgabePaket]);

  const trimmedName = name.trim();
  const canSave = useMemo(() => {
    if (saving) return false;
    return target === 'new' ? trimmedName.length > 0 : true;
  }, [saving, target, trimmedName]);

  async function aufsGeraet() {
    setLaedtHerunter(true);
    try {
      const weg = await herunterladen(blob, stickerFileName(mime));
      if (weg === 'geladen') toast('Sticker gespeichert.', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setLaedtHerunter(false);
    }
  }

  /*
   * Ein angelegtes Paket wird beim zweiten Versuch WIEDERVERWENDET.
   *
   * „Neues Paket“ legte erst das Paket an und lud dann hoch. Ging das
   * Hochladen schief – im Zug ist das der Normalfall –, blieb das leere Paket
   * stehen, und `target` stand weiter auf „neu“. Der zweite Tipp auf
   * „Speichern“ legte also ein zweites gleichnamiges Paket an, der dritte ein
   * drittes. Nach drei Anläufen hatte man drei leere „Meine Sticker“ und immer
   * noch keinen Sticker.
   *
   * Jetzt wird das Paket sofort in die Liste aufgenommen und ausgewählt: Der
   * nächste Versuch lädt nur noch hoch, und der Anwender sieht, was wirklich
   * schon entstanden ist.
   */
  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      let packId = target;
      if (target === 'new') {
        const neu = await api.stickers.createPack({ name: trimmedName, isPublic: false });
        packId = neu.id;
        setPacks((liste) => [...liste, neu]);
        setTarget(neu.id);
      }

      const attachment = await uploadBlob({
        kind: 'sticker',
        mime,
        fileName: stickerFileName(mime),
        blob,
        width: STICKER_SIZE,
        height: STICKER_SIZE,
      });

      /*
       * Der Ton NACH dem Bild und der Sticker zuletzt.
       *
       * Reihenfolge ist hier keine Geschmacksfrage. Bricht der zweite Upload
       * ab – im Zug der Normalfall –, liegt ein Anhang ohne Sticker herum,
       * und das ist der harmlose Fall. Andersherum hätte man einen Sticker
       * mit einem Ton, der nie ankam. Angelegt wird deshalb erst, wenn beide
       * Dateien oben sind.
       */
      let tonAnhang: { id: string } | null = null;
      if (ton) {
        tonAnhang = await uploadBlob({
          kind: 'audio',
          mime: ton.mime,
          fileName: timestampName('stickerton', ton.mime),
          blob: ton.blob,
          durationMs: ton.dauerMs,
        });
      }

      const pack = await api.stickers.addSticker(packId, {
        attachmentId: attachment.id,
        emoji: firstEmoji(emoji) || null,
        ...(tonAnhang ? { tonAttachmentId: tonAnhang.id, tonDauerMs: ton?.dauerMs } : {}),
      });
      toast('Sticker gespeichert', 'success');
      onSaved(pack);
    } catch (error) {
      toast(errorMessage(error, 'Sticker konnte nicht gespeichert werden'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={saving ? () => {} : onClose} title="Sticker speichern">
      <div className="stk-save-preview">
        {preview && (
          <img src={preview} alt="Vorschau des neuen Stickers" width={128} height={128} />
        )}
      </div>

      {loading ? (
        <Spinner label="Pakete werden geladen …" />
      ) : (
        <div className="stk-radio-list">
          {packs.map((pack) => {
            const full = pack.stickerCount >= LIMITS.stickersPerPackMax;
            return (
              <button
                key={pack.id}
                type="button"
                className={`stk-radio ${target === pack.id ? 'is-active' : ''}`}
                onClick={() => setTarget(pack.id)}
                disabled={full}
              >
                <span className="stk-radio-dot" aria-hidden="true" />
                <span className="stk-radio-text">
                  <strong className="truncate">{pack.name}</strong>
                  <span className="muted">
                    {full
                      ? 'Paket ist voll'
                      : `${pack.stickerCount} von ${LIMITS.stickersPerPackMax} Stickern`}
                  </span>
                </span>
              </button>
            );
          })}

          <button
            type="button"
            className={`stk-radio ${target === 'new' ? 'is-active' : ''}`}
            onClick={() => setTarget('new')}
          >
            <span className="stk-radio-dot" aria-hidden="true" />
            <span className="stk-radio-text">
              <strong>Neues Paket</strong>
              <span className="muted">Legt ein eigenes Paket an</span>
            </span>
          </button>
        </div>
      )}

      {target === 'new' && (
        <div className="field">
          <label htmlFor="stk-new-pack">Name des Pakets</label>
          <input
            id="stk-new-pack"
            className="input"
            value={name}
            maxLength={LIMITS.stickerPackNameMax}
            onChange={(event) => setName(event.target.value)}
            placeholder="z. B. Familie"
          />
        </div>
      )}

      {/*
          Ton – optional, und zwar sichtbar optional.

          Der Abschnitt steht VOR dem Emoji, weil er der grössere Eingriff
          ist, und er zeigt im Ruhezustand genau einen Knopf. Ein Sticker
          ohne Ton bleibt damit so einfach zu speichern wie vorher.
      */}
      <div className="field">
        <label>Ton (optional)</label>
        {tonOffen ? (
          <TonWaehlen
            maxSekunden={Math.round(LIMITS.stickerTonMaxMs / 1000)}
            onAbbruch={() => setTonOffen(false)}
            onFertig={(ergebnis) => {
              setTon(ergebnis);
              setTonOffen(false);
              toast('Ton übernommen.', 'success');
            }}
          />
        ) : ton ? (
          <div className="row row-between">
            <span className="muted">🔊 {formatClock(ton.dauerMs)}</span>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn btn-sm" onClick={() => setTonOffen(true)}>
                Ändern
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setTon(null)}>
                Entfernen
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => setTonOffen(true)}
            disabled={saving}
          >
            🔊 Ton hinzufügen
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor="stk-emoji">Emoji (optional)</label>
        <input
          id="stk-emoji"
          className="input"
          value={emoji}
          maxLength={8}
          onChange={(event) => setEmoji(event.target.value)}
          placeholder="😀"
        />
        <div className="stk-emoji-row">
          {QUICK_EMOJI.map((value) => (
            <button
              key={value}
              type="button"
              className={`stk-emoji-btn ${emoji === value ? 'is-active' : ''}`}
              onClick={() => setEmoji(value === emoji ? '' : value)}
              aria-label={`Emoji ${value}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => void save()}
        disabled={!canSave}
      >
        {saving ? 'Wird gespeichert …' : 'Speichern'}
      </button>
      {/* Der Sticker liegt hier schon fertig als Blob vor – das ist der
          natuerliche Ort fuers Speichern aufs Geraet, und man muss ihn nicht
          erst irgendwohin schicken, um ihn zu behalten. */}
      <button
        type="button"
        className="btn btn-block"
        onClick={() => void aufsGeraet()}
        disabled={saving || laedtHerunter}
      >
        {laedtHerunter ? '…' : '⬇ Aufs Handy speichern'}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onClose} disabled={saving}>
        Abbrechen
      </button>
    </Sheet>
  );
}
