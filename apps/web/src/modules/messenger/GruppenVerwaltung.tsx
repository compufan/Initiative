/**
 * Gruppenverwaltung und Persönliches je Chat – die Abschnitte der Chat-Info.
 *
 * Jeder Abschnitt schreibt über `verwaltung` (eigene API-Datei) und legt die
 * Antwort des Servers in den Speicher; die anderen Geräte und Mitglieder
 * bekommen ihre Fassung per Rundruf. Was jemand darf, zeigt `gruppenRechte.ts`
 * an – entschieden wird im Server.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import {
  BESCHREIBUNG_MAX,
  HINTERGRUENDE,
  LANGSAM_STUFEN,
  LIMITS,
  MELDE_GRUENDE,
  type BeitrittsanfrageDto,
  type ConversationDto,
  type ConversationMemberDto,
  type EinladungslinkDto,
  type Hintergrund,
  type MeldeGrund,
  type NotifyLevel,
} from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Sheet } from '../../components/Sheet.js';
import { prepareImage, uploadBlob } from '../../lib/upload.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import { Toggle } from '../profile/Toggle.js';
import { istStumm, STUMM_VORGABEN, stummBis, stummText } from './chatliste.js';
import { darfInfoAendern, langsamText, mitgliedAktionen } from './gruppenRechte.js';
import { memberName, roleLabel } from './helpers.js';

function fehlertext(fehler: unknown, ersatz: string): string {
  return fehler instanceof Error && fehler.message ? fehler.message : ersatz;
}

/** Ein PATCH auf den Chat, Antwort in den Speicher, Meldung an den Menschen. */
async function aendern(
  chat: ConversationDto,
  patch: Record<string, unknown>,
  erfolg: string | null,
  fehler: string,
): Promise<ConversationDto | null> {
  try {
    const neu = await verwaltung.gruppe.aendern(chat.id, patch);
    useChat.getState().upsertConversation(neu);
    if (erfolg) toast(erfolg, 'success');
    return neu;
  } catch (error) {
    toast(fehlertext(error, fehler), 'error');
    return null;
  }
}

/* ---------- Gruppeninfo: Name, Bild, Beschreibung ---------- */

export function GruppenInfo({ chat, myId }: { chat: ConversationDto; myId: string }) {
  const darf = darfInfoAendern(chat, myId);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [titel, setTitel] = useState(chat.title ?? '');
  const [beschreibung, setBeschreibung] = useState(chat.description ?? '');
  const [busy, setBusy] = useState(false);
  const datei = useRef<HTMLInputElement>(null);
  const titelId = useId();
  const textId = useId();

  useEffect(() => {
    if (!bearbeiten) {
      setTitel(chat.title ?? '');
      setBeschreibung(chat.description ?? '');
    }
  }, [chat.title, chat.description, bearbeiten]);

  async function speichern() {
    const patch: Record<string, unknown> = {};
    if (titel.trim() && titel.trim() !== chat.title) patch.title = titel.trim();
    if (beschreibung.trim() !== (chat.description ?? '')) {
      patch.description = beschreibung.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      setBearbeiten(false);
      return;
    }
    setBusy(true);
    const neu = await aendern(chat, patch, 'Gruppeninfo gespeichert', 'Speichern fehlgeschlagen');
    setBusy(false);
    if (neu) setBearbeiten(false);
  }

  async function bildGewaehlt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      toast('Bitte wähle ein Bild aus', 'error');
      return;
    }
    setBusy(true);
    try {
      // Derselbe Weg wie beim Profilbild: verkleinern, hochladen, als eigene
      // Datei verknüpfen (der Server prüft, dass sie mir gehört).
      const bild = await prepareImage(file, 640);
      const anhang = await uploadBlob({
        kind: 'image',
        mime: bild.mime,
        fileName: file.name || 'gruppenbild',
        blob: bild.blob,
        width: bild.width,
        height: bild.height,
        previewDataUrl: bild.previewDataUrl,
      });
      await aendern(
        chat,
        { avatarAttachmentId: anhang.id },
        'Gruppenbild geändert',
        'Bild fehlgeschlagen',
      );
    } catch (error) {
      toast(fehlertext(error, 'Bild konnte nicht hochgeladen werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (bearbeiten) {
    return (
      <form
        className="stack"
        aria-label="Gruppeninfo bearbeiten"
        onSubmit={(event) => {
          event.preventDefault();
          void speichern();
        }}
      >
        <div className="field">
          <label htmlFor={titelId}>Gruppenname</label>
          <input
            id={titelId}
            className="input"
            value={titel}
            maxLength={LIMITS.conversationTitleMax}
            required
            autoFocus
            onChange={(event) => setTitel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={textId}>Beschreibung</label>
          <textarea
            id={textId}
            className="textarea"
            value={beschreibung}
            maxLength={BESCHREIBUNG_MAX}
            aria-describedby={`${textId}-zaehler`}
            placeholder="Worum geht es in dieser Gruppe?"
            onChange={(event) => setBeschreibung(event.target.value)}
          />
          <span id={`${textId}-zaehler`} className="faint" style={{ fontSize: '0.75rem' }}>
            {beschreibung.length} / {BESCHREIBUNG_MAX}
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn" onClick={() => setBearbeiten(false)}>
            Abbrechen
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={busy || !titel.trim()}
          >
            Speichern
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className="stack" aria-label="Gruppeninfo">
      {chat.description ? (
        <p className="gv-beschreibung">{chat.description}</p>
      ) : (
        darf && (
          <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            Noch keine Beschreibung.
          </p>
        )
      )}
      {darf && (
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => setBearbeiten(true)}>
            ✏️ Name und Beschreibung
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => datei.current?.click()}
          >
            🖼️ Gruppenbild ändern
          </button>
          {chat.avatarUrl && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void aendern(
                  chat,
                  { avatarAttachmentId: null },
                  'Gruppenbild entfernt',
                  'Entfernen fehlgeschlagen',
                )
              }
            >
              Bild entfernen
            </button>
          )}
          <input
            ref={datei}
            type="file"
            accept="image/*"
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void bildGewaehlt(event)}
          />
        </div>
      )}
    </section>
  );
}

/* ---------- Mitteilungen je Chat ---------- */

const STUFEN: { wert: NotifyLevel; label: string; hinweis?: string }[] = [
  { wert: 'alle', label: 'Alle' },
  {
    wert: 'erwaehnungen',
    label: 'Nur @Erwähnungen',
    hinweis: 'Erwähnungen folgen – bis dahin bleibt es in diesem Chat still.',
  },
  { wert: 'aus', label: 'Aus' },
];

export function ChatMitteilungen({ chat }: { chat: ConversationDto }) {
  const [busy, setBusy] = useState(false);
  const stumm = istStumm(chat);
  const gruppenName = useId();

  async function tun(patch: Record<string, unknown>, erfolg: string) {
    setBusy(true);
    await aendern(chat, patch, erfolg, 'Ändern fehlgeschlagen');
    setBusy(false);
  }

  const stufe = STUFEN.find((eintrag) => eintrag.wert === chat.notifyLevel);

  return (
    <section className="stack" aria-labelledby={`${gruppenName}-titel`}>
      <span id={`${gruppenName}-titel`} className="msg-info-label">
        Mitteilungen
      </span>
      <div className="msg-chip-row" role="group" aria-label="Stummschalten">
        {STUMM_VORGABEN.map((vorgabe) => (
          <button
            key={vorgabe.wert}
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void tun({ mutedUntil: stummBis(vorgabe.wert) }, 'Chat stummgeschaltet')}
          >
            {vorgabe.wert === 'immer' ? 'Immer' : vorgabe.label}
          </button>
        ))}
        <button
          type="button"
          className={`btn btn-sm ${stumm ? '' : 'btn-primary'}`}
          aria-pressed={!stumm}
          disabled={busy}
          onClick={() => void tun({ mutedUntil: null }, 'Mitteilungen wieder an')}
        >
          Nicht stumm
        </button>
      </div>
      {stumm && (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {stummText(chat)}
        </span>
      )}
      <div className="msg-chip-row" role="radiogroup" aria-label="Wann eine Mitteilung kommt">
        {STUFEN.map((eintrag) => (
          <button
            key={eintrag.wert}
            type="button"
            role="radio"
            aria-checked={chat.notifyLevel === eintrag.wert}
            className={`btn btn-sm ${chat.notifyLevel === eintrag.wert ? 'btn-primary' : ''}`}
            disabled={busy}
            onClick={() =>
              void tun({ notifyLevel: eintrag.wert }, `Mitteilungen: ${eintrag.label}`)
            }
          >
            {eintrag.label}
          </button>
        ))}
      </div>
      {stufe?.hinweis && (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {stufe.hinweis}
        </span>
      )}
      <Toggle
        label="Vorschau anzeigen"
        description="Text der Nachricht in der Mitteilung – nur, wenn er auch in den Einstellungen an ist."
        checked={chat.notifyPreview}
        busy={busy}
        onChange={(an) =>
          void tun(
            { notifyPreview: an },
            an ? 'Vorschau an' : 'Vorschau aus – nur „Neue Nachricht“',
          )
        }
      />
    </section>
  );
}

/* ---------- Hintergrund ---------- */

const HINTERGRUND_NAMEN: Record<Hintergrund, string> = {
  sand: 'Sand',
  salbei: 'Salbei',
  himmel: 'Himmel',
  flieder: 'Flieder',
  nacht: 'Nacht',
  punkte: 'Punkte',
  wellen: 'Wellen',
  karo: 'Karo',
};

export function HintergrundWahl({ chat }: { chat: ConversationDto }) {
  const [busy, setBusy] = useState(false);
  async function waehlen(wert: Hintergrund | null) {
    setBusy(true);
    await aendern(chat, { hintergrund: wert }, 'Hintergrund geändert', 'Ändern fehlgeschlagen');
    setBusy(false);
  }
  return (
    <section className="stack" aria-label="Hintergrund">
      <span className="msg-info-label">Hintergrund (nur bei dir)</span>
      <div className="gv-hintergruende" role="group" aria-label="Hintergrund wählen">
        <button
          type="button"
          className="gv-hintergrund"
          aria-pressed={chat.hintergrund == null}
          disabled={busy}
          onClick={() => void waehlen(null)}
        >
          Standard
        </button>
        {HINTERGRUENDE.map((wert) => (
          <button
            key={wert}
            type="button"
            className={`gv-hintergrund hg-${wert}`}
            aria-pressed={chat.hintergrund === wert}
            disabled={busy}
            onClick={() => void waehlen(wert)}
          >
            {HINTERGRUND_NAMEN[wert]}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---------- Gruppenschalter ---------- */

export function GruppenSchalter({ chat }: { chat: ConversationDto }) {
  const [busy, setBusy] = useState(false);
  const langsamId = useId();
  async function setzen(teil: Record<string, unknown>) {
    setBusy(true);
    await aendern(
      chat,
      { settings: teil },
      'Gruppeneinstellung gespeichert',
      'Ändern fehlgeschlagen',
    );
    setBusy(false);
  }
  return (
    <section className="stack" aria-label="Gruppeneinstellungen">
      <span className="msg-info-label">Gruppeneinstellungen</span>
      <Toggle
        label="Nur Admins dürfen senden"
        description="Alle anderen lesen nur mit – für Ankündigungen."
        checked={chat.settings.nurAdminsSenden}
        busy={busy}
        onChange={(an) => void setzen({ nurAdminsSenden: an })}
      />
      <Toggle
        label="Nur Admins dürfen die Gruppeninfo ändern"
        description="Name, Bild und Beschreibung."
        checked={chat.settings.nurAdminsInfo}
        busy={busy}
        onChange={(an) => void setzen({ nurAdminsInfo: an })}
      />
      <div className="field">
        <label htmlFor={langsamId}>Langsamer Modus</label>
        <select
          id={langsamId}
          className="select"
          value={chat.settings.langsamerModus}
          disabled={busy}
          aria-describedby={`${langsamId}-hinweis`}
          onChange={(event) => void setzen({ langsamerModus: Number(event.target.value) })}
        >
          {LANGSAM_STUFEN.map((sekunden) => (
            <option key={sekunden} value={sekunden}>
              {sekunden === 0 ? 'Aus' : `Eine Nachricht je ${langsamText(sekunden)}`}
            </option>
          ))}
        </select>
        <span id={`${langsamId}-hinweis`} className="faint" style={{ fontSize: '0.75rem' }}>
          Gilt je Mitglied; Admins sind ausgenommen.
        </span>
      </div>
    </section>
  );
}

/* ---------- Einladungslinks und Anfragen ---------- */

const GUELTIGKEITEN: { stunden: number | null; label: string }[] = [
  { stunden: 1, label: '1 Stunde' },
  { stunden: 24, label: '1 Tag' },
  { stunden: 24 * 7, label: '1 Woche' },
  { stunden: 24 * 30, label: '30 Tage' },
  { stunden: null, label: 'Bis ich ihn zurückziehe' },
];

export function linkAdresse(token: string): string {
  return `${window.location.origin}/join/${token}`;
}

async function teilen(adresse: string, titel: string) {
  try {
    if (navigator.share) {
      await navigator.share({ title: titel, text: `Tritt „${titel}“ bei`, url: adresse });
      return;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(adresse);
    toast('Link kopiert', 'success');
  } catch {
    toast('Kopieren nicht möglich – markier den Link von Hand', 'error');
  }
}

export function Einladungslinks({ chat, titel }: { chat: ConversationDto; titel: string }) {
  const [links, setLinks] = useState<EinladungslinkDto[] | null>(null);
  const [anfragen, setAnfragen] = useState<BeitrittsanfrageDto[]>([]);
  const [neuOffen, setNeuOffen] = useState(false);
  const [stunden, setStunden] = useState<number | null>(24 * 7);
  const [nutzungen, setNutzungen] = useState('');
  const [freigabe, setFreigabe] = useState(false);
  const [busy, setBusy] = useState(false);
  const gueltigId = useId();
  const nutzId = useId();

  async function laden() {
    try {
      const [l, a] = await Promise.all([
        verwaltung.links.liste(chat.id),
        verwaltung.links.anfragen(chat.id),
      ]);
      setLinks(l.items);
      setAnfragen(a.items);
    } catch {
      setLinks([]);
    }
  }

  useEffect(() => {
    void laden();
    // Neu laden, wenn sich die Mitglieder ändern (eine Anfrage wurde
    // anderswo entschieden, jemand ist beigetreten). `laden` selbst hängt nur
    // an `chat.id`.
  }, [chat.id, chat.members.length]);

  async function anlegen() {
    setBusy(true);
    try {
      const max = nutzungen.trim() ? Number(nutzungen) : null;
      const link = await verwaltung.links.anlegen(chat.id, {
        gueltigStunden: stunden,
        maxUses: max,
        freigabe,
      });
      setLinks((alt) => [link, ...(alt ?? [])]);
      setNeuOffen(false);
      toast('Einladungslink erstellt', 'success');
    } catch (error) {
      toast(fehlertext(error, 'Link konnte nicht erstellt werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function zurueckziehen(link: EinladungslinkDto) {
    setBusy(true);
    try {
      await verwaltung.links.zurueckziehen(chat.id, link.id);
      setLinks((alt) => (alt ?? []).filter((eintrag) => eintrag.id !== link.id));
      toast('Link zurückgezogen – er öffnet nichts mehr', 'success');
    } catch (error) {
      toast(fehlertext(error, 'Zurückziehen fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function entscheiden(anfrage: BeitrittsanfrageDto, annehmen: boolean) {
    setBusy(true);
    try {
      await verwaltung.links.entscheiden(chat.id, anfrage.id, annehmen);
      setAnfragen((alt) => alt.filter((eintrag) => eintrag.id !== anfrage.id));
      toast(annehmen ? `${anfrage.user.displayName} ist dabei` : 'Anfrage abgelehnt', 'success');
    } catch (error) {
      toast(fehlertext(error, 'Entscheiden fehlgeschlagen'), 'error');
      void laden();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" aria-label="Einladungslinks">
      {anfragen.length > 0 && (
        <div className="stack" aria-label="Beitrittsanfragen">
          <span className="msg-info-label">Beitrittsanfragen ({anfragen.length})</span>
          {anfragen.map((anfrage) => (
            <div key={anfrage.id} className="gv-zeile">
              <Avatar
                name={anfrage.user.displayName}
                id={anfrage.user.id}
                url={anfrage.user.avatarUrl}
                size={36}
              />
              <span className="truncate" style={{ flex: 1 }}>
                {anfrage.user.displayName}
                <span className="faint" style={{ display: 'block', fontSize: '0.75rem' }}>
                  @{anfrage.user.username}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                aria-label={`Anfrage von ${anfrage.user.displayName} ablehnen`}
                onClick={() => void entscheiden(anfrage, false)}
              >
                Ablehnen
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                aria-label={`${anfrage.user.displayName} aufnehmen`}
                onClick={() => void entscheiden(anfrage, true)}
              >
                Aufnehmen
              </button>
            </div>
          ))}
        </div>
      )}

      <span className="msg-info-label">Einladungslinks</span>
      {links === null && <span className="muted">Wird geladen …</span>}
      {links?.length === 0 && !neuOffen && (
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          Mit einem Link kann jemand beitreten, ohne dass du ihn einzeln hinzufügst. Vor dem
          Beitritt sieht man nur Name, Bild und Mitgliederzahl.
        </span>
      )}
      {links?.map((link) => (
        <div key={link.id} className="gv-link">
          <code>{linkAdresse(link.token)}</code>
          <span className="faint" style={{ fontSize: '0.78rem' }}>
            {link.expiresAt
              ? `gilt bis ${new Date(link.expiresAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`
              : 'gilt bis zum Zurückziehen'}
            {' · '}
            {link.maxUses ? `${link.uses} von ${link.maxUses} genutzt` : `${link.uses}× genutzt`}
            {link.freigabe ? ' · nur nach Freigabe' : ''}
          </span>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-sm"
              style={{ flex: 1 }}
              onClick={() => void teilen(linkAdresse(link.token), titel)}
            >
              Teilen
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void zurueckziehen(link)}
            >
              Zurückziehen
            </button>
          </div>
        </div>
      ))}
      {neuOffen ? (
        <form
          className="stack gv-link"
          aria-label="Neuer Einladungslink"
          onSubmit={(event) => {
            event.preventDefault();
            void anlegen();
          }}
        >
          <div className="field">
            <label htmlFor={gueltigId}>Gültig</label>
            <select
              id={gueltigId}
              className="select"
              value={stunden ?? ''}
              onChange={(event) =>
                setStunden(event.target.value === '' ? null : Number(event.target.value))
              }
            >
              {GUELTIGKEITEN.map((eintrag) => (
                <option key={eintrag.label} value={eintrag.stunden ?? ''}>
                  {eintrag.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={nutzId}>Höchstens so oft nutzbar (leer: unbegrenzt)</label>
            <input
              id={nutzId}
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={nutzungen}
              onChange={(event) => setNutzungen(event.target.value)}
            />
          </div>
          <Toggle
            label="Beitritt nur nach Freigabe"
            description="Wer den Link öffnet, stellt eine Anfrage; ein Admin nimmt auf."
            checked={freigabe}
            onChange={setFreigabe}
          />
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn" onClick={() => setNeuOffen(false)}>
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={busy}>
              Link erstellen
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-block" onClick={() => setNeuOffen(true)}>
          🔗 Einladungslink erstellen
        </button>
      )}
    </section>
  );
}

/* ---------- Ein Mitglied: Rolle, Spitzname, entfernen, melden, blockieren ---------- */

export function MitgliedSheet({
  chat,
  mitglied,
  myId,
  gesperrt,
  onSperreGeaendert,
  onClose,
}: {
  chat: ConversationDto;
  mitglied: ConversationMemberDto;
  myId: string;
  gesperrt: boolean;
  onSperreGeaendert: (gesperrt: boolean) => void;
  onClose: () => void;
}) {
  const darf = mitgliedAktionen(chat, myId, mitglied.userId);
  const [busy, setBusy] = useState(false);
  const [spitzname, setSpitzname] = useState(mitglied.nickname ?? '');
  const [frage, setFrage] = useState<'entfernen' | 'besitz' | null>(null);
  const [melden, setMelden] = useState(false);
  const spitzId = useId();
  const name = memberName(mitglied);
  const fremd = mitglied.userId !== myId;

  async function rolle(patch: Record<string, unknown>, erfolg: string) {
    setBusy(true);
    try {
      const neu = await verwaltung.gruppe.mitglied(chat.id, mitglied.userId, patch);
      useChat.getState().upsertConversation(neu);
      toast(erfolg, 'success');
      onClose();
    } catch (error) {
      toast(fehlertext(error, 'Ändern fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function entfernen() {
    setBusy(true);
    try {
      await verwaltung.gruppe.entfernen(chat.id, mitglied.userId);
      toast(`${name} entfernt`, 'success');
      onClose();
    } catch (error) {
      toast(fehlertext(error, 'Entfernen fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function sperreUmschalten() {
    setBusy(true);
    try {
      if (gesperrt) await verwaltung.sperren.freigeben(mitglied.userId);
      else await verwaltung.sperren.blockieren(mitglied.userId);
      onSperreGeaendert(!gesperrt);
      toast(gesperrt ? `${name} freigegeben` : `${name} blockiert`, 'success');
    } catch (error) {
      toast(fehlertext(error, 'Das hat nicht geklappt'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (melden) {
    return (
      <MeldenSheet
        ziel={{ userId: mitglied.userId, name }}
        onClose={() => {
          setMelden(false);
          onClose();
        }}
      />
    );
  }

  return (
    <Sheet open onClose={onClose} title={name}>
      <div className="stack chat-aktionen">
        <div className="gv-zeile">
          <Avatar name={name} id={mitglied.userId} url={mitglied.user.avatarUrl} size={48} />
          <span style={{ minWidth: 0 }}>
            <strong className="truncate" style={{ display: 'block' }}>
              {mitglied.user.displayName}
            </strong>
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              @{mitglied.user.username} · {roleLabel(mitglied.role)}
            </span>
          </span>
        </div>

        {frage ? (
          <>
            <p style={{ margin: 0 }}>
              {frage === 'entfernen'
                ? `${name} aus der Gruppe entfernen?`
                : `Die Gruppe an ${name} übergeben? Du bleibst Admin, ${name} wird Besitzer.`}
            </p>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn" onClick={() => setFrage(null)}>
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ flex: 1 }}
                disabled={busy}
                autoFocus
                onClick={() =>
                  void (frage === 'entfernen'
                    ? entfernen()
                    : rolle({ role: 'owner' }, `${name} ist jetzt Besitzer`))
                }
              >
                {frage === 'entfernen' ? 'Entfernen' : 'Übergeben'}
              </button>
            </div>
          </>
        ) : (
          <>
            {darf.spitzname && (
              <form
                className="row"
                style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void rolle({ nickname: spitzname.trim() || null }, 'Spitzname gespeichert');
                }}
              >
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor={spitzId}>Spitzname in dieser Gruppe</label>
                  <input
                    id={spitzId}
                    className="input"
                    value={spitzname}
                    maxLength={LIMITS.displayNameMax}
                    placeholder={mitglied.user.displayName}
                    onChange={(event) => setSpitzname(event.target.value)}
                  />
                </div>
                <button type="submit" className="btn" disabled={busy}>
                  Speichern
                </button>
              </form>
            )}
            {darf.zumAdmin && (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => void rolle({ role: 'admin' }, `${name} ist jetzt Admin`)}
              >
                ⭐ Zum Admin machen
              </button>
            )}
            {darf.adminEntziehen && (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => void rolle({ role: 'member' }, `${name} ist kein Admin mehr`)}
              >
                Admin entziehen
              </button>
            )}
            {darf.besitzUebergeben && (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => setFrage('besitz')}
              >
                👑 Besitz übergeben
              </button>
            )}
            {darf.entfernen && (
              <button
                type="button"
                className="btn btn-block btn-danger"
                disabled={busy}
                onClick={() => setFrage('entfernen')}
              >
                Aus der Gruppe entfernen
              </button>
            )}
            {fremd && (
              <>
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy}
                  onClick={() => void sperreUmschalten()}
                >
                  {gesperrt ? '✅ Freigeben' : '⛔ Blockieren'}
                </button>
                <button type="button" className="btn btn-block" onClick={() => setMelden(true)}>
                  🚩 Melden
                </button>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- Melden ---------- */

const GRUND_TEXT: Record<MeldeGrund, string> = {
  spam: 'Spam oder Werbung',
  belaestigung: 'Belästigung oder Drohung',
  unangemessen: 'Unangemessene Inhalte',
  gewalt: 'Gewalt oder Gefahr',
  sonstiges: 'Etwas anderes',
};

/**
 * Eine Person oder eine Nachricht melden. Die Verwaltung bekommt Grund,
 * Freitext und – bei einer Nachricht – deren Text, wie du ihn gerade siehst.
 */
export function MeldenSheet({
  ziel,
  onClose,
}: {
  ziel: { userId?: string; messageId?: string; name: string };
  onClose: () => void;
}) {
  const [grund, setGrund] = useState<MeldeGrund>('spam');
  const [freitext, setFreitext] = useState('');
  const [busy, setBusy] = useState(false);
  const textId = useId();

  async function senden() {
    setBusy(true);
    try {
      await verwaltung.sperren.melden({
        userId: ziel.userId,
        messageId: ziel.messageId,
        grund,
        freitext: freitext.trim() || undefined,
      });
      toast('Danke – die Verwaltung sieht sich das an', 'success');
      onClose();
    } catch (error) {
      toast(fehlertext(error, 'Melden fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={ziel.messageId ? 'Nachricht melden' : `${ziel.name} melden`}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void senden();
        }}
      >
        <fieldset className="chat-aktionen-ordner">
          <legend className="msg-info-label">Grund</legend>
          {MELDE_GRUENDE.map((wert) => (
            <label key={wert} className="row" style={{ gap: 'var(--space-2)' }}>
              <input
                type="radio"
                name="meldegrund"
                value={wert}
                checked={grund === wert}
                onChange={() => setGrund(wert)}
              />
              <span>{GRUND_TEXT[wert]}</span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor={textId}>Was ist passiert? (freiwillig)</label>
          <textarea
            id={textId}
            className="textarea"
            maxLength={1000}
            value={freitext}
            onChange={(event) => setFreitext(event.target.value)}
          />
        </div>
        <p className="faint" style={{ margin: 0, fontSize: '0.78rem' }}>
          Die gemeldete Person erfährt nicht, wer gemeldet hat.
        </p>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          Meldung senden
        </button>
      </form>
    </Sheet>
  );
}
