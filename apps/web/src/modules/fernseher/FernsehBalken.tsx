import { useEffect } from 'react';
import { FernsehSheet } from './FernsehSheet.js';
import { useFernseher } from './state.js';

/**
 * Der Weg zurück zur Fernbedienung.
 *
 * # Wofür er da ist
 *
 * Ein Anwender hat berichtet: „Die Fernsteuerung beim Streamen, mit der man
 * das nächste Bild oder das letzte machen kann, lässt sich schliessen, aber
 * nicht wieder öffnen, während weiter gestreamt wird."
 *
 * Das stimmte, und es war schlimmer als es klingt: Der Code lebte allein im
 * Blatt, und am Fernseher stand er auch nicht mehr – dort lief ja die Diashow.
 * Es gab buchstäblich keinen Weg zurück, ausser die Schau am Fernseher
 * auszuschalten.
 *
 * # Warum ein Balken und kein Knopf irgendwo
 *
 * Weil man beim Weiterblättern nicht in der Dateiansicht sitzt. Man legt das
 * Telefon weg, liest im Chat, und dann will jemand das nächste Bild. Ein
 * Knopf, den man erst suchen muss, indem man zurück in die Sammlung geht, ist
 * für diesen Moment kein Knopf.
 *
 * Er liegt deshalb als Overlay des Moduls über der ganzen App – dieselbe
 * Ebene, auf der auch die Aktualisierungsmeldung sitzt – und er ist schmal:
 * eine Zeile über der Navigationsleiste, nicht ein Kasten mitten im Bild.
 *
 * # Warum er von selbst verschwindet
 *
 * Weil er sonst lügt. `nachsehen` fragt beim Server, und der antwortet nur
 * für Sitzungen, deren Fernseher sich in den letzten zwei Minuten gemeldet
 * hat. Ein ausgeschalteter Fernseher nimmt den Balken also mit – nach
 * spätestens einer Minute, denn so oft wird nachgesehen.
 */
export function FernsehBalken() {
  const laufend = useFernseher((zustand) => zustand.laufend);
  const offen = useFernseher((zustand) => zustand.fernbedienungOffen);
  const fernbedienung = useFernseher((zustand) => zustand.fernbedienung);

  /*
   * Einmal beim Start und danach jede Minute.
   *
   * Nicht öfter: Die Diashow taktet sich im Fernseher selbst, hier wird nur
   * die Frage „läuft noch etwas?" beantwortet. Ein Sekundentakt wäre eine
   * Anfrage je Sekunde für eine Auskunft, die sich stündlich ändert.
   */
  useEffect(() => {
    void useFernseher.getState().nachsehen();
    const uhr = window.setInterval(() => void useFernseher.getState().nachsehen(), 60_000);
    return () => window.clearInterval(uhr);
  }, []);

  /*
   * Wie hoch die Navigationsleiste gerade ist – gemessen, nicht geraten.
   *
   * Sie hat keine feste Höhe: Sie wächst mit der Schriftgrösse des Systems,
   * bekommt unten den sicheren Bereich des Geräts dazu und verschwindet ganz,
   * wenn ein Bildschirm sie ausblendet (`useNavVisibility`). Eine Zahl im CSS
   * wäre auf genau einem Gerät richtig.
   *
   * Der Beobachter meldet auch das Verschwinden: Ist keine Leiste da, steht
   * der Balken unten am Rand, wo sonst die Leiste wäre.
   */
  useEffect(() => {
    const setzen = () => {
      const leiste = document.querySelector('.app-nav');
      const hoehe = leiste ? leiste.getBoundingClientRect().height : 0;
      document.documentElement.style.setProperty('--tv-balken-unten', `${Math.round(hoehe)}px`);
    };
    setzen();
    const beobachter = new ResizeObserver(setzen);
    const leiste = document.querySelector('.app-nav');
    if (leiste) beobachter.observe(leiste);
    // Die Leiste kann auch ganz kommen und gehen – dann greift kein
    // ResizeObserver, weil es das Element vorher nicht gab.
    const koerper = new MutationObserver(setzen);
    koerper.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', setzen);
    return () => {
      beobachter.disconnect();
      koerper.disconnect();
      window.removeEventListener('resize', setzen);
      document.documentElement.style.removeProperty('--tv-balken-unten');
    };
  }, []);

  if (!laufend) return null;

  return (
    <>
      <div className="tv-balken">
        <span className="tv-balken-text">
          <span aria-hidden="true">📺</span>{' '}
          {laufend.art === 'chat' ? 'Chat auf dem Fernseher' : 'Läuft auf dem Fernseher'}
          {/*
              Bei einem Chat steht hier KEINE Stückzahl.

              Er hat keine – seine Liste steht nicht in der Sitzung, sondern
              wird bei jedem Abruf frisch geholt. „0 Stücke" hätte da gestanden,
              und das liest sich wie ein Fehler statt wie eine andere Art von
              Programm.
          */}
          {laufend.art !== 'chat' && (
            <span className="tv-balken-klein">
              {' '}
              · {laufend.stueckzahl} {laufend.stueckzahl === 1 ? 'Stück' : 'Stücke'}
              {laufend.pausiert && ' · pausiert'}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => fernbedienung(true)}
        >
          Fernbedienung
        </button>
      </div>
      {offen && <FernsehSheet open onClose={() => fernbedienung(false)} />}
    </>
  );
}
