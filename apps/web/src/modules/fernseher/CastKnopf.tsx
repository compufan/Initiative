import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { toast } from '../../state/ui.js';
import { reihenfolge } from '../../tv/mischen.js';
import {
  Diashow,
  abspielen,
  castBeobachten,
  EMPFAENGER,
  castErlaubnisBeobachten,
  castErlaubt,
  castErlauben,
  castGrund,
  castLaden,
  stueckFuer,
  type CastZustand,
} from './cast.js';
import { castAnzeige } from './castAnzeige.js';
import { CastDiagnose } from './CastDiagnose.js';
import { FernsehSheet } from './FernsehSheet.js';

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
 * # Der Fehler, an dem diese Datei einmal gescheitert ist
 *
 * Hier stand: „Kein Gerät in Reichweite: nichts zeigen." Und darüber, als
 * Bedingung: `if (zustand === 'aus' || zustand === 'keine-geraete') return
 * null;`. Was dabei herauskam, hat ein Anwender so beschrieben:
 *
 *   „Ich klicke auf den Fernseherbutton, muss einer Datenschutzvereinbarung
 *    zustimmen. Danach passiert gar nichts. Der Fernseher-Button ist danach
 *    auch weg."
 *
 * Genau so war es auch gebaut. `castErlaubt()` wird synchron aus dem lokalen
 * Speicher gelesen, also fiel im selben Bild der Schwellenknopf weg – und der
 * Zustand stand noch auf `aus`, weil das SDK erst geladen wurde. Zwischen
 * beidem lag nichts. Und wer keinen Chromecast im WLAN hat, blieb für immer
 * bei `keine-geraete`, also bei einer leeren Stelle ohne ein Wort Erklärung.
 *
 * Die Lehre steht jetzt als Regel in dieser Datei: **Sobald jemand zugestimmt
 * hat, verschwindet hier nichts mehr stillschweigend.** Es gibt für jeden
 * Zustand etwas zu sehen – und sei es der Satz, dass nichts gefunden wurde
 * und wo der andere Weg steht. Ein Knopf, der nach einer Zustimmung spurlos
 * verschwindet, ist nicht zurückhaltend, sondern kaputt.
 *
 * # Und der zweite Tipp
 *
 * Der Knopf im Blatt hiess „Erlauben und verbinden" und verband nicht. Er
 * konnte es auch nicht: Der Gerätewähler von Chrome geht nur aus einer
 * echten, frischen Fingerbewegung auf – die ist nach dem Laden des SDK längst
 * vorbei, und `requestSession()` aus einem `.then()` heraus tut nichts. Der
 * richtige Weg ist der, den §5.1 ohnehin verlangt: Nach der Zustimmung
 * erscheint das echte Cast-Symbol, und darauf tippt man. Das Blatt sagt das
 * jetzt, statt etwas zu versprechen.
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
  /**
   * Wo der Knopf steht – und wie viel er sagen darf.
   *
   * `rund` ist die dunkle Leiste über einem Foto: Dort ist Platz für ein
   * Symbol und für nichts sonst, und ein Satz Text stünde quer im Bild.
   *
   * `leiste` ist eine gewöhnliche Werkzeugleiste (Sammlung, Dateiansicht).
   * Dort steht daneben ein beschrifteter Knopf, und ein nacktes Emoji verliert
   * jeden Vergleich. Hier darf der Knopf Text tragen und darf sagen, wenn
   * etwas nicht geht.
   */
  stil?: 'rund' | 'leiste';
}

/**
 * Wie viele Sekunden ein Bild in der Diashow steht, wenn niemand etwas sagt.
 */
const STANDZEIT = 8;

/**
 * Wie lange „kein Gerät gefunden" noch als „wird gesucht" gilt.
 *
 * Chrome sucht die Geräte per mDNS im WLAN, und das dauert. Unmittelbar nach
 * dem Laden meldet das SDK deshalb fast immer `NO_DEVICES_AVAILABLE`, auch
 * wenn zwei Zimmer weiter ein Chromecast steht. Wer das sofort als „nichts
 * gefunden" hinschreibt, sagt in der Mehrzahl der Fälle die Unwahrheit und
 * nimmt dem Anwender die Lust, es noch einmal zu versuchen.
 */
const SUCHFRIST_MS = 6000;

/**
 * Wie lange ein Tipp auf den Cast-Knopf noch als „ja, dieses hier" gilt.
 *
 * Zwischen dem Tipp und dem Zustandekommen der Verbindung liegt der
 * Gerätewähler von Chrome: die Liste aufgehen lassen, ein Gerät wählen,
 * verbinden. Eine Minute ist dafür reichlich – und kurz genug, dass eine
 * Sitzung, die Stunden später aus einer anderen Lasche wieder auftaucht,
 * nicht mehr als Antwort auf diesen Tipp durchgeht.
 */
const WUNSCH_GILT_MS = 60_000;

const KEIN_GERAET_SUCHT = 'Suche Fernseher im WLAN …';
const NICHT_GELADEN =
  'Chromecast liess sich nicht laden – meist hält ein Inhaltsblocker im Browser gstatic.com auf. Dann hilft der Weg mit dem Code.';
const KEIN_GERAET_TEXT =
  'Kein Chromecast im WLAN gefunden. Er muss eingeschaltet und im selben Netz sein – sonst hilft der Weg mit dem Code.';

export function CastKnopf({ stuecke, sekunden, was, modusWahl, stil = 'rund' }: CastKnopfProps) {
  const [zustand, setZustand] = useState<CastZustand>('aus');
  /*
   * Die Erlaubnis kommt aus einer GEMEINSAMEN Quelle, nicht aus einem
   * `useState`-Anfangswert.
   *
   * Es gibt diesen Knopf mehr als einmal zugleich: In einer Sammlung sitzt
   * einer in der Werkzeugleiste, und öffnet man ein Foto, kommt der Betrachter
   * mit einem zweiten darüber – die Leiste dahinter bleibt montiert. Mit einem
   * Anfangswert hätte jede Instanz ihre eigene Wahrheit: Wer im Betrachter
   * zustimmt, träfe beim Schliessen auf eine Leiste, die noch einmal fragt.
   */
  const erlaubt = useSyncExternalStore(castErlaubnisBeobachten, castErlaubt, () => false);
  const [frage, setFrage] = useState(false);
  /**
   * Das Blatt mit dem Code – der Weg, der ohne Chromecast funktioniert.
   *
   * Es hängt hier und nicht in einem eigenen Knopf daneben, und das ist der
   * Punkt: Der Moment, in dem jemand erfährt „kein Chromecast gefunden", ist
   * genau der Moment, in dem er den anderen Weg braucht. Vorher stand dort ein
   * Satz, der ihn erwähnte – als Meldung, die man nicht antippen kann. Eine
   * Sackgasse mit Wegbeschreibung ist immer noch eine Sackgasse.
   *
   * Ein zweiter Knopf in der Leiste wäre die Alternative gewesen und die
   * schlechtere: §5.1 der Cast-Bedingungen verlangt den echten Launcher auf
   * oberster Ebene, und ein zweiter Fernsehknopf unmittelbar daneben ist die
   * Konkurrenz, die in der Sammlung schon einmal aufgelöst werden musste.
   */
  const [codeWeg, setCodeWeg] = useState(false);
  /** „Warum wird nichts gefunden?" – die Auskunft, die den Fall entscheidet. */
  const [diagnose, setDiagnose] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  /** Läuft die Schonfrist, in der „nichts gefunden" noch „wird gesucht" heisst? */
  const [sucht, setSucht] = useState(false);
  /** Wann zuletzt auf den echten Cast-Knopf getippt wurde – 0 heisst: nie. */
  const wollte = useRef(0);
  const schau = useRef<Diashow | null>(null);
  const stueckeRef = useRef(stuecke);
  stueckeRef.current = stuecke;

  const grund = castGrund();

  /*
   * Laden und beobachten – an `erlaubt` gehängt, nicht an nichts.
   *
   * Vorher stand hier ein leeres Abhängigkeitsfeld. Beim allerersten Besuch
   * lief der Effekt also genau einmal, bekam von `castLaden()` ein `null`
   * (es war ja noch nichts erlaubt) und trat nie wieder an. Das einzige
   * wirksame Abo hing danach im Klickhandler des Blattes – ohne Abmeldung,
   * und bei jedem weiteren Zustimmen ein weiteres Mal.
   */
  useEffect(() => {
    if (!erlaubt) {
      setZustand('aus');
      return undefined;
    }
    let weg = false;
    let ab: (() => void) | null = null;
    /*
     * Die Schonfrist beginnt, wenn die SUCHE beginnt – nicht, wenn jemand
     * zustimmt.
     *
     * Vorher stand sie ganz oben im Effekt. Das Laden des Skripts darf sich
     * aber bis zu acht Sekunden Zeit lassen (`castLaden`), und es ging von
     * derselben Uhr ab: Auf einer langsamen Verbindung war die Frist schon
     * abgelaufen, wenn Chrome noch keine einzige Sekunde per mDNS gesucht
     * hatte. Dann stand „kein Chromecast gefunden" da – die Unwahrheit, die
     * die Frist gerade verhindern soll.
     */
    let frist = 0;
    void castLaden().then((ctx) => {
      if (weg) return;
      if (!ctx) {
        /*
         * Das Skript kam nicht – kein Netz, ein Blocker, oder die Frist von
         * acht Sekunden in `castLaden` ist abgelaufen. Ohne diesen Zweig
         * bliebe der Zustand für immer auf `aus`, und darüber stünde bis in
         * alle Ewigkeit „wird geladen …". Ein Ladehinweis ohne Ende ist eine
         * Unwahrheit mit Verfallsdatum.
         */
        setSucht(false);
        setZustand('fehlgeschlagen');
        return;
      }
      setSucht(true);
      frist = window.setTimeout(() => setSucht(false), SUCHFRIST_MS);
      ab = castBeobachten(ctx, setZustand);
    });
    return () => {
      weg = true;
      window.clearTimeout(frist);
      ab?.();
      schau.current?.anhalten();
    };
  }, [erlaubt]);

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
    if (zustand === 'verbunden' && Date.now() - wollte.current < WUNSCH_GILT_MS) {
      wollte.current = 0;
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

  /*
   * Was gezeigt wird, entscheidet `castAnzeige` – und zwar ausserhalb dieser
   * Komponente.
   *
   * Der Grund ist der Fehler oben im Kopf dieser Datei: Die Entscheidung stand
   * einmal als Bedingungskette mittendrin, und dass zwei ihrer Zweige `null`
   * ergaben, hat kein Test gesehen. Die Tests dieses Projektes kommen ohne
   * Renderer aus, und ein Browsertest sieht immer nur den Zustand, den der
   * Läufer gerade herstellt.
   *
   * Als eigene Funktion lässt sich die Regel erschöpfend prüfen – über alle
   * sechs Zustände, nicht über die zwei, die zufällig eintreten. Siehe
   * `castAnzeige.test.ts`.
   */
  const anzeige = castAnzeige({ grund, erlaubt, zustand, stil });

  if (anzeige === 'nichts') return null;

  if (anzeige === 'geht-hier-nicht') {
    return (
      <>
        <Auskunft
          stil={stil}
          zeichen="ⓘ"
          text={
            grund === 'kein-sicherer-kontext'
              ? 'Chromecast braucht https – über diese Adresse geht nur der Weg mit dem Code.'
              : 'Dieser Browser kann kein Chromecast – auf dem iPhone und in Safari geht nur der Weg mit dem Code.'
          }
          weiter={() => setCodeWeg(true)}
        />
        <CodeWeg
          offen={codeWeg}
          zu={() => setCodeWeg(false)}
          stuecke={stuecke}
          sekunden={sekunden}
        />
      </>
    );
  }

  /* ---------- Vor der Zustimmung ---------- */

  if (anzeige === 'schalter') {
    return (
      <>
        <button
          type="button"
          className={stil === 'rund' ? 'media-round-btn' : 'btn btn-sm btn-primary'}
          onClick={() => setFrage(true)}
          aria-label="Auf den Fernseher – mit Chromecast"
          title="Auf den Fernseher – mit Chromecast"
        >
          {stil === 'rund' ? '📺' : '📺 Chromecast'}
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
              von diesem Server.
            </p>
            {/*
              Der Satz, der hier gefehlt hat.

              Der Knopf hiess „Erlauben und verbinden" und verband nicht: Der
              Gerätewähler von Chrome geht nur aus einer frischen
              Fingerbewegung auf, und die ist nach dem Laden des SDK vorbei.
              Ein zweiter Tipp ist also nicht eine Unbequemlichkeit, die man
              wegerklären müsste – er ist der Weg. Nur wissen muss man es.
            */}
            <p className="cast-frage-klein">
              Danach erscheint hier das Cast-Symbol von Google – ein Bildschirm mit einem
              Funkzeichen in der Ecke. <strong>Einmal darauf tippen</strong>, und der Browser zeigt
              die Fernseher im WLAN.
            </p>
            <p className="cast-frage-klein">
              Ohne Google geht es auch: Am Fernseher <strong>{tvAdresse()}</strong> öffnen und den
              Code eintippen. Das braucht kein Chromecast und kein fremdes Skript.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => {
                // `castErlauben` meldet es allen Instanzen – siehe
                // `castErlaubnisBeobachten` in cast.ts. Ein eigenes
                // `setErlaubt` gäbe es hier nur für diese eine.
                castErlauben(true);
                setFrage(false);
              }}
            >
              Erlauben
            </button>
            <button type="button" className="btn btn-block" onClick={() => setFrage(false)}>
              Nicht jetzt
            </button>
          </div>
        </Sheet>
      </>
    );
  }

  /* ---------- Nach der Zustimmung: hier verschwindet nichts mehr ---------- */

  if (anzeige === 'laedt') {
    /*
     * Das SDK ist unterwegs. Ein gesperrter Hinweis ist die ehrliche Auskunft;
     * eine Leerstelle wäre die Fassung, die als „kaputt" gelesen wird.
     *
     * Bewusst OHNE 📺: Der Schalter davor trug dieses Zeichen, aber ab hier
     * ist das Streamen eingeschaltet, und die Rolle des Cast-Knopfes gehört
     * dem echten `<google-cast-launcher>` (§5.1). Ein eigenes Symbol an seiner
     * Stelle wäre genau das, was die Bedingungen ausschliessen – auch ein
     * gesperrtes.
     */
    return (
      <span
        className="cast-laedt"
        role="status"
        aria-busy="true"
        aria-label="Chromecast wird geladen"
        title="Chromecast wird geladen …"
      >
        <span className="spinner" aria-hidden="true" />
        {stil === 'leiste' && <span className="cast-hinweis">Chromecast wird geladen …</span>}
      </span>
    );
  }

  if (anzeige === 'fehlgeschlagen') {
    /*
     * Das Skript ist nicht gekommen. Der häufigste Grund ist ein Blocker im
     * Browser, der zweite ist fehlendes Netz – beides erklärt sich nicht von
     * selbst, und beides ist kein Grund, still zu verschwinden.
     */
    return (
      <>
        <Auskunft stil={stil} zeichen="⚠" text={NICHT_GELADEN} weiter={() => setDiagnose(true)} />
        <CodeWeg
          offen={codeWeg}
          zu={() => setCodeWeg(false)}
          stuecke={stuecke}
          sekunden={sekunden}
        />
        <CastDiagnose
          offen={diagnose}
          zu={() => setDiagnose(false)}
          zustand={zustand}
          empfaenger={EMPFAENGER}
          zumCodeWeg={() => setCodeWeg(true)}
        />
      </>
    );
  }

  const keineGeraete = anzeige === 'kein-geraet';

  return (
    <span
      className={[
        'cast-knopf',
        stil === 'leiste' ? 'cast-knopf-leiste' : '',
        laeuft ? 'ist-beschaeftigt' : '',
        keineGeraete ? 'ist-leer' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClickCapture={(ereignis) => {
        /*
         * Der Wunsch wird HIER vermerkt und nicht erst, wenn die Verbindung
         * steht: Bis dahin ist die Fingerbewegung vorbei, und ohne diesen
         * Merker wüsste `schicken` nicht, ob der Mensch etwas wollte oder ob
         * nur eine alte Sitzung wieder aufgetaucht ist.
         *
         * Zwei Einschränkungen, und beide haben einen Ablauf hinter sich:
         *
         * **Nur der echte Knopf zählt.** In diesem Bereich liegt auch die
         * Auskunft „kein Chromecast gefunden" – ein Knopf, der nichts tut als
         * einen Satz zu zeigen. Wer den antippt, will nichts streamen.
         *
         * **Der Wunsch altert.** Er wird sonst nie zurückgenommen: Bricht
         * jemand die Geräteliste ab, bleibt er scharf. Taucht Stunden später
         * eine Sitzung aus einer anderen Lasche auf (`ORIGIN_SCOPED`,
         * `resumeSavedSession`), schöbe sich das hier offene Foto ungefragt
         * über das, was dort gerade läuft. §3.4.8 verlangt das Gegenteil:
         * gecastet wird auf Verlangen für DIESEN Inhalt.
         */
        const ziel = ereignis.target as Element | null;
        if (!ziel?.closest?.('google-cast-launcher')) return;
        if (zustand !== 'verbunden') wollte.current = Date.now();
      }}
    >
      {/*
        Das Element bleibt montiert, auch wenn gerade kein Gerät gefunden ist.

        Es blendet sich in diesem Fall selbst aus – das ist das Verhalten des
        SDK und zugleich das, was Google empfiehlt. Es hier auszuhängen wäre
        riskant: Das Element bindet sich beim Verbinden an den CastContext,
        und ein Aus- und Wiedereinhängen bei jedem Zustandswechsel ist eine
        Wette auf ein Verhalten, das nirgends zugesichert ist.
      */}
      <google-cast-launcher aria-label="Auf den Fernseher (Chromecast)" />
      {/*
        Kein Gerät gefunden – und was dann dasteht, hängt vom Platz ab.

        In einer Werkzeugleiste ist Raum für den Satz, und dort gehört er auch
        hin: Es ist die Stelle, an der jemand gerade zugestimmt hat und wissen
        will, warum trotzdem nichts geschieht.

        In der dunklen Leiste über einem Foto wäre derselbe Satz an jedem Bild
        ein Textblock quer im Weg – an jedem Schreibtisch ohne Chromecast, für
        immer. Dort bleibt ein Symbol stehen, und den Satz bekommt, wer darauf
        tippt. Sichtbar ist beides; laut ist nur das eine.
      */}
      {keineGeraete && (
        /*
         * Das Zeichen ist bewusst KEIN Fernseher.
         *
         * Der echte `<google-cast-launcher>` ist in diesem Zustand
         * ausgeblendet (er tut das selbst, und `.ist-leer` hilft nach). Ein
         * 📺 unmittelbar daneben sässe damit genau auf seinem Platz – und
         * ein eigenes Zeichen an der Stelle des Cast-Knopfes ist das, was
         * §5.1 ausschliesst. Ein Auskunftszeichen behauptet nichts und
         * verspricht nichts.
         *
         * Solange noch gesucht wird, führt es auch nirgendwohin: Wer nach drei
         * Sekunden auf „Suche Fernseher …" tippt, will nicht in ein Blatt
         * geschickt werden, das ihm den Umweg erklärt.
         */
        <Auskunft
          stil={stil}
          zeichen={sucht ? '⋯' : 'ⓘ'}
          text={sucht ? KEIN_GERAET_SUCHT : KEIN_GERAET_TEXT}
          weiter={sucht ? undefined : () => setCodeWeg(true)}
        />
      )}
      <CodeWeg offen={codeWeg} zu={() => setCodeWeg(false)} stuecke={stuecke} sekunden={sekunden} />
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
 * Der Weg mit dem Code, aufgehängt am Cast-Knopf.
 *
 * Eine eigene kleine Komponente, weil dasselbe Blatt an drei Stellen
 * gebraucht wird – kein Gerät gefunden, Skript nicht geladen, Browser kann
 * nicht – und es an allen dreien dasselbe tut.
 */
function CodeWeg({
  offen,
  zu,
  stuecke,
  sekunden,
}: {
  offen: boolean;
  zu: () => void;
  stuecke: string[];
  sekunden?: number;
}) {
  if (!offen) return null;
  return (
    <FernsehSheet
      open
      onClose={zu}
      attachmentIds={stuecke}
      sekundenVorgabe={sekunden}
      titel={
        stuecke.length === 1 ? 'Auf den Fernseher' : `${stuecke.length} Stück auf den Fernseher`
      }
    />
  );
}

/**
 * Eine Auskunft, die sich nach dem Platz richtet.
 *
 * Es gibt zwei Stellen mit sehr verschiedenem Platzangebot, und dieselbe
 * Mitteilung muss an beiden ankommen:
 *
 * In einer Werkzeugleiste steht der Satz. Das ist die Stelle, an der jemand
 * gerade zugestimmt hat und wissen will, warum trotzdem nichts geschieht.
 *
 * In der dunklen Leiste über einem Foto wäre derselbe Satz an jedem Bild ein
 * Textblock quer im Weg – an jedem Schreibtisch ohne Chromecast, für immer.
 * Dort bleibt ein gedämpftes Zeichen stehen, und den Satz bekommt, wer darauf
 * tippt. Sichtbar ist beides; laut ist nur das eine.
 *
 * Was es NICHT gibt, ist die dritte Möglichkeit: nichts. Die stand hier
 * einmal, und ein Anwender hat sie als „der Knopf ist weg" gemeldet.
 */
function Auskunft({
  stil,
  zeichen,
  text,
  weiter,
}: {
  stil: 'rund' | 'leiste';
  zeichen: string;
  text: string;
  /** Der Weg, der trotzdem geht. Ohne ihn bliebe es bei der Mitteilung. */
  weiter?: () => void;
}) {
  const oeffnen = (ereignis: { stopPropagation: () => void }) => {
    // Bleibt hier: Der Wunschmerker am Wrapper darf diesen Tipp nicht als
    // „auf den Fernseher" zählen – siehe `onClickCapture` oben.
    ereignis.stopPropagation();
    if (weiter) weiter();
    else toast(text);
  };

  if (stil === 'leiste') {
    /*
     * In der Leiste ist Platz für den Satz – und der Satz ist anklickbar.
     *
     * Ein `<button>` mit Fliesstext darin, nicht ein Satz mit einem Link
     * daneben: Wer liest, dass kein Chromecast gefunden wurde, tippt als
     * Nächstes genau darauf.
     */
    return (
      <button type="button" className="cast-hinweis cast-hinweis-knopf" onClick={oeffnen}>
        {text}
        {weiter && <span className="cast-hinweis-mehr"> Hier tippen.</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="media-round-btn cast-leer-knopf"
      aria-label={weiter ? `${text} Zum Weg mit dem Code.` : text}
      title={text}
      onClick={oeffnen}
    >
      {zeichen}
    </button>
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
