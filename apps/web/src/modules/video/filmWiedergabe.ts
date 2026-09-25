import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { Stueck } from './ausschnitt.js';
import { filmDauerMs, filmZuQuelle, quelleZuFilm } from './schnitt.js';

/**
 * Den FILM abspielen – nicht das Quellvideo.
 *
 * Ein Videoelement kennt nur sein eigenes Video. Der Film aus mehreren
 * Abschnitten ist aber eine Reihe von Sprüngen darin: Ist ein Abschnitt zu
 * Ende, geht es am Anfang des nächsten weiter, auch wenn der im Quellvideo
 * vorn liegt oder derselbe noch einmal ist. Genau das tut dieser Haken, und
 * zwar für das Blatt und für den Editor gleich – zwei Fassungen davon wären
 * zwei Stellen, an denen die Wiedergabe über eine Grenze hinwegspringt.
 *
 * Die Wiedergabestelle zählt in FILMzeit. Eine Quellzeit allein wüsste
 * nicht, in welchem Abschnitt sie steht, sobald ein Ausschnitt zweimal
 * vorkommt.
 */
export interface FilmWiedergabe {
  /** Die Stelle im Film, in Millisekunden. */
  readonly spielkopfMs: number;
  readonly spielt: boolean;
  /** Welcher Abschnitt gerade läuft oder zuletzt lief. */
  readonly nummer: number;
  abspielen(): void;
  anhalten(): void;
  /** Springt an eine Stelle im Film und hält dort an. */
  setzen(filmMs: number): void;
}

export function useFilmWiedergabe(
  videoRef: RefObject<HTMLVideoElement | null>,
  abschnitte: readonly Stueck[],
): FilmWiedergabe {
  const [spielkopfMs, setSpielkopfMs] = useState(0);
  const [spielt, setSpielt] = useState(false);
  const [nummer, setNummer] = useState(0);
  const nummerRef = useRef(0);
  const liste = useRef(abschnitte);
  liste.current = abschnitte;

  const nummerSetzen = useCallback((neu: number) => {
    nummerRef.current = neu;
    setNummer(neu);
  }, []);

  const anhalten = useCallback(() => {
    videoRef.current?.pause();
    setSpielt(false);
  }, [videoRef]);

  const setzen = useCallback(
    (filmMs: number) => {
      const gesamt = filmDauerMs(liste.current);
      const film = Math.max(0, Math.min(gesamt, filmMs));
      const ort = filmZuQuelle(liste.current, film);
      const element = videoRef.current;
      if (element) {
        element.pause();
        if (ort) element.currentTime = ort.quelleMs / 1000;
      }
      if (ort) nummerSetzen(ort.nummer);
      setSpielt(false);
      setSpielkopfMs(film);
    },
    [nummerSetzen, videoRef],
  );

  const abspielen = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const gesamt = filmDauerMs(liste.current);
    // Am Ende angekommen fängt ein neuer Druck auf „Abspielen" vorn an –
    // sonst stünde er dort und täte sichtbar nichts.
    const start = spielkopfMs >= gesamt - 1 ? 0 : spielkopfMs;
    const ort = filmZuQuelle(liste.current, start);
    if (!ort) return;
    nummerSetzen(ort.nummer);
    element.currentTime = ort.quelleMs / 1000;
    setSpielkopfMs(start);
    setSpielt(true);
    void element.play().catch(() => setSpielt(false));
  }, [nummerSetzen, spielkopfMs, videoRef]);

  /*
   * Die Grenzen werden je Bild der Anzeige geprüft, nicht über
   * `timeupdate`.
   *
   * `timeupdate` kommt nur rund viermal je Sekunde; ein Abschnitt liefe
   * dann bis zu einer Viertelsekunde über sein Ende hinaus, und genau die
   * Stelle, die jemand herausgeschnitten hat, blitzte bei jedem Abspielen
   * wieder auf.
   */
  useEffect(() => {
    if (!spielt) return undefined;
    let rahmen = 0;
    const schritt = () => {
      const element = videoRef.current;
      const abschnitte = liste.current;
      if (!element || abschnitte.length === 0) return;
      let aktuell = Math.min(nummerRef.current, abschnitte.length - 1);
      const zeit = element.currentTime * 1000;
      const stueck = abschnitte[aktuell];
      if (zeit >= stueck.bisMs - 1 || element.ended) {
        if (aktuell + 1 >= abschnitte.length) {
          element.pause();
          setSpielt(false);
          setSpielkopfMs(filmDauerMs(abschnitte));
          return;
        }
        aktuell += 1;
        nummerSetzen(aktuell);
        element.currentTime = abschnitte[aktuell].vonMs / 1000;
        if (element.paused) void element.play().catch(() => setSpielt(false));
        setSpielkopfMs(quelleZuFilm(abschnitte, aktuell, abschnitte[aktuell].vonMs));
      } else if (zeit >= stueck.vonMs - 50) {
        // Während eines Sprungs steht `currentTime` noch kurz an der alten
        // Stelle – die zählt nicht als Wiedergabestelle.
        setSpielkopfMs(quelleZuFilm(abschnitte, aktuell, zeit));
      }
      rahmen = requestAnimationFrame(schritt);
    };
    rahmen = requestAnimationFrame(schritt);
    return () => cancelAnimationFrame(rahmen);
  }, [nummerSetzen, spielt, videoRef]);

  /*
   * Ändern sich die Abschnitte (Kürzen, Teilen, Entfernen), bleibt die
   * Stelle im Film – aber nie hinter dem neuen Ende.
   */
  useEffect(() => {
    const gesamt = filmDauerMs(abschnitte);
    setSpielkopfMs((alt) => Math.min(alt, gesamt));
    const ort = filmZuQuelle(abschnitte, Math.min(spielkopfMs, gesamt));
    if (ort && ort.nummer !== nummerRef.current) nummerSetzen(ort.nummer);
    // `spielkopfMs` gehört nicht hinein: Die Stelle soll hier nur nachgezogen
    // werden, wenn sich die LISTE ändert, nicht bei jedem Bild der Wiedergabe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abschnitte, nummerSetzen]);

  return { spielkopfMs, spielt, nummer, abspielen, anhalten, setzen };
}
