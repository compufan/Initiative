//! Ausgaben, Anteile und Zahlungswege.
//!
//! Zwei Dinge, die hier bewusst entschieden sind:
//!
//! Erstens rechnet alles in **Cent**. Fließkomma wäre bei Geld die falsche
//! Zahlenart.
//!
//! Zweitens lässt sich eine Ausgabe nur vor jemandem verbergen, der **keinen
//! Anteil** daran hat. Sonst schuldete er Geld, das in seinem eigenen Saldo
//! nicht auftaucht – der Saldo wäre still falsch statt sichtbar unvollständig.
//! Für das Geschenk vor dem Beschenkten reicht die Regel: Wer beschenkt wird,
//! zahlt nicht mit.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::{ExpenseRow, PaymentProfileRow};
use crate::dto::{BalanceDto, ExpenseDto, ListResult, PaymentProfileDto};
use crate::error::{AppError, AppResult};
use crate::modules::double_option;
use crate::services::calendar::require_event;
use crate::services::conversations::assert_membership;
use crate::services::events::assert_attendee;
use crate::services::expenses::{
    balances, may_edit, paypal_me_url, readable_expense, require_expense, split_evenly,
    to_expense_dto, VISIBILITIES,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/expenses", get(list).post(create))
        .route("/expenses/{id}", get(by_id).patch(update).delete(remove))
        .route("/expenses/{id}/settle", post(settle))
        .route("/expenses/settle-up", post(settle_up))
        .route("/expenses/balances", get(balance_list))
        .route(
            "/expenses/payment-profile",
            get(my_profile).put(save_profile),
        )
        .route("/expenses/payment-profile/{user_id}", get(profile_of))
        .route("/expenses/{id}/hidden/{user_id}", post(hide).delete(unhide))
}

const TITLE_MAX: usize = 160;
const NOTE_MAX: usize = 2000;

/* ---------- Auflisten ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    conversation_id: Option<Uuid>,
    event_id: Option<Uuid>,
    /// Auch die schon abgerechneten mitliefern.
    #[serde(default)]
    include_settled: bool,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<ExpenseDto>>> {
    if let Some(conversation_id) = query.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }
    if let Some(event_id) = query.event_id {
        let event = require_event(&state, event_id).await?;
        assert_attendee(&state.pool, &event, user.id()).await?;
    }

    let rows = sqlx::query_as::<_, ExpenseRow>(
        "select * from expenses
          where deleted_at is null
            and ($1::uuid is null or conversation_id = $1)
            and ($2::uuid is null or event_id = $2)
            and ($3 or settled_at is null)
          order by spent_at desc",
    )
    .bind(query.conversation_id)
    .bind(query.event_id)
    .bind(query.include_settled)
    .fetch_all(&state.pool)
    .await?;

    // Die Sichtbarkeit entscheidet je Ausgabe. Sie in die Abfrage zu falten
    // wäre schneller, aber die Regel stünde dann an zwei Stellen – und die
    // eine davon würde beim nächsten Mal vergessen.
    let mut items = Vec::new();
    for row in rows {
        if crate::services::expenses::may_see(&state.pool, &row, user.id()).await? {
            items.push(to_expense_dto(&state.pool, row, user.id()).await?);
        }
    }
    Ok(Json(ListResult::new(items)))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ExpenseDto>> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    Ok(Json(to_expense_dto(&state.pool, expense, user.id()).await?))
}

/* ---------- Anlegen ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareInput {
    user_id: Uuid,
    /// Fester Anteil in Cent. Ohne Angabe wird gleichmäßig geteilt.
    amount_cents: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    conversation_id: Option<Uuid>,
    event_id: Option<Uuid>,
    title: String,
    note: Option<String>,
    amount_cents: i64,
    #[serde(default = "default_currency")]
    currency: String,
    /// Wer ausgelegt hat. Ohne Angabe: ich.
    paid_by: Option<Uuid>,
    spent_at: Option<DateTime<Utc>>,
    /// Unter wem geteilt wird.
    shares: Vec<ShareInput>,
    #[serde(default = "default_visibility")]
    visibility: String,
    #[serde(default)]
    viewer_ids: Vec<Uuid>,
    /// Wem sie verborgen bleiben soll – etwa dem Beschenkten.
    #[serde(default)]
    hidden_from_ids: Vec<Uuid>,
}

fn default_currency() -> String {
    "EUR".to_string()
}

fn default_visibility() -> String {
    "participants".to_string()
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<ExpenseDto>)> {
    let title = input.title.trim().to_string();
    Validator::new()
        .length("title", &title, 1, TITLE_MAX)
        .one_of("visibility", &input.visibility, VISIBILITIES)
        .require("amountCents", input.amount_cents > 0, "Betrag fehlt")
        .require("shares", !input.shares.is_empty(), "mindestens eine Person")
        .require(
            "currency",
            input.currency.len() == 3 && input.currency.chars().all(|c| c.is_ascii_alphabetic()),
            "Währung als drei Buchstaben, z. B. EUR",
        )
        .finish()?;
    if let Some(note) = input.note.as_deref() {
        Validator::new()
            .length("note", note, 0, NOTE_MAX)
            .finish()?;
    }

    if let Some(conversation_id) = input.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }
    if let Some(event_id) = input.event_id {
        let event = require_event(&state, event_id).await?;
        assert_attendee(&state.pool, &event, user.id()).await?;
    }

    let anteile = verteile(input.amount_cents, &input.shares)?;
    let beteiligte: Vec<Uuid> = input.shares.iter().map(|share| share.user_id).collect();

    // Verbergen geht nur vor jemandem, der nicht mitzahlt.
    for hidden in &input.hidden_from_ids {
        if beteiligte.contains(hidden) {
            return Err(AppError::bad_request(
                "Eine Ausgabe lässt sich nur vor jemandem verbergen, der keinen Anteil daran hat – sonst stimmte sein Saldo nicht mehr",
            ));
        }
    }

    let id = Uuid::now_v7();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "insert into expenses
           (id, conversation_id, event_id, created_by, title, note, amount_cents, currency,
            paid_by, spent_at, visibility)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()), $11)",
    )
    .bind(id)
    .bind(input.conversation_id)
    .bind(input.event_id)
    .bind(user.id())
    .bind(&title)
    .bind(clean(input.note))
    .bind(input.amount_cents)
    .bind(input.currency.to_uppercase())
    .bind(input.paid_by.unwrap_or_else(|| user.id()))
    .bind(input.spent_at)
    .bind(&input.visibility)
    .execute(&mut *tx)
    .await?;

    for (share, betrag) in input.shares.iter().zip(anteile) {
        sqlx::query(
            "insert into expense_shares (expense_id, user_id, amount_cents) values ($1, $2, $3)",
        )
        .bind(id)
        .bind(share.user_id)
        .bind(betrag)
        .execute(&mut *tx)
        .await?;
    }
    for viewer in &input.viewer_ids {
        sqlx::query("insert into expense_viewers (expense_id, user_id) values ($1, $2)")
            .bind(id)
            .bind(viewer)
            .execute(&mut *tx)
            .await?;
    }
    for hidden in &input.hidden_from_ids {
        sqlx::query("insert into expense_hidden_from (expense_id, user_id) values ($1, $2)")
            .bind(id)
            .bind(hidden)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let expense = require_expense(&state.pool, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(to_expense_dto(&state.pool, expense, user.id()).await?),
    ))
}

/// Verteilt den Betrag auf die Anteile.
///
/// Wer einen festen Betrag angibt, bekommt genau den. Der Rest wird unter den
/// Übrigen gleichmäßig aufgeteilt – restlos, bis auf den letzten Cent.
fn verteile(amount_cents: i64, shares: &[ShareInput]) -> AppResult<Vec<i64>> {
    let feste: i64 = shares.iter().filter_map(|share| share.amount_cents).sum();
    if feste > amount_cents {
        return Err(AppError::bad_request(
            "Die festen Anteile sind zusammen größer als der Betrag",
        ));
    }
    let offene = shares
        .iter()
        .filter(|share| share.amount_cents.is_none())
        .count();
    if offene == 0 && feste != amount_cents {
        return Err(AppError::bad_request(format!(
            "Die Anteile ergeben {} statt {}",
            feste, amount_cents
        )));
    }

    let mut rest = split_evenly(amount_cents - feste, offene).into_iter();
    shares
        .iter()
        .map(|share| match share.amount_cents {
            Some(betrag) if betrag < 0 => {
                Err(AppError::bad_request("Ein Anteil kann nicht negativ sein"))
            }
            Some(betrag) => Ok(betrag),
            None => Ok(rest.next().unwrap_or(0)),
        })
        .collect()
}

/* ---------- Ändern ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    note: Option<Option<String>>,
    spent_at: Option<DateTime<Utc>>,
    visibility: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    event_id: Option<Option<Uuid>>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateInput>,
) -> AppResult<Json<ExpenseDto>> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    if !may_edit(&expense, user.id()) {
        return Err(AppError::forbidden(
            "Ändern darf nur, wer die Ausgabe eingetragen hat",
        ));
    }
    if let Some(title) = input.title.as_deref() {
        Validator::new()
            .length("title", title.trim(), 1, TITLE_MAX)
            .finish()?;
    }
    if let Some(visibility) = input.visibility.as_deref() {
        Validator::new()
            .one_of("visibility", visibility, VISIBILITIES)
            .finish()?;
    }
    if let Some(Some(event_id)) = input.event_id {
        let event = require_event(&state, event_id).await?;
        assert_attendee(&state.pool, &event, user.id()).await?;
    }

    sqlx::query(
        "update expenses set
           title      = coalesce($2, title),
           note       = case when $3 then $4 else note end,
           spent_at   = coalesce($5, spent_at),
           visibility = coalesce($6, visibility),
           event_id   = case when $7 then $8 else event_id end,
           updated_at = now()
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(input.title.map(|value| value.trim().to_string()))
    .bind(input.note.is_some())
    .bind(input.note.flatten())
    .bind(input.spent_at)
    .bind(input.visibility)
    .bind(input.event_id.is_some())
    .bind(input.event_id.flatten())
    .execute(&state.pool)
    .await?;

    let expense = require_expense(&state.pool, id).await?;
    Ok(Json(to_expense_dto(&state.pool, expense, user.id()).await?))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    if !may_edit(&expense, user.id()) {
        return Err(AppError::forbidden(
            "Löschen darf nur, wer die Ausgabe eingetragen hat",
        ));
    }
    sqlx::query("update expenses set deleted_at = now(), updated_at = now() where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettleInput {
    /// Wessen Anteil beglichen ist. Ohne Angabe: der eigene.
    user_id: Option<Uuid>,
    #[serde(default = "default_true")]
    settled: bool,
}

fn default_true() -> bool {
    true
}

/// Markiert einen Anteil als beglichen.
///
/// Den eigenen darf jeder abhaken; fremde nur, wer die Ausgabe eingetragen
/// hat oder ausgelegt hat – das Geld ist ja bei ihm angekommen.
async fn settle(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<SettleInput>,
) -> AppResult<Json<ExpenseDto>> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    let ziel = input.user_id.unwrap_or_else(|| user.id());
    if ziel != user.id() && !may_edit(&expense, user.id()) && expense.paid_by != Some(user.id()) {
        return Err(AppError::forbidden(
            "Fremde Anteile darf nur abhaken, wer ausgelegt oder eingetragen hat",
        ));
    }

    sqlx::query(
        "update expense_shares
            set settled_at = case when $3 then now() else null end,
                settled_by = case when $3 then $4::uuid else null end
          where expense_id = $1 and user_id = $2",
    )
    .bind(id)
    .bind(ziel)
    .bind(input.settled)
    .bind(user.id())
    .execute(&state.pool)
    .await?;

    // Ist alles abgehakt, gilt die ganze Ausgabe als erledigt.
    sqlx::query(
        "update expenses set
           settled_at = case
             when exists (
               select 1 from expense_shares
                where expense_id = $1 and settled_at is null and user_id <> coalesce(paid_by, user_id)
             ) then null
             else coalesce(settled_at, now())
           end,
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;

    let expense = require_expense(&state.pool, id).await?;
    Ok(Json(to_expense_dto(&state.pool, expense, user.id()).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettleUpInput {
    /// Mit wem abgerechnet wird.
    user_id: Uuid,
    /// `false` macht den Haken wieder weg – falls jemand zu früh geklickt hat.
    #[serde(default = "wahr")]
    settled: bool,
}

fn wahr() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettleUpResult {
    /// Wie viele Anteile angefasst wurden.
    count: i64,
    /// Was dabei zusammenkam – in Cent, aus Sicht des Aufrufers.
    amount_cents: i64,
}

/// Alles begleichen, was zwischen mir und einer Person offen ist.
///
/// Bisher ging Abhaken nur je Ausgabe. Bei fünf gemeinsamen Abenden waren das
/// fünf Klicks an fünf Karten – während die Übersicht nur eine einzige Summe
/// zeigt. Wer diese Summe überweist, will einmal bestätigen, nicht fünfmal.
///
/// Es werden **beide Richtungen** abgehakt, und das ist Absicht: „Abrechnen“
/// heißt, dass zwischen uns nichts mehr offen ist. Wenn ich 20 schulde und mir
/// 5 zustehen, überweise ich 15 – danach ist beides erledigt, nicht nur eine
/// Hälfte. Genau diese Zahl steht auch in der Übersicht.
///
/// Erlaubt ist das, weil jeder Anteil ohnehin von einem der beiden abgehakt
/// werden dürfte: der eigene immer, der fremde auf einer Ausgabe, die man
/// selbst ausgelegt hat.
async fn settle_up(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<SettleUpInput>,
) -> AppResult<Json<SettleUpResult>> {
    if input.user_id == user.id() {
        return Err(AppError::bad_request(
            "Mit sich selbst rechnet man nicht ab",
        ));
    }

    // Nur Anteile, die ich auch einzeln abhaken dürfte – dieselbe Regel wie in
    // `settle`, nur als Mengenoperation.
    let rows = sqlx::query_as::<_, (Uuid, i64)>(
        "update expense_shares s
            set settled_at = case when $3 then now() else null end,
                settled_by = case when $3 then $1::uuid else null end
           from expenses e
          where s.expense_id = e.id
            and (
              -- Ich schulde: mein Anteil auf einer Ausgabe, die der andere
              -- ausgelegt hat.
              (s.user_id = $1 and e.paid_by = $2)
              -- Der andere schuldet mir: sein Anteil auf meiner Ausgabe.
              or (s.user_id = $2 and e.paid_by = $1)
            )
            and s.user_id <> coalesce(e.paid_by, s.user_id)
            and (s.settled_at is null) = $3
          returning s.expense_id, s.amount_cents",
    )
    .bind(user.id())
    .bind(input.user_id)
    .bind(input.settled)
    .fetch_all(&state.pool)
    .await?;

    let betroffene: Vec<Uuid> = {
        let mut ids: Vec<Uuid> = rows.iter().map(|(expense_id, _)| *expense_id).collect();
        ids.sort();
        ids.dedup();
        ids
    };

    // Ausgaben, an denen nichts mehr offen ist, gelten als erledigt.
    for expense_id in &betroffene {
        sqlx::query(
            "update expenses set
               settled_at = case
                 when exists (
                   select 1 from expense_shares
                    where expense_id = $1 and settled_at is null
                      and user_id <> coalesce(paid_by, user_id)
                 ) then null
                 else coalesce(settled_at, now())
               end,
               updated_at = now()
             where id = $1",
        )
        .bind(expense_id)
        .execute(&state.pool)
        .await?;
    }

    let summe: i64 = rows.iter().map(|(_, cents)| *cents).sum();

    if !betroffene.is_empty() {
        crate::services::expenses::melde_abrechnung(
            &state,
            user.id(),
            input.user_id,
            summe,
            input.settled,
        )
        .await;
    }

    Ok(Json(SettleUpResult {
        count: rows.len() as i64,
        amount_cents: summe,
    }))
}

/* ---------- Wer schuldet wem ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceQuery {
    conversation_id: Option<Uuid>,
}

async fn balance_list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<BalanceQuery>,
) -> AppResult<Json<ListResult<BalanceDto>>> {
    if let Some(conversation_id) = query.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }
    Ok(Json(ListResult::new(
        balances(&state.pool, user.id(), query.conversation_id).await?,
    )))
}

/* ---------- Verbergen ---------- */

async fn hide(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<ExpenseDto>> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    if !may_edit(&expense, user.id()) {
        return Err(AppError::forbidden(
            "Das darf nur, wer die Ausgabe eingetragen hat",
        ));
    }
    let hat_anteil: bool = sqlx::query_scalar(
        "select exists (select 1 from expense_shares where expense_id = $1 and user_id = $2)",
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    if hat_anteil {
        return Err(AppError::bad_request(
            "Wer einen Anteil trägt, kann die Ausgabe nicht verborgen bekommen – sein Saldo stimmte sonst nicht",
        ));
    }

    sqlx::query(
        "insert into expense_hidden_from (expense_id, user_id) values ($1, $2)
         on conflict do nothing",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.pool)
    .await?;

    let expense = require_expense(&state.pool, id).await?;
    Ok(Json(to_expense_dto(&state.pool, expense, user.id()).await?))
}

/// Gibt eine verborgene Ausgabe wieder frei – nach dem Geburtstag.
async fn unhide(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<ExpenseDto>> {
    let expense = readable_expense(&state.pool, id, user.id()).await?;
    if !may_edit(&expense, user.id()) {
        return Err(AppError::forbidden(
            "Das darf nur, wer die Ausgabe eingetragen hat",
        ));
    }
    sqlx::query("delete from expense_hidden_from where expense_id = $1 and user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;

    let expense = require_expense(&state.pool, id).await?;
    Ok(Json(to_expense_dto(&state.pool, expense, user.id()).await?))
}

/* ---------- Zahlungswege ---------- */

fn to_profile_dto(row: PaymentProfileRow) -> PaymentProfileDto {
    PaymentProfileDto {
        user_id: row.user_id,
        paypal_me: row.paypal_me,
        iban: row.iban,
        bic: row.bic,
        account_holder: row.account_holder,
        note: row.note,
    }
}

async fn my_profile(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<PaymentProfileDto>> {
    let row =
        sqlx::query_as::<_, PaymentProfileRow>("select * from payment_profiles where user_id = $1")
            .bind(user.id())
            .fetch_optional(&state.pool)
            .await?;
    Ok(Json(row.map(to_profile_dto).unwrap_or(PaymentProfileDto {
        user_id: user.id(),
        paypal_me: None,
        iban: None,
        bic: None,
        account_holder: None,
        note: None,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInput {
    paypal_me: Option<String>,
    iban: Option<String>,
    bic: Option<String>,
    account_holder: Option<String>,
    note: Option<String>,
}

async fn save_profile(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<ProfileInput>,
) -> AppResult<Json<PaymentProfileDto>> {
    // Den PayPal-Namen gleich hier prüfen, statt ihn erst beim Bezahlen
    // scheitern zu lassen: Wer ihn falsch einträgt, merkt es sonst nie.
    if let Some(name) = input
        .paypal_me
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if paypal_me_url(name, 100, "EUR").is_none() {
            return Err(AppError::bad_request(
                "Der PayPal.Me-Name passt nicht. Erlaubt sind Buchstaben, Ziffern und Bindestriche – oder füge einfach deinen Link ein.",
            ));
        }
    }

    let row = sqlx::query_as::<_, PaymentProfileRow>(
        "insert into payment_profiles (user_id, paypal_me, iban, bic, account_holder, note)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (user_id) do update set
           paypal_me      = excluded.paypal_me,
           iban           = excluded.iban,
           bic            = excluded.bic,
           account_holder = excluded.account_holder,
           note           = excluded.note,
           updated_at     = now()
         returning *",
    )
    .bind(user.id())
    .bind(clean(input.paypal_me))
    .bind(clean(input.iban).map(|value| value.replace(' ', "").to_uppercase()))
    .bind(clean(input.bic).map(|value| value.to_uppercase()))
    .bind(clean(input.account_holder))
    .bind(clean(input.note))
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(to_profile_dto(row)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileQuery {
    /// Für den fertigen PayPal-Link mit Betrag.
    amount_cents: Option<i64>,
    currency: Option<String>,
}

/// Wie ich dieser Person Geld zurückgeben kann.
///
/// Nur einsehbar, wenn wir wenigstens einen Chat teilen – Bankdaten sind
/// nichts, was jeder abfragen können soll.
async fn profile_of(
    State(state): State<AppState>,
    user: AuthUser,
    Path(user_id): Path<Uuid>,
    Query(query): Query<ProfileQuery>,
) -> AppResult<Json<serde_json::Value>> {
    if user_id != user.id() {
        let gemeinsam: bool = sqlx::query_scalar(
            "select exists (
               select 1
                 from conversation_members a
                 join conversation_members b on a.conversation_id = b.conversation_id
                where a.user_id = $1 and b.user_id = $2
             )",
        )
        .bind(user.id())
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
        if !gemeinsam {
            return Err(AppError::forbidden("Ihr habt keinen gemeinsamen Chat"));
        }
    }

    let row =
        sqlx::query_as::<_, PaymentProfileRow>("select * from payment_profiles where user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let profile = row.map(to_profile_dto).unwrap_or(PaymentProfileDto {
        user_id,
        paypal_me: None,
        iban: None,
        bic: None,
        account_holder: None,
        note: None,
    });

    let paypal_url = profile.paypal_me.as_deref().and_then(|name| {
        paypal_me_url(
            name,
            query.amount_cents.unwrap_or(0).max(0),
            query.currency.as_deref().unwrap_or("EUR"),
        )
    });

    Ok(Json(json!({ "profile": profile, "paypalUrl": paypal_url })))
}
