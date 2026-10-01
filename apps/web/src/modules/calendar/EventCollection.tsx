import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEventDto, CollectionDto } from '@initiative/shared';
import { api, ApiError } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { useNamen } from '../../state/leute.js';
import { toast } from '../../state/ui.js';
import { ordnerZeilen, pfadText } from '../files/ordner.js';
import { useFiles } from '../files/state.js';
import { SammlungZugriff } from './SammlungZugriff.js';
import { TerminSammlungSheet, type BlattMeldung } from './TerminSammlungSheet.js';
import {
  istUnklar,
  nochmalVerknuepfen,
  sammlungAnlegenUndVerknuepfen,
  verwerfen,
  type Fortschritt,
  type TerminSammlungDienste,
  type TerminSammlungPlan,
  type ZugErgebnis,
} from './terminSammlung.js';

interface Props {
  event: CalendarEventDto;
  canManage: boolean;
  onChanged: (event: CalendarEventDto) => void;
}

/** Die vier Aufrufe, aus denen der Zug besteht – einspeisbar für die Tests. */
const dienste: TerminSammlungDienste = {
  anlegen: (body) => api.collections.create(body),
  verknuepfen: (terminId, sammlungId) => api.calendar.linkCollection(terminId, sammlungId),
  freigeben: (sammlungId, userId, level) => api.collections.grant(sammlungId, { userId, level }),
  verwerfen: (sammlungId) => api.collections.remove(sammlungId),
};

/** Angelegt, aber nicht verknüpft – der Zustand, in dem der Anwender wählen muss. */
interface Rest {
  sammlung: CollectionDto;
  plan: TerminSammlungPlan;
  /** Woran der Termin vorher hing, falls sich das Verwerfen als nötig erweist. */
  vorher: string | null;
}

function knopfText(stand: Fortschritt | null): string | null {
  if (!stand) return null;
  if (stand.schritt === 'anlegen') return 'Legt an …';
  if (stand.schritt === 'verknuepfen') return 'Verknüpft …';
  return `Gibt frei … ${Math.min(stand.erledigt + 1, stand.gesamt)} von ${stand.gesamt}`;
}

/** Der Text des Servers ohne den Schlusspunkt, damit ein Satz daran nicht doppelt endet. */
function ohnePunkt(fehler: unknown, ersatz: string): string {
  const text = fehler instanceof Error && fehler.message ? fehler.message : ersatz;
  return text.replace(/[.\s]+$/, '');
}

/**
 * Die Sammlung zum Termin.
 *
 * Zwei Wege, die gleich ehrlich sind: eine bestehende Sammlung verknüpfen
 * oder eine neue anlegen (auch in einem Ordner) und verknüpfen. Bewusst eine
 * Verknüpfung statt einer Kopie: Die Bilder vom Wochenende liegen in der
 * Sammlung, wo sie hingehören, und der Termin zeigt dorthin.
 *
 * Verknüpfen vergibt nie stillschweigend Rechte. Wer hineinkommt, regelt ein
 * ausdrücklicher, sichtbarer Schritt – beim Anlegen im Blatt vor dem Tipp,
 * bei einer bestehenden Sammlung im Abschnitt „Zugriff der Eingeladenen“.
 * Die Dokumente am Termin (`EventDocuments`) sind etwas anderes und haben mit
 * der Sammlung nichts zu tun.
 */
export function EventCollection({ event, canManage, onChanged }: Props) {
  const myId = useMyId();
  const collections = useFiles((state) => state.collections);
  const status = useFiles((state) => state.status);
  const load = useFiles((state) => state.load);

  const [geladen, setGeladen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blatt, setBlatt] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [stand, setStand] = useState<Fortschritt | null>(null);
  const [meldung, setMeldung] = useState<BlattMeldung | null>(null);
  const [rest, setRest] = useState<Rest | null>(null);
  const [zuTief, setZuTief] = useState<ReadonlySet<string>>(() => new Set());
  const [ladeVersuch, setLadeVersuch] = useState(0);

  /*
   * Sofort greifender Wächter gegen den Doppeltipp.
   *
   * Ein `useState` käme zu spät: Der zweite Tipp läge noch im selben Render,
   * und der Server hat für Sammlungen keinen Schlüssel zur Wiederholung (anders
   * als die Termine mit `clientId`). Zwei Tipps hiessen zwei Sammlungen.
   */
  const laeuftJetzt = useRef(false);
  // Der Zug läuft im Elternteil und überlebt das Blatt; am Ende muss er wissen,
  // ob es noch offen ist, ohne dass sein Abschluss veraltet.
  const blattOffen = useRef(blatt);
  blattOffen.current = blatt;

  /*
   * Die Liste kommt aus dem Dateien-Speicher, nicht aus einem eigenen Aufruf.
   *
   * Dann kennt „Dateien“ eine hier angelegte Sammlung sofort und am richtigen
   * Platz im Baum, und beide Ansichten sagen dasselbe. Neu geladen wird auch,
   * wenn sich die Verknüpfung ändert (ein Rundruf von aussen): Die Sammlung
   * kann erst seit diesem Augenblick freigegeben sein.
   *
   * Ein Fehlschlag wird gezeigt, nicht verschluckt – ohne Netz sähe sonst ein
   * Termin mit Sammlung aus, als gäbe es keine einzige.
   */
  useEffect(() => {
    let aktuell = true;
    setGeladen(false);
    void load().finally(() => {
      if (aktuell) setGeladen(true);
    });
    return () => {
      aktuell = false;
    };
  }, [load, event.collectionId, ladeVersuch]);

  const verknuepft = collections.find((eintrag) => eintrag.id === event.collectionId) ?? null;
  const ladeFehler = status === 'error';
  /*
   * Verknüpft, aber nicht in der eigenen Liste: gelöscht, oder nie
   * freigegeben. Für den Eingeladenen ist beides dasselbe und soll es auch
   * bleiben. Vorher stand hier ein Knopf, der in ein Fehlerband führte.
   * Erst urteilen, wenn die Liste frisch da ist – sonst blitzt der Hinweis bei
   * jedem Öffnen kurz auf.
   */
  const unerreichbar = Boolean(event.collectionId) && !verknuepft && geladen && !ladeFehler;

  const ersteller = useNamen([event.createdBy], myId);

  // Nur Sammlungen, in denen man ändern darf (der Server lehnte die anderen
  // mit 403 ab – ein Knopf, der sicher scheitert), dazu die gerade verknüpfte,
  // auch wenn sie nur zum Ansehen ist, damit die Auswahl stimmt. In Baum-
  // reihenfolge und mit Pfad, damit gleichnamige Unterordner unterscheidbar sind.
  const auswahl = useMemo(() => {
    const zeilen = ordnerZeilen(collections, { maxTiefe: Infinity })
      .filter((zeile) => zeile.wahlbar || zeile.collection.id === event.collectionId)
      .map((zeile) => zeile.collection);
    // Eine nur ansehbare Sammlung ohne änderbaren Nachfahren steht nicht in der
    // Baumliste; als verknüpfte gehört sie trotzdem hinein.
    if (verknuepft && !zeilen.some((eintrag) => eintrag.id === verknuepft.id)) {
      zeilen.push(verknuepft);
    }
    return zeilen;
  }, [collections, event.collectionId, verknuepft]);

  async function setzen(collectionId: string | null) {
    const vorher = event.collectionId;
    setBusy(true);
    try {
      onChanged(await api.calendar.linkCollection(event.id, collectionId));
      if (collectionId === null && vorher) {
        // Gelöst wird nichts als die Verknüpfung – das darf nicht überraschen.
        toast(
          'Verknüpfung gelöst. Wer schon Zugriff bekam, behält ihn – das lässt sich in Dateien unter „Teilen“ zurücknehmen.',
        );
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nicht verknüpft');
    } finally {
      setBusy(false);
    }
  }

  /** Wohin mit einem Fehler: ins Blatt, solange es offen ist, sonst als Hinweis. */
  function melden(neu: BlattMeldung) {
    if (blattOffen.current) setMeldung(neu);
    else toast(neu.text, 'error');
  }

  function abschliessen(ergebnis: ZugErgebnis, plan: TerminSammlungPlan, vorher: string | null) {
    const dateien = useFiles.getState();

    if (ergebnis.art === 'fertig') {
      dateien.upsert(ergebnis.sammlung);
      onChanged(ergebnis.termin);
      setRest(null);
      setMeldung(null);
      setBlatt(false);
      toast(
        `„${pfadText(useFiles.getState().collections, ergebnis.sammlung.id)}“ angelegt und verknüpft.`,
        'success',
      );
      if (ergebnis.nichtFreigegeben.length > 0) {
        // Der Abschnitt „Zugriff der Eingeladenen“ zeigt es danach dauerhaft.
        toast(
          `Verknüpft, aber nicht freigegeben für: ${ergebnis.nichtFreigegeben.map((person) => person.name).join(', ')}.`,
          'error',
        );
      }
      return;
    }

    if (ergebnis.art === 'nichtAngelegt') {
      const { fehler } = ergebnis;
      if (istUnklar(fehler)) {
        // Ein „es wurde nichts angelegt“ wäre hier geraten.
        melden({
          feld: 'allgemein',
          text: 'Der Server antwortet nicht. Ob die Sammlung angelegt wurde, ist unklar – sieh in Dateien nach, bevor du es noch einmal versuchst.',
        });
      } else if (fehler instanceof ApiError && fehler.isOffline) {
        melden({
          feld: 'allgemein',
          text: 'Keine Verbindung zum Server – es wurde nichts angelegt.',
        });
      } else if (fehler instanceof ApiError && fehler.status === 400 && plan.parentId) {
        // Die Rechnung des Clients war eine Untergrenze (ein Elternordner war
        // unsichtbar). Der Server kennt die wahre Tiefe; der Ordner gilt für
        // diese Sitzung als zu tief.
        const gemerkt = plan.parentId;
        setZuTief((bisher) => new Set(bisher).add(gemerkt));
        melden({ feld: 'ordner', text: fehler.message, ordnerZurueck: true });
      } else if (fehler instanceof ApiError && (fehler.status === 403 || fehler.status === 404)) {
        // Das Recht am Ordner ist weg, oder der Ordner selbst: Liste auffrischen.
        void dateien.load();
        melden({ feld: 'ordner', text: fehler.message, ordnerZurueck: true });
      } else {
        melden({
          feld: 'allgemein',
          text: fehler instanceof Error ? fehler.message : 'Anlegen fehlgeschlagen',
        });
      }
      return;
    }

    // nichtVerknuepft: Die Sammlung gibt es auf dem Server.
    const { sammlung } = ergebnis;
    if (!ergebnis.aufgeraeumt) dateien.upsert(sammlung);

    if (ergebnis.endgueltig) {
      const grund = ohnePunkt(ergebnis.fehler, 'Der Server hat es abgelehnt');
      melden({
        feld: 'allgemein',
        text: `Das Verknüpfen hat nicht geklappt: ${grund}. ${
          ergebnis.aufgeraeumt
            ? 'Die neue Sammlung wurde wieder entfernt.'
            : `Die Sammlung „${sammlung.name}“ liegt noch in Dateien und lässt sich dort löschen.`
        }`,
      });
      return;
    }

    // Keine Antwort: nichts räumen, der Server hat vielleicht doch verknüpft.
    // Auch wenn das Blatt inzwischen zu ist, muss es wieder auf – die
    // Entscheidung gehört dem Anwender, und sie ist nur dort zu treffen.
    setMeldung(null);
    setRest({ sammlung, plan, vorher });
    setBlatt(true);
  }

  async function starten(plan: TerminSammlungPlan, vorhandene?: Rest) {
    if (laeuftJetzt.current) return;
    laeuftJetzt.current = true;
    setLaeuft(true);
    setMeldung(null);
    const vorher = vorhandene ? vorhandene.vorher : event.collectionId;
    try {
      const ergebnis = vorhandene
        ? await nochmalVerknuepfen(plan, vorhandene.sammlung, dienste, setStand)
        : await sammlungAnlegenUndVerknuepfen(plan, dienste, setStand);
      abschliessen(ergebnis, plan, vorher);
    } finally {
      laeuftJetzt.current = false;
      setLaeuft(false);
      setStand(null);
    }
  }

  /**
   * „Verwerfen“: die angelegte, aber nicht verknüpfte Sammlung wieder entfernen.
   *
   * Hat der Server das Verknüpfen doch angenommen, zeigte der Termin danach
   * auf eine gelöschte Sammlung. Deshalb wird danach nachgesehen und
   * gegebenenfalls zurückgesetzt auf das, woran er vorher hing.
   */
  async function verwerfenRest(angelegt: Rest) {
    if (laeuftJetzt.current) return;
    laeuftJetzt.current = true;
    setLaeuft(true);
    try {
      if (await verwerfen(angelegt.sammlung, dienste)) {
        useFiles.getState().forget(angelegt.sammlung.id);
        setRest(null);
        try {
          const jetzt = await api.calendar.byId(event.id);
          onChanged(
            jetzt.collectionId === angelegt.sammlung.id
              ? await api.calendar.linkCollection(event.id, angelegt.vorher)
              : jetzt,
          );
        } catch {
          // Der Abgleich ist eine Zugabe – die Sammlung ist weg, das war gewollt.
        }
        toast(`„${angelegt.sammlung.name}“ wurde verworfen.`);
      } else {
        setRest(null);
        toast(
          `Die Sammlung „${angelegt.sammlung.name}“ liegt noch in Dateien und lässt sich dort löschen.`,
          'error',
        );
      }
    } finally {
      laeuftJetzt.current = false;
      setLaeuft(false);
    }
  }

  function blattSchliessen() {
    // Schliessen mitten im Zug lässt ihn weiterlaufen; sein Ergebnis kommt als Hinweis.
    setBlatt(false);
    setMeldung(null);
    // Mit einer angelegten, nicht verknüpften Sammlung gilt Schliessen als
    // „Verwerfen“ – sonst bliebe ein Rest unter dem Namen des Termins liegen.
    if (rest) void verwerfenRest(rest);
  }

  // Ohne Verknüpfung und ohne Recht gibt es nichts zu zeigen – eine leere
  // Karte wäre nur Rauschen.
  if (!canManage && !event.collectionId) return null;

  const pfad = event.collectionId && verknuepft ? pfadText(collections, verknuepft.id) : null;
  const vollerPfad =
    event.collectionId && verknuepft ? pfadText(collections, verknuepft.id, { max: 99 }) : null;

  return (
    <section className="card stack" aria-labelledby="cal-coll-title">
      <h2 id="cal-coll-title" className="cal-block-title">
        Sammlung
      </h2>

      {/*
          `Link`, kein rohes `href`: Ein echter Seitenaufruf lädt die ganze
          PWA neu – Zustand fort, Verlauf fort, und auf einem Telefon dauert
          es sichtbar. Jede andere Stelle im Modul macht es längst so.

          Zu sehen ist der Pfad (`Familie › Wochenende`), damit ein
          Unterordner nicht wie eine oberste Sammlung aussieht.
      */}
      {event.collectionId && !unerreichbar && (
        <Link
          className="btn btn-block"
          to={`/dateien/${event.collectionId}`}
          data-tipp={
            vollerPfad
              ? `Öffnet „${vollerPfad}“ mit allen Dateien und Bildern, die zu diesem Termin gehören`
              : 'Öffnet den Ordner mit allen Dateien und Bildern, die zu diesem Termin gehören'
          }
        >
          <span aria-hidden="true">📁</span>
          <span className="truncate">{pfad ?? 'Zur Sammlung'}</span>
        </Link>
      )}

      {unerreichbar && (
        <div className="stack">
          <p className="cal-hint" role="status">
            Zu diesem Termin gehört eine Sammlung, die dir nicht freigegeben ist.{' '}
            {canManage
              ? ''
              : `Frag ${ersteller(event.createdBy)}, ob die Sammlung für dich freigegeben wird.`}
          </p>
          {canManage && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void setzen(null)}
            >
              Verknüpfung lösen
            </button>
          )}
        </div>
      )}

      {ladeFehler && (
        <p className="cal-hint">
          Die Sammlungen konnten nicht geladen werden.{' '}
          <button type="button" className="btn btn-sm" onClick={() => setLadeVersuch((n) => n + 1)}>
            Erneut versuchen
          </button>
        </p>
      )}

      {canManage && verknuepft && (
        <SammlungZugriff event={event} sammlung={verknuepft} collections={collections} />
      )}

      {canManage && (
        <>
          <div className="field">
            <label htmlFor="cal-coll-select">Bestehende Sammlung verknüpfen</label>
            <select
              id="cal-coll-select"
              className="select"
              value={event.collectionId ?? ''}
              disabled={busy || laeuft}
              onChange={(änderung) => void setzen(änderung.target.value || null)}
            >
              <option value="">Keine</option>
              {auswahl.map((eintrag) => (
                <option key={eintrag.id} value={eintrag.id}>
                  {pfadText(collections, eintrag.id)}
                </option>
              ))}
              {/* Eine Verknüpfung, die man nicht sieht, bleibt in der Auswahl
                  stehen – sonst zeigte das Feld „Keine“, wo etwas verknüpft ist. */}
              {event.collectionId && !verknuepft && (
                <option value={event.collectionId}>Nicht freigegebene Sammlung</option>
              )}
            </select>
            <p className="cal-hint">
              Verknüpfen vergibt keine Rechte: Wer in die Sammlung darf, bleibt, wie es ist.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-block"
            disabled={laeuft}
            onClick={() => {
              setMeldung(null);
              setBlatt(true);
            }}
          >
            ＋ Neue Sammlung anlegen …
          </button>

          <TerminSammlungSheet
            open={blatt}
            onClose={blattSchliessen}
            event={event}
            collections={collections}
            verknuepft={verknuepft}
            laeuft={laeuft}
            knopfText={knopfText(stand)}
            meldung={meldung}
            rest={rest?.sammlung ?? null}
            gesperrt={zuTief}
            onAnlegen={(plan) => void starten(plan)}
            onErneut={() => rest && void starten(rest.plan, rest)}
            onVerwerfen={() => rest && void verwerfenRest(rest)}
          />
        </>
      )}
    </section>
  );
}
