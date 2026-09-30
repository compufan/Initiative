import { useEffect, useState } from 'react';
import type { AttachmentDto, CollectionDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../media/helpers.js';
import { toast } from '../../state/ui.js';
import { SpiegelSheet } from './SpiegelSheet.js';
import { useFernseher } from './state.js';

/**
 * „Auf den Fernseher“ – der Weg für Fotos, Videos und die ganze Diashow.
 *
 * # Warum hier ein Code eingetippt wird
 *
 * Weil es andersherum schlimmer wäre. Der naheliegende Weg – das Telefon
 * vergibt den Code, der Fernseher fragt danach – bedeutete, ihn mit einer
 * FERNBEDIENUNG einzugeben: acht Zeichen auf einer Bildschirmtastatur, bei der
 * man mit Pfeiltasten von Buchstabe zu Buchstabe fährt. So herum zeigt der
 * Fernseher nur an, und getippt wird auf dem Gerät, das eine Tastatur hat.
 *
 * # Warum nicht einfach „streamen“ wie beim Video
 *
 * Weil die eingebauten Wege des Browsers (Remote Playback, AirPlay)
 * ausschliesslich Medienelemente kennen. Ein Foto lässt sich damit nicht
 * schicken und eine Warteschlange schon gar nicht – dafür braucht es das
 * Google-Cast-SDK, und das gibt es nur nach Zustimmung und nur in Chrome
 * (`cast.ts`). Dieser Weg hier braucht nichts davon.
 *
 * # Was dieses Blatt sonst noch ist
 *
 *   * **Die Fernbedienung**, solange etwas läuft – und dann auch der Knopf
 *     „Stattdessen dies zeigen", wenn es mit etwas Neuem geöffnet wurde.
 *   * **Der Einstieg in den dritten Weg**, die Spiegelung des Telefons
 *     (`SpiegelSheet`), für Fernseher ohne Browser.
 */
export function FernsehSheet({
  open,
  onClose,
  collection,
  attachmentIds,
  gespraech,
  titel,
  sekundenVorgabe,
  ansicht,
}: {
  open: boolean;
  onClose: () => void;
  /** Eine ganze Sammlung – dafür prüft der Server EINMAL statt je Datei. */
  collection?: CollectionDto;
  /** Oder eine Handvoll einzelner Dateien. */
  attachmentIds?: string[];
  /**
   * Oder ein Gespräch – dann zeigt der Fernseher den Verlauf statt Bilder.
   *
   * Das ist die ehrliche Fassung von „die App auf dem Fernseher spiegeln":
   * Pixel zu spiegeln kann eine Web-App nicht (die Belege stehen in
   * `docs/FEATURES.md`), eine zweite ANSICHT zu zeigen schon – und die ist in
   * Wahrheit besser: aus vier Metern lesbar statt eine geschrumpfte
   * Telefonoberfläche.
   */
  gespraech?: { id: string; name: string };
  titel?: string;
  /** Wie lange ein Foto stehen soll, wenn der Aufrufer eine Meinung hat. */
  sekundenVorgabe?: number;
  /**
   * Die Stücke selbst – für den dritten Weg, die Spiegelung.
   *
   * Der Code-Weg braucht nur Kennungen (der Server holt den Rest). Die
   * Fernsehansicht zeigt aber im TELEFON, und dafür braucht es Art und
   * Adresse jedes Stücks. Ohne diese Angabe gibt es den Knopf zum Spiegeln
   * hier nicht – bei einem Chat etwa, der gespiegelt einfach die App ist.
   */
  ansicht?: AttachmentDto[];
}) {
  const [code, setCode] = useState('');
  const [modus, setModus] = useState<'linear' | 'zufall'>('linear');
  const [sekunden, setSekunden] = useState(sekundenVorgabe ?? 6);
  const [busy, setBusy] = useState(false);
  /*
   * Die laufende Sitzung kommt aus dem gemeinsamen Speicher, nicht aus einem
   * `useState` hier.
   *
   * Sie stand einmal hier – und beim Schliessen wurde sie auf `null` gesetzt.
   * Ein Anwender hat berichtet, die Fernbedienung lasse sich „schliessen, aber
   * nicht wieder öffnen, während weiter gestreamt wird". Genau so war es: Der
   * Code lebte nur in diesem Blatt, und am Fernseher stand er auch nicht mehr,
   * weil dort die Diashow lief.
   */
  const laeuft = useFernseher((zustand) => zustand.laufend);
  const merken = useFernseher((zustand) => zustand.merken);
  const vergessen = useFernseher((zustand) => zustand.vergessen);
  /** Wo die Diashow gerade steht – die Fernbedienung rechnet von hier aus weiter. */
  const [stelle, setStelle] = useState(0);
  const [pause, setPause] = useState(false);
  /** Ob die Rückfrage vor einem Chat schon beantwortet ist – siehe `starten`. */
  const [sicher, setSicher] = useState(false);
  /** Der dritte Weg: das Telefon spiegeln (`SpiegelSheet`). */
  const [spiegeln, setSpiegeln] = useState(false);

  /*
   * Beim Öffnen nachsehen, ob schon etwas läuft.
   *
   * Der Server weiss es (`GET /tv/meine`), und er ist die einzige Quelle, die
   * auch ein zweites Telefon und einen geleerten Browserspeicher überlebt.
   */
  useEffect(() => {
    if (!open) {
      setBusy(false);
      // Eine halb beantwortete Rückfrage darf ein zweites Öffnen nicht
      // überleben – sonst startete der nächste Druck sofort.
      setSicher(false);
      setSpiegeln(false);
      return;
    }
    void useFernseher.getState().nachsehen();
  }, [open]);

  // Was die laufende Sitzung meldet, gilt – auch Stelle und Pause.
  useEffect(() => {
    if (!laeuft) return;
    setStelle(laeuft.stelle);
    setPause(laeuft.pausiert);
  }, [laeuft]);

  /**
   * Einstellen – auf einen neuen Code oder auf den laufenden.
   *
   * `aufCode` gesetzt heisst „Stattdessen dies zeigen": derselbe Fernseher,
   * der schon läuft, bekommt ein anderes Programm. Der Server erlaubt das dem
   * Besitzer ohnehin (`einstellen` in `fernsehen.rs`), und seit dort der
   * Besitzer nicht mehr gegen die Bremse zählt, geht es auch am zwanzigsten
   * Foto eines Abends noch.
   */
  const starten = async (aufCode?: string) => {
    const sauber = (aufCode ?? code).trim();
    if (sauber.length < 4) {
      toast('Der Code vom Fernseher fehlt noch.', 'error');
      return;
    }
    /*
     * Bei einem Chat wird EINMAL nachgefragt – bei Fotos nie.
     *
     * Der Code ist acht Zeichen aus vierundzwanzig, also gut 2^36; ein
     * Fehlgriff, der zufällig eine andere laufende Sitzung trifft, ist sehr
     * unwahrscheinlich. Bei Urlaubsfotos wäre so ein Treffer peinlich. Bei
     * Nachrichten ist er ein Datenleck in eine fremde Wohnung, und dafür ist
     * „sehr unwahrscheinlich" die falsche Grössenordnung.
     *
     * Deshalb steht der Name des Gesprächs auch auf dem Fernseher, bevor die
     * erste Nachricht kommt: Wer hier bestätigt und dort etwas anderes liest,
     * merkt es sofort.
     *
     * Zweimal DERSELBE Knopf und kein `confirm()` – so hält es diese App auch
     * beim Verlassen eines Chats und beim Löschen für alle. Der native Kasten
     * hält den Hauptfaden an, sieht auf jedem Gerät anders aus, und manche
     * App-interne Browser unterdrücken ihn ganz. Dann wäre die Rückfrage
     * genau dort still, wo sie gebraucht wird.
     */
    if (gespraech && !sicher) {
      setSicher(true);
      return;
    }
    setBusy(true);
    try {
      const antwort = await api.tv.einstellen(sauber, {
        collectionId: collection?.id,
        attachmentIds: collection || gespraech ? undefined : attachmentIds,
        conversationId: gespraech?.id,
        // Beim Umstellen gelten Reihenfolge und Tempo des laufenden Programms –
        // die Regler dafür stehen in dieser Ansicht gar nicht.
        modus: aufCode && laeuft ? laeuft.modus : modus,
        sekunden: aufCode && laeuft ? laeuft.sekunden : sekunden,
      });
      merken({
        code: antwort.code,
        art: gespraech ? 'chat' : 'diashow',
        gespraechId: gespraech?.id ?? null,
        stueckzahl: antwort.stueckzahl,
        stelle: 0,
        pausiert: false,
        modus: aufCode && laeuft ? laeuft.modus : modus,
        sekunden: aufCode && laeuft ? laeuft.sekunden : sekunden,
        gesehenVorSekunden: 0,
      });
      setStelle(0);
      setPause(false);
      setSicher(false);
      toast(
        gespraech
          ? `„${gespraech.name}" läuft auf dem Fernseher.`
          : `Läuft auf dem Fernseher – ${antwort.stueckzahl} Stück.`,
        'success',
      );
    } catch (fehler) {
      toast(
        errorMessage(fehler, 'Der Code passt nicht. Steht er noch so auf dem Fernseher?'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Läuft dort ein Chat?
   *
   * Aus der laufenden Sitzung, nicht aus der Eigenschaft `gespraech`: Der
   * Balken am unteren Rand holt dieses Blatt zurück, ohne zu wissen, was
   * eingestellt wurde – er kennt nur den Code. Aus der Eigenschaft gelesen
   * zeigte er dann die Knöpfe einer Diashow für einen Chat.
   */
  const istChat = laeuft?.art === 'chat';

  /** Zurück zum Neuesten – die Seite null. */
  const zumNeuesten = async () => {
    if (!laeuft) return;
    try {
      const jetzt = await api.tv.steuern(laeuft.code, { stelle: 0 });
      setStelle(jetzt.stelle);
    } catch (fehler) {
      toast(errorMessage(fehler, 'Der Fernseher antwortet nicht mehr.'), 'error');
    }
  };

  /** Ein Schritt der Fernbedienung – die Stelle rechnet der Server im Kreis. */
  const springen = async (richtung: number) => {
    if (!laeuft) return;
    try {
      /*
       * Nur die RICHTUNG geht hinüber, nicht die Zielstelle.
       *
       * Hier stand `stelle + richtung` aus dem eigenen Gedächtnis. Das stimmte
       * nur, solange niemand sonst blätterte – aber der Fernseher schaltet
       * eine Diashow selbst weiter. Nach zehn Minuten Schau stand das Telefon
       * noch bei Bild 1, und „Weiter" sprang zurück an den Anfang. Der
       * Fernseher meldet seine Stelle jetzt dem Server, und der rechnet den
       * Schritt von dort aus (`schritt` in `fernsehen.rs`).
       */
      const jetzt = await api.tv.steuern(laeuft.code, { schritt: richtung });
      setStelle(jetzt.stelle);
    } catch (fehler) {
      toast(errorMessage(fehler, 'Der Fernseher antwortet nicht mehr.'), 'error');
    }
  };

  const pausieren = async () => {
    if (!laeuft) return;
    const neu = !pause;
    setPause(neu);
    try {
      await api.tv.steuern(laeuft.code, { pausiert: neu });
    } catch (fehler) {
      setPause(!neu);
      toast(errorMessage(fehler, 'Der Fernseher antwortet nicht mehr.'), 'error');
    }
  };

  const beenden = async () => {
    if (!laeuft) return;
    try {
      await api.tv.beenden(laeuft.code);
      vergessen();
      setStelle(0);
      setPause(false);
      onClose();
    } catch (fehler) {
      toast(errorMessage(fehler, 'Das Beenden hat nicht geklappt.'), 'error');
    }
  };

  /** Wurde das Blatt mit etwas Neuem geöffnet – oder nur als Fernbedienung? */
  const hatNeues = Boolean(collection || gespraech || (attachmentIds && attachmentIds.length > 0));
  /** Lässt sich das hier auch über die Spiegelung zeigen? */
  const spiegelbar = !gespraech && Boolean(ansicht && ansicht.length > 0);

  return (
    <>
      <Sheet
        open={open && !spiegeln}
        onClose={onClose}
        title={laeuft ? 'Läuft auf dem Fernseher' : (titel ?? 'Auf den Fernseher')}
        variant="modal"
      >
        {laeuft ? (
          <div className="tv-fern">
            {hatNeues && (
              /*
               * „Stattdessen dies zeigen" – ohne Beenden und ohne den Code neu
               * abzutippen.
               *
               * Hier stand für JEDES Foto nur die Fernbedienung des laufenden
               * Programms. Wer an einem Abend Stück für Stück zeigen wollte,
               * musste „Beenden" drücken (danach war der Code am Telefon
               * vergessen), zum Fernseher gehen, den Code ablesen und neu
               * tippen – und jedes Mal zählte das gegen die Bremse von zwanzig
               * Versuchen je Stunde.
               */
              <div className="tv-stattdessen">
                <button
                  type="button"
                  className={`btn btn-block ${sicher ? 'btn-danger' : 'btn-primary'}`}
                  disabled={busy}
                  onClick={() => void starten(laeuft.code)}
                >
                  {busy
                    ? 'Wird umgestellt …'
                    : sicher
                      ? `„${gespraech?.name}" wirklich zeigen?`
                      : '📺 Stattdessen dies zeigen'}
                </button>
                <p className="tv-hinweis">
                  {titel ?? 'Das hier'} – auf demselben Fernseher, ohne neuen Code.
                </p>
              </div>
            )}
            <p className="tv-zeile">
              {istChat
                ? 'Der Chat läuft auf dem Fernseher'
                : `${laeuft.stueckzahl} ${laeuft.stueckzahl === 1 ? 'Stück' : 'Stücke'}`}{' '}
              · Code <strong>{laeuft.code}</strong>
            </p>
            {/*
              Dieselben drei Knöpfe, eine andere Bedeutung.

              Bei der Diashow ist die Stelle die Nummer des Bildes; bei einem
              Chat die SEITE im Verlauf, zwölf Nachrichten je Seite. Und die
              Pause dazwischen gibt es beim Chat nicht – da läuft nichts
              weiter, was sich anhalten liesse. An ihrer Stelle steht der Weg
              zurück zum Neuesten: Wer drei Seiten zurückgeblättert hat, will
              nicht dreimal „weiter" drücken.

              „Zurück" heisst beim Chat WEITER ZURÜCK im Verlauf, also eine
              höhere Stelle. Das Vorzeichen dreht sich, die Beschriftung
              nicht – ‹ zeigt in beiden Fällen dorthin, wo man herkommt.
          */}
            <div className="tv-tasten">
              <button type="button" className="btn" onClick={() => void springen(istChat ? 1 : -1)}>
                ‹ {istChat ? 'Früher' : 'Zurück'}
              </button>
              {istChat ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void zumNeuesten()}
                  disabled={stelle === 0}
                >
                  ⤓ Neueste
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void pausieren()}>
                  {pause ? '▶ Weiter' : '⏸ Pause'}
                </button>
              )}
              <button type="button" className="btn" onClick={() => void springen(istChat ? -1 : 1)}>
                {istChat ? 'Später' : 'Weiter'} ›
              </button>
            </div>
            {istChat && (
              /*
               * Die Frist gehört auf den Schirm, nicht in eine Fussnote.
               *
               * Ein Chat fällt nach einer halben Stunde ohne Lebenszeichen vom
               * Fernseher. Wer das nicht weiss, hält es für einen Fehler – und
               * wer es weiss, versteht, warum er nichts tun muss, wenn er geht.
               */
              <p className="tv-hinweis">
                Der Fernseher zeigt nur die letzten Nachrichten und hört von selbst auf, wenn eine
                halbe Stunde lang niemand schreibt oder blättert.
              </p>
            )}
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => void beenden()}
            >
              Beenden
            </button>
          </div>
        ) : (
          <div className="tv-einstellen">
            {/*
            Wozu dieser Weg da ist – bevor jemand acht Handgriffe macht.

            Er ist die Rückfallebene hinter Chromecast, und das steht jetzt
            auch dort, wo er beginnt. Aber er ist nicht die schlechtere
            Fassung: Er läuft auf jedem Fernseher mit Browser, er zeigt Bilder
            in voller Grösse statt in 1280 × 720, und er läuft weiter, wenn
            das Telefon in der Tasche steckt – die Diashow taktet sich im
            Fernseher selbst (`src/tv/tv.ts`), nicht von hier aus.
          */}
            <p className="tv-zeile">
              {gespraech
                ? `„${gespraech.name}" gross auf dem Fernseher – auf jedem Gerät mit Browser, ohne Chromecast und ohne App.`
                : 'Für jeden Fernseher mit Browser – auch ohne Chromecast. Fotos in voller Grösse, und die Diashow läuft weiter, wenn das Telefon in der Tasche steckt.'}
            </p>
            <ol className="tv-schritte">
              <li>
                Öffne am Fernseher den Browser und gib <strong>{tvAdresse()}</strong> ein.
              </li>
              <li>Tippe den Code ab, der dort erscheint.</li>
            </ol>

            <label className="feld">
              <span>Code vom Fernseher</span>
              <input
                className="tv-code-eingabe"
                value={code}
                onChange={(ereignis) => setCode(ereignis.target.value)}
                placeholder="ABCD-EFGH"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                maxLength={12}
              />
            </label>

            {/*
              Reihenfolge und Standzeit gibt es beim Chat nicht.

              Ein Gesprächsverlauf hat eine Reihenfolge – seine eigene –, und
              „gemischt" wäre dafür kein Wunsch, sondern ein Fehler. Die
              Standzeit ebenso: Es taktet nichts weiter, es steht, bis jemand
              schreibt. Beides abgeblendet stehen zu lassen wäre schlechter als
              es wegzulassen; ein grauer Regler lädt zum Ziehen ein.
          */}
            {!gespraech && (
              <>
                <fieldset className="tv-wahl">
                  <legend>Reihenfolge</legend>
                  <label>
                    <input
                      type="radio"
                      name="tv-modus"
                      checked={modus === 'linear'}
                      onChange={() => setModus('linear')}
                    />
                    Der Reihe nach
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="tv-modus"
                      checked={modus === 'zufall'}
                      onChange={() => setModus('zufall')}
                    />
                    Gemischt
                  </label>
                </fieldset>

                <label className="feld">
                  <span>Ein Foto steht {sekunden} Sekunden</span>
                  <input
                    type="range"
                    min={2}
                    max={30}
                    step={1}
                    value={sekunden}
                    onChange={(ereignis) => setSekunden(Number(ereignis.target.value))}
                  />
                </label>
                {/*
                 * Videos laufen ganz durch, egal was hier steht. Ein Video nach
                 * sechs Sekunden abzuschneiden, weil das die Diashow-Zeit ist, wäre
                 * die schlechtere Voreinstellung – und ohne diesen Satz hielte man
                 * es für einen Fehler.
                 */}
                <p className="tv-hinweis">Videos laufen immer ganz durch.</p>
              </>
            )}
            {gespraech && (
              <p className="tv-hinweis">
                Der Fernseher zeigt die letzten Nachrichten und hört von selbst auf, wenn eine halbe
                Stunde lang niemand schreibt oder blättert. Wer den Chat verlässt, dessen Fernseher
                geht sofort aus.
              </p>
            )}

            <button
              type="button"
              className={`btn btn-block ${sicher ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy}
              onClick={() => void starten()}
            >
              {busy
                ? 'Wird gestartet …'
                : sicher
                  ? `„${gespraech?.name}" wirklich zeigen?`
                  : 'Starten'}
            </button>
            {sicher && <p className="tv-hinweis">Jeder im Raum kann den Verlauf dann mitlesen.</p>}
            {spiegelbar && (
              /*
               * Der dritte Weg, am Ende und nicht vorn.
               *
               * Dieses Blatt ist der Code-Weg, und wer es öffnet, hat meist einen
               * Fernseher mit Browser vor sich. Für die anderen – Apple TV,
               * Chromecast, Roku, oder ein Fernseher, dessen Browser nicht mag –
               * steht hier der Weg über die Spiegelung des Telefons.
               */
              <div className="tv-andere-wege">
                <p className="tv-hinweis">
                  Fernseher ohne Browser? Apple TV, Chromecast, Roku – oder einfach kein Code zur
                  Hand:
                </p>
                <button type="button" className="btn btn-block" onClick={() => setSpiegeln(true)}>
                  📱 Telefon spiegeln – Fernsehansicht
                </button>
              </div>
            )}
          </div>
        )}
      </Sheet>
      {spiegeln && ansicht && (
        <SpiegelSheet open onClose={() => setSpiegeln(false)} stuecke={ansicht} />
      )}
    </>
  );
}

/**
 * Die Adresse, die am Fernseher einzugeben ist.
 *
 * Aus der eigenen Adresse abgeleitet und nicht fest eingetragen: Diese App
 * wird selbst gehostet, und unter welchem Namen sie läuft, weiss nur die
 * Auslieferung. Ohne den Hafen und ohne `https://` – das tippt sich sonst auf
 * einer Fernbedienung doppelt so lang, und jeder Browser ergänzt es.
 */
function tvAdresse(): string {
  if (typeof window === 'undefined') return '/tv';
  const ort = window.location;
  const hafen = ort.port && ort.port !== '80' && ort.port !== '443' ? `:${ort.port}` : '';
  return `${ort.hostname}${hafen}/tv`;
}
