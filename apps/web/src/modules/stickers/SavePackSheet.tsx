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

const QUICK_EMOJI = ['😀', '😂', '😍', '🥳', '😎', '🤯', '😭', '👍', '🙏', '🔥', '✨', '💜'];

interface SavePackSheetProps {
  blob: Blob;
  mime: string;
  onClose: () => void;
  onSaved: (pack: StickerPackDto) => void;
}

/** Second half of the studio: pick a pack (or create one) and upload. */
export function SavePackSheet({ blob, mime, onClose, onSaved }: SavePackSheetProps) {
  const myId = useMyId();
  const [packs, setPacks] = useState<StickerPackDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<string>('new');
  const [name, setName] = useState('Meine Sticker');
  const [emoji, setEmoji] = useState('');
  const [saving, setSaving] = useState(false);
  const [laedtHerunter, setLaedtHerunter] = useState(false);
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
        const usable = own.find((pack) => pack.stickerCount < LIMITS.stickersPerPackMax);
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
  }, [myId]);

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

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const packId =
        target === 'new'
          ? (await api.stickers.createPack({ name: trimmedName, isPublic: false })).id
          : target;

      const attachment = await uploadBlob({
        kind: 'sticker',
        mime,
        fileName: stickerFileName(mime),
        blob,
        width: STICKER_SIZE,
        height: STICKER_SIZE,
      });

      const pack = await api.stickers.addSticker(packId, {
        attachmentId: attachment.id,
        emoji: firstEmoji(emoji) || null,
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
