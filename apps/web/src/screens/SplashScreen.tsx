export function SplashScreen() {
  return (
    <div
      className="app-shell"
      style={{ alignItems: 'center', justifyContent: 'center', gap: 'var(--space-4)' }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 76,
          height: 76,
          borderRadius: 24,
          background: 'linear-gradient(140deg, var(--accent), var(--accent-2))',
          display: 'grid',
          placeItems: 'center',
          fontSize: 38,
          boxShadow: 'var(--shadow)',
        }}
      >
        ⚡
      </div>
      <strong style={{ fontSize: '1.2rem', letterSpacing: '-0.01em' }}>Initiative</strong>
      <span className="spinner" role="status" aria-label="Lädt" />
    </div>
  );
}
