import { useEffect, useMemo, useState } from 'react';
import { Screen } from '../../components/Screen.js';

/**
 * „Verwendete Software“ – die Nennung fremder Arbeit.
 *
 * # Warum es diese Seite gibt
 *
 * Weil fast jede der hier benutzten Lizenzen sie verlangt. MIT sagt es am
 * knappsten: „The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.“ Wer eine
 * Web-App ausliefert, verteilt Kopien – an jeden Besucher. Ohne diese Seite
 * war die App also formal im Unrecht, und zwar bei jedem einzelnen der hier
 * genannten Pakete.
 *
 * # Warum sie nachgeladen wird
 *
 * Die Liste ist 350 KB gross. Sie gehört nicht ins Bundle, das jeder beim
 * Start lädt, sondern hierher – abgeholt, wenn jemand sie sehen will.
 *
 * # Warum eher zu viel als zu wenig darin steht
 *
 * Die Liste entsteht aus dem Abhängigkeitsbaum, nicht aus einer Messung des
 * fertigen Bundles. Manches darin wird beim Bauen wegoptimiert und kommt nie
 * beim Nutzer an. Das ist Absicht: Jemanden zu nennen, dessen Code am Ende
 * nicht mitgeliefert wird, schadet niemandem – jemanden zu vergessen,
 * dessen Code mitgeliefert wird, ist ein Lizenzverstoss.
 */

interface Eintrag {
  name: string;
  version?: string;
  lizenz: string;
  urheber?: string;
  quelle?: string;
  hinweis?: string;
  beleg?: string;
  textId?: string;
}

interface Gruppe {
  teil: string;
  titel: string;
  eintraege: Eintrag[];
  fehlt?: string;
}

interface Liste {
  gruppen: Gruppe[];
  texte: Record<string, string>;
}

const ERKLAERUNG: Record<string, string> = {
  web: 'Läuft in deinem Browser und wird mit der App an dich ausgeliefert.',
  wasm: 'Steckt fest einkompiliert in den Rechenwerken für die Bilderkennung – nicht als eigenes Paket, sondern als Teil zweier grosser WASM-Dateien.',
  modell:
    'Die Modelle für Freistellen und Tiefenschärfe. Sie werden nur geladen, wenn du ein Verfahren zum ersten Mal benutzt, und rechnen danach in deinem Gerät.',
  api: 'Läuft auf dem Server. Dieses Programm wird an niemanden weitergegeben – die Nennung steht hier trotzdem, weil die Arbeit dieselbe ist.',
};

export function LizenzenScreen() {
  const [liste, setListe] = useState<Liste | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [suche, setSuche] = useState('');
  const [offen, setOffen] = useState<string | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    void fetch('/lizenzen.json')
      .then((antwort) => {
        if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
        return antwort.json() as Promise<Liste>;
      })
      .then((daten) => {
        if (!abgebrochen) setListe(daten);
      })
      .catch(() => {
        if (!abgebrochen) setFehler('Die Liste konnte gerade nicht geladen werden.');
      });
    return () => {
      abgebrochen = true;
    };
  }, []);

  const gefiltert = useMemo(() => {
    if (!liste) return [];
    const wort = suche.trim().toLowerCase();
    if (!wort) return liste.gruppen;
    return liste.gruppen
      .map((gruppe) => ({
        ...gruppe,
        eintraege: gruppe.eintraege.filter(
          (eintrag) =>
            eintrag.name.toLowerCase().includes(wort) ||
            eintrag.lizenz.toLowerCase().includes(wort) ||
            (eintrag.urheber ?? '').toLowerCase().includes(wort),
        ),
      }))
      .filter((gruppe) => gruppe.eintraege.length > 0);
  }, [liste, suche]);

  const gesamt = liste?.gruppen.reduce((summe, gruppe) => summe + gruppe.eintraege.length, 0) ?? 0;

  return (
    <Screen title="Verwendete Software" back="/profil/einstellungen">
      <section className="card stack">
        <p className="prf-hint" style={{ margin: 0 }}>
          Diese App steht auf fremder Arbeit. Was hier steht, ist die Nennung, die deren Lizenzen
          verlangen – mit Rechteinhaber, Lizenz und Herkunft. Tippe einen Eintrag an, um seinen
          Lizenztext zu lesen.
        </p>
        <p className="prf-hint" style={{ margin: 0 }}>
          Initiative selbst steht unter der MIT-Lizenz.
        </p>
        {liste && (
          <input
            className="input"
            type="search"
            placeholder={`Unter ${gesamt} Einträgen suchen …`}
            value={suche}
            onChange={(änderung) => setSuche(änderung.target.value)}
            aria-label="Verwendete Software durchsuchen"
          />
        )}
      </section>

      {fehler && (
        <section className="card">
          <p className="prf-hint" style={{ margin: 0 }}>
            {fehler}
          </p>
        </section>
      )}
      {!liste && !fehler && (
        <section className="card">
          <p className="prf-hint" style={{ margin: 0 }}>
            Wird geladen …
          </p>
        </section>
      )}

      {gefiltert.map((gruppe) => (
        <section className="card stack" key={gruppe.teil}>
          <h2 className="prf-block-title">
            {gruppe.titel} <span className="badge">{gruppe.eintraege.length}</span>
          </h2>
          <p className="prf-hint" style={{ margin: 0 }}>
            {ERKLAERUNG[gruppe.teil]}
          </p>
          {gruppe.fehlt && (
            <p className="prf-hint" style={{ margin: 0 }}>
              {gruppe.fehlt}
            </p>
          )}
          <ul className="lzn-liste">
            {gruppe.eintraege.map((eintrag) => {
              const schluessel = `${gruppe.teil}/${eintrag.name}@${eintrag.version ?? ''}`;
              const auf = offen === schluessel;
              const text = eintrag.textId ? liste?.texte[eintrag.textId] : undefined;
              return (
                <li key={schluessel} className="lzn-zeile">
                  <button
                    type="button"
                    className="lzn-kopf"
                    aria-expanded={auf}
                    onClick={() => setOffen(auf ? null : schluessel)}
                  >
                    <span className="lzn-name">
                      {eintrag.name}
                      {eintrag.version && <span className="prf-hint"> {eintrag.version}</span>}
                    </span>
                    <span className="badge">{eintrag.lizenz}</span>
                  </button>
                  {auf && (
                    <div className="lzn-inhalt stack">
                      {eintrag.urheber && <p className="lzn-urheber">{eintrag.urheber}</p>}
                      {eintrag.hinweis && <p className="prf-hint">{eintrag.hinweis}</p>}
                      {eintrag.beleg && <p className="prf-hint">Nachweis: {eintrag.beleg}</p>}
                      {eintrag.quelle && (
                        <a
                          className="prf-hint"
                          href={eintrag.quelle}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {eintrag.quelle}
                        </a>
                      )}
                      {text ? (
                        <pre className="lzn-text">{text}</pre>
                      ) : (
                        <p className="prf-hint">
                          Kein Lizenztext beigelegt – die Lizenz {eintrag.lizenz} gilt in ihrer
                          veröffentlichten Fassung.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Screen>
  );
}
