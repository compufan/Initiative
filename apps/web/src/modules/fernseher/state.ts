import { create } from 'zustand';
import { api } from '../../lib/api.js';

/**
 * Was gerade auf einem Fernseher läuft.
 *
 * # Warum das nicht im Blatt bleiben konnte
 *
 * Es blieb es einmal: `useState` in `FernsehSheet`, und beim Schliessen weg.
 * Ein Anwender hat berichtet, die Fernbedienung lasse sich „schliessen, aber
 * nicht wieder öffnen, während weiter gestreamt wird". Genau so war es – und
 * es gab auch keinen Weg zurück: Der Code stand nur im Blatt, und am
 * Fernseher stand er nicht mehr, weil dort die Diashow lief.
 *
 * # Warum der Server gefragt wird und nicht der lokale Speicher
 *
 * Der lokale Speicher wäre die halbe Antwort. Er überlebt kein zweites Gerät,
 * keinen geleerten Browser und keine Sitzung, die ein anderes Telefon derselben
 * Person gestartet hat. Der Server weiss es ohnehin: `besitzer_id` steht in
 * `fernsehsitzungen`, und der Index dafür liegt seit Migration 0017 herum,
 * ohne dass ihn je jemand benutzt hätte.
 *
 * Gefragt wird selten – beim Start, nach dem Einstellen, beim Öffnen des
 * Blattes. Eine Diashow, die niemand steuert, braucht keine Umfrage im
 * Sekundentakt; der Fernseher taktet sich selbst.
 */
export interface LaufendeSitzung {
  code: string;
  stueckzahl: number;
  stelle: number;
  pausiert: boolean;
  modus: 'linear' | 'zufall';
  sekunden: number;
  gesehenVorSekunden: number;
}

interface FernseherStore {
  laufend: LaufendeSitzung | null;
  /** Läuft gerade eine Abfrage? Verhindert, dass sich zwei überholen. */
  fragtGerade: boolean;
  /** Beim Server nachsehen. Still: Ein Fehler hier darf nichts kaputtmachen. */
  nachsehen: () => Promise<void>;
  /** Nach dem Einstellen sofort setzen, ohne auf die Abfrage zu warten. */
  merken: (sitzung: LaufendeSitzung) => void;
  /** Nach dem Beenden. */
  vergessen: () => void;
  /** Die Fernbedienung öffnen – das Blatt hängt daran. */
  fernbedienungOffen: boolean;
  fernbedienung: (offen: boolean) => void;
}

/**
 * Ab wann ein Fernseher als „meldet sich nicht mehr" gilt.
 *
 * Das TV-Blatt fragt im Sekundentakt nach der Fassungsnummer und setzt dabei
 * `gesehen_at`. Zwei Minuten Stille heissen also: ausgeschaltet, Browser zu,
 * oder aus dem WLAN. Eine Fernbedienung für so einen Fernseher anzubieten
 * wäre ein Knopf, der ins Leere greift.
 */
export const STILL_AB_SEKUNDEN = 120;

export const useFernseher = create<FernseherStore>((set, get) => ({
  laufend: null,
  fragtGerade: false,
  fernbedienungOffen: false,

  async nachsehen() {
    if (get().fragtGerade) return;
    set({ fragtGerade: true });
    try {
      const antwort = await api.tv.meine();
      const lebend = antwort.items.find((s) => s.gesehenVorSekunden <= STILL_AB_SEKUNDEN);
      set({ laufend: lebend ?? null });
    } catch {
      /*
       * Still. Diese Abfrage läuft beim Start der App mit, und ein Fehler
       * hier – offline, Server neu gestartet – darf nicht als Meldung
       * aufschlagen. Was sie nicht findet, gibt es für die Oberfläche nicht.
       */
    } finally {
      set({ fragtGerade: false });
    }
  },

  merken(sitzung) {
    set({ laufend: sitzung });
  },

  vergessen() {
    set({ laufend: null, fernbedienungOffen: false });
  },

  fernbedienung(offen) {
    set({ fernbedienungOffen: offen });
  },
}));
