import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { prepareImage, uploadBlob } from '../../lib/upload.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { connectionInfo, errorMessage, memberSince, patchMe } from './helpers.js';

type EditField = 'displayName' | 'bio' | null;

/** `/profil` – own account at a glance plus the entry points into the settings. */
export function ProfileScreen() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const connection = useSession((state) => state.connection);
  const [editing, setEditing] = useState<EditField>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!user) {
    return (
      <Screen title="Profil">
        <EmptyState
          emoji="👤"
          title="Profil noch nicht geladen"
          description="Du bist angemeldet, aber dein Profil konnte nicht vom Server geholt werden. Prüfe deine Verbindung und versuche es noch einmal."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void useSession.getState().refreshUser()}
            >
              Erneut versuchen
            </button>
          }
        />
      </Screen>
    );
  }

  const status = connectionInfo(connection);
  const since = memberSince(user.createdAt);

  function startEdit(field: Exclude<EditField, null>) {
    setDraft(field === 'displayName' ? (user?.displayName ?? '') : (user?.bio ?? ''));
    setEditing(field);
  }

  async function saveEdit() {
    if (!editing || !user) return;
    const value = draft.trim();
    if (editing === 'displayName' && value.length === 0) {
      toast('Der Anzeigename darf nicht leer sein', 'error');
      return;
    }
    const unchanged =
      editing === 'displayName' ? value === user.displayName : value === (user.bio ?? '');
    if (unchanged) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      await patchMe(
        editing === 'displayName'
          ? { displayName: value }
          : { bio: value.length > 0 ? value : null },
      );
      setEditing(null);
      toast(editing === 'displayName' ? 'Name gespeichert' : 'Über mich gespeichert', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function pickAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      toast('Bitte wähle ein Foto aus', 'error');
      return;
    }
    setUploading(true);
    try {
      const prepared = await prepareImage(file, 640);
      const attachment = await uploadBlob({
        kind: 'image',
        mime: prepared.mime,
        fileName: file.name || 'profilbild',
        blob: prepared.blob,
        width: prepared.width,
        height: prepared.height,
        previewDataUrl: prepared.previewDataUrl,
      });
      await patchMe({ avatarAttachmentId: attachment.id });
      toast('Profilbild aktualisiert', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Profilbild konnte nicht gespeichert werden'), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setUploading(true);
    try {
      await patchMe({ avatarAttachmentId: null });
      toast('Profilbild entfernt', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Profilbild konnte nicht entfernt werden'), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await useSession.getState().logout();
    } catch (error) {
      toast(errorMessage(error, 'Abmelden fehlgeschlagen'), 'error');
      setBusy(false);
      setConfirmLogout(false);
    }
  }

  return (
    <Screen
      title="Profil"
      actions={
        <button
          type="button"
          className="icon-btn"
          aria-label="Einstellungen"
          onClick={() => navigate('/profil/einstellungen')}
        >
          ⚙️
        </button>
      }
    >
      <section className="card prf-hero">
        <button
          type="button"
          className="prf-avatar-btn"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          aria-label="Profilbild ändern"
        >
          <Avatar name={user.displayName} id={user.id} url={user.avatarUrl} size={104} />
          <span className="prf-avatar-badge" aria-hidden="true">
            {uploading ? '…' : '📷'}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="prf-file-input"
          onChange={(event) => void pickAvatar(event)}
        />
        {uploading ? (
          <Spinner label="Profilbild wird hochgeladen …" />
        ) : user.avatarUrl ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void removeAvatar()}
          >
            Profilbild entfernen
          </button>
        ) : (
          <span className="prf-hint">Tippe auf das Bild, um ein Foto auszuwählen.</span>
        )}

        {editing === 'displayName' ? (
          <div className="stack prf-edit">
            <label className="prf-field-label" htmlFor="prf-display-name">
              Anzeigename
            </label>
            <input
              id="prf-display-name"
              className="input"
              value={draft}
              autoFocus
              maxLength={LIMITS.displayNameMax}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveEdit();
                if (event.key === 'Escape') setEditing(null);
              }}
            />
            <div className="prf-edit-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void saveEdit()}
              >
                Speichern
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="prf-name-btn"
            onClick={() => startEdit('displayName')}
            aria-label="Anzeigenamen ändern"
          >
            <span className="prf-name">{user.displayName}</span>
            <span className="prf-pencil" aria-hidden="true">
              ✏️
            </span>
          </button>
        )}

        <span className="prf-handle">@{user.username}</span>
        {since && <span className="prf-meta">{since}</span>}
      </section>

      <section className="card stack">
        <h2 className="prf-block-title">Über mich</h2>
        {editing === 'bio' ? (
          <div className="stack">
            <textarea
              className="textarea"
              value={draft}
              autoFocus
              maxLength={LIMITS.bioMax}
              placeholder="Ein, zwei Sätze über dich."
              aria-label="Über mich"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="row row-between">
              <span className="prf-counter">
                {draft.length}/{LIMITS.bioMax}
              </span>
              <div className="prf-edit-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void saveEdit()}
                >
                  Speichern
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" className="prf-bio-btn" onClick={() => startEdit('bio')}>
            <span className={user.bio ? 'prf-bio' : 'prf-bio prf-bio-empty'}>
              {user.bio ?? 'Erzähl den anderen kurz, wer du bist. Tippen zum Schreiben.'}
            </span>
            <span className="prf-pencil" aria-hidden="true">
              ✏️
            </span>
          </button>
        )}
      </section>

      <section className="card prf-connection" aria-label="Verbindungsstatus">
        <span className={`prf-dot is-${status.tone}`} aria-hidden="true" />
        <span className="stack prf-connection-text">
          <strong>{status.label}</strong>
          <span className="prf-hint">{status.description}</span>
        </span>
      </section>

      <nav className="card prf-menu" aria-label="Weitere Bereiche">
        <button
          type="button"
          className="list-row prf-menu-row"
          onClick={() => navigate('/profil/einstellungen')}
        >
          <span className="prf-menu-icon" aria-hidden="true">
            ⚙️
          </span>
          <span className="prf-menu-text">
            <strong>Einstellungen</strong>
            <span className="prf-hint">Aussehen, Benachrichtigungen, Konto</span>
          </span>
          <span className="prf-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          type="button"
          className="list-row prf-menu-row"
          onClick={() => navigate('/sticker')}
        >
          <span className="prf-menu-icon" aria-hidden="true">
            🌟
          </span>
          <span className="prf-menu-text">
            <strong>Sticker-Pakete</strong>
            <span className="prf-hint">Eigene Sticker erstellen und Pakete verwalten</span>
          </span>
          <span className="prf-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          type="button"
          className="list-row prf-menu-row"
          onClick={() => navigate('/profil/einstellungen#kalender')}
        >
          <span className="prf-menu-icon" aria-hidden="true">
            📆
          </span>
          <span className="prf-menu-text">
            <strong>Kalender abonnieren</strong>
            <span className="prf-hint">Termine in der Kalender-App deines Handys</span>
          </span>
          <span className="prf-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          type="button"
          className="list-row prf-menu-row prf-menu-danger"
          onClick={() => setConfirmLogout(true)}
        >
          <span className="prf-menu-icon" aria-hidden="true">
            🚪
          </span>
          <span className="prf-menu-text">
            <strong>Abmelden</strong>
            <span className="prf-hint">Meldet dich auf diesem Gerät ab</span>
          </span>
        </button>
      </nav>

      <ConfirmDialog
        open={confirmLogout}
        title="Abmelden?"
        description="Die auf diesem Gerät gespeicherten Chats werden dabei gelöscht. Deine Nachrichten bleiben auf dem Server."
        confirmLabel="Abmelden"
        danger
        busy={busy}
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => void logout()}
      />
    </Screen>
  );
}
