import { useEffect, useState } from 'react';
import { formatCents, type PaymentProfileDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

interface SettleSheetProps {
  open: boolean;
  onClose: () => void;
  /** Wem ich Geld schulde. */
  userId: string;
  displayName: string;
  amountCents: number;
  currency: string;
}

/**
 * „Zurückzahlen“ – wie man dem anderen sein Geld gibt.
 *
 * Ausdrücklich ohne PayPal-Geschäftskonto: Der Link ist der persönliche
 * PayPal.Me-Link, den jeder kostenlos anlegen kann. Es läuft kein Geld über
 * diese App, es fallen keine Gebühren an, und es gibt nichts einzurichten.
 * Wer PayPal nicht mag, bekommt die Bankdaten zum Kopieren.
 */
export function SettleSheet({
  open,
  onClose,
  userId,
  displayName,
  amountCents,
  currency,
}: SettleSheetProps) {
  const [profile, setProfile] = useState<PaymentProfileDto | null>(null);
  const [paypalUrl, setPaypalUrl] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);

  useEffect(() => {
    if (!open) return;
    let abgebrochen = false;
    setLaedt(true);
    void api.expenses
      .paymentProfileOf(userId, Math.abs(amountCents), currency)
      .then((ergebnis) => {
        if (abgebrochen) return;
        setProfile(ergebnis.profile);
        setPaypalUrl(ergebnis.paypalUrl);
      })
      .catch((error: unknown) => {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Nicht abrufbar');
      })
      .finally(() => {
        if (!abgebrochen) setLaedt(false);
      });
    return () => {
      abgebrochen = true;
    };
  }, [open, userId, amountCents, currency]);

  async function kopieren(text: string, was: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${was} kopiert.`);
    } catch {
      // Ohne Zwischenablage (unsicherer Kontext, alte Browser) bleibt der
      // Text auf dem Bildschirm zum Abschreiben – kein Grund für einen Fehler.
      toast('Kopieren geht hier nicht – der Text steht oben zum Abschreiben.');
    }
  }

  const hatZahlweg = Boolean(paypalUrl || profile?.iban);

  return (
    <Sheet open={open} onClose={onClose} title={`${formatCents(Math.abs(amountCents), currency)} an ${displayName}`}>
      {laedt ? (
        <Spinner label="Zahlungswege werden geladen …" />
      ) : (
        <div className="stack">
          {!hatZahlweg && (
            <p className="exp-hint">
              {displayName} hat noch keinen Zahlungsweg hinterlegt. Ihr müsst das direkt klären –
              oder {displayName} trägt unter Profil → Zahlungswege PayPal.Me oder eine IBAN ein.
            </p>
          )}

          {paypalUrl && (
            <a className="btn btn-primary btn-block" href={paypalUrl} target="_blank" rel="noreferrer">
              Mit PayPal.Me senden
            </a>
          )}

          {profile?.iban && (
            <section className="exp-bank stack">
              <strong>Überweisung</strong>
              <Zeile
                label="Empfänger"
                wert={profile.accountHolder ?? displayName}
                onCopy={kopieren}
              />
              <Zeile label="IBAN" wert={formatIban(profile.iban)} onCopy={kopieren} />
              {profile.bic && <Zeile label="BIC" wert={profile.bic} onCopy={kopieren} />}
              <Zeile
                label="Betrag"
                wert={formatCents(Math.abs(amountCents), currency)}
                onCopy={kopieren}
              />
            </section>
          )}

          {profile?.note && <p className="exp-hint">{profile.note}</p>}

          <p className="exp-hint">
            Über diese App läuft kein Geld. Sie zeigt nur, wohin – bezahlt wird direkt zwischen
            euch.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function Zeile({
  label,
  wert,
  onCopy,
}: {
  label: string;
  wert: string;
  onCopy: (text: string, was: string) => void;
}) {
  return (
    <div className="exp-bank-row">
      <span className="exp-bank-label">{label}</span>
      <span className="exp-bank-value truncate">{wert}</span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onCopy(wert.replace(/\s/g, ''), label)}
      >
        Kopieren
      </button>
    </div>
  );
}

/** IBAN in Vierergruppen – so steht sie auf jedem Kontoauszug. */
function formatIban(iban: string): string {
  return iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}
