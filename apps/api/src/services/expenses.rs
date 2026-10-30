//! Ausgaben: wer hat ausgelegt, wer schuldet wem wie viel.
//!
//! Alle Beträge in Cent. Fließkomma wäre hier die falsche Zahlenart – 0.1 +
//! 0.2 ergibt darin nicht 0.3, und bei Geld summiert sich das zu Beträgen,
//! die niemand nachrechnen kann.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{ExpenseRow, ExpenseShareRow};
use crate::dto::{BalanceDto, ExpenseDto, ExpenseShareDto};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const VISIBILITIES: &[&str] = &["participants", "conversation", "listed"];

/// Teilt einen Betrag so auf, dass die Summe **genau** stimmt.
///
/// 10 Euro auf drei Personen sind 3,34 + 3,33 + 3,33 – nicht dreimal 3,33.
/// Der Rest von einem Cent muss irgendwohin, sonst fehlt er im Saldo und
/// niemand findet den Fehler wieder.
pub fn split_evenly(amount_cents: i64, anzahl: usize) -> Vec<i64> {
    if anzahl == 0 {
        return Vec::new();
    }
    let anzahl_i = anzahl as i64;
    let grundbetrag = amount_cents / anzahl_i;
    let rest = amount_cents % anzahl_i;
    (0..anzahl_i)
        .map(|index| grundbetrag + i64::from(index < rest))
        .collect()
}

/// Darf diese Person die Ausgabe sehen?
///
/// Zwei Fragen nacheinander: Ist sie überhaupt im Kreis der Sehenden – und
/// wurde sie ausdrücklich ausgenommen? Das Ausnehmen gewinnt immer, sonst
/// wäre das Geschenk vor dem Beschenkten nicht zu verbergen.
pub async fn may_see(pool: &PgPool, expense: &ExpenseRow, user_id: Uuid) -> AppResult<bool> {
    let ausgenommen: bool = sqlx::query_scalar(
        "select exists (
           select 1 from expense_hidden_from where expense_id = $1 and user_id = $2
         )",
    )
    .bind(expense.id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if ausgenommen {
        return Ok(false);
    }

    // Wer sie angelegt oder ausgelegt hat, sieht sie immer.
    if expense.created_by == Some(user_id) || expense.paid_by == Some(user_id) {
        return Ok(true);
    }

    let hat_anteil: bool = sqlx::query_scalar(
        "select exists (select 1 from expense_shares where expense_id = $1 and user_id = $2)",
    )
    .bind(expense.id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if hat_anteil {
        return Ok(true);
    }

    match expense.visibility.as_str() {
        "conversation" => match expense.conversation_id {
            Some(conversation_id) => Ok(sqlx::query_scalar(
                "select exists (
                   select 1 from conversation_members
                    where conversation_id = $1 and user_id = $2
                 )",
            )
            .bind(conversation_id)
            .bind(user_id)
            .fetch_one(pool)
            .await?),
            None => Ok(false),
        },
        "listed" => Ok(sqlx::query_scalar(
            "select exists (select 1 from expense_viewers where expense_id = $1 and user_id = $2)",
        )
        .bind(expense.id)
        .bind(user_id)
        .fetch_one(pool)
        .await?),
        // "participants" – und alles Unbekannte, das waere ein Datenfehler und
        // darf nicht versehentlich Einblick geben.
        _ => Ok(false),
    }
}

/// Wie viele Personen eine Ausgabe höchstens nennt – je Liste (Anteile,
/// Zuschauer, Ausgenommene). Jede Kennung kostet eine Zeile und bei jeder
/// Änderung eine Meldung; ohne Grenze stand das offen.
pub const PERSONEN_MAX: usize = 100;

/// Welche der genannten Personen eine Ausgabe NICHT nennen darf.
///
/// Wer eine Ausgabe anlegt, schreibt anderen Schulden zu und schickt ihnen
/// Ereignisse. Vorher nahm das jede Konto-Kennung an – man konnte einem
/// Fremden eine Schuld anhängen oder ihn als Zuschauer eintragen. Erlaubt
/// ist jetzt nur, wer zum Zusammenhang der Ausgabe gehört:
///
/// - mit Chat: wer darin Mitglied ist,
/// - mit Termin: wer dazu eingeladen ist (oder ihn angelegt hat),
/// - mit beidem: wer zu einem von beiden gehört – die Oberfläche wählt aus
///   dem Chat, und ein Termin bringt seine Gäste mit,
/// - ohne beides: wer mit dem Anleger einen Chat teilt.
///
/// Der Anleger selbst ist immer erlaubt.
pub async fn unpassende_personen(
    pool: &PgPool,
    anleger: Uuid,
    conversation_id: Option<Uuid>,
    event_id: Option<Uuid>,
    personen: &[Uuid],
) -> AppResult<Vec<Uuid>> {
    if personen.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar(
        "select p from unnest($1::uuid[]) as p
          where p <> $2
            and not (
              ($3::uuid is not null and exists (
                 select 1 from conversation_members
                  where conversation_id = $3 and user_id = p))
              or ($4::uuid is not null and (
                 exists (select 1 from event_attendees where event_id = $4 and user_id = p)
                 or exists (select 1 from calendar_events where id = $4 and created_by = p)))
              or ($3::uuid is null and $4::uuid is null and exists (
                 select 1 from conversation_members a
                   join conversation_members b on b.conversation_id = a.conversation_id
                  where a.user_id = $2 and b.user_id = p))
            )",
    )
    .bind(personen)
    .bind(anleger)
    .bind(conversation_id)
    .bind(event_id)
    .fetch_all(pool)
    .await?)
}

pub async fn require_expense(pool: &PgPool, id: Uuid) -> AppResult<ExpenseRow> {
    sqlx::query_as::<_, ExpenseRow>("select * from expenses where id = $1 and deleted_at is null")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Ausgabe nicht gefunden"))
}

/// Wie [`require_expense`], aber wirft, wenn die Person sie nicht sehen darf.
///
/// 404 statt 403: Eine Ausgabe, die vor jemandem verborgen ist, darf sich
/// nicht durch einen anderen Fehlercode verraten. „Verboten“ hiesse: es gibt
/// sie – und genau das soll das Geschenk ja nicht.
pub async fn readable_expense(pool: &PgPool, id: Uuid, user_id: Uuid) -> AppResult<ExpenseRow> {
    let expense = require_expense(pool, id).await?;
    if !may_see(pool, &expense, user_id).await? {
        return Err(AppError::not_found("Ausgabe nicht gefunden"));
    }
    Ok(expense)
}

/// Ändern darf, wer sie angelegt hat.
pub fn may_edit(expense: &ExpenseRow, user_id: Uuid) -> bool {
    expense.created_by == Some(user_id)
}

/// Hat der Schuldner selbst gemeldet, dass er gezahlt hat?
fn gemeldet(share: &ExpenseShareRow) -> bool {
    share.settled_by == Some(share.user_id) || share.confirmed_by == Some(share.user_id)
}

/// Hat der Auslegende den Eingang bestätigt?
fn bestaetigt(share: &ExpenseShareRow, paid_by: Option<Uuid>) -> bool {
    paid_by.is_some() && (share.settled_by == paid_by || share.confirmed_by == paid_by)
}

/// Der Zustand eines Anteils in einem Wort – als **Tatsache**, unabhängig
/// davon, wer hinsieht.
///
/// Vier Stufen, und der Unterschied zwischen den mittleren beiden ist der
/// Punkt: „gemeldet“ heißt, der Schuldner sagt, er habe gezahlt. „bestätigt“
/// heißt, der Auslegende sagt, es sei angekommen. Beides ist eine einseitige
/// Aussage; erst zusammen ist der Vorgang abgeschlossen.
///
/// Wer selbst ausgelegt hat, schuldet sich nichts – sein eigener Anteil ist
/// von vornherein erledigt. Ohne diese Zeile stand der Auslegende in seiner
/// eigenen Ausgabe als offener Posten.
pub fn share_status(share: &ExpenseShareRow, paid_by: Option<Uuid>) -> &'static str {
    if paid_by == Some(share.user_id) {
        return "closed";
    }
    match (gemeldet(share), bestaetigt(share, paid_by)) {
        (true, true) => "closed",
        (true, false) => "reported",
        (false, true) => "confirmed",
        (false, false) => "open",
    }
}

/// Was diese Ausgabe **für mich** bedeutet – und das ist für jeden anders.
///
/// Der Anwender hat die Regel klar benannt: Legt A für B aus, wandert die
/// Ausgabe bei B in die erledigten, sobald B „bezahlt“ gedrückt hat – und bei
/// A erst, wenn A den Eingang bestätigt hat. Legt A für mehrere aus, bleibt
/// sie bei A so lange offen, bis er bei jedem bestätigt hat, während sie bei
/// jedem Einzelnen sofort weiterrückt.
///
/// Ein gemeinsamer Zustand für alle kann das nicht abbilden. Deshalb hängt er
/// hier am Betrachter:
///
/// - Ich schulde: mein eigener Anteil, sonst nichts. Was die anderen tun,
///   geht mich nichts an.
/// - Ich habe ausgelegt: der schwächste aller fremden Anteile – und „schwach“
///   heißt aus meiner Sicht: solange ich nicht bestätigt habe, ist er offen.
///   Dass jemand gemeldet hat, ist für mich eine Aufforderung, kein Abschluss.
/// - Ich bin weder noch (sehe die Ausgabe nur): die Tatsachenlage.
pub fn expense_status_for(
    shares: &[ExpenseShareRow],
    paid_by: Option<Uuid>,
    viewer: Uuid,
) -> &'static str {
    let ich_lege_aus = paid_by == Some(viewer);

    let betroffen: Vec<&ExpenseShareRow> = if ich_lege_aus {
        shares.iter().filter(|s| s.user_id != viewer).collect()
    } else if let Some(meiner) = shares.iter().find(|s| s.user_id == viewer) {
        vec![meiner]
    } else {
        shares
            .iter()
            .filter(|s| Some(s.user_id) != paid_by)
            .collect()
    };

    if betroffen.is_empty() {
        return "closed";
    }

    let mut schwaechster = 3;
    for share in betroffen {
        let tatsache = share_status(share, paid_by);
        let rang = if ich_lege_aus {
            // Aus Sicht des Auslegenden zählt nur die eigene Bestätigung.
            // „gemeldet“ ist für ihn noch nichts Erledigtes.
            match tatsache {
                "closed" => 3,
                "confirmed" => 2,
                _ => 0,
            }
        } else {
            match tatsache {
                "open" => 0,
                "reported" => 1,
                "confirmed" => 2,
                _ => 3,
            }
        };
        schwaechster = schwaechster.min(rang);
    }

    match schwaechster {
        0 => "open",
        1 => "reported",
        2 => "confirmed",
        _ => "closed",
    }
}

pub async fn to_expense_dto(
    pool: &PgPool,
    expense: ExpenseRow,
    viewer: Uuid,
) -> AppResult<ExpenseDto> {
    let shares =
        sqlx::query_as::<_, ExpenseShareRow>("select * from expense_shares where expense_id = $1")
            .bind(expense.id)
            .fetch_all(pool)
            .await?;
    let viewer_ids: Vec<Uuid> =
        sqlx::query_scalar("select user_id from expense_viewers where expense_id = $1")
            .bind(expense.id)
            .fetch_all(pool)
            .await?;
    let hidden_from_ids: Vec<Uuid> =
        sqlx::query_scalar("select user_id from expense_hidden_from where expense_id = $1")
            .bind(expense.id)
            .fetch_all(pool)
            .await?;

    Ok(ExpenseDto {
        can_edit: may_edit(&expense, viewer),
        id: expense.id,
        conversation_id: expense.conversation_id,
        event_id: expense.event_id,
        created_by: expense.created_by,
        title: expense.title,
        note: expense.note,
        amount_cents: expense.amount_cents,
        currency: expense.currency,
        paid_by: expense.paid_by,
        spent_at: expense.spent_at,
        visibility: expense.visibility,
        viewer_ids,
        hidden_from_ids,
        status: expense_status_for(&shares, expense.paid_by, viewer),
        shares: shares
            .into_iter()
            .map(|share| ExpenseShareDto {
                user_id: share.user_id,
                amount_cents: share.amount_cents,
                settled_at: share.settled_at,
                settled_by: share.settled_by,
                confirmed_at: share.confirmed_at,
                confirmed_by: share.confirmed_by,
                status: share_status(&share, expense.paid_by),
            })
            .collect(),
        settled_at: expense.settled_at,
        created_at: expense.created_at,
        updated_at: expense.updated_at,
    })
}

/// Was mir die anderen schulden und was ich ihnen schulde.
///
/// Gerechnet wird ausschliesslich über Ausgaben, die **ich** sehen darf. Das
/// ist keine Nachlässigkeit, sondern der Preis der Geschenk-Regel: Was vor mir
/// verborgen ist, darf auch in meinem Saldo nicht auftauchen. Weil sich
/// verbergen nur lässt, was mich gar nicht betrifft, bleibt mein Saldo dabei
/// trotzdem richtig – er ist nur nicht die ganze Geschichte des Chats.
pub async fn balances(
    pool: &PgPool,
    user_id: Uuid,
    conversation_id: Option<Uuid>,
) -> AppResult<Vec<BalanceDto>> {
    /*
     * Eine Abfrage statt „alle offenen Ausgaben des Systems laden und je
     * Ausgabe `may_see` fragen“.
     *
     * Vorher kamen ohne Chat-Filter ALLE offenen Ausgaben aller Konten in den
     * Speicher, und für jede liefen bis zu vier Abfragen – eine Übersicht,
     * die mit jeder fremden Ausgabe langsamer wurde und sich von außen
     * beliebig aufblähen ließ.
     *
     * Die Sichtbarkeit bleibt dabei dieselbe, nur in SQL gelesen: Zum Saldo
     * trägt eine Zeile nur bei, wenn ich ausgelegt habe oder den Anteil trage.
     * Genau in beiden Fällen sagt `may_see` „ja“ – außer ich bin
     * ausgenommen, und das prüft das `not exists`. Alle übrigen Wege in
     * `may_see` (Chat, Liste) machen eine Ausgabe sichtbar, ändern aber an
     * meinem Saldo nichts.
     */
    let zeilen = sqlx::query_as::<_, (Uuid, Uuid, i64, String)>(
        "select e.paid_by, s.user_id, s.amount_cents, e.currency
           from expenses e
           join expense_shares s on s.expense_id = e.id
          where e.deleted_at is null
            and e.settled_at is null
            and s.settled_at is null
            and ($2::uuid is null or e.conversation_id = $2)
            and e.paid_by is not null
            -- Der eigene Anteil dessen, der ausgelegt hat, ist kein Posten.
            and s.user_id <> e.paid_by
            and (e.paid_by = $1 or s.user_id = $1)
            and not exists (
              select 1 from expense_hidden_from h
               where h.expense_id = e.id and h.user_id = $1
            )
          order by e.spent_at, e.id",
    )
    .bind(user_id)
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    let mut netto: HashMap<Uuid, i64> = HashMap::new();
    let mut waehrung = "EUR".to_string();
    for (payer, schuldner, cents, currency) in zeilen {
        waehrung = currency;
        if payer == user_id {
            *netto.entry(schuldner).or_insert(0) += cents;
        } else {
            *netto.entry(payer).or_insert(0) -= cents;
        }
    }

    let mut liste: Vec<BalanceDto> = netto
        .into_iter()
        .filter(|(_, cents)| *cents != 0)
        .map(|(user_id, net_cents)| BalanceDto {
            user_id,
            net_cents,
            currency: waehrung.clone(),
        })
        .collect();
    // Grösste Schuld zuerst – das ist die, die man zuerst begleichen will.
    liste.sort_by_key(|eintrag| -eintrag.net_cents.abs());
    Ok(liste)
}

/// Der PayPal.Me-Link für einen Betrag.
///
/// Ausdrücklich ohne Geschäftskonto: Das ist der persönliche Link, den jeder
/// kostenlos anlegen kann. Es läuft kein Geld über uns, es fallen keine
/// Gebühren an, und es gibt nichts einzurichten.
pub fn paypal_me_url(name: &str, amount_cents: i64, currency: &str) -> Option<String> {
    let sauber = name.trim().trim_start_matches('@');
    // Auch eine ganze Adresse annehmen – viele kopieren den Link, nicht den Namen.
    let sauber = sauber
        .rsplit_once("paypal.me/")
        .map(|(_, rest)| rest)
        .unwrap_or(sauber)
        .trim_matches('/');
    if sauber.is_empty()
        || !sauber
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    let betrag = format!("{}.{:02}", amount_cents / 100, (amount_cents % 100).abs());
    Some(format!("https://paypal.me/{sauber}/{betrag}{currency}"))
}

/// Sagt beiden Seiten Bescheid, dass abgerechnet wurde.
///
/// Ohne das erfährt der Empfänger nur dann von einer Zahlung, wenn er von sich
/// aus die Ausgabenseite öffnet – und wartet derweil womöglich auf Geld, das
/// längst da ist.
///
/// Bewusst leise im Fehlerfall: Eine misslungene Benachrichtigung darf das
/// Abrechnen nicht rückgängig machen. Das Geld ist geflossen, der Haken sitzt;
/// dass die Meldung nicht ankam, ist ärgerlich, aber kein Grund, den Vorgang
/// scheitern zu lassen.
pub async fn melde_abrechnung(state: &AppState, wer: Uuid, mit: Uuid, cents: i64, beglichen: bool) {
    let payload = serde_json::json!({
        "byUserId": wer,
        "withUserId": mit,
        "amountCents": cents,
        "settled": beglichen,
    });
    state
        .hub
        .publish(
            vec![wer, mit],
            crate::realtime::Event::new("expense.settled", payload),
        )
        .await;

    if !beglichen || !state.push.enabled() {
        return;
    }

    let name = sqlx::query_scalar::<_, String>("select display_name from users where id = $1")
        .bind(wer)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "Jemand".to_string());

    let payload = crate::dto::PushPayload {
        title: "Ausgaben".to_string(),
        body: format!("{name} hat {} als bezahlt markiert.", format_cents(cents)),
        tag: Some("expense-settled".to_string()),
        url: "/ausgaben".to_string(),
        conversation_id: None,
        message_id: None,
        kind: "expense".to_string(),
    };
    let _ = state
        .push
        .send_to_users(&state.pool, &[mit], &payload)
        .await;
}

/// Cent als Text – „12,50 €“. Nur für Meldungen; gerechnet wird in Cent.
pub fn format_cents(cents: i64) -> String {
    let betrag = cents.abs();
    format!("{},{:02} €", betrag / 100, betrag % 100)
}

/// Wer diese Ausgabe sehen darf – als Liste, für Benachrichtigungen.
///
/// `may_see` beantwortet die Frage für eine Person; hier wird sie umgedreht.
/// Bewusst dieselben Regeln, nur einmal in die andere Richtung gelesen –
/// zwei getrennte Fassungen derselben Regel wären zwei Gelegenheiten, sie
/// unterschiedlich falsch zu beantworten.
///
/// Die Ausgenommenen fallen zuletzt heraus. Das Geschenk darf auch in einer
/// Echtzeitmeldung nicht beim Beschenkten auftauchen – sonst hätte die ganze
/// Verbergen-Regel ein Loch, das niemand vermutet.
pub async fn empfaenger(pool: &PgPool, expense: &ExpenseRow) -> AppResult<Vec<Uuid>> {
    let mut ids: Vec<Uuid> = Vec::new();
    if let Some(id) = expense.created_by {
        ids.push(id);
    }
    if let Some(id) = expense.paid_by {
        ids.push(id);
    }

    let anteile: Vec<Uuid> =
        sqlx::query_scalar("select user_id from expense_shares where expense_id = $1")
            .bind(expense.id)
            .fetch_all(pool)
            .await?;
    ids.extend(anteile);

    match expense.visibility.as_str() {
        "conversation" => {
            if let Some(conversation_id) = expense.conversation_id {
                let mitglieder: Vec<Uuid> = sqlx::query_scalar(
                    "select user_id from conversation_members where conversation_id = $1",
                )
                .bind(conversation_id)
                .fetch_all(pool)
                .await?;
                ids.extend(mitglieder);
            }
        }
        "listed" => {
            let benannte: Vec<Uuid> =
                sqlx::query_scalar("select user_id from expense_viewers where expense_id = $1")
                    .bind(expense.id)
                    .fetch_all(pool)
                    .await?;
            ids.extend(benannte);
        }
        _ => {}
    }

    let verborgen: Vec<Uuid> =
        sqlx::query_scalar("select user_id from expense_hidden_from where expense_id = $1")
            .bind(expense.id)
            .fetch_all(pool)
            .await?;

    ids.sort();
    ids.dedup();
    ids.retain(|id| !verborgen.contains(id));
    Ok(ids)
}

/// Sagt allen Beteiligten, dass sich an einer Ausgabe etwas getan hat.
///
/// Jeder bekommt seine EIGENE Fassung: Der Zustand einer Ausgabe hängt am
/// Betrachter (siehe `expense_status_for`), und wer sie verbergen soll,
/// bekommt gar nichts. Eine gemeinsame Nachricht an alle wäre hier schlicht
/// falsch.
pub async fn melde_ausgabe(state: &AppState, expense: &ExpenseRow) {
    let Ok(ids) = empfaenger(&state.pool, expense).await else {
        return;
    };
    for id in ids {
        let Ok(dto) = to_expense_dto(&state.pool, expense.clone(), id).await else {
            continue;
        };
        state
            .hub
            .publish(
                vec![id],
                crate::realtime::Event::new(
                    "expense.updated",
                    serde_json::json!({ "expense": dto }),
                ),
            )
            .await;
    }
}

/// Und dass eine fort ist.
pub async fn melde_ausgabe_geloescht(state: &AppState, expense: &ExpenseRow) {
    let Ok(ids) = empfaenger(&state.pool, expense).await else {
        return;
    };
    state
        .hub
        .publish(
            ids,
            crate::realtime::Event::new(
                "expense.deleted",
                serde_json::json!({ "expenseId": expense.id }),
            ),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teilt_ohne_rest_zu_verlieren() {
        // 10 Euro auf drei: 3,34 + 3,33 + 3,33. Dreimal 3,33 waeren 9,99 -
        // ein Cent, den niemand mehr wiederfindet.
        let anteile = split_evenly(1000, 3);
        assert_eq!(anteile, vec![334, 333, 333]);
        assert_eq!(anteile.iter().sum::<i64>(), 1000);
    }

    #[test]
    fn teilt_glatt_wenn_es_aufgeht() {
        assert_eq!(split_evenly(900, 3), vec![300, 300, 300]);
        assert_eq!(split_evenly(1, 1), vec![1]);
    }

    #[test]
    fn teilt_auch_kleinstbetraege() {
        // Ein Cent auf drei: einer bekommt ihn, die anderen nichts.
        let anteile = split_evenly(1, 3);
        assert_eq!(anteile.iter().sum::<i64>(), 1);
        assert_eq!(anteile, vec![1, 0, 0]);
    }

    #[test]
    fn ohne_teilnehmer_kein_anteil() {
        assert!(split_evenly(500, 0).is_empty());
    }

    #[test]
    fn baut_den_paypal_link() {
        assert_eq!(
            paypal_me_url("maxmuster", 1234, "EUR").as_deref(),
            Some("https://paypal.me/maxmuster/12.34EUR")
        );
        // Runde Betraege bekommen trotzdem zwei Nachkommastellen.
        assert_eq!(
            paypal_me_url("maxmuster", 500, "EUR").as_deref(),
            Some("https://paypal.me/maxmuster/5.00EUR")
        );
    }

    #[test]
    fn nimmt_auch_die_ganze_adresse() {
        // Die meisten kopieren den Link statt den Namen abzuschreiben.
        for eingabe in [
            "@maxmuster",
            "paypal.me/maxmuster",
            "https://paypal.me/maxmuster",
            "https://www.paypal.me/maxmuster/",
        ] {
            assert_eq!(
                paypal_me_url(eingabe, 100, "EUR").as_deref(),
                Some("https://paypal.me/maxmuster/1.00EUR"),
                "fehlgeschlagen bei {eingabe}"
            );
        }
    }

    #[test]
    fn weist_unbrauchbare_namen_ab() {
        // Ohne diese Pruefung liesse sich ueber das Namensfeld eine beliebige
        // Adresse in die App schmuggeln.
        assert!(paypal_me_url("", 100, "EUR").is_none());
        assert!(paypal_me_url("max muster", 100, "EUR").is_none());
        assert!(paypal_me_url("evil.example/../x", 100, "EUR").is_none());
        assert!(paypal_me_url("max?a=b", 100, "EUR").is_none());
    }
}
