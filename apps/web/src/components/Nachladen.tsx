import {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Spinner } from './Feedback.js';

/**
 * Nachgeladene Teile der App – und was passiert, wenn das Nachladen scheitert.
 *
 * # Warum überhaupt
 *
 * Der Bildeditor, das Sticker-Studio und die Videowerkstatt lagen zusammen
 * mit gut 470 kB im Start-Stück. Jeder zahlte sie beim Öffnen der App, auch
 * wer an diesem Tag nur drei Nachrichten liest. Jetzt kommen sie erst, wenn
 * jemand auf den Stift tippt.
 *
 * # Warum eine eigene Fehlergrenze
 *
 * Ein `import()` kann scheitern, ein statischer Import nicht – er ist ja schon
 * da. Offline ohne vollständigen Vorrat oder nach einer neuen Fassung, deren
 * Stücke andere Namen tragen, wirft `React.lazy` beim Rendern. Ohne Grenze
 * risse das den ganzen Baum mit: weisser Bildschirm statt eines Satzes.
 * Die Grenze fängt genau das ab und bietet „Neu laden" an – nach einem
 * Neuladen gilt der Vorrat der aktuellen Fassung wieder.
 */

/**
 * Wo das Nachgeladene erscheint:
 * - `vollbild`: eine Werkstatt über allem (Editor, Studio)
 * - `bildschirm`: eine ganze Seite (eine Route)
 * - `blatt`: ein Blatt über einem schon offenen Teil. Kein Platzhalter – ein
 *   Schleier über dem Blatt darunter flackerte nur kurz; scheitert es, kommt
 *   die Meldung aber trotzdem als Vollbild.
 */
export type LadeArt = 'vollbild' | 'bildschirm' | 'blatt';

interface GrenzeProps {
  art: LadeArt;
  children: ReactNode;
  /** Bei `vollbild`: der Weg zurück, ohne die Seite neu zu laden. */
  onSchliessen?: () => void;
}

interface GrenzeZustand {
  fehler: unknown;
}

/**
 * Ein gescheitertes `import()` – unterschieden von einem Fehler IM Teil.
 *
 * Nur das Laden fängt die Grenze ab. Ein Fehler beim Rechnen im Editor ist
 * etwas anderes; ihn als „konnte nicht geladen werden" zu melden, hiesse,
 * ihn zu verstecken. Er geht weiter nach oben, wie vor dem Nachladen auch.
 */
export class LadeFehler extends Error {
  constructor(ursache: unknown) {
    super('Ein Teil der App konnte nicht geladen werden', { cause: ursache });
    this.name = 'LadeFehler';
  }
}

/** Fängt einen gescheiterten Ladevorgang ab und sagt, was zu tun ist. */
export class LadeGrenze extends Component<GrenzeProps, GrenzeZustand> {
  override state: GrenzeZustand = { fehler: null };

  static getDerivedStateFromError(fehler: unknown): GrenzeZustand {
    return { fehler };
  }

  override componentDidCatch(fehler: unknown, info: ErrorInfo) {
    if (fehler instanceof LadeFehler)
      console.warn('[nachladen]', fehler.cause, info.componentStack);
  }

  override render() {
    if (!this.state.fehler) return this.props.children;
    // Kein Ladefehler: weiterreichen, als gäbe es diese Grenze nicht.
    if (!(this.state.fehler instanceof LadeFehler)) throw this.state.fehler;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const inhalt = (
      <div className="nachladen-fehler" role="alert">
        <strong>Dieser Teil der App konnte nicht geladen werden.</strong>
        <span>
          {offline
            ? 'Du bist gerade offline. Sobald du wieder Netz hast, lade die App neu.'
            : 'Vermutlich gibt es eine neue Fassung der App. Neu laden behebt das.'}
        </span>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          {this.props.onSchliessen && (
            <button type="button" className="btn" onClick={this.props.onSchliessen}>
              Schließen
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Neu laden
          </button>
        </div>
      </div>
    );
    return <Rahmen art={this.props.art}>{inhalt}</Rahmen>;
  }
}

/**
 * Die Fläche für Platzhalter und Fehlermeldung.
 *
 * `vollbild` liegt über allem wie die Werkstatt selbst, die gleich kommt –
 * so springt nichts, wenn sie da ist. `bildschirm` füllt den Platz einer
 * Seite unter der Kopfleiste.
 */
function Rahmen({ art, children }: { art: LadeArt; children: ReactNode }) {
  if (art !== 'bildschirm') {
    return createPortal(<div className="nachladen-schleier">{children}</div>, document.body);
  }
  return <div className="nachladen-seite">{children}</div>;
}

function Platzhalter({ art }: { art: LadeArt }) {
  if (art === 'blatt') return null;
  return (
    <Rahmen art={art}>
      <Spinner label="Wird geladen …" />
    </Rahmen>
  );
}

/**
 * Eine Komponente, deren Code erst beim ersten Zeigen geholt wird.
 *
 * Die Aufrufstelle bleibt dabei unverändert: Was herauskommt, nimmt dieselben
 * Props wie das Original, und Platzhalter wie Fehlergrenze stecken schon
 * darin. Bei `vollbild` und `blatt` schliesst „Schließen" über die
 * `onClose`-Prop des Originals – alle Werkstätten heissen dort gleich.
 */
export function nachladbar<P extends object>(
  laden: () => Promise<ComponentType<P>>,
  art: LadeArt = 'vollbild',
): ComponentType<P> {
  /*
   * Kein zweiter Versuch ohne Neuladen: Der Browser merkt sich ein
   * gescheitertes Modul (nachgemessen in Chromium) – ein neues `import()`
   * derselben Adresse scheitert sofort wieder. Deshalb bietet die Grenze
   * „Neu laden" an und nicht „Erneut versuchen".
   */
  const Spaeter = lazy(async () => {
    try {
      return { default: await laden() };
    } catch (ursache) {
      throw new LadeFehler(ursache);
    }
  });
  function Nachgeladen(props: P) {
    const schliessen = (props as { onClose?: unknown }).onClose;
    return (
      <LadeGrenze
        art={art}
        onSchliessen={typeof schliessen === 'function' ? (schliessen as () => void) : undefined}
      >
        <Suspense fallback={<Platzhalter art={art} />}>
          <Spaeter {...props} />
        </Suspense>
      </LadeGrenze>
    );
  }
  return Nachgeladen;
}
