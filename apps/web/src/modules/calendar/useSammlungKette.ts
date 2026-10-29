import { useEffect, useState } from 'react';
import type { CollectionDto } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { pfadZu } from '../files/state.js';
import type { KettenGlied } from './terminSammlung.js';

/**
 * Die Rechte jedes Ordners auf dem Weg zu dieser Sammlung – für die Frage,
 * wer hineinkommt.
 *
 * Parallel (höchstens acht Aufrufe, so tief darf der Baum sein). Ein Ordner,
 * dessen Rechte nicht zu laden sind, geht mit `grants: null` in die Kette:
 * Die Rechnung zählt davon dann nichts, sagt also weniger, aber nie etwas
 * Falsches.
 *
 * `null` heisst „wird geladen“ – und bleibt es, solange die Antwort zu einer
 * früheren Sammlung gehört: Sonst stünde beim Umschalten kurz die Auskunft
 * des alten Ordners unter dem Namen des neuen.
 *
 * `neu` zählt hoch, wenn die Rechte sich geändert haben (nach dem Freigeben).
 */
export function useSammlungKette(
  collections: CollectionDto[],
  sammlungId: string | null,
  neu = 0,
): KettenGlied[] | null {
  const pfadSchluessel = sammlungId
    ? pfadZu(collections, sammlungId)
        .map((eintrag) => eintrag.id)
        .join(',')
    : '';
  const schluessel = `${pfadSchluessel}#${neu}`;
  const [kette, setKette] = useState<{ fuer: string; glieder: KettenGlied[] } | null>(null);

  useEffect(() => {
    if (!pfadSchluessel) return undefined;
    let abgebrochen = false;
    // `collections` ändert sich bei jedem Anlegen; der Pfad ist, worauf es ankommt.
    const sammlungen = pfadZu(collections, sammlungId ?? '');
    void Promise.all(
      sammlungen.map(async (sammlung): Promise<KettenGlied> => {
        const grants = await api.collections
          .grants(sammlung.id)
          .then((antwort) => antwort.items)
          .catch(() => null);
        return { sammlung, grants };
      }),
    ).then((glieder) => {
      if (!abgebrochen) setKette({ fuer: schluessel, glieder });
    });
    return () => {
      abgebrochen = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel]);

  return kette && kette.fuer === schluessel ? kette.glieder : null;
}
