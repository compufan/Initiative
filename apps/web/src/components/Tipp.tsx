import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tippLage, type TippLage } from './tippLage.js';

/**
 * Tooltips, die auch auf einem Telefon ankommen.
 *
 * # Warum nicht `title`
 *
 * `title` ist die naheliegende Antwort und auf einem Handy nutzlos: Es
 * erscheint nur beim Zeigen mit der Maus. Auf einem Touchgerät gibt es kein
 * Zeigen – es gibt nur Berühren, und das ist schon der Klick. Die halbe App
 * trug `title`-Angaben, die dort niemand je gesehen hat.
 *
 * # Der Weg hier
 *
 * Ein `data-tipp="…"` an irgendeinem Element genügt. Diese Komponente hängt
 * sich EINMAL an das Dokument und findet das Element über `closest` – kein
 * Umbau an 357 Knöpfen, keine Umhüllung, kein zusätzlicher Zustand je Knopf.
 *
 * - **Finger**: 500 ms drücken. Bewegt sich der Finger, wird abgebrochen –
 *   sonst öffnete jedes Scrollen Blasen.
 * - **Maus**: Zeigen genügt, nach 400 ms.
 *
 * # Das Lesen darf nicht auslösen
 *
 * Der Punkt, an dem so etwas gewöhnlich schiefgeht: Wer lange auf „Löschen“
 * drückt, um zu lesen, was es tut, hat danach gelöscht. Deshalb schluckt
 * diese Komponente genau EINEN Klick, nachdem sie eine Blase gezeigt hat –
 * in der Erfassungsphase, bevor React ihn überhaupt sieht.
 */

/** So lange muss ein Finger liegen bleiben. */
const HALTEN_MS = 500;

/** So lange muss eine Maus stillstehen. */
const ZEIGEN_MS = 400;

/** Ab dieser Bewegung ist es kein Halten mehr, sondern ein Wischen. */
const WACKELN_PX = 12;

interface Sichtbar {
  text: string;
  lage: TippLage;
}

export function Tipp() {
  const [sichtbar, setSichtbar] = useState<Sichtbar | null>(null);
  const blase = useRef<HTMLDivElement | null>(null);
  const uhr = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const ziel = useRef<HTMLElement | null>(null);
  /** Steht auf true, solange ein Klick zu schlucken ist. */
  const schlucken = useRef(false);

  useEffect(() => {
    const abbrechen = () => {
      if (uhr.current != null) {
        window.clearTimeout(uhr.current);
        uhr.current = null;
      }
      start.current = null;
      ziel.current = null;
    };

    const zeigen = (element: HTMLElement, text: string) => {
      const kasten = element.getBoundingClientRect();
      /*
       * Erst zeigen, dann messen, dann setzen.
       *
       * Die Breite der Blase hängt an ihrem Text, und die kennt nur der
       * Browser. Ein geschätzter Wert wäre bei „Motiv + Tiefe“ und bei
       * „Zuschneiden, geraderichten, Licht und Farbe“ gleich falsch. Also
       * wird sie unsichtbar gesetzt, gemessen und im selben Bild
       * verschoben – `requestAnimationFrame` macht daraus einen Schritt,
       * den niemand flackern sieht.
       */
      setSichtbar({
        text,
        lage: tippLage(
          { links: kasten.left, oben: kasten.top, breite: kasten.width, hoehe: kasten.height },
          { breite: 220, hoehe: 44 },
          { breite: window.innerWidth, hoehe: window.innerHeight },
        ),
      });
      requestAnimationFrame(() => {
        const el = blase.current;
        if (!el) return;
        const eigen = el.getBoundingClientRect();
        setSichtbar((alt) =>
          alt
            ? {
                ...alt,
                lage: tippLage(
                  {
                    links: kasten.left,
                    oben: kasten.top,
                    breite: kasten.width,
                    hoehe: kasten.height,
                  },
                  { breite: eigen.width, hoehe: eigen.height },
                  { breite: window.innerWidth, hoehe: window.innerHeight },
                ),
              }
            : alt,
        );
      });
      schlucken.current = true;
    };

    const beiDruck = (event: PointerEvent) => {
      setSichtbar(null);
      schlucken.current = false;
      abbrechen();
      if (event.pointerType === 'mouse') return;
      const element = (event.target as Element | null)?.closest<HTMLElement>('[data-tipp]');
      const text = element?.dataset.tipp;
      if (!element || !text) return;
      start.current = { x: event.clientX, y: event.clientY };
      ziel.current = element;
      uhr.current = window.setTimeout(() => {
        uhr.current = null;
        if (ziel.current) zeigen(ziel.current, text);
      }, HALTEN_MS);
    };

    const beiBewegung = (event: PointerEvent) => {
      const anfang = start.current;
      if (!anfang) return;
      if (Math.hypot(event.clientX - anfang.x, event.clientY - anfang.y) > WACKELN_PX) abbrechen();
    };

    const beiLoslassen = () => {
      abbrechen();
    };

    const beiZeigen = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const element = (event.target as Element | null)?.closest<HTMLElement>('[data-tipp]');
      const text = element?.dataset.tipp;
      if (!element || !text) {
        abbrechen();
        setSichtbar(null);
        return;
      }
      if (ziel.current === element) return;
      abbrechen();
      ziel.current = element;
      uhr.current = window.setTimeout(() => {
        uhr.current = null;
        zeigen(element, text);
        // Beim Zeigen mit der Maus gibt es keinen Klick zu schlucken – wer
        // klickt, hat vorher gesehen, was der Knopf tut.
        schlucken.current = false;
      }, ZEIGEN_MS);
    };

    const beiKlick = (event: MouseEvent) => {
      if (!schlucken.current) return;
      schlucken.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const zu = () => {
      abbrechen();
      setSichtbar(null);
    };

    document.addEventListener('pointerdown', beiDruck, true);
    document.addEventListener('pointermove', beiBewegung, true);
    document.addEventListener('pointerup', beiLoslassen, true);
    document.addEventListener('pointercancel', zu, true);
    document.addEventListener('pointerover', beiZeigen, true);
    document.addEventListener('click', beiKlick, true);
    window.addEventListener('scroll', zu, true);
    window.addEventListener('resize', zu);
    return () => {
      abbrechen();
      document.removeEventListener('pointerdown', beiDruck, true);
      document.removeEventListener('pointermove', beiBewegung, true);
      document.removeEventListener('pointerup', beiLoslassen, true);
      document.removeEventListener('pointercancel', zu, true);
      document.removeEventListener('pointerover', beiZeigen, true);
      document.removeEventListener('click', beiKlick, true);
      window.removeEventListener('scroll', zu, true);
      window.removeEventListener('resize', zu);
    };
  }, []);

  if (!sichtbar) return null;

  return createPortal(
    <div
      ref={blase}
      className={`tipp${sichtbar.lage.darunter ? ' tipp-unten' : ''}`}
      style={{ left: sichtbar.lage.links, top: sichtbar.lage.oben }}
      role="tooltip"
    >
      {sichtbar.text}
    </div>,
    document.body,
  );
}
