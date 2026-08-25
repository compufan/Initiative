import { useEffect, useState } from 'react';
import { formatCents, type PaymentProfileDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useMyName } from '../../state/session.js';
import { toast } from '../../state/ui.js';

interface SettleSheetProps {
  open: boolean;
  onClose: () => void;
  /** Mit wem abgerechnet wird. */
  userId: string;
  displayName: string;
  /** Negativ: ich schulde. Positiv: mir wird geschuldet. */
  amountCents: number;
  currency: string;
  /** Damit die Übersicht sich neu rechnet, sobald abgehakt wurde. */
  onSettled?: () => void;
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
  onSettled,
}: SettleSheetProps) {
  const [profile, setProfile] = useState<PaymentProfileDto | null>(null);
  const [paypalUrl, setPaypalUrl] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [hakt, setHakt] = useState(false);

  // Aus welcher Richtung wird abgerechnet? Davon haengt alles ab: Wer schuldet,
  // MELDET eine Zahlung; wer Geld bekommt, BESTAETIGT ihren Eingang.
  const ichSchulde = amountCents < 0;

  // Was der Empfänger auf dem Kontoauszug lesen soll. Der eigene Anzeigename
  // ist die einzige Angabe, die dort wirklich weiterhilft – „Rückzahlung“
  // allein steht bei ihm womöglich dreimal.
  const meinName = useMyName();
  const verwendungszweck = meinName ? `Ausgaben ${meinName}` : 'Ausgaben';

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

  /**
   * Der Schritt, der bisher fehlte.
   *
   * Das Blatt zeigte IBAN und PayPal-Link – und hoerte dann auf. Wer bezahlt
   * hatte, musste es schliessen und danach jede einzelne Ausgabe im Verlauf
   * suchen und dort abhaken. Bei fuenf gemeinsamen Abenden sind das fuenf
   * Klicks an fuenf Karten, obwohl hier nur eine Summe steht.
   *
   * `settleUp` haakt beides ab, was zwischen uns offen ist. Das ist die
   * Bedeutung von "abrechnen": danach ist nichts mehr offen, nicht nur eine
   * Haelfte.
   */
  async function abhaken() {
    setHakt(true);
    try {
      const { count } = await api.expenses.settleUp(userId);
      toast(
        count === 0
          ? 'Es war nichts mehr offen.'
          : count === 1
            ? 'Ein Anteil abgehakt.'
            : `${count} Anteile abgehakt.`,
      );
      onSettled?.();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Abhaken fehlgeschlagen', 'error');
    } finally {
      setHakt(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        ichSchulde
          ? `${formatCents(Math.abs(amountCents), currency)} an ${displayName}`
          : `${formatCents(Math.abs(amountCents), currency)} von ${displayName}`
      }
    >
      {laedt ? (
        <Spinner label="Zahlungswege werden geladen …" />
      ) : (
        <div className="stack">
          {!ichSchulde && (
            <p className="exp-hint">
              {displayName} schuldet dir das noch. Sobald das Geld da ist, hak es hier ab – dann
              sieht {displayName} es auch.
            </p>
          )}

          {ichSchulde && !hatZahlweg && (
            <p className="exp-hint">
              {displayName} hat noch keinen Zahlungsweg hinterlegt. Ihr müsst das direkt klären –
              oder {displayName} trägt unter Profil → Einstellungen → Zahlungswege PayPal.Me oder
              eine IBAN ein.
            </p>
          )}

          {ichSchulde && paypalUrl && (
            <a className="btn btn-primary btn-block" href={paypalUrl} target="_blank" rel="noreferrer">
              Mit PayPal.Me senden
            </a>
          )}

          {ichSchulde && profile?.iban && (
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
              {/* Der Empfaenger will wissen, wofuer das Geld kam. Ohne
                  Vorschlag schreibt jeder etwas anderes – oder nichts. */}
              <Zeile label="Verwendungszweck" wert={verwendungszweck} onCopy={kopieren} />
            </section>
          )}

          {ichSchulde && profile?.note && <p className="exp-hint">{profile.note}</p>}

          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={hakt}
            onClick={() => void abhaken()}
          >
            {hakt
              ? 'Wird abgehakt …'
              : ichSchulde
                ? 'Bezahlt – abhaken'
                : 'Erhalten – abhaken'}
          </button>

          <p className="exp-hint">
            {ichSchulde
              ? 'Über diese App läuft kein Geld. Sie zeigt nur, wohin – bezahlt wird direkt zwischen euch. Der Haken sagt allen Beteiligten Bescheid.'
              : 'Der Haken sagt auch der anderen Seite Bescheid.'}
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
