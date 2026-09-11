/**
 * Die beiden Streifen zur Verlaufsgrenze.
 *
 * `VerlaufsGrenze` steht oben im Verlauf, dort wo er aufhört – das ist die
 * Stelle, an der die Frage entsteht. `VerlaufsAntraege` steht unter der
 * Kopfzeile, weil es eine Handlung von mir verlangt und nicht darauf warten
 * darf, dass ich nach oben scrolle.
 */
import { useEffect } from 'react';
import type { ConversationDto } from '@initiative/shared';
import { toast } from '../../state/ui.js';
import { antraegeVon, useVerlauf } from '../../state/verlauf.js';
import { memberName } from './helpers.js';
import { eigeneLage, fremdeAntraege } from './verlaufBand.js';

function seitWann(iso: string): string {
  const datum = new Date(iso);
  if (Number.isNaN(datum.getTime())) return 'deinem Beitritt';
  return datum.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

function melden(fehler: unknown): void {
  toast(fehler instanceof Error ? fehler.message : 'Das hat gerade nicht geklappt', 'error');
}

/** Lädt die offenen Anträge, sobald ein Gespräch geöffnet wird. */
export function useVerlaufsantraege(conversationId: string): void {
  const laden = useVerlauf((state) => state.laden);
  useEffect(() => {
    if (!conversationId) return;
    void laden(conversationId).catch(() => {
      /* Ein fehlender Streifen ist kein Grund für eine Fehlermeldung. */
    });
  }, [conversationId, laden]);
}

interface Props {
  conversation: ConversationDto | null;
  myId: string;
}

export function VerlaufsGrenze({ conversation, myId }: Props) {
  const antraege = useVerlauf((state) => antraegeVon(state, conversation?.id ?? ''));
  const laeuft = useVerlauf((state) => state.laeuft[conversation?.id ?? ''] ?? false);
  const stellen = useVerlauf((state) => state.stellen);
  const zurueckziehen = useVerlauf((state) => state.zurueckziehen);

  const lage = eigeneLage(conversation, antraege, myId);
  if (!conversation || lage.art === 'sieht-alles') return null;

  if (lage.art === 'niemand-da') {
    return (
      <div className="verlauf-grenze">
        <p className="verlauf-grenze-text">
          Hier beginnt, was du sehen kannst – seit {seitWann(lage.seit)}. Was davor geschrieben
          wurde, gehört denen, die damals dabei waren; von ihnen ist niemand mehr im Chat.
        </p>
      </div>
    );
  }

  if (lage.art === 'beantragt') {
    const gesamt = lage.offen + lage.zugestimmt;
    return (
      <div className="verlauf-grenze">
        <p className="verlauf-grenze-text">
          Du hast den älteren Verlauf beantragt. {lage.zugestimmt} von {gesamt}{' '}
          {gesamt === 1 ? 'hat' : 'haben'} zugestimmt – es müssen alle sein.
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={laeuft}
          onClick={() => {
            void zurueckziehen(conversation.id, lage.antrag.id).catch(melden);
          }}
        >
          Antrag zurückziehen
        </button>
      </div>
    );
  }

  return (
    <div className="verlauf-grenze">
      <p className="verlauf-grenze-text">
        Hier beginnt, was du sehen kannst – seit {seitWann(lage.seit)}. Den Verlauf davor bekommst
        du nur, wenn alle anderen im Chat zustimmen.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        disabled={laeuft}
        onClick={() => {
          void stellen(conversation.id)
            .then(() => toast('Antrag gestellt – die anderen werden gefragt', 'info'))
            .catch(melden);
        }}
      >
        Älteren Verlauf beantragen
      </button>
    </div>
  );
}

export function VerlaufsAntraege({ conversation, myId }: Props) {
  const antraege = useVerlauf((state) => antraegeVon(state, conversation?.id ?? ''));
  const laeuft = useVerlauf((state) => state.laeuft[conversation?.id ?? ''] ?? false);
  const abstimmen = useVerlauf((state) => state.abstimmen);

  if (!conversation) return null;
  const offen = fremdeAntraege(antraege, myId);
  if (offen.length === 0) return null;

  return (
    <div className="verlauf-antraege">
      {offen.map(({ antrag, meineStimme }) => {
        const mitglied = conversation.members.find((m) => m.userId === antrag.antragsteller);
        const name = mitglied ? memberName(mitglied) : 'Jemand';
        return (
          <div key={antrag.id} className="verlauf-antrag" role="group" aria-label={`Antrag von ${name}`}>
            <p className="verlauf-antrag-text">
              <strong>{name}</strong> möchte auch lesen, was vor dem Beitritt geschrieben wurde.
              {meineStimme === null
                ? ' Dafür müssen alle zustimmen – auch du.'
                : meineStimme === 'ja'
                  ? ' Du hast zugestimmt.'
                  : ' Du hast abgelehnt.'}
            </p>
            {/*
              * Solange ich nicht abgestimmt habe, wiegen beide Knöpfe gleich
              * schwer. Bei einer Abstimmung, die Einstimmigkeit verlangt,
              * wäre ein hervorgehobenes „Zustimmen" ein Schubs – und wer
              * nicht will, dass ein Neuer mitliest, soll das nicht gegen das
              * Layout durchsetzen müssen.
              */}
            <div className="verlauf-antrag-knoepfe">
              <button
                type="button"
                className={`btn btn-sm ${meineStimme === 'ja' ? 'btn-primary' : meineStimme === 'nein' ? 'btn-ghost' : ''}`}
                disabled={laeuft || meineStimme === 'ja'}
                aria-pressed={meineStimme === 'ja'}
                onClick={() => {
                  void abstimmen(conversation.id, antrag.id, true).catch(melden);
                }}
              >
                Zustimmen
              </button>
              <button
                type="button"
                className={`btn btn-sm ${meineStimme === 'nein' ? 'btn-danger' : meineStimme === 'ja' ? 'btn-ghost' : ''}`}
                disabled={laeuft || meineStimme === 'nein'}
                aria-pressed={meineStimme === 'nein'}
                onClick={() => {
                  void abstimmen(conversation.id, antrag.id, false).catch(melden);
                }}
              >
                Ablehnen
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
