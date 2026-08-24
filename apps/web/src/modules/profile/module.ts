import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { ProfileScreen } from './ProfileScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { AdminScreen } from './AdminScreen.js';
import { adoptAccountTheme } from './helpers.js';
import './styles.css';

/**
 * Profile & settings – the personal corner of the app.
 *
 * It owns the own account (picture, name, bio), the switches for look and
 * notifications, the home-screen installation, the calendar subscription and
 * the way out: password change, logout and the offline cache.
 */
export default defineWebModule({
  key: 'profile',
  title: 'Profil',
  description: 'Profilbild, Anzeigename, Benachrichtigungen, Darstellung und Konto.',
  nav: [{ path: '/profil', label: 'Profil', icon: '👤', order: 90 }],
  routes: [
    { path: '/profil', element: createElement(ProfileScreen) },
    { path: '/profil/einstellungen', element: createElement(SettingsScreen) },
    { path: '/verwaltung', element: createElement(AdminScreen) },
  ],
  init: adoptAccountTheme,
});
