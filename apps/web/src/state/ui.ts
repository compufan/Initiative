import { useEffect, type DependencyList, type EffectCallback } from 'react';
import { create } from 'zustand';
import { uuidv7 } from '@initiative/shared';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
}

export type ThemePreference = 'system' | 'light' | 'dark';

interface UiState {
  toasts: Toast[];
  theme: ThemePreference;
  installPrompt: BeforeInstallPromptEvent | null;
  swUpdateReady: (() => void) | null;
  toast: (message: string, kind?: ToastKind) => void;
  dismissToast: (id: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setInstallPrompt: (event: BeforeInstallPromptEvent | null) => void;
  setSwUpdate: (apply: (() => void) | null) => void;
}

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const THEME_KEY = 'initiative.theme';

function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function applyTheme(theme: ThemePreference): void {
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolved = theme === 'system' ? (prefersLight ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#f5f6fb' : '#0b1020');
}

/*
 * Der Auslauf einer Meldung – anhaltbar.
 *
 * Seit die Meldung ein Knopf ist, kann sie den Fokus tragen. Verschwindet ein
 * fokussiertes Element aus dem Dokument, fällt der Fokus auf den Rumpf zurück,
 * und die nächste Tabulatortaste fängt wieder ganz vorn an – wer mit der
 * Tastatur arbeitet, verliert mitten im Bedienen seine Stelle. Deshalb steht
 * die Zeit still, solange jemand auf der Meldung steht.
 *
 * Ausserhalb des Zustands, weil ein Zeitgeber kein Zustand ist: Er darf kein
 * neues Bild auslösen, und er soll beim Aufräumen nicht mitwandern.
 */
const AUSLAUF_MS = 4200;
const uhren = new Map<string, number>();

function auslaufPlanen(id: string): void {
  auslaufStoppen(id);
  const kennung = setTimeout(() => {
    uhren.delete(id);
    useUi.setState((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  }, AUSLAUF_MS);
  uhren.set(id, kennung as unknown as number);
}

function auslaufStoppen(id: string): void {
  const kennung = uhren.get(id);
  if (kennung != null) clearTimeout(kennung);
  uhren.delete(id);
}

/** Hält den Auslauf an, solange die Meldung den Fokus hat. */
export function toastFesthalten(id: string): void {
  auslaufStoppen(id);
}

/** Lässt die Zeit weiterlaufen, sobald der Fokus weiterzieht. */
export function toastLoslassen(id: string): void {
  if (useUi.getState().toasts.some((toast) => toast.id === id)) auslaufPlanen(id);
}

export const useUi = create<UiState>((set) => ({
  toasts: [],
  theme: readTheme(),
  installPrompt: null,
  swUpdateReady: null,

  toast(message, kind = 'info') {
    const id = uuidv7();
    set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }));
    auslaufPlanen(id);
  },

  dismissToast(id) {
    auslaufStoppen(id);
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  setTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    applyTheme(theme);
    set({ theme });
  },

  setInstallPrompt(event) {
    set({ installPrompt: event });
  },

  setSwUpdate(apply) {
    set({ swUpdateReady: apply });
  },
}));

export function toast(message: string, kind: ToastKind = 'info'): void {
  useUi.getState().toast(message, kind);
}

if (typeof window !== 'undefined') {
  applyTheme(readTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (useUi.getState().theme === 'system') applyTheme('system');
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    useUi.getState().setInstallPrompt(event as BeforeInstallPromptEvent);
  });
}

/** Screens that own the full viewport (chat view, camera) hide the tab bar. */
export const useNavVisibility = create<{ hidden: number }>(() => ({ hidden: 0 }));

const useIsomorphicEffect = (effect: EffectCallback, deps: DependencyList) =>
  useEffect(effect, deps);

export function useHideNav(active = true): void {
  useIsomorphicEffect(() => {
    if (!active) return undefined;
    useNavVisibility.setState((state) => ({ hidden: state.hidden + 1 }));
    return () => useNavVisibility.setState((state) => ({ hidden: Math.max(0, state.hidden - 1) }));
  }, [active]);
}
