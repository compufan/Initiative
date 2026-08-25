import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCents, type ExpenseDto } from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ExpenseSheet } from '../expenses/ExpenseSheet.js';

interface EventExpensesProps {
  eventId: string;
  conversationId: string | null;
}

/**
 * Was der Termin gekostet hat.
 *
 * Dieselben Ausgaben wie unter „Ausgaben“, nur auf diesen Termin gefiltert –
 * es ist keine zweite Kasse, sondern derselbe Blick von einer anderen Seite.
 */
export function EventExpenses({ eventId, conversationId }: EventExpensesProps) {
  const myId = useMyId();
  const [items, setItems] = useState<ExpenseDto[]>([]);
  const [laedt, setLaedt] = useState(true);
  const [neu, setNeu] = useState(false);

  const laden = useCallback(async () => {
    setLaedt(true);
    try {
      setItems((await api.expenses.list({ eventId })).items);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ausgaben nicht ladbar');
    } finally {
      setLaedt(false);
    }
  }, [eventId]);

  useEffect(() => {
    void laden();
  }, [laden]);

  const summe = items.reduce((wert, expense) => wert + expense.amountCents, 0);
  const meins = items.reduce(
    (wert, expense) =>
      wert + (expense.shares.find((share) => share.userId === myId)?.amountCents ?? 0),
    0,
  );

  return (
    <section className="card stack" aria-labelledby="cal-exp-title">
      <div className="row row-between">
        <h2 id="cal-exp-title" className="cal-block-title">
          Ausgaben
        </h2>
        <button type="button" className="btn btn-sm" onClick={() => setNeu(true)}>
          Ausgabe eintragen
        </button>
      </div>

      {laedt && items.length === 0 ? (
        <Spinner label="Ausgaben werden geladen …" />
      ) : items.length === 0 ? (
        <p className="cal-hint">
          Noch nichts eingetragen. Was hier landet, taucht auch unter „Ausgaben“ auf – es ist
          dieselbe Kasse.
        </p>
      ) : (
        <>
          <ul className="list">
            {items.map((expense) => (
              <li key={expense.id} className="cal-doc">
                <span className="truncate">{expense.title}</span>
                <span className="cal-doc-meta">
                  {formatCents(expense.amountCents, expense.currency)}
                </span>
              </li>
            ))}
          </ul>
          <p className="cal-hint">
            Zusammen {formatCents(summe)} · dein Anteil {formatCents(meins)} ·{' '}
            <Link to="/ausgaben">alle Ausgaben und Salden</Link>
          </p>
        </>
      )}

      <ExpenseSheet
        open={neu}
        onClose={() => setNeu(false)}
        conversationId={conversationId}
        eventId={eventId}
        onSaved={() => void laden()}
      />
    </section>
  );
}
