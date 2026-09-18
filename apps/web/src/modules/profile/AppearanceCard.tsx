import { useUi, type MarkePraesenz, type ThemePreference } from '../../state/ui.js';
import { patchMe } from './helpers.js';

const THEMES: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '🌗' },
  { value: 'light', label: 'Hell', icon: '☀️' },
  { value: 'dark', label: 'Dunkel', icon: '🌙' },
];

/**
 * Wie kräftig das Zeichen der Gruppe im Hintergrund steht.
 *
 * Drei Stufen statt eines Schalters, weil hier zwei Dinge gegeneinander
 * stehen: Es ist das Zeichen der Gruppe und soll zu sehen sein – und darüber
 * liegen Chatblasen, Listen und Formulare, die gelesen werden müssen. Wer
 * beides will, braucht einen Regler, keinen Hebel.
 */
const MARKEN: { value: MarkePraesenz; label: string; icon: string }[] = [
  { value: 'aus', label: 'Aus', icon: '▢' },
  { value: 'dezent', label: 'Dezent', icon: '◍' },
  { value: 'deutlich', label: 'Deutlich', icon: '◉' },
];

/** Light, dark or whatever the phone says – applied instantly, saved quietly. */
export function AppearanceCard() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const marke = useUi((state) => state.marke);
  const setMarke = useUi((state) => state.setMarke);

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

      <h3 className="prf-block-title" id="prf-marke-title">
        Zeichen der Gruppe
      </h3>
      <p className="prf-hint">
        Das Logo steht blass hinter der ganzen App. „Dezent“ ist so gewählt, dass nie ein Text darum
        kämpfen muss.
      </p>
      <div className="prf-segment" role="group" aria-labelledby="prf-marke-title">
        {MARKEN.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`prf-segment-btn${marke === option.value ? ' is-active' : ''}`}
            aria-pressed={marke === option.value}
            onClick={() => setMarke(option.value)}
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
