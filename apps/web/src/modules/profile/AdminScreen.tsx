import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../../components/Screen.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { api, type AdminMemberDto, type InviteDto, type StorageCheck } from '../../lib/api.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { errorMessage } from './helpers.js';

/** Ein Code ist nur brauchbar, solange er weder zurückgezogen noch aufgebraucht ist. */
function inviteState(invite: InviteDto): { label: string; usable: boolean } {
  if (invite.revokedAt) return { label: 'zurückgezogen', usable: false };
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) {
    return { label: 'abgelaufen', usable: false };
  }
  if (invite.maxUses != null && invite.uses >= invite.maxUses) {
    return { label: 'aufgebraucht', usable: false };
  }
  const left = invite.maxUses == null ? '∞' : `${invite.maxUses - invite.uses}`;
  return { label: `${left} Einlösung(en) offen`, usable: true };
}

/** `/verwaltung` – Einladungscodes und Mitglieder. Nur für Admins erreichbar. */
export function AdminScreen() {
  const navigate = useNavigate();
  const myId = useSession((state) => state.user?.id ?? '');

  const [invites, setInvites] = useState<InviteDto[] | null>(null);
  const [members, setMembers] = useState<AdminMemberDto[] | null>(null);
  const [note, setNote] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<AdminMemberDto | null>(null);
  const [storage, setStorage] = useState<StorageCheck | null>(null);
  const [checking, setChecking] = useState(false);

  async function load() {
    try {
      const [nextInvites, nextMembers] = await Promise.all([
        api.admin.invites(),
        api.admin.members(),
      ]);
      setInvites(nextInvites);
      setMembers(nextMembers);
    } catch (error) {
      toast(errorMessage(error, 'Verwaltung konnte nicht geladen werden'), 'error');
      navigate('/profil/einstellungen', { replace: true });
    }
  }

  useEffect(() => {
    void load();
    // Einmal beim Öffnen; danach aktualisiert jede Aktion selbst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createInvite() {
    setBusy(true);
    try {
      const parsed = Number.parseInt(maxUses, 10);
      const created = await api.admin.createInvite({
        note: note.trim() || undefined,
        maxUses: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      });
      setInvites((current) => [created, ...(current ?? [])]);
      setNote('');
      toast('Code erstellt', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Code konnte nicht erstellt werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast('Code kopiert', 'success');
    } catch {
      toast('Kopieren hat nicht geklappt – Code bitte abtippen', 'error');
    }
  }

  async function revoke(code: string) {
    try {
      await api.admin.revokeInvite(code);
      setInvites(
        (current) =>
          current?.map((item) =>
            item.code === code ? { ...item, revokedAt: new Date().toISOString() } : item,
          ) ?? null,
      );
      toast('Code zurückgezogen', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Zurückziehen fehlgeschlagen'), 'error');
    }
  }

  async function removeMember(member: AdminMemberDto) {
    setBusy(true);
    try {
      await api.admin.removeMember(member.id);
      setMembers((current) => current?.filter((item) => item.id !== member.id) ?? null);
      toast(`${member.displayName} wurde entfernt`, 'success');
    } catch (error) {
      toast(errorMessage(error, 'Entfernen fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function runStorageCheck() {
    setChecking(true);
    try {
      setStorage(await api.admin.storageCheck());
    } catch (error) {
      toast(errorMessage(error, 'Prüfung fehlgeschlagen'), 'error');
    } finally {
      setChecking(false);
    }
  }

  return (
    <Screen title="Verwaltung" subtitle="Einladungen und Mitglieder" back="/profil/einstellungen">
      <section className="card stack" aria-labelledby="adm-storage-title">
        <h2 className="prf-block-title" id="adm-storage-title">
          Speicher prüfen
        </h2>
        <p className="prf-hint">
          Testet vom Server aus, ob Fotos, Sprachnachrichten und Sticker im Objektspeicher landen
          können – Zugangsdaten, Bucket und die CORS-Regel, die der Browser zum Hochladen braucht.
        </p>
        <button type="button" className="btn" disabled={checking} onClick={() => void runStorageCheck()}>
          {checking ? 'Wird geprüft …' : 'Jetzt prüfen'}
        </button>

        {storage && (
          <div className="stack" style={{ gap: 10 }}>
            <div className={storage.steps.every((s) => s.ok) ? 'prf-note is-ok' : 'prf-note'}>
              <strong>{storage.verdict}</strong>
            </div>
            <p className="prf-hint" style={{ margin: 0 }}>
              Treiber: <code>{storage.driver}</code>
              {storage.bucket && (
                <>
                  {' · '}Bucket: <code>{storage.bucket}</code>
                </>
              )}
              <br />
              Erwarteter Browser-Origin: <code>{storage.browserOrigin}</code>
            </p>
            <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none', gap: 10 }}>
              {storage.steps.map((step) => (
                <li key={step.name} className="stack" style={{ gap: 2 }}>
                  <strong>
                    {step.ok ? '✓' : '✗'} {step.name}
                  </strong>
                  <span className="prf-hint">{step.detail}</span>
                  {step.hint && (
                    <span className="prf-hint" style={{ fontWeight: 600 }}>
                      → {step.hint}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="adm-invite-title">
        <h2 className="prf-block-title" id="adm-invite-title">
          Einladungscode erstellen
        </h2>
        <p className="prf-hint">
          Der Code wird hier erzeugt; weitergeben kannst du ihn, wie du magst. Bei der
          Registrierung tippt die eingeladene Person ihn ins Feld „Einladungscode“.
        </p>
        <div className="field">
          <label htmlFor="adm-note">Notiz (nur für dich)</label>
          <input
            id="adm-note"
            className="input"
            value={note}
            placeholder="z. B. für Chris"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="adm-max">Wie oft einlösbar?</label>
          <input
            id="adm-max"
            className="input"
            type="number"
            min="1"
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
          />
          <p className="prf-hint">Leer oder 0 bedeutet: unbegrenzt.</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void createInvite()}>
          Code erstellen
        </button>
      </section>

      <section className="card stack" aria-labelledby="adm-codes-title">
        <h2 className="prf-block-title" id="adm-codes-title">
          Codes
        </h2>
        {invites == null ? (
          <Spinner label="Codes werden geladen …" />
        ) : invites.length === 0 ? (
          <EmptyState emoji="🎟️" title="Noch keine Codes" description="Erstelle oben den ersten." />
        ) : (
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {invites.map((invite) => {
              const state = inviteState(invite);
              return (
                <li key={invite.code} className="stack" style={{ gap: 6 }}>
                  {/* Der Code darf nie umbrechen – er wird abgetippt. */}
                  <code
                    style={{
                      fontSize: '1.05rem',
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                      opacity: state.usable ? 1 : 0.55,
                    }}
                  >
                    {invite.code}
                  </code>
                  <p className="prf-hint" style={{ margin: 0 }}>
                    {invite.note ? `${invite.note} · ` : ''}
                    {state.label}
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void copy(invite.code)}
                    >
                      Kopieren
                    </button>
                    {state.usable && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void revoke(invite.code)}
                      >
                        Zurückziehen
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="adm-members-title">
        <h2 className="prf-block-title" id="adm-members-title">
          Mitglieder
        </h2>
        {members == null ? (
          <Spinner label="Mitglieder werden geladen …" />
        ) : (
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {members.map((member) => (
              <li key={member.id} className="row" style={{ gap: 10, alignItems: 'center' }}>
                <span className="stack" style={{ gap: 0, flex: 1 }}>
                  <strong>{member.displayName}</strong>
                  <span className="prf-hint">
                    @{member.username}
                    {member.isAdmin ? ' · Admin' : ''}
                    {member.id === myId ? ' · du' : ''}
                  </span>
                </span>
                {member.id !== myId && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setConfirm(member)}
                  >
                    Entfernen
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm != null}
        title={`${confirm?.displayName ?? ''} entfernen?`}
        description="Das Konto und alle zugehörigen Nachrichten werden gelöscht. Das lässt sich nicht rückgängig machen."
        confirmLabel="Entfernen"
        danger
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void removeMember(confirm)}
      />
    </Screen>
  );
}
