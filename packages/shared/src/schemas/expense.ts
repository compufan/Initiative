import { z } from 'zod';

/**
 * Ausgaben: wer hat ausgelegt, wer schuldet wem wie viel.
 *
 * Alle Beträge in **Cent**. Fließkomma wäre bei Geld die falsche Zahlenart –
 * 0.1 + 0.2 ergibt darin nicht 0.3, und das summiert sich zu Beträgen, die
 * niemand nachrechnen kann.
 */

/** Wer eine Ausgabe überhaupt sehen darf. */
export const EXPENSE_VISIBILITIES = ['participants', 'conversation', 'listed'] as const;
export type ExpenseVisibility = (typeof EXPENSE_VISIBILITIES)[number];

export interface ExpenseShareDto {
  userId: string;
  amountCents: number;
  settledAt: string | null;
  /**
   * Wer abgehakt hat.
   *
   * Ist das der Schuldner selbst, ist es eine **Meldung** („ich habe
   * überwiesen“). Ist es der Auslegende, eine **Bestätigung** („ist
   * angekommen“). Der Unterschied ist genau der Punkt, an dem sich Leute sonst
   * uneinig werden, deshalb steht er dabei.
   */
  settledBy: string | null;
}

export interface ExpenseDto {
  id: string;
  conversationId: string | null;
  /** Zu welchem Termin sie gehört, falls zu einem. */
  eventId: string | null;
  createdBy: string | null;
  title: string;
  note: string | null;
  amountCents: number;
  currency: string;
  /** Wer ausgelegt hat. */
  paidBy: string | null;
  spentAt: string;
  visibility: ExpenseVisibility;
  /** Bei `listed`: wer sie sehen darf. */
  viewerIds: string[];
  /** Wem sie ausdrücklich verborgen bleibt – das Geschenk vor dem Beschenkten. */
  hiddenFromIds: string[];
  shares: ExpenseShareDto[];
  settledAt: string | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Was zwei Personen einander schulden – aus meiner Sicht. */
export interface BalanceDto {
  userId: string;
  /** Positiv: die Person schuldet mir. Negativ: ich schulde ihr. */
  netCents: number;
  currency: string;
}

export interface PaymentProfileDto {
  userId: string;
  /** Nur der Name aus dem persönlichen PayPal.Me-Link – kein Geschäftskonto. */
  paypalMe: string | null;
  iban: string | null;
  bic: string | null;
  accountHolder: string | null;
  note: string | null;
}

export const expenseShareSchema = z.object({
  userId: z.string().uuid(),
  /** Fester Anteil in Cent. Ohne Angabe wird gleichmäßig geteilt. */
  amountCents: z.number().int().nonnegative().optional(),
});

export const createExpenseSchema = z.object({
  conversationId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  note: z.string().max(2000).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  paidBy: z.string().uuid().optional(),
  spentAt: z.string().optional(),
  shares: z.array(expenseShareSchema).min(1),
  visibility: z.enum(EXPENSE_VISIBILITIES).optional(),
  viewerIds: z.array(z.string().uuid()).optional(),
  hiddenFromIds: z.array(z.string().uuid()).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const paymentProfileSchema = z.object({
  paypalMe: z.string().max(120).nullable().optional(),
  iban: z.string().max(40).nullable().optional(),
  bic: z.string().max(16).nullable().optional(),
  accountHolder: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});
export type PaymentProfileInput = z.infer<typeof paymentProfileSchema>;

/**
 * Teilt einen Betrag so auf, dass die Summe **genau** stimmt.
 *
 * 10 Euro auf drei Personen sind 3,34 + 3,33 + 3,33 – nicht dreimal 3,33.
 * Dieselbe Rechnung wie im Server (`services/expenses.rs`), damit die
 * Vorschau in der App zeigt, was hinterher wirklich gespeichert wird.
 */
export function splitEvenly(amountCents: number, anzahl: number): number[] {
  if (anzahl <= 0) return [];
  const grundbetrag = Math.trunc(amountCents / anzahl);
  const rest = amountCents % anzahl;
  return Array.from({ length: anzahl }, (_, index) => grundbetrag + (index < rest ? 1 : 0));
}

/** „12,34 €“ – aus Cent, ohne den Umweg über Fließkomma-Arithmetik. */
export function formatCents(amountCents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amountCents / 100);
}

/**
 * Liest einen eingetippten Betrag als Cent.
 *
 * Nimmt Komma und Punkt gleichermaßen – auf einer deutschen Tastatur tippt man
 * „12,50“, auf einem Zahlenfeld oft „12.50“. `null`, wenn es kein Betrag ist.
 */
export function parseAmount(value: string): number | null {
  const sauber = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(sauber)) return null;
  // Über den String runden statt über `* 100`: 19.99 * 100 ist in Fließkomma
  // 1998.9999999999998, und daraus würden 1998 Cent.
  const [ganz, bruch = ''] = sauber.split('.');
  return Number(ganz) * 100 + Number(bruch.padEnd(2, '0'));
}

/**
 * Der persönliche PayPal.Me-Link mit Betrag.
 *
 * Ohne Geschäftskonto: Das ist der Link, den jeder kostenlos anlegen kann.
 * `null`, wenn der Name unbrauchbar ist – dieselbe Prüfung wie im Server.
 */
export function paypalMeUrl(
  name: string | null,
  amountCents: number,
  currency = 'EUR',
): string | null {
  if (!name) return null;
  const ohneAt = name.trim().replace(/^@/, '');
  const teile = ohneAt.split('paypal.me/');
  const sauber = (teile.length > 1 ? teile[teile.length - 1] : ohneAt).replace(/^\/+|\/+$/g, '');
  if (!sauber || !/^[A-Za-z0-9-]+$/.test(sauber)) return null;
  const betrag = (Math.abs(amountCents) / 100).toFixed(2);
  return `https://paypal.me/${sauber}/${betrag}${currency}`;
}
