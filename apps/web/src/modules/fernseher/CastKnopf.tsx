import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { toast } from '../../state/ui.js';
import { reihenfolge } from '../../tv/mischen.js';
import {
  Diashow,
  abspielen,
  castBeobachten,
  castErlaubt,
  castErlauben,
  castLaden,
  castMoeglich,
  sitzungHolen,
  stueckFuer,
  type CastZustand,
} from './cast.js';

/**
 * Der Cast-Knopf – und zwar der ECHTE.
 *
 * # Warum hier kein eigenes Symbol steht
 *
 * Weil die Nutzungsbedingungen es verbieten. §5.1 der Google Cast SDK
 * Additional Developer Terms: Die App „must use the cast button available in
 * the Get Started guide", er „must be at the top level, meaning that it cannot
 * appear in a drop-down menu", und er „must appear on all pages that show
 * content that can be sent to a Google Cast Receiver".
 *
 * `<google-cast-launcher>` ist genau dieser Knopf. Das Element kommt mit dem
 * SDK, bringt seinen eigenen Schattenbaum samt Symbol mit, spiegelt den
 * Verbindungszustand von selbst und öffnet beim Antippen den Gerätewähler von
 * Chrome. Ein nachgebautes Symbol wäre bequemer zu gestalten und formal ein
 * Verstoss.
 *
 * Was es NICHT tut: sich ausblenden, wenn kein Gerät in der Nähe ist. Das
 * müssen wir – sonst steht auf jedem Schreibtisch ohne Chromecast ein Knopf,
 * der nichts tut.
 *
 * # Die Schwelle davor
 *
 * In der Datenschutzerklärung steht „Die Seite lädt nichts von fremden
 * Servern". Damit dieser Satz wahr bleibt, wird `cast_sender.js` erst geholt,
 * wenn jemand das Streamen einmal ausdrücklich einschaltet. Vorher steht hier
 * ein Knopf mit Text und ohne Cast-Symbol – er ist nicht der Cast-Knopf,
 * sondern der Schalter, der ihn erscheinen lässt.
 */

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'google-cast-launcher': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

interface CastKnopfProps {
  /**
   * Was gecastet wird, sobald eine Verbindung steht.
   *
   * Eine Liste, weil derselbe Knopf beides bedient: ein einzelnes Foto (ein
   * Eintrag) und eine ganze Sammlung als Diashow (viele).
   */
  stuecke: string[];
  /** Wie lange ein Foto steht. Ohne Angabe: kein Takt, nur das erste Stück. */
  sekunden?: number;
  /** Was in der Schwellenabfrage steht. */
  was?: string;
  /**
   * Zwei Knöpfe statt einem, sobald die Verbindung steht: der Reihe nach oder
   * gemischt.
   *
   * Nur für eine Sammlung sinnvoll. Bei einem einzelnen Foto gäbe es nichts
   * zu mischen, und zwei Knöpfe, von denen einer immer dasselbe tut, sind
   * schlechter als einer.
   */
  modusWahl?: boolean;
}

/**
 * Wie viele Sekunden ein Bild in der Diashow steht, wenn niemand etwas sagt.
 */
const STANDZEIT = 8;

export function CastKnopf({ stuecke, sekunden, was, modusWahl }: CastKnopfProps) {
  const [zustand, setZustand] = useState<CastZustand>('aus');
  const [frage, setFrage] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const wollte = useRef(false);
  const schau = useRef<Diashow | null>(null);
  const stueckeRef = useRef(stuecke);
  stueckeRef.current = stuecke;

  /* Den Zustand beobachten – aber nur, wenn überhaupt geladen werden darf. */
  useEffect(() => {
    let weg = false;
    let ab: (() => void) | null = null;
    void castLaden().then((ctx) => {
      if (weg || !ctx) return;
      ab = castBeobachten(ctx, setZustand);
    });
    return () => {
      weg = true;
      ab?.();
      schau.current?.anhalten();
    };
  }, []);

  /**
   * Was auf den Fernseher geht, sobald die Verbindung steht.
   *
   * Nur wenn der Mensch in DIESEM Betrachter auf den Knopf gedrückt hat
   * (`wollte`). §3.4.8 der Bedingungen: „Content should only be cast in
   * response to a user request to cast that content." Eine Sitzung, die aus
   * einer anderen Lasche weiterläuft, darf hier also nichts anfangen.
   */
  const schicken = useCallback(
    async (modus: 'linear' | 'zufall' = 'linear') => {
      const ctx = await castLaden();
      if (!ctx) return;
      const sitzung = ctx.getCurrentSession();
      if (!sitzung) return;
      const liste = stueckeRef.current;
      if (liste.length === 0) return;
      setLaeuft(true);
      try {
        schau.current?.anhalten();
        if (liste.length === 1 || !sekunden) {
          await abspielen(sitzung, await stueckFuer(liste[0]));
        } else {
          /*
           * Gemischt wird mit derselben Rechnung wie auf dem TV-Blatt
           * (`tv/mischen.ts`) – gesät, nicht gewürfelt. Zwei Wege, die
           * „gemischt" verschieden verstehen, wären zwei Fehlerquellen statt
           * einer Einstellung.
           *
           * Die Saat kommt aus der Länge der Liste und der Uhr: Sie muss hier
           * nicht mit einem zweiten Gerät übereinstimmen – anders als beim
           * TV-Blatt gibt es keine Fernbedienung, die auf dieselbe Nummer
           * zeigen müsste.
           */
          const saat = (liste.length * 2654435761) >>> 0;
          const folge = reihenfolge(liste.length, modus, saat).map((i) => liste[i]);
          const schauNeu = new Diashow(sitzung, folge, sekunden ?? STANDZEIT, (_s, _g, fehler) => {
            if (fehler) toast(fehler, 'error');
          });
          schau.current = schauNeu;
          await schauNeu.starten();
        }
      } catch (fehler) {
        const text = (fehler as Error)?.message;
        if (text) toast(text, 'error');
      } finally {
        setLaeuft(false);
      }
    },
    [sekunden],
  );

  useEffect(() => {
    if (zustand === 'verbunden' && wollte.current) {
      wollte.current = false;
      /*
       * Beim Verbinden läuft es der Reihe nach los. Wer mischen will, tippt
       * danach auf „Gemischt" – ein Knopfdruck, der eine Wahl bedeutet, darf
       * nicht stillschweigend eine andere treffen.
       */
      if (!modusWahl) void schicken('linear');
    }
    if (zustand !== 'verbunden') {
      schau.current?.anhalten();
      schau.current = null;
    }
  }, [zustand, schicken, modusWahl]);

  // Auf Safari, Firefox und ohne https gibt es gar nichts zu zeigen – dort
  // greift der andere Weg (Remote Playback, AirPlay, das TV-Blatt).
  if (!castMoeglich()) return null;

  if (!castErlaubt()) {
    return (
      <>
        <button
          type="button"
          className="media-round-btn"
          onClick={() => setFrage(true)}
          aria-label="Fernseher verbinden"
          title="Fernseher verbinden"
        >
          📺
        </button>
        <Sheet
          open={frage}
          onClose={() => setFrage(false)}
          title="Auf den Fernseher – mit Google"
          variant="modal"
        >
          <div className="cast-frage">
            <p>
              Zum Streamen auf einen Chromecast braucht der Browser ein kleines Skript von Google (
              <code>gstatic.com</code>). Es wird erst geladen, wenn du hier zustimmst – bis dahin
              lädt diese App nichts von fremden Servern.
            </p>
            <p className="cast-frage-klein">
              Dabei erfährt Google deine IP-Adresse und welchen Browser du benutzt. Die Fotos und
              Videos selbst gehen <strong>nicht</strong> über Google – die holt der Fernseher direkt
              von diesem Server. Du kannst das in den Einstellungen jederzeit wieder abschalten.
            </p>
            <p className="cast-frage-klein">
              Ohne Google geht es auch: Am Fernseher <strong>{tvAdresse()}</strong> öffnen und den
              Code eintippen. Das braucht kein Chromecast und kein fremdes Skript.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => {
                castErlauben(true);
                setFrage(false);
                void castLaden().then((ctx) => {
                  if (ctx) castBeobachten(ctx, setZustand);
                });
              }}
            >
              Erlauben und verbinden
            </button>
            <button type="button" className="btn btn-block" onClick={() => setFrage(false)}>
              Nicht jetzt
            </button>
          </div>
        </Sheet>
      </>
    );
  }

  /*
   * Kein Gerät in Reichweite: nichts zeigen. Ein Knopf, der zuverlässig
   * „nichts gefunden" sagt, wird nach zweimal nicht mehr gedrückt.
   *
   * `aus` heisst: Das SDK ist noch nicht da (oder gar nicht gekommen). Auch
   * dann gibt es nichts zu zeigen – das Element existiert ja noch nicht.
   */
  if (zustand === 'aus' || zustand === 'keine-geraete') return null;

  return (
    <span
      className={`cast-knopf ${laeuft ? 'ist-beschaeftigt' : ''}`}
      onClickCapture={() => {
        /*
         * Der Wunsch wird HIER vermerkt und nicht erst, wenn die Verbindung
         * steht: Bis dahin ist die Fingerbewegung vorbei, und ohne diesen
         * Merker wüsste `schicken` nicht, ob der Mensch etwas wollte oder ob
         * nur eine alte Sitzung wieder aufgetaucht ist.
         */
        if (zustand !== 'verbunden') wollte.current = true;
      }}
    >
      <google-cast-launcher aria-label="Auf den Fernseher" />
      {zustand === 'verbunden' && !modusWahl && (
        <button
          type="button"
          className="media-round-btn"
          onClick={() => void schicken('linear')}
          aria-label={was ? `${was} auf den Fernseher` : 'Hier auf den Fernseher'}
          title={was ? `${was} auf den Fernseher` : 'Hier auf den Fernseher'}
        >
          ▶
        </button>
      )}
      {zustand === 'verbunden' && modusWahl && (
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void schicken('linear')}
            title="Die Fotos der Reihe nach zeigen"
          >
            ▶ Der Reihe nach
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void schicken('zufall')}
            title="Die Fotos in zufälliger Reihenfolge zeigen"
          >
            🔀 Gemischt
          </button>
        </>
      )}
    </span>
  );
}

/**
 * Die Adresse, die am Fernseher einzugeben ist – für den Weg ohne Google.
 *
 * Doppelt zu `FernsehSheet` und trotzdem hier: Wer die Abfrage oben liest,
 * soll den anderen Weg erfahren, ohne ihn suchen zu müssen.
 */
function tvAdresse(): string {
  if (typeof window === 'undefined') return '/tv';
  const ort = window.location;
  const hafen = ort.port && ort.port !== '80' && ort.port !== '443' ? `:${ort.port}` : '';
  return `${ort.hostname}${hafen}/tv`;
}
