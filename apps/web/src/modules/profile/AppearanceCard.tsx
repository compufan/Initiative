import { useUi, type ThemePreference } from '../../state/ui.js';
import { patchMe } from './helpers.js';

const THEMES: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '🌗' },
  { value: 'light', label: 'Hell', icon: '☀️' },
  { value: 'dark', label: 'Dunkel', icon: '🌙' },
];

/** Light, dark or whatever the phone says – applied instantly, saved quietly. */
export function AppearanceCard() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);

  function choose(next: ThemePreference) {
    setTheme(next);
    // The look is already applied locally; storing it on the account only makes
    // the next device start out the same way, so a failure stays silent.
    void patchMe({ settings: { theme: next } }).catch(() => {});
  }

  return (
    <section className="card stack" aria-labelledby="prf-appearance-title">
      <h2 className="prf-block-title" id="prf-appearance-title">
        Darstellung
      </h2>
      <p className="prf-hint">
        „System“ übernimmt die Einstellung deines Handys und wechselt abends automatisch.
      </p>
      <div className="prf-segment" role="group" aria-label="Farbschema">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`prf-segment-btn${theme === option.value ? ' is-active' : ''}`}
            aria-pressed={theme === option.value}
            onClick={() => choose(option.value)}
          >
            <span className="prf-segment-icon" aria-hidden="true">
              {option.icon}
            </span>
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
