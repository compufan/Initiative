import { useEffect, useRef, useState } from 'react';
import type { MessageRendererProps } from '../types.js';
import { claimPlayback, releasePlayback } from '../media/helpers.js';
import { stickerSrc } from './helpers.js';

/**
 * Sticker bubble – 128 px, no bubble background. A sticker whose pack was
 * deleted in the meantime leaves a discreet hint instead of a broken image.
 *
 * # Warum ein Sticker mit Ton NICHT von selbst klingt
 *
 * Erstens, weil es nicht ginge: `play()` ohne vorangegangene Nutzergeste wird
 * in Chrome, Safari und Firefox mit `NotAllowedError` abgelehnt. Zweitens,
 * weil es auch dann falsch wäre, wenn es ginge – ein Gespräch mit zwanzig
 * klingenden Stickern spielte beim Öffnen zwanzig Töne übereinander.
 *
 * Also: Ein Tipp startet, der nächste hält an, und `claimPlayback` sorgt
 * dafür, dass immer nur einer klingt – dieselbe Regel wie bei
 * Sprachnachrichten und Videos.
 */
export function StickerBubble({ message }: MessageRendererProps) {
  const [broken, setBroken] = useState(false);
  const [spielt, setSpielt] = useState(false);
  /*
   * Die Adresse wird ERST beim ersten Tipp gesetzt.
   *
   * `preload="metadata"` wie bei der Sprachblase wäre hier falsch: Ein
   * Gespräch mit zwanzig klingenden Stickern löste zwanzig Anfragen aus,
   * bevor jemand irgendetwas angetippt hat.
   */
  const [tonQuelle, setTonQuelle] = useState<string | null>(null);
  const ton = useRef<HTMLAudioElement | null>(null);
  const gedruecktSeit = useRef(0);
  const sticker = message.sticker;
  const tonUrl = sticker?.tonUrl ?? null;

  useEffect(() => {
    const element = ton.current;
    return () => {
      if (element) {
        element.pause();
        releasePlayback(element);
      }
    };
  }, []);

  if (!sticker) {
    if (message.pending) {
      return (
        <div className="stk-bubble stk-bubble-pending">
          <span className="spinner" aria-hidden="true" />
          <span>Sticker wird gesendet …</span>
        </div>
      );
    }
    return <div className="stk-bubble-missing">Dieser Sticker ist nicht mehr verfügbar</div>;
  }

  if (broken) {
    return <div className="stk-bubble-missing">Dieser Sticker ist nicht mehr verfügbar</div>;
  }

  const beschreibung = sticker.emoji
    ? `Sticker ${sticker.emoji}`
    : `Sticker aus ${sticker.packName}`;

  const bild = (
    <img
      className="stk-bubble-image"
      src={stickerSrc(sticker.url)}
      alt={beschreibung}
      width={128}
      height={128}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );

  if (!tonUrl) return <div className="stk-bubble">{bild}</div>;

  const sekunden = Math.max(1, Math.round((sticker.tonDauerMs ?? 0) / 1000));

  const antippen = () => {
    /*
     * Ein langer Druck ist kein Tipp.
     *
     * `useLongPress` hängt an der Nachrichtenspalte und öffnet nach 450 ms das
     * Aktionsblatt – und je nach Browser kommt danach TROTZDEM ein `click`
     * hier an. Ohne diese Schranke startete der Ton jedes Mal, wenn jemand den
     * Sticker weiterleiten will. Dieselbe Überlegung wie der Schutz gegen
     * `event.detail === 0` bei der Sprachblase.
     */
    if (Date.now() - gedruecktSeit.current > 400) return;

    const element = ton.current;
    if (!element) {
      // Beim allerersten Tipp gibt es das Element noch nicht – die Quelle
      // wird gesetzt, und der Effekt am Element startet danach.
      setTonQuelle(tonUrl);
      setSpielt(true);
      return;
    }
    if (spielt) {
      element.pause();
      element.currentTime = 0;
      setSpielt(false);
      return;
    }
    claimPlayback(element);
    element.currentTime = 0;
    void element.play().catch(() => setSpielt(false));
    setSpielt(true);
  };

  return (
    <div className="stk-bubble">
      <button
        type="button"
        className={`stk-bubble-knopf${spielt ? ' ist-aktiv' : ''}`}
        onPointerDown={() => {
          gedruecktSeit.current = Date.now();
        }}
        onClick={antippen}
        aria-label={`${beschreibung} mit Ton, ${sekunden} Sekunden – ${
          spielt ? 'anhalten' : 'abspielen'
        }`}
      >
        {bild}
        <span className="stk-bubble-ton" aria-hidden="true">
          {spielt ? '⏸' : '🔊'}
        </span>
      </button>
      {tonQuelle && (
        <audio
          ref={ton}
          src={tonQuelle}
          preload="none"
          onCanPlay={(ereignis) => {
            // Der erste Tipp hat nur die Quelle gesetzt; gestartet wird hier,
            // sobald sie da ist. Der Browser zählt das noch zur Geste.
            const element = ereignis.currentTarget;
            if (spielt && element.paused) {
              claimPlayback(element);
              void element.play().catch(() => setSpielt(false));
            }
          }}
          onEnded={(ereignis) => {
            setSpielt(false);
            releasePlayback(ereignis.currentTarget);
          }}
          onPause={() => setSpielt(false)}
        />
      )}
    </div>
  );
}
