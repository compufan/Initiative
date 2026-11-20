import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import {
  emojiLaden,
  emojiSuchen,
  zuletztLesen,
  zuletztMerken,
  type EmojiDaten,
} from './emoji.js';

interface EmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onWaehlen: (emoji: string) => void;
  titel?: string;
}

/**
 * Die volle Emoji-Auswahl hinter „＋“: Kategorien, Suche (deutsch und
 * englisch) und die zuletzt benutzten.
 *
 * Tastatur: Tab erreicht Suche, Kategorien und Raster; jedes Emoji ist ein
 * Knopf mit seinem deutschen Namen als Beschriftung.
 */
export function EmojiPicker({ open, onClose, onWaehlen, titel = 'Emoji wählen' }: EmojiPickerProps) {
  return (
    <Sheet open={open} onClose={onClose} title={titel}>
      {open && <Auswahl onWaehlen={onWaehlen} />}
    </Sheet>
  );
}

function Auswahl({ onWaehlen }: { onWaehlen: (emoji: string) => void }) {
  const [daten, setDaten] = useState<EmojiDaten | null>(null);
  const [fehler, setFehler] = useState(false);
  const [suche, setSuche] = useState('');
  const [kategorie, setKategorie] = useState<string>('zuletzt');
  const zuletzt = useMemo(() => zuletztLesen(), []);
  const rasterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let aktiv = true;
    emojiLaden()
      .then((geladen) => {
        if (!aktiv) return;
        setDaten(geladen);
        if (zuletzt.length === 0) setKategorie(geladen.kategorien[0]?.id ?? 'smileys');
      })
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [zuletzt.length]);

  const sichtbar = useMemo(() => {
    if (!daten) return [];
    if (suche.trim()) return emojiSuchen(daten.emoji, suche);
    if (kategorie === 'zuletzt') {
      return zuletzt.map(
        (emoji) =>
          daten.emoji.find((eintrag) => eintrag.emoji === emoji) ?? {
            emoji,
            kategorie: 'zuletzt',
            de: emoji,
            en: '',
          },
      );
    }
    return daten.emoji.filter((eintrag) => eintrag.kategorie === kategorie);
  }, [daten, suche, kategorie, zuletzt]);

  function waehlen(emoji: string) {
    zuletztMerken(emoji);
    onWaehlen(emoji);
  }

  if (fehler) return <p className="muted">Die Emoji-Auswahl liess sich nicht laden.</p>;
  if (!daten) return <Spinner label="Emoji werden geladen" />;

  return (
    <div className="stack emoji-auswahl">
      <input
        type="search"
        className="input"
        placeholder="Emoji suchen (z. B. herz, lachen, party)"
        aria-label="Emoji suchen"
        value={suche}
        onChange={(event) => setSuche(event.target.value)}
        autoFocus
      />
      {!suche.trim() && (
        <div className="emoji-kategorien" role="tablist" aria-label="Kategorien">
          {zuletzt.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={kategorie === 'zuletzt'}
              aria-label="Zuletzt benutzt"
              title="Zuletzt benutzt"
              className={`emoji-kategorie ${kategorie === 'zuletzt' ? 'is-aktiv' : ''}`}
              onClick={() => setKategorie('zuletzt')}
            >
              🕘
            </button>
          )}
          {daten.kategorien.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kategorie === k.id}
              aria-label={k.name}
              title={k.name}
              className={`emoji-kategorie ${kategorie === k.id ? 'is-aktiv' : ''}`}
              onClick={() => {
                setKategorie(k.id);
                rasterRef.current?.scrollTo({ top: 0 });
              }}
            >
              {k.symbol}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-raster" ref={rasterRef} role="group" aria-label="Emoji">
        {sichtbar.map((eintrag) => (
          <button
            key={eintrag.emoji}
            type="button"
            className="emoji-knopf"
            aria-label={eintrag.de}
            title={eintrag.de}
            onClick={() => waehlen(eintrag.emoji)}
          >
            {eintrag.emoji}
          </button>
        ))}
        {sichtbar.length === 0 && <p className="muted">Kein passendes Emoji gefunden.</p>}
      </div>
    </div>
  );
}
