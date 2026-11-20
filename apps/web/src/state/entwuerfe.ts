import { create } from 'zustand';
import type { EntwurfDto } from '@initiative/shared';
import { ApiError, api } from '../lib/api.js';
import { readMeta, writeMeta } from '../lib/db.js';

/**
 * Entwürfe je Chat – sofort lokal, gedrosselt auf dem Server.
 *
 * Lokal liegt jeder Entwurf im Speicher und in IndexedDB (`meta`), damit ein
 * Neuladen oder ein Absturz nichts verliert. Auf den Server geht er
 * gedrosselt ([`SYNC_MS`] nach der letzten Änderung), damit nicht jeder
 * Tastendruck eine Anfrage wird; die anderen Geräte bekommen ihn über
 * `draft.updated` und beim Laden über `GET /entwuerfe`.
 *
 * # Konfliktregel: der neueste gewinnt
 *
 * `stand` ist die Uhrzeit des Geräts, das zuletzt geschrieben hat. Beim
 * Zusammenführen gilt der jüngere Stand ([`zusammenfuehren`]); der Server
 * wendet dieselbe Regel an und kappt eine vorgehende Uhr auf seine Zeit.
 */
export const SYNC_MS = 1200;
const META_SCHLUESSEL = 'chatentwuerfe';

export interface ChatEntwurf {
  text: string;
  replyToId: string | null;
  /** Millisekunden; der jüngere gewinnt. */
  stand: number;
  /** Schon beim Server? Sonst wird er beim nächsten Abgleich geschickt. */
  synchron: boolean;
}

interface EntwurfState {
  entwuerfe: Record<string, ChatEntwurf>;
}

export const useEntwuerfe = create<EntwurfState>(() => ({ entwuerfe: {} }));

/** Der Server-Stand als lokaler Entwurf. */
export function ausDto(dto: EntwurfDto): ChatEntwurf {
  return {
    text: dto.text ?? '',
    replyToId: dto.text ? dto.replyToId : null,
    stand: dto.updatedAt ? Date.parse(dto.updatedAt) : 0,
    synchron: true,
  };
}

/** Neuester gewinnt; bei Gleichstand der Server (er ist schon bei allen). */
export function zusammenfuehren(
  lokal: ChatEntwurf | undefined,
  server: ChatEntwurf | undefined,
): ChatEntwurf | undefined {
  if (!lokal) return server;
  if (!server) return lokal;
  return lokal.stand > server.stand ? lokal : server;
}

const wecker = new Map<string, ReturnType<typeof setTimeout>>();
let speichernWecker: ReturnType<typeof setTimeout> | null = null;

function speichern(): void {
  if (speichernWecker != null) return;
  speichernWecker = setTimeout(() => {
    speichernWecker = null;
    try {
      void writeMeta(META_SCHLUESSEL, useEntwuerfe.getState().entwuerfe).catch(() => {});
    } catch {
      /* ohne Speicher: nur im Arbeitsspeicher */
    }
  }, 250);
}

function setzenIntern(conversationId: string, entwurf: ChatEntwurf | undefined): void {
  useEntwuerfe.setState((state) => {
    const entwuerfe = { ...state.entwuerfe };
    if (entwurf) entwuerfe[conversationId] = entwurf;
    else delete entwuerfe[conversationId];
    return { entwuerfe };
  });
  speichern();
}

/** Der Anwender hat getippt: sofort lokal, gedrosselt zum Server. */
export function entwurfSetzen(
  conversationId: string,
  text: string,
  replyToId: string | null,
): void {
  const bisher = useEntwuerfe.getState().entwuerfe[conversationId];
  const leer = text.trim().length === 0;
  if (bisher && bisher.text === text && bisher.replyToId === (leer ? null : replyToId)) return;
  if (!bisher && leer) return;
  setzenIntern(conversationId, {
    text,
    replyToId: leer ? null : replyToId,
    // Streng steigend, auch wenn zwei Änderungen in derselben Millisekunde
    // kommen – sonst verlöre die zweite gegen die erste.
    stand: Math.max(Date.now(), (bisher?.stand ?? 0) + 1),
    synchron: false,
  });
  planen(conversationId, SYNC_MS);
}

/** Nach dem Senden: der Entwurf ist erledigt (der Server leert ihn auch). */
export function entwurfErledigt(conversationId: string): void {
  const bisher = useEntwuerfe.getState().entwuerfe[conversationId];
  if (!bisher) return;
  entwurfSetzen(conversationId, '', null);
}

function planen(conversationId: string, ms: number): void {
  const laufend = wecker.get(conversationId);
  if (laufend) clearTimeout(laufend);
  wecker.set(
    conversationId,
    setTimeout(() => {
      wecker.delete(conversationId);
      void hochladen(conversationId);
    }, ms),
  );
}

async function hochladen(conversationId: string): Promise<void> {
  const entwurf = useEntwuerfe.getState().entwuerfe[conversationId];
  if (!entwurf || entwurf.synchron) return;
  try {
    const { entwurf: jetzt } = await api.messages.entwurfSetzen(conversationId, {
      text: entwurf.text.trim() ? entwurf.text : null,
      replyToId: entwurf.replyToId,
      stand: new Date(entwurf.stand).toISOString(),
    });
    const aktuell = useEntwuerfe.getState().entwuerfe[conversationId];
    // Inzwischen weitergetippt: Das Neuere geht beim nächsten Takt.
    if (aktuell && aktuell.stand !== entwurf.stand) return;
    const server = ausDto(jetzt);
    // Gewonnen (Stand gleich) oder verloren (ein anderes Gerät war neuer):
    // In beiden Fällen gilt jetzt, was der Server sagt.
    setzenIntern(conversationId, server.text || server.stand ? server : undefined);
  } catch (error) {
    // Offline: beim nächsten Anlass (Rückkehr, Verbindung) erneut.
    if (!(error instanceof ApiError && error.isOffline)) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // Kein Mitglied mehr o. ä. – lokal behalten, nicht weiter anklopfen.
        const aktuell = useEntwuerfe.getState().entwuerfe[conversationId];
        if (aktuell) setzenIntern(conversationId, { ...aktuell, synchron: true });
      }
    }
  }
}

/** Vom Server gemeldet (anderes Gerät) – übernehmen, wenn neuer. */
export function entwurfVomServer(dto: EntwurfDto): void {
  const lokal = useEntwuerfe.getState().entwuerfe[dto.conversationId];
  const sieger = zusammenfuehren(lokal, ausDto(dto));
  if (sieger !== lokal) setzenIntern(dto.conversationId, sieger);
}

/**
 * Lokal gespeicherte Entwürfe lesen, dann mit dem Server abgleichen: was dort
 * neuer ist, übernehmen; was hier neuer und noch nicht oben ist, schicken.
 */
export async function entwuerfeLaden(): Promise<void> {
  const gespeichert = await Promise.resolve()
    .then(() => readMeta<Record<string, ChatEntwurf>>(META_SCHLUESSEL))
    .catch(() => null);
  if (gespeichert) {
    useEntwuerfe.setState((state) => {
      const entwuerfe = { ...gespeichert };
      for (const [id, entwurf] of Object.entries(state.entwuerfe)) {
        const sieger = zusammenfuehren(entwurf, entwuerfe[id]);
        if (sieger) entwuerfe[id] = sieger;
      }
      return { entwuerfe };
    });
  }
  await entwuerfeAbgleichen();
}

export async function entwuerfeAbgleichen(): Promise<void> {
  let server: EntwurfDto[];
  try {
    server = (await api.messages.entwuerfe()).items;
  } catch {
    return;
  }
  const bekannt = new Set(server.map((dto) => dto.conversationId));
  for (const dto of server) entwurfVomServer(dto);
  // Lokal, aber nicht oben: hochladen. Synchron, aber oben nicht mehr da:
  // anderswo gesendet oder geleert – hier auch weg.
  for (const [id, entwurf] of Object.entries(useEntwuerfe.getState().entwuerfe)) {
    if (!entwurf.synchron) planen(id, 0);
    else if (!bekannt.has(id) && entwurf.text) setzenIntern(id, undefined);
  }
}

export function entwuerfeVergessen(): void {
  for (const laufend of wecker.values()) clearTimeout(laufend);
  wecker.clear();
  useEntwuerfe.setState({ entwuerfe: {} });
}
