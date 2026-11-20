/**
 * Aus einem User-Agent einen Gerätenamen für die Geräteliste machen:
 * „Firefox auf Linux“, „Safari auf iPhone“.
 *
 * Bewusst grob: Es geht ums Wiedererkennen („das ist mein Laptop“), nicht um
 * Versionsnummern. Unbekanntes heisst „Unbekanntes Gerät“ – lieber das als ein
 * falscher Name.
 */
export function geraetName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua.trim()) return 'Unbekanntes Gerät';

  const plattform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;

  // Reihenfolge zählt: Edge und Opera nennen sich auch „Chrome“, Chrome nennt
  // sich auch „Safari“.
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;

  if (browser && plattform) return `${browser} auf ${plattform}`;
  if (browser) return browser;
  if (plattform) return plattform;
  return 'Unbekanntes Gerät';
}

/** Ein passendes Zeichen zur Plattform. */
export function geraetZeichen(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone|Android.*Mobile|Mobile/.test(ua)) return '📱';
  if (/iPad|Tablet/.test(ua)) return '📲';
  return '💻';
}
