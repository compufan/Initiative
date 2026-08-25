import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EXPENSE_VISIBILITIES,
  formatCents,
  parseAmount,
  splitEvenly,
  type ConversationDto,
  type ExpenseDto,
  type ExpenseVisibility,
  type UserDto,
} from '@initiative/shared';
import { PersonenWahl } from '../../components/PersonenWahl.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';

/**
 * Die drei Sichtbarkeiten in Worten.
 *
 * Bewusst „zusätzlich“ und nicht „nur“: Der Server gibt jedem mit Anteil
 * immer Einsicht (services/expenses.rs, may_see). Wer hier „nur ausgewählte“
 * schriebe, verspräche mehr, als die App halten kann.
 */
const SICHT_TEXT: Record<ExpenseVisibility, string> = {
  participants: 'Nur wer mitzahlt',
  conversation: 'Alle im Chat',
  listed: 'Ausgewählte Personen zusätzlich',
};

interface ExpenseSheetProps {
  open: boolean;
  onClose: () => void;
  conversationId?: string | null;
  eventId?: string | null;
  onSaved?: (expense: ExpenseDto) => void;
}

/**
 * Eine Ausgabe eintragen.
 *
 * Zwei Dinge sind hier wichtig und deshalb sichtbar:
 *
 * Die Aufteilung wird **vorgerechnet**, bevor gespeichert wird – 10 Euro auf
 * drei sind 3,34 + 3,33 + 3,33, und das soll man sehen, statt sich hinterher
 * über einen krummen Saldo zu wundern.
 *
 * „Vor jemandem verbergen“ steht nur für Leute zur Wahl, die **nicht**
 * mitzahlen. Sonst schuldete jemand Geld, das in seinem eigenen Saldo nicht
 * auftaucht – der Server lehnt das ab, und die App bietet es erst gar nicht an.
 */
export function ExpenseSheet({
  open,
  onClose,
  conversationId,
  eventId,
  onSaved,
}: ExpenseSheetProps) {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);

  const [chatId, setChatId] = useState(conversationId ?? '');
  const [title, setTitle] = useState('');
  const [betrag, setBetrag] = useState('');
  const [paidBy, setPaidBy] = useState(myId);
  const [beteiligte, setBeteiligte] = useState<string[]>([]);
  const [verborgen, setVerborgen] = useState<string[]>([]);
  const [sichtbarkeit, setSichtbarkeit] = useState<ExpenseVisibility>('participants');
  const [zuschauer, setZuschauer] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [leute, setLeute] = useState<UserDto[]>([]);

  const chat = conversations.find((eintrag) => eintrag.id === chatId) ?? null;

  // Nur beim Aufgehen zuruecksetzen, nicht bei jeder Aenderung der
  // Abhaengigkeiten. `conversations` bekommt bei jeder Chat-Aktualisierung
  // eine neue Kennung – mit ihr im Abhaengigkeitsfeld leerte sich das
  // Formular waehrend des Tippens.
  const warOffen = useRef(false);
  useEffect(() => {
    if (!open) {
      warOffen.current = false;
      return;
    }
    if (warOffen.current) return;
    warOffen.current = true;
    setChatId(conversationId ?? conversations[0]?.id ?? '');
    setTitle('');
    setBetrag('');
    setPaidBy(myId);
    setVerborgen([]);
    setSichtbarkeit('participants');
    setZuschauer([]);
    setNote('');
  }, [open, conversationId, conversations, myId]);

  // Wer im gewählten Chat ist. Ohne die Namen wäre die Liste eine Reihe
  // Kennungen, mit denen niemand etwas anfangen kann.
  useEffect(() => {
    if (!chat) {
      setLeute([]);
      setBeteiligte([]);
      return;
    }
    const ids = chat.members.map((member) => member.userId);
    setBeteiligte(ids);
    let abgebrochen = false;
    void Promise.all(ids.map((id) => api.users.byId(id).catch(() => null)))
      .then((ergebnis) => {
        if (!abgebrochen)
          setLeute(ergebnis.filter((eintrag): eintrag is UserDto => Boolean(eintrag)));
      })
      .catch(() => {});
    return () => {
      abgebrochen = true;
    };
  }, [chat]);

  const cents = parseAmount(betrag);
  const vorschau = useMemo(() => {
    if (cents == null || beteiligte.length === 0) return [];
    return splitEvenly(cents, beteiligte.length);
  }, [cents, beteiligte.length]);

  const name = (id: string) =>
    id === myId ? 'Du' : (leute.find((person) => person.id === id)?.displayName ?? 'Unbekannt');

  async function speichern() {
    const sauber = title.trim();
    if (!sauber) {
      toast('Die Ausgabe braucht einen Namen.');
      return;
    }
    if (cents == null || cents <= 0) {
      toast('Trag einen Betrag ein, zum Beispiel 12,50.');
      return;
    }
    if (beteiligte.length === 0) {
      toast('Wähle mindestens eine Person, die mitzahlt.');
      return;
    }
    setBusy(true);
    try {
      const expense = await api.expenses.create({
        conversationId: chatId || undefined,
        eventId: eventId ?? undefined,
        title: sauber,
        note: note.trim() || undefined,
        amountCents: cents,
        paidBy,
        shares: beteiligte.map((userId) => ({ userId })),
        hiddenFromIds: verborgen.length > 0 ? verborgen : undefined,
        visibility: sichtbarkeit,
        viewerIds: sichtbarkeit === 'listed' && zuschauer.length > 0 ? zuschauer : undefined,
      });
      onSaved?.(expense);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  // Verbergen geht nur bei Leuten ohne Anteil.
  const verbergbar = leute.filter((person) => !beteiligte.includes(person.id));

  // Wer nachträglich mitzahlt, kann nicht mehr verborgen bleiben. Der Server
  // lehnt das ab – mit einer klaren Meldung, aber erst beim Speichern, und
  // dann ist das Blatt schon ausgefüllt. Also hier gleich aufräumen.
  useEffect(() => {
    setVerborgen((liste) => {
      const uebrig = liste.filter((id) => !beteiligte.includes(id));
      // Gleiche Liste zurückgeben, wenn nichts wegfällt: sonst rechnet React
      // bei jeder Änderung an den Beteiligten eine Runde umsonst.
      return uebrig.length === liste.length ? liste : uebrig;
    });
  }, [beteiligte]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ausgabe eintragen"
      actions={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void speichern()}
        >
          {busy ? 'Speichert …' : 'Speichern'}
        </button>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="exp-title">Wofür?</label>
          <input
            id="exp-title"
            className="input"
            value={title}
            maxLength={160}
            placeholder="Kohle und Fleisch"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="exp-amount">Betrag</label>
          <input
            id="exp-amount"
            className="input"
            // `inputMode` statt `type="number"`: das Zahlenfeld erlaubt auf
            // manchen Geräten kein Komma, und dann tippt man 12,50 und
            // bekommt gar nichts.
            inputMode="decimal"
            value={betrag}
            placeholder="45,00"
            onChange={(event) => setBetrag(event.target.value)}
          />
          {betrag.trim() !== '' && cents == null && (
            <span className="exp-warn">Das ist kein Betrag. Zum Beispiel: 12,50</span>
          )}
        </div>

        {!conversationId && (
          <div className="field">
            <label htmlFor="exp-chat">Für welchen Chat?</label>
            <select
              id="exp-chat"
              className="select"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
            >
              <option value="">Nur für mich</option>
              {conversations.map((eintrag) => (
                <option key={eintrag.id} value={eintrag.id}>
                  {chatName(eintrag)}
                </option>
              ))}
            </select>
          </div>
        )}

        {leute.length > 0 && (
          <div className="field">
            <label htmlFor="exp-payer">Wer hat ausgelegt?</label>
            <select
              id="exp-payer"
              className="select"
              value={paidBy}
              onChange={(event) => setPaidBy(event.target.value)}
            >
              {leute.map((person) => (
                <option key={person.id} value={person.id}>
                  {name(person.id)}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="field">
          <legend>Wer zahlt mit?</legend>
          {leute.length === 0 ? (
            <p className="exp-hint">Wähle oben einen Chat.</p>
          ) : (
            <PersonenWahl
              label="Wer zahlt mit?"
              vorschlaege={leute.map((person) => ({
                id: person.id,
                displayName: name(person.id),
              }))}
              gewaehlt={beteiligte}
              onChange={setBeteiligte}
              // Auch jemand ausserhalb des Chats darf mitzahlen. Das geht
              // wirklich und nicht nur an der Oberfläche: Wer einen Anteil
              // hat, sieht die Ausgabe in seiner Liste, ganz unabhängig
              // davon, ob er im Chat ist (services/expenses.rs, may_see).
              zusatz={(id) => {
                const index = beteiligte.indexOf(id);
                if (index < 0 || vorschau[index] == null) return null;
                return <span className="exp-share">{formatCents(vorschau[index])}</span>;
              }}
            />
          )}
          {vorschau.length > 0 && (
            <p className="exp-hint">
              {/* Vorrechnen statt hinterher erklaeren: 10 Euro auf drei sind
                  3,34 + 3,33 + 3,33 – kein Cent geht verloren. */}
              Aufgeteilt: {vorschau.map((wert) => formatCents(wert)).join(' + ')} ={' '}
              {formatCents(vorschau.reduce((summe, wert) => summe + wert, 0))}
            </p>
          )}
        </fieldset>

        {/* Bisher entstand jede Ausgabe stillschweigend als 'participants' –
            die Sichtbarkeit war in Schema und Server da, aber ueber die App
            nicht erreichbar. */}
        <fieldset className="field">
          <legend>Wer darf sie sehen?</legend>
          {EXPENSE_VISIBILITIES.map((wert) => (
            <label key={wert} className="exp-check">
              <input
                type="radio"
                name="exp-sichtbarkeit"
                checked={sichtbarkeit === wert}
                onChange={() => setSichtbarkeit(wert)}
              />
              <span>{SICHT_TEXT[wert]}</span>
            </label>
          ))}
          <p className="exp-hint">
            Wer mitzahlt, sieht die Ausgabe immer – das lässt sich hier nicht wegnehmen, sonst
            stimmte sein Saldo nicht mehr. Die Wahl entscheidet nur, wer sie <em>zusätzlich</em>{' '}
            sieht.
          </p>
        </fieldset>

        {sichtbarkeit === 'listed' && (
          <fieldset className="field">
            <legend>Diese Personen zusätzlich</legend>
            <PersonenWahl
              label="Wer die Ausgabe zusätzlich sehen darf"
              vorschlaege={leute.map((person) => ({
                id: person.id,
                displayName: name(person.id),
              }))}
              gewaehlt={zuschauer}
              onChange={setZuschauer}
            />
          </fieldset>
        )}

        {verbergbar.length > 0 && (
          <fieldset className="field">
            <legend>Verbergen vor …</legend>
            <p className="exp-hint">
              Für Geschenke: Diese Personen sehen die Ausgabe nicht. Zur Wahl stehen nur Leute, die
              nicht mitzahlen – sonst würde ihr Saldo nicht mehr stimmen.
            </p>
            <PersonenWahl
              label="Verbergen vor"
              vorschlaege={verbergbar.map((person) => ({
                id: person.id,
                displayName: name(person.id),
              }))}
              gewaehlt={verborgen}
              onChange={setVerborgen}
              // Hier ohne Suche: Jemanden zu verbergen, der die Ausgabe
              // ohnehin nie zu sehen bekäme, ist keine Einstellung, sondern
              // eine Falle.
              suchbar={false}
            />
          </fieldset>
        )}

        <div className="field">
          <label htmlFor="exp-note">Notiz (freiwillig)</label>
          <textarea
            id="exp-note"
            className="textarea"
            rows={2}
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>
    </Sheet>
  );
}

function chatName(chat: ConversationDto): string {
  return chat.title ?? (chat.type === 'group' ? 'Gruppe' : 'Chat');
}
