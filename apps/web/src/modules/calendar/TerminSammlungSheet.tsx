import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LIMITS, type CalendarEventDto, type CollectionDto } from '@initiative/shared';
import { PersonenWahl, type Person } from '../../components/PersonenWahl.js';
import { Sheet } from '../../components/Sheet.js';
import { useChat } from '../../state/chat.js';
import { useNamen } from '../../state/leute.js';
import { useMyId } from '../../state/session.js';
import { OrdnerWahl } from '../files/OrdnerWahl.js';
import { gleichnamigUnter, ordnerZeilen } from '../files/ordner.js';
import { pfadZu } from '../files/state.js';
import { conversationTitle } from '../messenger/helpers.js';
import { useSammlungKette } from './useSammlungKette.js';
import {
  erbtVon,
  standardName,
  stufeKurz,
  ZUGRIFF_TEXT,
  zusammenfassung,
  type TerminSammlungPlan,
  type TerminStufe,
} from './terminSammlung.js';

/** Was der Zug dem Blatt zu sagen hat – ein frisches Objekt je Meldung. */
export interface BlattMeldung {
  feld: 'ordner' | 'allgemein';
  text: string;
  /** Der gewählte Ordner taugt nicht (mehr): zurück auf die oberste Ebene. */
  ordnerZurueck?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  event: CalendarEventDto;
  /** Die Sammlungen, die man sieht – aus dem Dateien-Speicher. */
  collections: CollectionDto[];
  /** Woran der Termin gerade hängt, damit das Ersetzen nicht überrascht. */
  verknuepft: CollectionDto | null;
  /** Der Zug läuft – das Blatt hält still. */
  laeuft: boolean;
  /** Was am Knopf steht, solange er läuft („Gibt frei … 3 von 8“). */
  knopfText: string | null;
  meldung: BlattMeldung | null;
  /** Angelegt, aber noch nicht mit dem Termin verknüpft. */
  rest: CollectionDto | null;
  /** Ordner, die der Server schon als zu tief abgelehnt hat. */
  gesperrt: ReadonlySet<string>;
  onAnlegen: (plan: TerminSammlungPlan) => void;
  onErneut: () => void;
  onVerwerfen: () => void;
}

/**
 * Das Blatt „Neue Sammlung zum Termin“.
 *
 * Es sammelt nur die Angaben – Name, Ordner, wer hineindarf – und reicht den
 * Plan an `EventCollection` weiter. Der Zug selbst (anlegen, verknüpfen,
 * freigeben) läuft dort: Schliesst jemand das Blatt mitten darin, soll er
 * nicht abbrechen und eine halb angelegte Sammlung hinterlassen.
 */
export function TerminSammlungSheet({
  open,
  onClose,
  event,
  collections,
  verknuepft,
  laeuft,
  knopfText,
  meldung,
  rest,
  gesperrt,
  onAnlegen,
  onErneut,
  onVerwerfen,
}: Props) {
  const myId = useMyId();
  const formId = useId();
  const nameFeld = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [nameFehler, setNameFehler] = useState<string | null>(null);
  const [ordner, setOrdner] = useState<string | null>(null);
  const [stufe, setStufe] = useState<TerminStufe>('edit');
  const [gewaehlt, setGewaehlt] = useState<string[]>([]);

  // Alle ausser mir – ich lege an und bin ohnehin Besitzer.
  const eingeladene = useMemo(
    () =>
      event.attendees.map((teilnehmer) => teilnehmer.userId).filter((userId) => userId !== myId),
    [event.attendees, myId],
  );
  const eingeladeneText = eingeladene.join(',');
  const namen = useNamen(eingeladene, myId);

  /*
   * Beim Öffnen frisch – nicht nur beim ersten Einhängen.
   *
   * Das Blatt bleibt dauerhaft eingehängt und wird über `open` eingeblendet;
   * ein `useState(standardName(...))` läse den Titel genau einmal. Wer eine
   * Sammlung anlegte und gleich die nächste wollte, fände sonst Namen und
   * Haken der vorigen vor. Vorangehakt sind alle Eingeladenen: Zweck einer
   * Termin-Sammlung ist, dass jeder etwas hineinlegen kann.
   */
  useEffect(() => {
    if (!open) return;
    setName(standardName(event.title));
    setNameFehler(null);
    setOrdner(null);
    setStufe('edit');
    setGewaehlt(eingeladeneText ? eingeladeneText.split(',') : []);
    // Absichtlich nicht von Titel und Eingeladenen abhängig: Ändert sich der
    // Termin bei offenem Blatt (Rundruf), sollen die Eingaben stehen bleiben.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Der Server hat den Ordner abgelehnt: zurück auf die oberste Ebene.
  useEffect(() => {
    if (meldung?.ordnerZurueck) setOrdner(null);
  }, [meldung]);

  // Ein Ordner, der nicht mehr wählbar ist (zu tief, Recht entzogen), gilt
  // nicht – sonst ginge der Plan mit einem Ziel los, das die Liste nicht mehr zeigt.
  const wahlbar = useMemo(
    () =>
      new Set(
        ordnerZeilen(collections, { zuTiefIds: gesperrt })
          .filter((zeile) => zeile.wahlbar)
          .map((zeile) => zeile.collection.id),
      ),
    [collections, gesperrt],
  );
  const ordnerId = ordner && wahlbar.has(ordner) ? ordner : null;

  const vorschlaege: Person[] = eingeladene.map((id) => ({ id, displayName: namen(id) }));

  const gleichnamig = gleichnamigUnter(collections, ordnerId, name);
  const anzahlZeichen = Array.from(name).length;
  const dabei = gewaehlt.filter((id) => eingeladene.includes(id));

  function abschicken(ereignis: React.FormEvent) {
    ereignis.preventDefault();
    // Der Wächter gegen den Doppeltipp sitzt im Zug selbst (`laeuft` als
    // Referenz); hier genügt es, nicht noch einmal anzustossen.
    if (laeuft) return;
    const sauber = name.trim();
    if (!sauber) {
      setNameFehler('Die Sammlung braucht einen Namen.');
      nameFeld.current?.focus();
      return;
    }
    onAnlegen({
      terminId: event.id,
      name: sauber,
      parentId: ordnerId,
      stufe,
      personen: dabei.map((id) => ({ id, name: namen(id) })),
    });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Neue Sammlung"
      actions={
        rest ? undefined : (
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={laeuft}
            aria-busy={laeuft}
          >
            {laeuft ? (knopfText ?? 'Legt an …') : 'Anlegen und verknüpfen'}
          </button>
        )
      }
    >
      <form id={formId} className="stack" onSubmit={abschicken} noValidate>
        {rest && (
          <div className="fil-meldung" role="alert">
            <p>
              „{rest.name}“ ist angelegt, aber noch nicht mit dem Termin verknüpft. Die Verbindung
              zum Server ist abgerissen – vielleicht ist es doch angekommen.
            </p>
            <div className="fil-meldung-knoepfe">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={laeuft}
                onClick={onErneut}
              >
                {laeuft ? (knopfText ?? 'Verknüpft …') : 'Erneut verknüpfen'}
              </button>
              <button type="button" className="btn btn-sm" disabled={laeuft} onClick={onVerwerfen}>
                Verwerfen
              </button>
            </div>
          </div>
        )}

        {meldung?.feld === 'allgemein' && (
          <p className="cal-error" role="alert">
            {meldung.text}
          </p>
        )}

        <fieldset className="fil-sperre" disabled={laeuft || Boolean(rest)}>
          {verknuepft && (
            <p className="cal-hint">
              Die Verknüpfung mit „{verknuepft.name}“ wird ersetzt. Die Sammlung selbst bleibt.
            </p>
          )}

          <div className="field">
            <label htmlFor={`${formId}-name`}>Name</label>
            <input
              id={`${formId}-name`}
              ref={nameFeld}
              className="input"
              type="text"
              value={name}
              maxLength={LIMITS.collectionNameMax}
              aria-invalid={nameFehler ? true : undefined}
              aria-describedby={nameFehler ? `${formId}-name-fehler` : undefined}
              onChange={(eingabe) => {
                setName(eingabe.target.value);
                setNameFehler(null);
              }}
            />
            {nameFehler && (
              <p id={`${formId}-name-fehler`} className="cal-error" role="alert">
                {nameFehler}
              </p>
            )}
            {anzahlZeichen >= 100 && (
              <p className="cal-hint">
                {anzahlZeichen} von {LIMITS.collectionNameMax} Zeichen
              </p>
            )}
            {gleichnamig && (
              <p className="cal-hint">
                {ordnerId ? 'Dort' : 'Auf der obersten Ebene'} gibt es schon „{gleichnamig.name}“ –
                lieber die verknüpfen?
              </p>
            )}
          </div>

          <div className="fil-gruppe">
            <span className="fil-gruppe-titel">Wo soll sie liegen?</span>
            <OrdnerWahl
              collections={collections}
              wert={ordnerId}
              onChange={setOrdner}
              label="Wo soll sie liegen?"
              gesperrt={gesperrt}
            />
            {meldung?.feld === 'ordner' && (
              <p className="cal-error" role="alert">
                {meldung.text}
              </p>
            )}
            {ordnerId && <GeerbterZugriff collections={collections} ordnerId={ordnerId} />}
          </div>

          <fieldset className="fil-gruppe">
            <legend className="fil-gruppe-titel">Wer bekommt Zugriff?</legend>
            <p className="cal-hint">Du bist Besitzer. Die Eingeladenen dürfen:</p>
            {(['edit', 'view'] as const).map((wert) => (
              <label key={wert} className="fil-radio">
                <input
                  type="radio"
                  name={`${formId}-stufe`}
                  checked={stufe === wert}
                  onChange={() => setStufe(wert)}
                />
                <span>{ZUGRIFF_TEXT[wert]}</span>
              </label>
            ))}
            <p className="cal-hint">
              Ändern heisst: Dateien hinzufügen, umbenennen, verschieben und entfernen.
            </p>
          </fieldset>

          {eingeladene.length > 0 && (
            <PersonenWahl
              label="Wer hinein darf"
              vorschlaege={vorschlaege}
              gewaehlt={gewaehlt}
              onChange={setGewaehlt}
              suchbar={false}
              zusatz={(id) =>
                event.attendees.find((teilnehmer) => teilnehmer.userId === id)?.status === 'no' ? (
                  <span className="fil-badge">hat abgesagt</span>
                ) : null
              }
            />
          )}
          <p className="cal-hint" aria-live="polite">
            {zusammenfassung({
              eingeladene: eingeladene.length,
              gewaehlt: dabei.map((id) => ({ id, name: namen(id) })),
              stufe,
            })}
          </p>
          {eingeladene.length > 0 && (
            <p className="cal-hint">
              Wer später eingeladen wird, bekommt den Zugriff nicht von allein – im Abschnitt
              „Sammlung“ lässt sich das nachholen.
            </p>
          )}
        </fieldset>
      </form>
    </Sheet>
  );
}

/**
 * Wer an dem gewählten Ordner schon Zugriff hat – und ihn damit auch an der
 * neuen Sammlung bekommt.
 *
 * Ein Unterordner erbt, was am Elternordner vergeben ist. Ohne diese Zeile
 * wäre „Unterordner“ eine stille Rechteausweitung: Man dächte, nur die
 * Eingeladenen kämen hinein, und die Familiengruppe sähe mit.
 */
function GeerbterZugriff({
  collections,
  ordnerId,
}: {
  collections: CollectionDto[];
  ordnerId: string;
}) {
  const myId = useMyId();
  const chats = useChat((state) => state.conversations);
  const pfad = pfadZu(collections, ordnerId);
  const kette = useSammlungKette(collections, ordnerId);

  const erbe = useMemo(
    () =>
      kette
        ? erbtVon(kette).filter((eintrag) => !(eintrag.art === 'person' && eintrag.userId === myId))
        : null,
    [kette, myId],
  );
  const namen = useNamen(
    (erbe ?? []).flatMap((eintrag) => (eintrag.art === 'person' ? [eintrag.userId] : [])),
    myId,
  );

  const ordner = pfad[pfad.length - 1];
  const wer = (erbe ?? []).map((eintrag) => {
    if (eintrag.art === 'person') return `${namen(eintrag.userId)} (${stufeKurz(eintrag.stufe)})`;
    const chat = chats.find((kandidat) => kandidat.id === eintrag.conversationId);
    return `alle in „${chat ? conversationTitle(chat, myId) : 'einem Chat'}“ (${stufeKurz(eintrag.stufe)})`;
  });
  // Ist der oberste sichtbare Ordner selbst ein Kind, gibt es Rechte, die man
  // nicht sehen kann – und das soll da stehen, statt es zu verschweigen.
  const verdeckt = pfad[0]?.parentId != null;

  return (
    <div className="stack" data-testid="geerbter-zugriff">
      {erbe === null ? (
        <p className="cal-hint">Zugriff im Ordner wird geprüft …</p>
      ) : (
        wer.length > 0 && (
          <p className="cal-hint">
            Wer im Ordner „{ordner?.name}“ schon Zugriff hat, bekommt ihn auch hier:{' '}
            {wer.join(', ')}.
          </p>
        )
      )}
      {verdeckt && (
        <p className="cal-hint">
          Weitere Personen können über Ordner Zugriff haben, die du selbst nicht siehst.
        </p>
      )}
    </div>
  );
}
