import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Screen } from '../../components/Screen.js';
import { AboutCard } from './AboutCard.js';
import { AccountCard } from './AccountCard.js';
import { AdminCard } from './AdminCard.js';
import { PasskeyCard } from './PasskeyCard.js';
import { AppearanceCard } from './AppearanceCard.js';
import { CalendarCard } from './CalendarCard.js';
import { InstallCard } from './InstallCard.js';
import { NotificationsCard } from './NotificationsCard.js';

/** `/profil/einstellungen` – one card per topic, in the order people need them. */
export function SettingsScreen() {
  const { hash } = useLocation();

  // `/profil/einstellungen#kalender` jumps straight to the subscription card.
  useEffect(() => {
    if (!hash) return undefined;
    const timer = window.setTimeout(() => {
      document
        .getElementById(hash.slice(1))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [hash]);

  return (
    <Screen title="Einstellungen" back="/profil">
      <AppearanceCard />
      <NotificationsCard />
      <InstallCard />
      <CalendarCard />
      <PasskeyCard />
      <AdminCard />
      <AccountCard />
      <AboutCard />
    </Screen>
  );
}
