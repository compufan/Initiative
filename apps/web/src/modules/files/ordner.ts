import {
  allowsLevel,
  buildCollectionTree,
  LIMITS,
  type CollectionDto,
  type CollectionNode,
} from '@initiative/shared';
import { pfadZu } from './state.js';

/**
 * Die Rechnung hinter der Ordnerwahl – rein, damit sie ohne Oberfläche
 * geprüft werden kann.
 *
 * Eine Sammlung ist ein Ordner; „in einen Ordner legen“ heisst, einen
 * Elternordner zu wählen. Was dort zur Wahl steht, hängt an zwei Dingen, die
 * der Server noch einmal selbst entscheidet: ob man im Ordner etwas anlegen
 * darf (`edit`) und wie tief er schon liegt. Die Oberfläche fragt nur, damit
 * kein Knopf zu sehen ist, der sicher scheitert.
 */

/** Warum eine Zeile nicht wählbar ist – `null`, wenn sie es ist. */
export type OrdnerGrund = null | 'nurAnsehen' | 'zuTief';

export interface OrdnerZeile {
  collection: CollectionDto;
  /** Einrückung: 0 für die oberste sichtbare Ebene. */
  depth: number;
  wahlbar: boolean;
  grund: OrdnerGrund;
  /**
   * Steht nur da, weil darunter ein Treffer liegt – für die Anzeige gedämpft.
   * Mit „nicht wählbar“ hat das nichts zu tun: Ein änderbarer Ordner bleibt
   * wählbar, auch wenn der Filter ihn nicht meint.
   */
  gedaempft: boolean;
}

export interface OrdnerOptionen {
  /** Nur Ordner, in denen man ändern darf (Vorgabe). */
  nurAendern?: boolean;
  /** Ebenen, die der Server zulässt; die Wurzel ist Ebene 1. */
  maxTiefe?: number;
  /** Ordner, die der Server schon als zu tief abgelehnt hat. */
  zuTiefIds?: ReadonlySet<string>;
  filter?: string;
}

/**
 * Wie viele Ebenen der Pfad bis hierher hat – die Wurzel zählt als Ebene 1,
 * wie auf dem Server.
 *
 * Das ist die Länge des SICHTBAREN Pfads. Ist ein Elternordner für diesen
 * Nutzer unsichtbar, liegt der Ordner in Wahrheit tiefer – die Zahl ist dann
 * nur eine Untergrenze, und der Server hat das letzte Wort.
 */
export function ebenen(collections: CollectionDto[], id: string): number {
  return pfadZu(collections, id).length;
}

function normal(text: string): string {
  return text.trim().toLocaleLowerCase('de');
}

/**
 * Alle Ordner in Baumreihenfolge, flach, mit Einrückung und Wählbarkeit.
 *
 * Ein Ordner, in dem man nur ansehen darf, bleibt als graue Zeile stehen,
 * WENN darunter etwas Änderbares liegt – sonst hinge das Kind ohne
 * Zusammenhang in der Luft. Ohne änderbaren Nachfahren fehlt er ganz: So
 * steht in der Liste nur, was sich irgendwie wählen lässt, ohne dass der
 * Baum zerreisst.
 *
 * Der Filter lässt Treffer samt ihren Vorfahren stehen.
 */
export function ordnerZeilen(
  collections: CollectionDto[],
  {
    nurAendern = true,
    maxTiefe = LIMITS.collectionDepthMax,
    zuTiefIds,
    filter = '',
  }: OrdnerOptionen = {},
): OrdnerZeile[] {
  const suche = normal(filter);

  function baue(knoten: CollectionNode): OrdnerZeile[] {
    const kinder = knoten.children.flatMap(baue);
    const { collection } = knoten;
    const aenderbar = !nurAendern || allowsLevel(collection.myLevel, 'edit');
    const trifft = suche === '' || normal(collection.name).includes(suche);

    // Weder selbst brauchbar noch Zusammenhang für etwas, das es ist.
    if (!(aenderbar && trifft) && kinder.length === 0) return [];

    const zuTief = knoten.depth + 1 >= maxTiefe || (zuTiefIds?.has(collection.id) ?? false);
    const grund: OrdnerGrund = !aenderbar ? 'nurAnsehen' : zuTief ? 'zuTief' : null;
    return [
      { collection, depth: knoten.depth, wahlbar: grund === null, grund, gedaempft: !trifft },
      ...kinder,
    ];
  }

  return buildCollectionTree(collections).flatMap(baue);
}

/**
 * Der Pfad als Text: `Eltern › Kind`.
 *
 * Höchstens die letzten `max` Ebenen; was davor liegt, steht als „… › “. Das
 * gilt auch, wenn der oberste sichtbare Ordner selbst einen Elternordner hat,
 * den man nicht sehen darf – sonst sähe ein Unterordner wie eine oberste
 * Sammlung aus.
 */
export function pfadText(collections: CollectionDto[], id: string, { max = 3 } = {}): string {
  const pfad = pfadZu(collections, id);
  const oberster = pfad[0];
  if (!oberster) return '';
  const gekuerzt = pfad.length > max || oberster.parentId !== null;
  const sichtbar = pfad.slice(-max).map((eintrag) => eintrag.name);
  return `${gekuerzt ? '… › ' : ''}${sichtbar.join(' › ')}`;
}

/**
 * Liegt unter diesem Ordner schon eine Sammlung mit dem Namen?
 *
 * Gross-/Kleinschreibung und Randleerzeichen zählen nicht. Für die oberste
 * Ebene (`null`) gehören auch die dazu, deren Elternordner man nicht sehen
 * darf – sie stehen für diesen Nutzer ja ebenfalls oben.
 */
export function gleichnamigUnter(
  collections: CollectionDto[],
  parentId: string | null,
  name: string,
): CollectionDto | undefined {
  const gesucht = normal(name);
  if (gesucht === '') return undefined;
  const bekannt = new Set(collections.map((eintrag) => eintrag.id));
  return collections.find((eintrag) => {
    const eltern = eintrag.parentId && bekannt.has(eintrag.parentId) ? eintrag.parentId : null;
    return eltern === parentId && normal(eintrag.name) === gesucht;
  });
}
