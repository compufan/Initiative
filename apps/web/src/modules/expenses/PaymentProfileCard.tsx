import { useEffect, useState } from 'react';
import { paypalMeUrl, type PaymentProfileDto } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

/**
 * Wie mir andere Geld zurückgeben können.
 *
 * Ausdrücklich **ohne PayPal-Geschäftskonto**: `paypalMe` ist der persönliche
 * Link, den jeder kostenlos anlegen kann. Über diese App läuft kein Geld, es
 * fallen keine Gebühren an, und es gibt nichts einzurichten – die App baut aus
 * dem Namen nur eine Adresse mit Betrag.
 */
export function PaymentProfileCard() {
  const [profile, setProfile] = useState<PaymentProfileDto | null>(null);
  const [paypalMe, setPaypalMe] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [holder, setHolder] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let abgebrochen = false;
    void api.expenses
      .myPaymentProfile()
      .then((ergebnis) => {
        if (abgebrochen) return;
        setProfile(ergebnis);
        setPaypalMe(ergebnis.paypalMe ?? '');
        setIban(ergebnis.iban ?? '');
        setBic(ergebnis.bic ?? '');
        setHolder(ergebnis.accountHolder ?? '');
        setNote(ergebnis.note ?? '');
      })
      .catch(() => {});
    return () => {
      abgebrochen = true;
    };
  }, []);

  // Sofort zeigen, was daraus wird – wer sich vertippt, merkt es hier und
  // nicht erst, wenn jemand vergeblich zu zahlen versucht.
  const vorschau = paypalMeUrl(paypalMe || null, 1234);
  const paypalKaputt = paypalMe.trim() !== '' && vorschau == null;

  async function speichern() {
    setBusy(true);
    try {
      setProfile(
        await api.expenses.savePaymentProfile({
          paypalMe: paypalMe.trim() || null,
          iban: iban.trim() || null,
          bic: bic.trim() || null,
          accountHolder: holder.trim() || null,
          note: note.trim() || null,
        }),
      );
      toast('Zahlungswege gespeichert.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="exp-pay-title">
      <h2 id="exp-pay-title" className="prf-block-title">
        Zahlungswege
      </h2>
      <p className="prf-hint">
        Damit andere dir zurückzahlen können. Über diese App läuft kein Geld – sie zeigt nur, wohin.
        Für PayPal reicht der persönliche PayPal.Me-Link, ein Geschäftskonto brauchst du nicht.
      </p>

      <div className="field">
        <label htmlFor="pay-paypal">PayPal.Me</label>
        <input
          id="pay-paypal"
          className="input"
          value={paypalMe}
          maxLength={120}
          placeholder="dein-name oder paypal.me/dein-name"
          onChange={(event) => setPaypalMe(event.target.value)}
        />
        {paypalKaputt ? (
          <span className="exp-warn">
            Das passt noch nicht. Erlaubt sind Buchstaben, Ziffern und Bindestriche – oder füg
            einfach deinen ganzen Link ein.
          </span>
        ) : (
          vorschau && <span className="prf-hint">Wird zu: {vorschau.replace('/12.34EUR', '')}</span>
        )}
      </div>

      <div className="field">
        <label htmlFor="pay-holder">Kontoinhaber</label>
        <input
          id="pay-holder"
          className="input"
          value={holder}
          maxLength={120}
          onChange={(event) => setHolder(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pay-iban">IBAN</label>
        <input
          id="pay-iban"
          className="input"
          value={iban}
          maxLength={40}
          placeholder="DE02 1203 0000 0000 2020 51"
          onChange={(event) => setIban(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pay-bic">BIC (freiwillig)</label>
        <input
          id="pay-bic"
          className="input"
          value={bic}
          maxLength={16}
          onChange={(event) => setBic(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pay-note">Hinweis (freiwillig)</label>
        <input
          id="pay-note"
          className="input"
          value={note}
          maxLength={500}
          placeholder="z. B. „Verwendungszweck bitte mit meinem Namen“"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || paypalKaputt}
        onClick={() => void speichern()}
      >
        {busy ? 'Speichert …' : 'Speichern'}
      </button>

      {profile && !profile.paypalMe && !profile.iban && (
        <p className="prf-hint">
          Bisher ist nichts hinterlegt. Ohne Angabe müssen andere dich fragen, wohin sie zahlen
          sollen.
        </p>
      )}
    </section>
  );
}
