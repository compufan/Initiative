import type { LinkVorschau } from '@initiative/shared';

const LINK = /(https?:\/\/[^\s<>()]+)/i;

/** Der erste http(s)-Link im Text – ohne Satzzeichen am Ende. */
export function ersterLink(text: string): string | null {
  const treffer = LINK.exec(text);
  if (!treffer) return null;
  return treffer[1]!.replace(/[.,;:!?)\]]+$/, '') || null;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Die Karte einer Link-Vorschau – unter dem Text einer Nachricht oder über der
 * Eingabezeile, solange man schreibt.
 *
 * Das Bild kommt aus dem eigenen Medienspeicher (`bildUrl`), nie von der
 * fremden Seite: Wer die Nachricht öffnet, lädt nichts von einem fremden
 * Server. Der Link selbst öffnet sich nur auf Tipp, mit `noreferrer`.
 */
export function LinkVorschauKarte({
  vorschau,
  imEntwurf = false,
  onVerwerfen,
}: {
  vorschau: LinkVorschau;
  imEntwurf?: boolean;
  onVerwerfen?: () => void;
}) {
  const inhalt = (
    <>
      {vorschau.bildUrl && (
        <img className="msg-link-bild" src={vorschau.bildUrl} alt="" loading="lazy" />
      )}
      <span className="msg-link-text">
        <span className="msg-link-seite">{vorschau.seite || host(vorschau.url)}</span>
        {vorschau.titel && <strong className="msg-link-titel">{vorschau.titel}</strong>}
        {vorschau.beschreibung && (
          <span className="msg-link-beschreibung">{vorschau.beschreibung}</span>
        )}
      </span>
    </>
  );
  if (imEntwurf) {
    return (
      <div className="msg-link-karte msg-link-entwurf" role="group" aria-label="Link-Vorschau">
        {inhalt}
        {onVerwerfen && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Link-Vorschau entfernen"
            onClick={onVerwerfen}
          >
            ✕
          </button>
        )}
      </div>
    );
  }
  return (
    <a
      className="msg-link-karte"
      href={vorschau.url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Link öffnen: ${vorschau.titel ?? host(vorschau.url)}`}
    >
      {inhalt}
    </a>
  );
}
