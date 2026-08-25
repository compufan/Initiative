import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatCents,
  type BalanceDto,
  type ExpenseDto,
  type UserDto,
} from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ExpenseSheet } from './ExpenseSheet.js';
import { SettleSheet } from './SettleSheet.js';

/**
 * „Ausgaben“ – wer hat ausgelegt, wer schuldet wem wie viel.
 *
 * Ganz oben steht die Antwort auf die einzige Frage, die wirklich jeden
 * interessiert: Schulde ich, oder schuldet man mir. Die Liste der einzelnen
 * Ausgaben kommt darunter.
 */
export function AusgabenScreen() {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);

  const [chatId, setChatId] = useState('');
  const [expenses, setExpenses] = useState<ExpenseDto[]>([]);
  const [balances, setBalances] = useState<BalanceDto[]>([]);
  const [leute, setLeute] = useState<Record<string, UserDto>>({});
  const [laedt, setLaedt] = useState(true);
  const [neu, setNeu] = useState(false);
  const [zahlen, setZahlen] = useState<BalanceDto | null>(null);

  const laden = useCallback(async () => {
    setLaedt(true);
    try {
      const [liste, salden] = await Promise.all([
        api.expenses.list({ conversationId: chatId || undefined }),
        api.expenses.balances(chatId || undefined),
      ]);
      setExpenses(liste.items);
      setBalances(salden.items);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ausgaben nicht ladbar');
    } finally {
      setLaedt(false);
    }
  }, [chatId]);

  useEffect(() => {
    void laden();
  }, [laden]);

  // Namen zu allen Kennungen, die irgendwo auftauchen.
  useEffect(() => {
    const ids = new Set<string>();
    for (const eintrag of balances) ids.add(eintrag.userId);
    for (const expense of expenses) {
      if (expense.paidBy) ids.add(expense.paidBy);
      for (const share of expense.shares) ids.add(share.userId);
    }
    const fehlend = [...ids].filter((id) => id !== myId && !leute[id]);
    if (fehlend.length === 0) return;
    void Promise.all(fehlend.map((id) => api.users.byId(id).catch(() => null))).then((ergebnis) => {
      const neueLeute: Record<string, UserDto> = {};
      for (const person of ergebnis) if (person) neueLeute[person.id] = person;
      if (Object.keys(neueLeute).length > 0) setLeute((alt) => ({ ...alt, ...neueLeute }));
    });
  }, [balances, expenses, leute, myId]);

  const name = useCallback(
    (id: string | null) =>
      id == null ? 'Unbekannt' : id === myId ? 'Du' : (leute[id]?.displayName ?? 'Unbekannt'),
    [leute, myId],
  );

  const summe = useMemo(
    () => balances.reduce((wert, eintrag) => wert + eintrag.netCents, 0),
    [balances],
  );
  const waehrung = balances[0]?.currency ?? 'EUR';

  return (
    <Screen
      title="Ausgaben"
      subtitle="Wer hat ausgelegt, wer schuldet wem"
      actions={
        <button
          type="button"
          className="icon-btn"
          aria-label="Ausgabe eintragen"
          onClick={() => setNeu(true)}
        >
          ＋
        </button>
      }
    >
      <div className="field">
        <label htmlFor="exp-filter">Chat</label>
        <select
          id="exp-filter"
          className="select"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
        >
          <option value="">Alle</option>
          {conversations.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title ?? (chat.type === 'group' ? 'Gruppe' : 'Chat')}
            </option>
          ))}
        </select>
      </div>

      <section className="card stack" aria-labelledby="exp-balance-title">
        <h2 id="exp-balance-title" className="exp-title">
          Salden
        </h2>
        {laedt && balances.length === 0 ? (
          <Spinner label="Wird gerechnet …" />
        ) : balances.length === 0 ? (
          <p className="exp-hint">Alles ausgeglichen. Niemand schuldet niemandem etwas.</p>
        ) : (
          <>
            <p className={`exp-summe ${summe < 0 ? 'exp-minus' : 'exp-plus'}`}>
              {summe >= 0
                ? `Dir wird ${formatCents(summe, waehrung)} geschuldet`
                : `Du schuldest ${formatCents(-summe, waehrung)}`}
            </p>
            <ul className="list">
              {balances.map((eintrag) => (
                <li key={eintrag.userId} className="exp-balance">
                  <span className="truncate">{name(eintrag.userId)}</span>
                  <span className={eintrag.netCents < 0 ? 'exp-minus' : 'exp-plus'}>
                    {eintrag.netCents < 0
                      ? `du schuldest ${formatCents(-eintrag.netCents, eintrag.currency)}`
                      : `schuldet dir ${formatCents(eintrag.netCents, eintrag.currency)}`}
                  </span>
                  {eintrag.netCents < 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => setZahlen(eintrag)}>
                      Zurückzahlen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {laedt && expenses.length === 0 ? null : expenses.length === 0 ? (
        <EmptyState
          emoji="🧾"
          title="Noch keine Ausgabe"
          description="Trag ein, was du ausgelegt hast – die App rechnet aus, wer dir wie viel schuldet."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setNeu(true)}>
              Ausgabe eintragen
            </button>
          }
        />
      ) : (
        <section className="stack" aria-label="Ausgaben">
          {expenses.map((expense) => (
            <ExpenseCard
              key={expense.id}
              expense={expense}
              name={name}
              myId={myId}
              onChanged={laden}
            />
          ))}
        </section>
      )}

      <ExpenseSheet
        open={neu}
        onClose={() => setNeu(false)}
        conversationId={chatId || null}
        onSaved={() => void laden()}
      />

      {zahlen && (
        <SettleSheet
          open
          onClose={() => setZahlen(null)}
          userId={zahlen.userId}
          displayName={name(zahlen.userId)}
          amountCents={zahlen.netCents}
          currency={zahlen.currency}
        />
      )}
    </Screen>
  );
}

function ExpenseCard({
  expense,
  name,
  myId,
  onChanged,
}: {
  expense: ExpenseDto;
  name: (id: string | null) => string;
  myId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const meiner = expense.shares.find((share) => share.userId === myId);
  const offen = expense.shares.filter((share) => share.settledAt == null).length;

  async function abhaken() {
    setBusy(true);
    try {
      await api.expenses.settle(expense.id, { settled: meiner?.settledAt == null });
      await onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nicht gespeichert');
    } finally {
      setBusy(false);
    }
  }

  async function loeschen() {
    setBusy(true);
    try {
      await api.expenses.remove(expense.id);
      await onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
      setBusy(false);
    }
  }

  return (
    <article className="card exp-card">
      <div className="row row-between">
        <strong className="truncate">{expense.title}</strong>
        <span className="exp-amount">{formatCents(expense.amountCents, expense.currency)}</span>
      </div>
      <p className="exp-meta">
        {name(expense.paidBy)} hat ausgelegt · {new Date(expense.spentAt).toLocaleDateString('de-DE')}
        {expense.hiddenFromIds.length > 0 && (
          <span className="exp-tag" title="Diese Ausgabe ist vor jemandem verborgen">
            verborgen
          </span>
        )}
      </p>
      {expense.note && <p className="exp-note">{expense.note}</p>}

      <ul className="exp-shares">
        {expense.shares.map((share) => (
          <li key={share.userId} className={share.settledAt ? 'exp-settled' : undefined}>
            <span className="truncate">{name(share.userId)}</span>
            <span>{formatCents(share.amountCents, expense.currency)}</span>
            {share.settledAt && <span aria-label="beglichen">✓</span>}
          </li>
        ))}
      </ul>

      <div className="row">
        {meiner && meiner.userId !== expense.paidBy && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void abhaken()}>
            {meiner.settledAt ? 'Doch noch offen' : 'Bezahlt'}
          </button>
        )}
        {expense.canEdit && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => void loeschen()}
          >
            Löschen
          </button>
        )}
        {offen === 0 && <span className="exp-tag">abgerechnet</span>}
      </div>
    </article>
  );
}
