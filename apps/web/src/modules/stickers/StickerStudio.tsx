import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { LIMITS, formatBytes, type StickerPackDto } from '@initiative/shared';
import { toast, useHideNav } from '../../state/ui.js';
import { clamp, errorMessage, firstEmoji, loadImageFromBlob, supportsWebp } from './helpers.js';
import { SavePackSheet } from './SavePackSheet.js';
import {
  STICKER_SIZE,
  cloneDoc,
  createDoc,
  exportSticker,
  isEmptyDoc,
  lupeGrenzen,
  renderSticker,
  toSourcePoint,
  type EditorSource,
  type ShapeKind,
  type StickerDoc,
  type TextSlot,
} from './render.js';
import {
  ENGINE_INFO,
  EngineError,
  engineAvailable,
  engineInfo,
  runEngine,
  type EngineKey,
} from './engines/index.js';
import { kanteWeichzeichnen, maskeTraegt, vorlageAus } from './engines/prepare.js';
import { teilAn, teileFinden } from './engines/teile.js';

type Tool = 'move' | 'erase' | 'keep' | 'teile';
type Tab = 'source' | 'move' | 'shape' | 'cutout' | 'detail' | 'outline' | 'text';

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'source', icon: '🖼️', label: 'Quelle' },
  { key: 'move', icon: '✋', label: 'Bewegen' },
  { key: 'shape', icon: '⬜', label: 'Form' },
  { key: 'cutout', icon: '🪄', label: 'Freistellen' },
  { key: 'detail', icon: '🔍', label: 'Detail' },
  { key: 'outline', icon: '✨', label: 'Kontur' },
  { key: 'text', icon: '🅣', label: 'Text' },
];

const SHAPES: { key: ShapeKind; label: string; icon: string }[] = [
  { key: 'square', label: 'Quadrat', icon: '⬜' },
  { key: 'circle', label: 'Kreis', icon: '⚪' },
  { key: 'free', label: 'Frei', icon: '🧽' },
];

const START_EMOJI = ['😀', '😂', '😍', '🥳', '😎', '🤔', '🙈', '🔥', '✨', '💜', '🎉', '🚀'];
const TEXT_COLORS = ['#ffffff', '#111111', '#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#af52de'];

const MIN_SCALE = 0.3;
const MAX_SCALE = 5;

/**
 * Wie weit die Lupe vergrössert.
 *
 * Acht ist kein willkürlicher Wert: Bei 512 Bildpunkten auf etwa 360 CSS-Pixeln
 * Anzeige ist ein Bildpunkt sonst 0,7 Pixel gross – mit dem Finger nicht zu
 * treffen. Bei 8x sind es gut fünf, und man kommt an eine Kontur heran.
 */
const MAX_LUPE = 8;
const HISTORY_MAX = 30;

interface StickerStudioProps {
  onClose: () => void;
  onSaved?: (pack: StickerPackDto) => void;
}

interface GestureState {
  mode: 'none' | 'pan' | 'pinch' | 'erase' | 'lupe' | 'lupenpinch';
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
  startDistance: number;
  startScale: number;
}

/**
 * Full screen sticker editor: photo, text or emoji as source, pan/pinch, shape
 * masks, an eraser, the simple background removal, the white sticker outline
 * and two text layers. Everything is rendered into a 512×512 canvas.
 */
export function StickerStudio({ onClose, onSaved }: StickerStudioProps) {
  useHideNav(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [source, setSource] = useState<EditorSource | null>(null);
  const [doc, setDoc] = useState<StickerDoc>(createDoc);
  const [tab, setTab] = useState<Tab>('source');
  const [tool, setTool] = useState<Tool>('move');
  const [slot, setSlot] = useState<TextSlot>('top');
  const [brush, setBrush] = useState(56);
  /** Ob der Pinsel wegnimmt oder das Original zurückholt. */
  const [pinsel, setPinsel] = useState<'weg' | 'zurueck'>('weg');
  /**
   * Die Lupe: reine Ansicht, nicht Teil des Stickers.
   *
   * Sie steht bewusst nicht im `doc` – sonst landete jedes Heranzoomen im
   * Rückgängig-Verlauf und, schlimmer, im gespeicherten Sticker. `x`/`y` ist
   * der Punkt, der in der Mitte steht, in Sticker-Koordinaten.
   */
  const [lupe, setLupe] = useState({ zoom: 1, x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 });
  const [emojiInput, setEmojiInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** Welches Modell gerade rechnet – für Spinner und gesperrte Knöpfe. */
  const [rechnet, setRechnet] = useState<EngineKey | null>(null);
  const [modellFehler, setModellFehler] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; mime: string } | null>(null);

  const docRef = useRef(doc);
  const sourceRef = useRef(source);
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  const pinselRef = useRef(pinsel);
  const lupeRef = useRef(lupe);
  const history = useRef<StickerDoc[]>([]);
  const lastCommit = useRef<{ label: string; at: number }>({ label: '', at: 0 });
  const pending = useRef<{ doc: StickerDoc; used: boolean } | null>(null);
  /**
   * Die liegenden Finger – in Sticker- *und* in Bildschirmkoordinaten.
   *
   * Beides wird gebraucht: Die Werkzeuge rechnen im Sticker, die Lupe muss auf
   * dem Bildschirm messen. Rechnete die Lupe im Sticker, veraenderte ihr
   * eigenes Zoomen die Messung, und das Zusammenziehen zweier Finger bliebe
   * ohne Wirkung.
   */
  const pointers = useRef(new Map<number, { x: number; y: number; cx: number; cy: number }>());
  const gesture = useRef<GestureState>({
    mode: 'none',
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    startDistance: 0,
    startScale: 1,
  });
  /**
   * Der laufende Lupenzug – in Bildschirmpixeln, nicht in Sticker-Koordinaten.
   *
   * Das ist wichtig: Waehrend des Ziehens verschiebt sich die Lupe, und damit
   * auch die Umrechnung Bildschirm -> Sticker. Rechnete man in
   * Sticker-Koordinaten, jagte sich das Bild selbst hinterher.
   */
  const lupenZug = useRef({ clientX: 0, clientY: 0, x: 0, y: 0, faktor: 1, distanz: 1, zoom: 1 });
  const busyGesture = useRef(false);
  const frame = useRef<number | null>(null);

  const render = useCallback((fast: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderSticker(canvas, sourceRef.current, docRef.current, {
      fast,
      // Waehrend der Arbeit bleibt Abgewaehltes sichtbar und gekennzeichnet.
      auswahlZeigen: toolRef.current === 'teile',
    });
  }, []);

  const schedule = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      render(busyGesture.current);
    });
  }, [render]);

  useEffect(() => {
    docRef.current = doc;
    sourceRef.current = source;
    schedule();
  }, [doc, source, schedule]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    pinselRef.current = pinsel;
  }, [pinsel]);

  useEffect(() => {
    lupeRef.current = lupe;
  }, [lupe]);

  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // The editor owns the viewport – the page behind it must not scroll away.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* ---------- history ---------- */

  const push = useCallback((snapshot: StickerDoc) => {
    history.current = [...history.current, snapshot].slice(-HISTORY_MAX);
    setCanUndo(true);
  }, []);

  /**
   * Saves the current document for undo. A label coalesces rapid changes of the
   * same kind (typing, dragging a slider) into a single step.
   */
  const commit = useCallback(
    (label?: string) => {
      const now = Date.now();
      if (label && lastCommit.current.label === label && now - lastCommit.current.at < 1500) {
        lastCommit.current = { label, at: now };
        return;
      }
      push(cloneDoc(docRef.current));
      lastCommit.current = { label: label ?? '', at: now };
    },
    [push],
  );

  /** Gestures only cost an undo step once they actually moved something. */
  const armGesture = useCallback(() => {
    pending.current = { doc: cloneDoc(docRef.current), used: false };
  }, []);

  const commitArmedGesture = useCallback(() => {
    const armed = pending.current;
    if (!armed || armed.used) return;
    armed.used = true;
    lastCommit.current = { label: '', at: 0 };
    push(armed.doc);
  }, [push]);

  const undo = useCallback(() => {
    const previous = history.current[history.current.length - 1];
    if (!previous) return;
    history.current = history.current.slice(0, -1);
    lastCommit.current = { label: '', at: 0 };
    setCanUndo(history.current.length > 0);
    setDoc(previous);
  }, []);

  const reset = useCallback(() => {
    commit();
    setDoc(createDoc());
    setTool('move');
    setLupe({ zoom: 1, x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 });
  }, [commit]);

  /**
   * Ein Teil der Modell-Maske an- oder abwählen.
   *
   * Der Finger tippt auf die Sticker-Fläche, die Maske liegt im Quellbild –
   * dazwischen liegen Verschieben und Zoomen, also muss der Punkt
   * zurückgerechnet werden. Ohne das wählt man beim Gruppenfoto das falsche
   * Objekt, und zwar umso mehr, je weiter man hineingezoomt hat.
   */
  function teilUmschalten(punkt: { x: number; y: number }) {
    const quelle = sourceRef.current;
    const maske = docRef.current.autoMask;
    if (!quelle || quelle.kind !== 'image' || !maske?.teile) return;

    const imBild = toSourcePoint(punkt, quelle, docRef.current);
    const faktor = maske.width / quelle.width;
    const teil = teilAn(maske.teile, imBild.x * faktor, imBild.y * faktor);
    if (teil === 0) return;

    commit();
    setDoc((value) => {
      const dabei = value.maskParts.includes(teil);
      // Leer heisst „alles“. Das erste Antippen wählt also NUR das Getippte
      // aus, statt es aus einer gedachten Vollauswahl zu entfernen – sonst
      // täte der erste Fingertipp das Gegenteil dessen, was man erwartet.
      const naechste = dabei
        ? value.maskParts.filter((nummer) => nummer !== teil)
        : [...value.maskParts, teil];
      return { ...value, maskParts: naechste };
    });
  }

  /**
   * Ein Modell laufen lassen und seine Maske übernehmen.
   *
   * Alles rechnet im Gerät. Beim ersten Mal wird das Modell geladen – deshalb
   * der Hinweis im Knopf, wie gross das ist.
   */
  const modellAnwenden = useCallback(
    async (key: EngineKey) => {
      const quelle = sourceRef.current;
      if (!quelle || quelle.kind !== 'image') return;
      setRechnet(key);
      setModellFehler(null);
      try {
        const { image, faktor } = vorlageAus(quelle.image, quelle.width, quelle.height);

        // Ein zuvor angetippter Punkt sagt dem Modell, welches Gesicht gemeint
        // ist. Er liegt auf der Sticker-Fläche und muss zurück ins Bild.
        const getippt = docRef.current.keep.at(-1);
        const seed = getippt
          ? (() => {
              const p = toSourcePoint(getippt, quelle, docRef.current);
              return { x: p.x * faktor, y: p.y * faktor };
            })()
          : undefined;

        const roh = await runEngine(key, { image, seed });
        const alpha = kanteWeichzeichnen(roh, image.width, image.height, 1);
        if (!maskeTraegt(alpha)) {
          throw new EngineError(
            `„${engineInfo(key).label}“ hat nichts gefunden, was sich freistellen lässt. Versuche ein anderes Verfahren oder tippe das Motiv an.`,
            key,
          );
        }

        // Die Maske in antippbare Flaechen zerlegen. Erst damit wird aus
        // "alles oder nichts" ein Auswaehlen: Flasche antippen, dann die
        // Person dazu. Siehe engines/teile.ts.
        const teile = teileFinden(alpha, image.width, image.height);

        commit();
        setDoc((value) => ({
          ...value,
          autoMask: { engine: key, width: image.width, height: image.height, alpha, teile },
          // Leere Auswahl heisst „alles“ – wer nichts antippt, bekommt wie
          // bisher das ganze Ergebnis des Modells.
          maskParts: [],
          // Antippen und "Ecken entfernen" wuerden dem Modell nur ins Handwerk
          // pfuschen – die faengt man neu an, wenn man sie braucht.
          keep: [],
          removeBg: false,
        }));
        // Gibt es mehr als eine Flaeche, ist Auswaehlen das Naheliegende.
        setTool(teile.anzahl > 1 ? 'teile' : 'move');
      } catch (error) {
        setModellFehler(
          error instanceof EngineError
            ? error.message
            : `Freistellen fehlgeschlagen: ${errorMessage(error, 'Unbekannter Fehler')}`,
        );
      } finally {
        setRechnet(null);
      }
    },
    [commit],
  );

  /* ---------- source ---------- */

  function applySource(next: EditorSource | null) {
    history.current = [];
    lastCommit.current = { label: '', at: 0 };
    setCanUndo(false);
    setSource(next);
    setDoc(createDoc());
    setTool('move');
    setLupe({ zoom: 1, x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 });
  }

  async function pickImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const image = await loadImageFromBlob(file);
      applySource({
        kind: 'image',
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setTab('move');
    } catch (error) {
      toast(errorMessage(error, 'Das Bild konnte nicht geladen werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function chooseEmoji(value: string) {
    const emoji = firstEmoji(value);
    if (!emoji) return;
    applySource({ kind: 'emoji', emoji });
    setTab('text');
  }

  /* ---------- Lupe ---------- */

  const lupeSetzen = useCallback((next: { zoom: number; x: number; y: number }) => {
    setLupe(lupeGrenzen(next, MAX_LUPE));
  }, []);

  /**
   * Was die Lupe mit dem Bild macht: erst vergroessern, dann den gewaehlten
   * Punkt in die Mitte schieben. In CSS wirkt die rechte Angabe zuerst,
   * deshalb steht `scale` hinten.
   */
  const lupeStil =
    lupe.zoom === 1
      ? undefined
      : {
          transformOrigin: '0 0',
          transform: `translate(${(0.5 - (lupe.zoom * lupe.x) / STICKER_SIZE) * 100}%, ${
            (0.5 - (lupe.zoom * lupe.y) / STICKER_SIZE) * 100
          }%) scale(${lupe.zoom})`,
          // Ab einer gewissen Vergroesserung sieht man ohnehin einzelne
          // Bildpunkte. Scharfe Kanten helfen dabei, weichgezeichneter Brei
          // nicht.
          imageRendering: lupe.zoom >= 4 ? ('pixelated' as const) : undefined,
        };

  /* ---------- canvas gestures ---------- */

  function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const factor = STICKER_SIZE / (rect.width || 1);
    return { x: (clientX - rect.left) * factor, y: (clientY - rect.top) * factor };
  }

  function midpoint(): { x: number; y: number; distance: number } {
    const list = [...pointers.current.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return { x: 0, y: 0, distance: 0 };
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  /** Der Fingerabstand auf dem Bildschirm – unabhaengig von der Lupe. */
  function clientDistance(): number {
    const list = [...pointers.current.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return 1;
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) || 1;
  }

  function beginPinch() {
    const mid = midpoint();
    const current = docRef.current;
    gesture.current = {
      mode: 'pinch',
      startX: mid.x,
      startY: mid.y,
      startOffsetX: current.offsetX,
      startOffsetY: current.offsetY,
      startDistance: mid.distance || 1,
      startScale: current.scale,
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!source) return;
    const point = canvasPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, { ...point, cx: event.clientX, cy: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is a nice-to-have */
    }

    busyGesture.current = true;
    if (pointers.current.size >= 2) {
      // Ueber 1x gehoeren beide Finger der Lupe: Wer eine Kontur bearbeitet,
      // will sich naeher heranholen und nicht den Bildausschnitt umbauen. Die
      // Lupe aendert am Sticker nichts, also gibt es dafuer auch nichts
      // rueckgaengig zu machen.
      if (lupeRef.current.zoom > 1) {
        beginLupenPinch();
        return;
      }
      armGesture();
      beginPinch();
      return;
    }

    const current = docRef.current;
    if (toolRef.current === 'teile') {
      armGesture();
      commitArmedGesture();
      gesture.current = { ...gesture.current, mode: 'none' };
      teilUmschalten(point);
      return;
    }
    if (toolRef.current === 'keep') {
      armGesture();
      commitArmedGesture();
      // Kein Ziehen: Ein Antippen ist ein Punkt, aus dem der Bereich waechst.
      gesture.current = { ...gesture.current, mode: 'none' };
      setDoc((value) => ({ ...value, keep: [...value.keep, { x: point.x, y: point.y }] }));
      return;
    }
    if (toolRef.current === 'erase') {
      armGesture();
      commitArmedGesture();
      gesture.current = { ...gesture.current, mode: 'erase' };
      setDoc((value) => ({
        ...value,
        strokes: [
          ...value.strokes,
          { size: brushRef.current, points: [point.x, point.y], mode: pinselRef.current },
        ],
      }));
      return;
    }

    if (lupeRef.current.zoom > 1) {
      // Verschieben heisst hier: den Ausschnitt unter der Lupe bewegen.
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      lupenZug.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        x: lupeRef.current.x,
        y: lupeRef.current.y,
        faktor: STICKER_SIZE / (rect?.width || 1),
        distanz: 1,
        zoom: lupeRef.current.zoom,
      };
      gesture.current = { ...gesture.current, mode: 'lupe' };
      return;
    }

    armGesture();
    gesture.current = {
      mode: 'pan',
      startX: point.x,
      startY: point.y,
      startOffsetX: current.offsetX,
      startOffsetY: current.offsetY,
      startDistance: 0,
      startScale: current.scale,
    };
  }

  /** Zwei Finger auf der Lupe: naeher heran oder wieder heraus. */
  function beginLupenPinch() {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    lupenZug.current = {
      clientX: 0,
      clientY: 0,
      x: lupeRef.current.x,
      y: lupeRef.current.y,
      faktor: STICKER_SIZE / (rect?.width || 1),
      distanz: clientDistance(),
      zoom: lupeRef.current.zoom,
    };
    gesture.current = { ...gesture.current, mode: 'lupenpinch' };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = canvasPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, { ...point, cx: event.clientX, cy: event.clientY });
    const state = gesture.current;

    if (state.mode === 'pinch' && pointers.current.size >= 2) {
      commitArmedGesture();
      const mid = midpoint();
      const ratio = clamp(
        (mid.distance || 1) / state.startDistance,
        MIN_SCALE / state.startScale,
        MAX_SCALE / state.startScale,
      );
      const centre = STICKER_SIZE / 2;
      setDoc((value) => ({
        ...value,
        scale: state.startScale * ratio,
        offsetX: mid.x - centre - (state.startX - centre - state.startOffsetX) * ratio,
        offsetY: mid.y - centre - (state.startY - centre - state.startOffsetY) * ratio,
      }));
      return;
    }

    if (state.mode === 'lupe') {
      const zug = lupenZug.current;
      lupeSetzen({
        zoom: zug.zoom,
        x: zug.x - (event.clientX - zug.clientX) * zug.faktor,
        y: zug.y - (event.clientY - zug.clientY) * zug.faktor,
      });
      return;
    }

    if (state.mode === 'lupenpinch' && pointers.current.size >= 2) {
      const zug = lupenZug.current;
      lupeSetzen({ zoom: (zug.zoom * clientDistance()) / zug.distanz, x: zug.x, y: zug.y });
      return;
    }

    if (state.mode === 'pan') {
      commitArmedGesture();
      setDoc((value) => ({
        ...value,
        offsetX: state.startOffsetX + (point.x - state.startX),
        offsetY: state.startOffsetY + (point.y - state.startY),
      }));
      return;
    }

    if (state.mode === 'erase') {
      setDoc((value) => {
        const strokes = value.strokes.slice();
        const last = strokes[strokes.length - 1];
        if (!last) return value;
        strokes[strokes.length - 1] = {
          ...last,
          points: [...last.points, point.x, point.y],
        };
        return { ...value, strokes };
      });
    }
  }

  function endPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size >= 2) {
      if (lupeRef.current.zoom > 1) beginLupenPinch();
      else beginPinch();
      return;
    }
    if (pointers.current.size === 1 && gesture.current.mode === 'lupenpinch') {
      gesture.current = { ...gesture.current, mode: 'none' };
      return;
    }
    if (pointers.current.size === 1 && gesture.current.mode === 'pinch') {
      const remaining = [...pointers.current.values()][0];
      const current = docRef.current;
      gesture.current = {
        mode: toolRef.current === 'erase' ? 'none' : 'pan',
        startX: remaining.x,
        startY: remaining.y,
        startOffsetX: current.offsetX,
        startOffsetY: current.offsetY,
        startDistance: 0,
        startScale: current.scale,
      };
      return;
    }
    if (pointers.current.size === 0) {
      gesture.current = { ...gesture.current, mode: 'none' };
      pending.current = null;
      busyGesture.current = false;
      lastCommit.current = { label: '', at: 0 };
      schedule();
    }
  }

  // Wheel zoom needs a non-passive listener, otherwise Chrome scrolls the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!sourceRef.current) return;
      event.preventDefault();
      if (lupeRef.current.zoom > 1) {
        const aktuell = lupeRef.current;
        lupeSetzen({
          ...aktuell,
          zoom: aktuell.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
        });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const factor = STICKER_SIZE / (rect.width || 1);
      const anchorX = (event.clientX - rect.left) * factor;
      const anchorY = (event.clientY - rect.top) * factor;
      const current = docRef.current;
      const next = clamp(
        current.scale * (event.deltaY < 0 ? 1.08 : 1 / 1.08),
        MIN_SCALE,
        MAX_SCALE,
      );
      const ratio = next / current.scale;
      const centre = STICKER_SIZE / 2;
      commit('wheel');
      setDoc((value) => ({
        ...value,
        scale: next,
        offsetX: anchorX - centre - (anchorX - centre - value.offsetX) * ratio,
        offsetY: anchorY - centre - (anchorY - centre - value.offsetY) * ratio,
      }));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [commit, lupeSetzen]);

  /** Slider zoom keeps the canvas centre fixed, so the offset scales with it. */
  function setZoom(next: number) {
    commit('zoom');
    setDoc((value) => {
      const ratio = next / value.scale;
      return {
        ...value,
        scale: next,
        offsetX: value.offsetX * ratio,
        offsetY: value.offsetY * ratio,
      };
    });
  }

  function chooseShape(shape: ShapeKind) {
    commit();
    setDoc((value) => ({ ...value, shape }));
    setPinsel('weg');
    setTool(shape === 'free' ? 'erase' : 'move');
  }

  function updateText(patch: Partial<StickerDoc['top']>) {
    commit(`text-${slot}`);
    setDoc((value) => ({ ...value, [slot]: { ...value[slot], ...patch } }));
  }

  /* ---------- export ---------- */

  async function openSave() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (isEmptyDoc(source, doc)) {
      toast('Wähle zuerst ein Foto, ein Emoji oder schreibe einen Text', 'info');
      setTab('source');
      return;
    }
    setBusy(true);
    try {
      // A queued preview frame must not overwrite the export-quality render.
      if (frame.current != null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      renderSticker(canvas, sourceRef.current, docRef.current, { fast: false });
      const exported = await exportSticker(canvas, supportsWebp());
      if (exported.blob.size > LIMITS.maxUploadBytes.sticker) {
        toast(
          `Der Sticker ist zu groß (${formatBytes(exported.blob.size)}, erlaubt sind ${formatBytes(
            LIMITS.maxUploadBytes.sticker,
          )})`,
          'error',
        );
        return;
      }
      setResult(exported);
    } catch (error) {
      toast(errorMessage(error, 'Sticker konnte nicht erstellt werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const layer = doc[slot];
  const hasImage = source?.kind === 'image';
  const teileAnzahl = doc.autoMask?.teile?.anzahl ?? 0;

  return createPortal(
    <div className="stk-studio">
      <div className="stk-studio-bar">
        <button
          type="button"
          className="stk-round-btn"
          onClick={onClose}
          aria-label="Editor schließen"
        >
          ✕
        </button>
        <button
          type="button"
          className="stk-round-btn"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Rückgängig"
        >
          ↶
        </button>
        <button type="button" className="stk-round-btn" onClick={reset} aria-label="Zurücksetzen">
          ⟲
        </button>
        <span className="stk-studio-title truncate">Sticker erstellen</span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void openSave()}
          disabled={busy}
        >
          {busy ? '…' : 'Weiter'}
        </button>
      </div>

      <div className="stk-stage">
        <div className="stk-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="stk-canvas"
            style={lupeStil}
            width={STICKER_SIZE}
            height={STICKER_SIZE}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onContextMenu={(event) => event.preventDefault()}
          />
          {!source && (
            <div className="stk-canvas-empty">
              <span className="stk-canvas-emoji" aria-hidden="true">
                🌟
              </span>
              <strong>Womit fängst du an?</strong>
              <div className="stk-btn-row">
                <label className="btn btn-sm">
                  📷 Kamera
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="stk-file"
                    onChange={(event) => void pickImage(event)}
                  />
                </label>
                <label className="btn btn-sm">
                  🖼️ Galerie
                  <input
                    type="file"
                    accept="image/*"
                    className="stk-file"
                    onChange={(event) => void pickImage(event)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    applySource({ kind: 'text' });
                    setTab('text');
                  }}
                >
                  🅣 Text
                </button>
              </div>
            </div>
          )}
          {source && lupe.zoom > 1 && (
            <span className="stk-mode-badge stk-mode-badge-right">
              🔍 {Math.round(lupe.zoom * 10) / 10}×
            </span>
          )}
          {source && (
            <span className="stk-mode-badge">
              {tool === 'erase'
                ? pinsel === 'weg'
                  ? '🧽 Radieren'
                  : '↩️ Zurückholen'
                : tool === 'keep'
                  ? '👆 Antippen zum Behalten'
                  : tool === 'teile'
                    ? '🎯 Teile antippen'
                    : '✋ Verschieben'}
            </span>
          )}
        </div>
      </div>

      <div className="stk-panel">
        {tab === 'source' && (
          <>
            <div className="stk-btn-row">
              <label className="btn btn-sm">
                📷 Kamera
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="stk-file"
                  onChange={(event) => void pickImage(event)}
                />
              </label>
              <label className="btn btn-sm">
                🖼️ Galerie
                <input
                  type="file"
                  accept="image/*"
                  className="stk-file"
                  onChange={(event) => void pickImage(event)}
                />
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  applySource({ kind: 'text' });
                  setTab('text');
                }}
              >
                🅣 Text
              </button>
            </div>
            <div className="stk-emoji-row">
              {START_EMOJI.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="stk-emoji-btn"
                  onClick={() => chooseEmoji(value)}
                  aria-label={`Emoji-Sticker ${value}`}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="stk-row">
              <input
                className="input"
                value={emojiInput}
                maxLength={8}
                placeholder="Eigenes Emoji einfügen"
                aria-label="Eigenes Emoji"
                onChange={(event) => setEmojiInput(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => chooseEmoji(emojiInput)}
                disabled={firstEmoji(emojiInput).length === 0}
              >
                Nehmen
              </button>
            </div>
          </>
        )}

        {tab === 'move' && (
          <>
            <label className="stk-slider">
              <span>Zoom</span>
              <input
                type="range"
                min={MIN_SCALE * 100}
                max={MAX_SCALE * 100}
                value={Math.round(doc.scale * 100)}
                onChange={(event) => setZoom(Number(event.target.value) / 100)}
              />
              <span className="stk-slider-value">{Math.round(doc.scale * 100)} %</span>
            </label>
            <div className="stk-btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, offsetX: 0, offsetY: 0, scale: 1 }));
                }}
              >
                Zentrieren
              </button>
              <button
                type="button"
                className={`btn btn-sm ${tool === 'move' ? 'stk-chip-active' : ''}`}
                onClick={() => setTool('move')}
              >
                ✋ Verschieben
              </button>
              <button
                type="button"
                className={`btn btn-sm ${tool === 'erase' ? 'stk-chip-active' : ''}`}
                onClick={() => setTool('erase')}
              >
                🧽 Radieren
              </button>
            </div>
            <p className="stk-hint">
              Ein Finger verschiebt, zwei Finger zoomen. Mit der Maus: ziehen und scrollen.
            </p>
          </>
        )}

        {tab === 'shape' && (
          <>
            <div className="stk-btn-row">
              {SHAPES.map((shape) => (
                <button
                  key={shape.key}
                  type="button"
                  className={`btn btn-sm ${doc.shape === shape.key ? 'stk-chip-active' : ''}`}
                  onClick={() => chooseShape(shape.key)}
                >
                  <span aria-hidden="true">{shape.icon}</span> {shape.label}
                </button>
              ))}
            </div>
            <label className="stk-slider">
              <span>Pinsel</span>
              <input
                type="range"
                min={12}
                max={160}
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
              />
              <span className="stk-slider-value">{brush}</span>
            </label>
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${tool === 'erase' && pinsel === 'weg' ? 'stk-chip-active' : ''}`}
                onClick={() => {
                  setPinsel('weg');
                  setTool(tool === 'erase' && pinsel === 'weg' ? 'move' : 'erase');
                }}
              >
                🧽 Radiergummi {tool === 'erase' && pinsel === 'weg' ? 'an' : 'aus'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, strokes: [] }));
                }}
                disabled={doc.strokes.length === 0}
              >
                Radierer zurücknehmen
              </button>
            </div>
          </>
        )}

        {tab === 'cutout' && (
          <>
            {/* Zuerst die Modelle: Ein Klick, und das Motiv steht frei. Das
                Antippen darunter bleibt der Rückfall für alles, was kein
                Modell trifft – und für Geräte ohne die Modelle. */}
            <div className="stk-btn-row">
              {ENGINE_INFO.filter((engine) => engine.key !== 'tap').map((engine) => {
                const verfuegbar = engineAvailable(engine.key);
                return (
                  <button
                    key={engine.key}
                    type="button"
                    className={`btn btn-sm ${doc.autoMask?.engine === engine.key ? 'stk-chip-active' : ''}`}
                    onClick={() => void modellAnwenden(engine.key)}
                    disabled={!hasImage || !verfuegbar || rechnet !== null}
                    title={
                      verfuegbar
                        ? engine.description
                        : 'In den Einstellungen unter „Freistellen für Sticker“ einschaltbar.'
                    }
                  >
                    {rechnet === engine.key ? '⏳ ' : '🪄 '}
                    {engine.label}
                    {rechnet === engine.key ? ' rechnet …' : ''}
                  </button>
                );
              })}
              {doc.autoMask && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    commit();
                    setDoc((value) => ({ ...value, autoMask: null }));
                    setModellFehler(null);
                  }}
                  disabled={rechnet !== null}
                >
                  Freistellen zurücknehmen
                </button>
              )}
            </div>
            {modellFehler && (
              <p className="stk-hint stk-hint-warn" role="status">
                {modellFehler}
              </p>
            )}
            {doc.autoMask && !modellFehler && (
              <p className="stk-hint" role="status">
                Freigestellt mit „{engineInfo(doc.autoMask.engine as EngineKey).label}“. Verschieben
                und Zoomen geht weiterhin – der Ausschnitt bleibt am Motiv.
              </p>
            )}
            {/* Das Modell liefert eine Fläche; erst die Zerlegung macht daraus
                antippbare Teile. Der Knopf erscheint nur, wenn es überhaupt
                mehr als eines gibt – bei einem einzelnen Motiv wäre er eine
                Wahl ohne Alternative. */}
            {teileAnzahl > 1 && (
              <>
                <div className="stk-btn-row">
                  <button
                    type="button"
                    className={`btn btn-sm ${tool === 'teile' ? 'stk-chip-active' : ''}`}
                    onClick={() => setTool(tool === 'teile' ? 'move' : 'teile')}
                  >
                    🎯 Teile antippen {tool === 'teile' ? 'an' : 'aus'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      commit();
                      setDoc((value) => ({ ...value, maskParts: [] }));
                    }}
                    disabled={doc.maskParts.length === 0}
                  >
                    Alle Teile behalten
                  </button>
                </div>
                <p className="stk-hint">
                  {doc.maskParts.length === 0
                    ? `${teileAnzahl} getrennte Flächen erkannt. Tippe im Bild an, was bleiben soll – etwa erst die Flasche, dann die Person. Ohne Antippen bleibt alles.`
                    : `${doc.maskParts.length} von ${teileAnzahl} Flächen ausgewählt. Das Schraffierte fällt weg – tippe es an, um es dazuzunehmen.`}
                </p>
              </>
            )}
            {!doc.autoMask && hasImage && rechnet === null && (
              <p className="stk-hint">
                Beim ersten Mal wird das Modell geladen (einmalig, danach im Gerät). Es rechnet auf
                deinem Gerät – es wird kein Bild irgendwohin geschickt.
              </p>
            )}
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${tool === 'keep' ? 'stk-chip-active' : ''}`}
                onClick={() => setTool(tool === 'keep' ? 'move' : 'keep')}
                disabled={!hasImage}
              >
                👆 Antippen zum Behalten {tool === 'keep' ? 'an' : 'aus'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, keep: [] }));
                }}
                disabled={!hasImage || doc.keep.length === 0}
              >
                Auswahl zurücksetzen
              </button>
            </div>
            {doc.keep.length > 0 && (
              <p className="stk-hint">
                {doc.keep.length === 1
                  ? '1 Stelle ausgewählt.'
                  : `${doc.keep.length} Stellen ausgewählt.`}{' '}
                Tippe weitere Bereiche an, die dazugehören – etwa Haare oder Pullover.
              </p>
            )}
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${doc.removeBg ? 'stk-chip-active' : ''}`}
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, removeBg: !value.removeBg }));
                }}
                disabled={!hasImage || doc.keep.length > 0}
              >
                🪄 Ecken entfernen {doc.removeBg ? 'an' : 'aus'}
              </button>
            </div>
            <label className="stk-slider">
              <span>Toleranz</span>
              <input
                type="range"
                min={5}
                max={120}
                value={doc.tolerance}
                disabled={!hasImage || (!doc.removeBg && doc.keep.length === 0)}
                onChange={(event) => {
                  commit('tolerance');
                  const tolerance = Number(event.target.value);
                  setDoc((value) => ({ ...value, tolerance }));
                }}
              />
              <span className="stk-slider-value">{doc.tolerance}</span>
            </label>
            <p className="stk-hint">
              {!hasImage
                ? 'Freistellen gibt es nur für Fotos.'
                : doc.keep.length > 0
                  ? 'Die Toleranz bestimmt, wie weit ein Antippen ins Bild wächst. Bleibt zu wenig stehen: erhöhen. Greift es auf den Hintergrund über: senken.'
                  : 'Tippe oben auf „Antippen zum Behalten“ und dann im Bild auf das, was im Sticker bleiben soll. „Ecken entfernen“ ist die einfachere Variante für einfarbige Hintergründe.'}
            </p>
          </>
        )}

        {tab === 'detail' && (
          <>
            {/* Detailarbeit heisst: nah heran und mit kleinem Pinsel. Die Lupe
                vergroessert nur die Ansicht – am Sticker aendert sie nichts,
                deshalb landet sie auch nicht im Rueckgaengig-Verlauf. */}
            <label className="stk-slider">
              <span>Lupe</span>
              <input
                type="range"
                min={10}
                max={MAX_LUPE * 10}
                value={Math.round(lupe.zoom * 10)}
                disabled={!source}
                onChange={(event) => lupeSetzen({ ...lupe, zoom: Number(event.target.value) / 10 })}
              />
              <span className="stk-slider-value">{Math.round(lupe.zoom * 10) / 10}×</span>
            </label>
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${tool === 'erase' && pinsel === 'weg' ? 'stk-chip-active' : ''}`}
                onClick={() => {
                  setPinsel('weg');
                  setTool('erase');
                }}
                disabled={!source}
              >
                🧽 Wegradieren
              </button>
              <button
                type="button"
                className={`btn btn-sm ${tool === 'erase' && pinsel === 'zurueck' ? 'stk-chip-active' : ''}`}
                onClick={() => {
                  setPinsel('zurueck');
                  setTool('erase');
                }}
                disabled={!hasImage}
                title="Holt das Original an dieser Stelle zurück – gegen ein Modell, das zu viel weggenommen hat."
              >
                ↩️ Zurückholen
              </button>
              <button
                type="button"
                className={`btn btn-sm ${tool === 'move' ? 'stk-chip-active' : ''}`}
                onClick={() => setTool('move')}
                disabled={!source}
              >
                ✋ Nur schauen
              </button>
            </div>
            <label className="stk-slider">
              <span>Pinsel</span>
              <input
                type="range"
                min={2}
                max={160}
                value={brush}
                disabled={!source}
                onChange={(event) => setBrush(Number(event.target.value))}
              />
              <span className="stk-slider-value">{brush}</span>
            </label>
            <div className="stk-btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, strokes: value.strokes.slice(0, -1) }));
                }}
                disabled={doc.strokes.length === 0}
              >
                Letzten Strich zurück
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, strokes: [] }));
                }}
                disabled={doc.strokes.length === 0}
              >
                Alle Striche zurück
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => lupeSetzen({ zoom: 1, x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 })}
                disabled={lupe.zoom === 1}
              >
                Lupe aus
              </button>
            </div>
            <p className="stk-hint">
              {!source
                ? 'Erst ein Bild wählen.'
                : lupe.zoom === 1
                  ? 'Zieh die Lupe auf, um an eine Kontur heranzukommen. Ein kleiner Pinsel und viel Vergrösserung sind zusammen so genau, wie es mit dem Finger geht.'
                  : 'Solange die Lupe an ist, gehören die Finger ihr: Ziehen verschiebt den Ausschnitt, zwei Finger zoomen. Der Sticker selbst bleibt unberührt – zum Verschieben des Motivs die Lupe wieder aus.'}
            </p>
            {lupe.zoom >= 4 && (
              <p className="stk-hint">
                Ab hier siehst du einzelne Bildpunkte. Feiner als das wird der Sticker nicht – er
                ist {STICKER_SIZE} Punkte breit.
              </p>
            )}
          </>
        )}

        {tab === 'outline' && (
          <>
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${doc.outline ? 'stk-chip-active' : ''}`}
                onClick={() => {
                  commit();
                  setDoc((value) => ({ ...value, outline: !value.outline }));
                }}
              >
                ✨ Weiße Kontur {doc.outline ? 'an' : 'aus'}
              </button>
            </div>
            <label className="stk-slider">
              <span>Stärke</span>
              <input
                type="range"
                min={2}
                max={26}
                value={doc.outlineWidth}
                disabled={!doc.outline}
                onChange={(event) => {
                  commit('outline-width');
                  const outlineWidth = Number(event.target.value);
                  setDoc((value) => ({ ...value, outlineWidth }));
                }}
              />
              <span className="stk-slider-value">{doc.outlineWidth}</span>
            </label>
          </>
        )}

        {tab === 'text' && (
          <>
            <div className="stk-btn-row">
              <button
                type="button"
                className={`btn btn-sm ${slot === 'top' ? 'stk-chip-active' : ''}`}
                onClick={() => setSlot('top')}
              >
                Oben
              </button>
              <button
                type="button"
                className={`btn btn-sm ${slot === 'bottom' ? 'stk-chip-active' : ''}`}
                onClick={() => setSlot('bottom')}
              >
                Unten
              </button>
            </div>
            <input
              className="input"
              value={layer.value}
              maxLength={60}
              placeholder={slot === 'top' ? 'Text oben' : 'Text unten'}
              aria-label={slot === 'top' ? 'Text oben' : 'Text unten'}
              onChange={(event) => updateText({ value: event.target.value })}
            />
            <label className="stk-slider">
              <span>Größe</span>
              <input
                type="range"
                min={24}
                max={140}
                value={layer.size}
                onChange={(event) => updateText({ size: Number(event.target.value) })}
              />
              <span className="stk-slider-value">{layer.size}</span>
            </label>
            <div className="stk-btn-row">
              {TEXT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`stk-swatch ${layer.color === color ? 'is-active' : ''}`}
                  style={{ background: color }}
                  onClick={() => updateText({ color })}
                  aria-label={`Textfarbe ${color}`}
                />
              ))}
              <input
                type="color"
                className="stk-swatch stk-swatch-picker"
                value={layer.color}
                aria-label="Eigene Textfarbe"
                onChange={(event) => updateText({ color: event.target.value })}
              />
              <button
                type="button"
                className={`btn btn-sm ${layer.outline ? 'stk-chip-active' : ''}`}
                onClick={() => updateText({ outline: !layer.outline })}
              >
                Kontur {layer.outline ? 'an' : 'aus'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="stk-tabs" role="tablist" aria-label="Werkzeuge">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`stk-tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            <span className="stk-tab-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {busy && (
        <div className="stk-busy" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
        </div>
      )}

      {result && (
        <SavePackSheet
          blob={result.blob}
          mime={result.mime}
          onClose={() => setResult(null)}
          onSaved={(pack) => {
            setResult(null);
            onSaved?.(pack);
            onClose();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
