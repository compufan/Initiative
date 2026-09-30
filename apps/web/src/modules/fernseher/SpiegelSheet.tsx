import { useEffect, useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Fernsehansicht } from './Fernsehansicht.js';
import { vollbildVersuchen } from './fernsehansicht.js';
import {
  mitteilungenAbschalten,
  plattformAus,
  plattformErmitteln,
  spiegelAnleitungen,
  type Anleitung,
  type Plattform,
} from './spiegeln.js';

/**
 * „Telefon spiegeln" – die Anleitung und der Start der Fernsehansicht.
 *
 * # Warum die Anleitung VOR der Ansicht steht und nicht in ihr
 *
 * Weil die Reihenfolge zählt. Wer erst spiegelt und dann in der App tippt,
 * zeigt dem ganzen Wohnzimmer die Chatliste, bis er die Fernsehansicht
 * gefunden hat – samt Mitteilungen. Deshalb steht hier zuerst, was vorher
 * abzuschalten ist, dann wie man spiegelt, und am Ende der eine Knopf.
 *
 * # Warum die Warnung vor Mitteilungen ganz oben steht
 *
 * Es ist ein Messenger. Gespiegelt wird alles, was das Telefon zeigt, und
 * beim iPhone sind Mitteilungen während der Synchronisierung laut Apple
 * standardmässig ERLAUBT – eine Vorschau aus einem anderen Chat stünde
 * sonst in Wohnzimmergrösse da. Das ist kein Tipp, den man überlesen darf.
 */
export function SpiegelSheet({
  open,
  onClose,
  stuecke,
  start = 0,
}: {
  open: boolean;
  onClose: () => void;
  /** Was die Fernsehansicht zeigt – Fotos und Videos. */
  stuecke: AttachmentDto[];
  /** Womit sie beginnt. */
  start?: number;
}) {
  const [plattform, setPlattform] = useState<Plattform>(() =>
    typeof navigator === 'undefined'
      ? 'andere'
      : plattformAus(navigator.userAgent, navigator.maxTouchPoints || 0),
  );
  const [modus, setModus] = useState<'linear' | 'zufall'>('linear');
  const [sekunden, setSekunden] = useState(6);
  const [laeuft, setLaeuft] = useState(false);

  // Das Modell nachfragen – Chrome gibt es nur so heraus (siehe `plattformAus`).
  useEffect(() => {
    if (!open) return undefined;
    let gilt = true;
    void plattformErmitteln().then((gefunden) => {
      if (gilt) setPlattform(gefunden);
    });
    return () => {
      gilt = false;
    };
  }, [open]);

  const { eigene, andere } = spiegelAnleitungen(plattform);
  const apfel = plattform === 'iphone' || plattform === 'ipad';

  return (
    <>
      <Sheet
        open={open && !laeuft}
        onClose={onClose}
        title="Telefon auf den Fernseher spiegeln"
        variant="modal"
      >
        <div className="stack spiegel">
          <p className="tv-zeile">
            Für Fernseher ohne Browser – Apple TV, Chromecast, Roku – und überall, wo das Telefon
            seinen Bildschirm hinschicken kann. Die App zeigt dafür eine eigene Ansicht: schwarz,
            quer, gross, mit Ton.
          </p>

          <div className="spiegel-warnung" role="note">
            <strong>Zuerst: Mitteilungen aus.</strong> Der Fernseher zeigt alles, was das Telefon
            zeigt – auch Mitteilungen und Vorschauen aus anderen Chats.{' '}
            {mitteilungenAbschalten(plattform)}
          </div>

          {eigene ? (
            <AnleitungsBlock anleitung={eigene} ueberschrift="So geht es auf diesem Gerät" />
          ) : (
            <p className="tv-hinweis">
              Welches Gerät das ist, liess sich nicht erkennen – die Anleitungen stehen unten.
            </p>
          )}

          <ul className="spiegel-regeln">
            <li>
              Das Telefon muss <strong>entsperrt bleiben und diese App vorn</strong>. Wer die App
              wechselt oder das Telefon sperrt, zeigt das auf dem Fernseher, und die Diashow hält
              an.
            </li>
            {apfel && (
              /*
               * Die iPhone-Falle, einmal in Worten: Das Vollbild der
               * Videosteuerung übergibt das Video an den Fernseher, und der
               * holt es sich ohne Anmeldung – schwarz. In der Fernsehansicht
               * gibt es diesen Knopf nicht; anderswo in der App schon.
               */
              <li>
                Videos laufen in der Fernsehansicht im Bild. Den Vollbildknopf eines Videos anderswo
                in der App beim Spiegeln nicht benutzen – dann holt der Fernseher das Video selbst
                und bleibt oft schwarz.
              </li>
            )}
          </ul>

          {stuecke.length > 1 && (
            <>
              <fieldset className="tv-wahl">
                <legend>Reihenfolge</legend>
                <label>
                  <input
                    type="radio"
                    name="spiegel-modus"
                    checked={modus === 'linear'}
                    onChange={() => setModus('linear')}
                  />
                  Der Reihe nach
                </label>
                <label>
                  <input
                    type="radio"
                    name="spiegel-modus"
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
              <p className="tv-hinweis">Videos laufen immer ganz durch.</p>
            </>
          )}

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              // Im Klick selbst – Vollbild verlangt einen frischen Fingertipp.
              vollbildVersuchen();
              setLaeuft(true);
            }}
          >
            📺 Fernsehansicht starten
          </button>

          <details className="spiegel-andere">
            <summary>{eigene ? 'Anleitung für andere Geräte' : 'Anleitungen'}</summary>
            {andere.map((anleitung) => (
              <AnleitungsBlock key={anleitung.id} anleitung={anleitung} />
            ))}
          </details>
        </div>
      </Sheet>
      {laeuft && (
        <Fernsehansicht
          stuecke={stuecke}
          start={start}
          modus={modus}
          sekunden={sekunden}
          onClose={() => {
            setLaeuft(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

function AnleitungsBlock({
  anleitung,
  ueberschrift,
}: {
  anleitung: Anleitung;
  ueberschrift?: string;
}) {
  return (
    <section className="spiegel-anleitung" data-plattform={anleitung.id}>
      {ueberschrift && <p className="spiegel-ueber">{ueberschrift}</p>}
      <h3 className="spiegel-titel">{anleitung.titel}</h3>
      <ol className="tv-schritte">
        {anleitung.schritte.map((schritt) => (
          <li key={schritt}>{schritt}</li>
        ))}
      </ol>
      <p className="tv-hinweis">
        <strong>Geht auf:</strong> {anleitung.ziele}
      </p>
      {anleitung.hinweis && <p className="tv-hinweis">{anleitung.hinweis}</p>}
    </section>
  );
}
