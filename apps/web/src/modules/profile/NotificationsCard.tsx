import { useState } from 'react';
import type { UserSettings } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { disablePush, enablePush, pushStatus, type PushStatus } from '../../lib/push.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { Toggle } from './Toggle.js';
import { errorMessage, notificationSettings, patchMe } from './helpers.js';

type Pending = 'push' | 'sound' | 'previews' | 'test' | null;

/**
 * Push, sound and previews.
 *
 * The switch for push does two things at once: it subscribes this device with
 * the browser and stores the wish on the account. iOS only hands out the Push
 * API to an installed PWA, which is what the hints below explain.
 */
export function NotificationsCard() {
  const user = useSession((state) => state.user);
  const settings = notificationSettings(user);
  const [status, setStatus] = useState<PushStatus>(() => pushStatus());
  const [pending, setPending] = useState<Pending>(null);

  const blocked = status === 'denied' || status === 'needs-install' || status === 'unsupported';
  const pushOn = settings.push && status === 'granted';

  async function save(patch: Partial<UserSettings['notifications']>) {
    await patchMe({ settings: { notifications: { ...settings, ...patch } } });
  }

  async function togglePush(next: boolean) {
    setPending('push');
    try {
      if (next) {
        const ok = await enablePush();
        const current = pushStatus();
        setStatus(current);
        if (!ok) {
          toast(
            current === 'denied'
              ? 'Benachrichtigungen sind im Browser blockiert'
              : current === 'granted'
                ? 'Dieser Server verschickt gerade keine Benachrichtigungen'
                : 'Benachrichtigungen wurden nicht erlaubt',
            'error',
          );
          return;
        }
        await save({ push: true });
        toast('Benachrichtigungen sind an', 'success');
      } else {
        await disablePush();
        await save({ push: false });
        toast('Benachrichtigungen sind aus', 'success');
      }
    } catch (error) {
      toast(errorMessage(error, 'Einstellung konnte nicht gespeichert werden'), 'error');
    } finally {
      setPending(null);
    }
  }

  async function toggleFlag(key: 'sound' | 'previews', next: boolean) {
    setPending(key);
    try {
      await save(key === 'sound' ? { sound: next } : { previews: next });
    } catch (error) {
      toast(errorMessage(error, 'Einstellung konnte nicht gespeichert werden'), 'error');
    } finally {
      setPending(null);
    }
  }

  async function sendTest() {
    setPending('test');
    try {
      const { delivered } = await api.push.test();
      if (delivered > 0) {
        toast(
          `Testbenachrichtigung an ${delivered} ${delivered === 1 ? 'Gerät' : 'Geräte'} gesendet`,
          'success',
        );
      } else {
        toast('Kein Gerät registriert – schalte Benachrichtigungen hier noch einmal ein', 'info');
      }
    } catch (error) {
      toast(errorMessage(error, 'Testbenachrichtigung fehlgeschlagen'), 'error');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card stack" aria-labelledby="prf-notifications-title">
      <h2 className="prf-block-title" id="prf-notifications-title">
        Benachrichtigungen
      </h2>
      <p className="prf-hint">
        Damit erfährst du von neuen Nachrichten, auch wenn Initiative gerade nicht offen ist.
      </p>

      <div className="prf-toggles">
        <Toggle
          label="Push-Benachrichtigungen"
          description="Meldungen auf dem Sperrbildschirm dieses Geräts"
          checked={pushOn}
          disabled={blocked}
          busy={pending === 'push'}
          onChange={(next) => void togglePush(next)}
        />
        <Toggle
          label="Ton"
          description="Kurzer Signalton bei neuen Nachrichten"
          checked={settings.sound}
          busy={pending === 'sound'}
          onChange={(next) => void toggleFlag('sound', next)}
        />
        <Toggle
          label="Vorschau"
          description="Absender und Text in der Meldung anzeigen"
          checked={settings.previews}
          busy={pending === 'previews'}
          onChange={(next) => void toggleFlag('previews', next)}
        />
      </div>

      {status === 'needs-install' && (
        <div className="prf-note">
          <strong>Auf dem iPhone nur als installierte App</strong>
          <p className="prf-hint">
            Safari darf Benachrichtigungen erst schicken, wenn Initiative auf dem Home-Bildschirm
            liegt: unten auf das Teilen-Symbol tippen → „Zum Home-Bildschirm“ → „Hinzufügen“. Danach
            Initiative über das neue Symbol öffnen und den Schalter hier erneut umlegen.
          </p>
        </div>
      )}

      {status === 'denied' && (
        <div className="prf-note is-warn">
          <strong>Im Browser blockiert</strong>
          <p className="prf-hint">
            iPhone: Einstellungen → Mitteilungen → Initiative → „Mitteilungen erlauben“. Android
            (Chrome): auf das Schloss-Symbol neben der Adresse tippen → Berechtigungen →
            Benachrichtigungen zulassen. Danach die Seite neu laden.
          </p>
        </div>
      )}

      {status === 'unsupported' && (
        <div className="prf-note">
          <strong>Dieser Browser kann keine Benachrichtigungen</strong>
          <p className="prf-hint">
            Probiere es mit Chrome, Firefox, Edge oder – auf dem iPhone – mit der installierten App.
          </p>
        </div>
      )}

      {pushOn && (
        <button
          type="button"
          className="btn btn-block"
          disabled={pending === 'test'}
          onClick={() => void sendTest()}
        >
          🔔 Testbenachrichtigung senden
        </button>
      )}
    </section>
  );
}
