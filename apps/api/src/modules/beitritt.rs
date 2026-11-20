//! Einladungslinks und Beitrittsanfragen.
//!
//! # Was ein Link verrät – und was nicht
//!
//! Die Vorschau (`GET /beitritt/{token}`) zeigt Name, Bild, Beschreibung und
//! Mitgliederzahl – sonst nichts. Keine Mitgliederliste, keine Nachricht,
//! keine Vorschauzeile: Wer den Link weiterreicht, soll nicht die Gespräche
//! mitreichen. Nach dem Beitritt gilt die übliche Verlaufsgrenze `sieht_ab`
//! (ab jetzt), wie bei jedem anderen, der dazukommt.
//!
//! # Raten
//!
//! Ein Token hat 32 zufällige Zeichen; Raten ist aussichtslos, aber nicht
//! kostenlos für den Server. Vorschau und Beitritt teilen sich deshalb eine
//! Bremse je Konto, und ein unbekannter, abgelaufener, zurückgezogener oder
//! ausgeschöpfter Link bekommt immer dieselbe Antwort – sie verrät nicht,
//! woran es lag, und damit auch nicht, dass ein Token einmal gültig war.
//!
//! # Genau einmal
//!
//! Beitritt, Zähler und Systemzeile stehen in einer Transaktion unter der
//! Zeilensperre des Links (`for update`): Zwei gleichzeitige Beitritte können
//! `max_uses` nicht gemeinsam überschreiten. Gemeldet wird nach dem Commit.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::drossel::Regel;
use crate::dto::{ListResult, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::{
    assert_membership, broadcast_conversation, get_membership, require_conversation,
};
use crate::services::messages::{ausliefern, nachricht_anlegen, NewMessage};
use crate::state::AppState;

/// Vorschau und Beitritt zusammen: zwanzig je zehn Minuten und Konto. Ein
/// Mensch öffnet einen Link einmal und tritt einmal bei; wer mehr braucht,
/// probiert Tokens durch.
const BEITRITT_RATEN: Regel = Regel::neu(20, Duration::from_secs(600));

/// Wie viele aktive Links eine Gruppe haben darf.
const LINKS_MAX: i64 = 20;
/// Längste Gültigkeit in Stunden (30 Tage); ohne Angabe gilt der Link, bis
/// er zurückgezogen wird.
const GUELTIG_MAX_STUNDEN: i64 = 24 * 30;
const NUTZUNGEN_MAX: i32 = 1000;

/// Die eine Antwort auf jeden Link, der nicht (mehr) gilt.
fn ungueltig() -> AppError {
    AppError::not_found("Dieser Einladungslink ist ungültig oder abgelaufen.")
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/{id}/einladungen",
            get(links).post(link_anlegen),
        )
        .route(
            "/conversations/{id}/einladungen/{link_id}",
            delete(link_zurueckziehen),
        )
        .route("/conversations/{id}/anfragen", get(anfragen))
        .route(
            "/conversations/{id}/anfragen/{anfrage_id}",
            post(anfrage_entscheiden),
        )
        .route("/beitritt/{token}", get(vorschau).post(beitreten))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct LinkDto {
    id: Uuid,
    token: String,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    max_uses: Option<i32>,
    uses: i32,
    freigabe: bool,
    created_at: chrono::DateTime<chrono::Utc>,
}

/// Nur Admins verwalten Links – in Gruppen.
async fn admin_einer_gruppe(state: &AppState, id: Uuid, person: Uuid) -> AppResult<()> {
    let mitglied = assert_membership(&state.pool, id, person).await?;
    if require_conversation(&state.pool, id).await?.r#type != "group" {
        return Err(AppError::bad_request(
            "Einladungslinks gibt es nur für Gruppen",
        ));
    }
    if mitglied.role == "member" {
        return Err(AppError::forbidden("Nur Admins dürfen das"));
    }
    Ok(())
}

async fn links(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<LinkDto>>> {
    admin_einer_gruppe(&state, id, user.id()).await?;
    let links = sqlx::query_as::<_, LinkDto>(
        "select id, token, expires_at, max_uses, uses, freigabe, created_at
           from conversation_invites
          where conversation_id = $1 and revoked_at is null
            and (expires_at is null or expires_at > now())
          order by created_at desc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(links)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkInput {
    /// Gültig für so viele Stunden; ohne Angabe bis zum Zurückziehen.
    gueltig_stunden: Option<i64>,
    max_uses: Option<i32>,
    #[serde(default)]
    freigabe: bool,
}

async fn link_anlegen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<LinkInput>,
) -> AppResult<(StatusCode, Json<LinkDto>)> {
    admin_einer_gruppe(&state, id, user.id()).await?;
    if let Some(stunden) = input.gueltig_stunden {
        if !(1..=GUELTIG_MAX_STUNDEN).contains(&stunden) {
            return Err(AppError::bad_request(
                "Ein Link gilt zwischen einer Stunde und 30 Tagen.",
            ));
        }
    }
    if let Some(nutzungen) = input.max_uses {
        if !(1..=NUTZUNGEN_MAX).contains(&nutzungen) {
            return Err(AppError::bad_request("Höchstens 1000 Nutzungen je Link."));
        }
    }
    let aktiv: i64 = sqlx::query_scalar(
        "select count(*) from conversation_invites
          where conversation_id = $1 and revoked_at is null
            and (expires_at is null or expires_at > now())",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    if aktiv >= LINKS_MAX {
        return Err(AppError::conflict(
            "Zu viele aktive Links. Zieh einen alten zurück.",
        ));
    }
    let link = sqlx::query_as::<_, LinkDto>(
        "insert into conversation_invites
           (id, conversation_id, token, created_by, expires_at, max_uses, freigabe)
         values ($1, $2, $3, $4,
                 case when $5::bigint is null then null
                      else now() + make_interval(hours => $5::int) end,
                 $6, $7)
         returning id, token, expires_at, max_uses, uses, freigabe, created_at",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(crate::auth::password::random_token(32))
    .bind(user.id())
    .bind(input.gueltig_stunden)
    .bind(input.max_uses)
    .bind(input.freigabe)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(link)))
}

async fn link_zurueckziehen(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, link_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    admin_einer_gruppe(&state, id, user.id()).await?;
    sqlx::query(
        "update conversation_invites set revoked_at = now()
          where id = $1 and conversation_id = $2 and revoked_at is null",
    )
    .bind(link_id)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, sqlx::FromRow)]
struct LinkZeile {
    id: Uuid,
    conversation_id: Uuid,
    freigabe: bool,
}

/// Ein gültiger Link – oder die eine Antwort für alles andere.
async fn gueltiger_link<'e, E>(executor: E, token: &str, sperren: bool) -> AppResult<LinkZeile>
where
    E: sqlx::PgExecutor<'e>,
{
    // Länge vorab: Ein überlanger „Token“ muss nicht erst in die Datenbank.
    if token.is_empty() || token.len() > 64 {
        return Err(ungueltig());
    }
    let sql = if sperren {
        "select i.id, i.conversation_id, i.freigabe from conversation_invites i
          join conversations c on c.id = i.conversation_id and c.type = 'group'
         where i.token = $1 and i.revoked_at is null
           and (i.expires_at is null or i.expires_at > now())
           and (i.max_uses is null or i.uses < i.max_uses)
         for update of i"
    } else {
        "select i.id, i.conversation_id, i.freigabe from conversation_invites i
          join conversations c on c.id = i.conversation_id and c.type = 'group'
         where i.token = $1 and i.revoked_at is null
           and (i.expires_at is null or i.expires_at > now())
           and (i.max_uses is null or i.uses < i.max_uses)"
    };
    sqlx::query_as::<_, LinkZeile>(sql)
        .bind(token)
        .fetch_optional(executor)
        .await?
        .ok_or_else(ungueltig)
}

fn bremsen(state: &AppState, person: Uuid) -> AppResult<()> {
    if !state
        .drossel
        .erlaubt(&format!("beitritt:{person}"), BEITRITT_RATEN)
    {
        return Err(AppError::too_many(
            "Zu viele Versuche mit Einladungslinks. Warte einen Moment.",
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VorschauDto {
    title: Option<String>,
    avatar_url: Option<String>,
    description: Option<String>,
    member_count: i64,
    /// Beitritt nur nach Freigabe durch einen Admin.
    freigabe: bool,
    schon_mitglied: bool,
    /// Gesetzt, wenn schon Mitglied – dann führt die Vorschau in den Chat.
    conversation_id: Option<Uuid>,
    anfrage_offen: bool,
}

async fn vorschau(
    State(state): State<AppState>,
    user: AuthUser,
    Path(token): Path<String>,
) -> AppResult<Json<VorschauDto>> {
    bremsen(&state, user.id())?;
    let link = gueltiger_link(&state.pool, &token, false).await?;
    let chat = require_conversation(&state.pool, link.conversation_id).await?;
    let member_count: i64 =
        sqlx::query_scalar("select count(*) from conversation_members where conversation_id = $1")
            .bind(chat.id)
            .fetch_one(&state.pool)
            .await?;
    let schon_mitglied = get_membership(&state.pool, chat.id, user.id())
        .await?
        .is_some();
    let anfrage_offen: bool = sqlx::query_scalar(
        "select exists (select 1 from beitrittsanfragen
                         where conversation_id = $1 and user_id = $2 and status = 'offen')",
    )
    .bind(chat.id)
    .bind(user.id())
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(VorschauDto {
        title: chat.title,
        avatar_url: chat
            .avatar_attachment_id
            .map(|id| state.config.media_url(&id)),
        description: chat.description,
        member_count,
        freigabe: link.freigabe,
        schon_mitglied,
        // Die Kennung nur für Mitglieder: Für alle anderen öffnet sie ohnehin
        // nichts, aber sie gehört zu den Dingen, die erst der Beitritt verrät.
        conversation_id: schon_mitglied.then_some(chat.id),
        anfrage_offen,
    }))
}

async fn beitreten(
    State(state): State<AppState>,
    user: AuthUser,
    Path(token): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    bremsen(&state, user.id())?;
    let mut tx = state.pool.begin().await?;
    let link = gueltiger_link(&mut *tx, &token, true).await?;
    let chat = link.conversation_id;

    if get_membership(&state.pool, chat, user.id())
        .await?
        .is_some()
    {
        tx.rollback().await?;
        return Ok(Json(
            json!({ "status": "mitglied", "conversationId": chat }),
        ));
    }

    if link.freigabe {
        // Höchstens eine offene Anfrage je Person (Teilindex). Eine zweite
        // ist kein Fehler – der Mensch hat nur zweimal getippt.
        let neu = sqlx::query(
            "insert into beitrittsanfragen (id, conversation_id, user_id, invite_id)
             values ($1, $2, $3, $4)
             on conflict (conversation_id, user_id) where status = 'offen' do nothing",
        )
        .bind(Uuid::now_v7())
        .bind(chat)
        .bind(user.id())
        .bind(link.id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        tx.commit().await?;
        if neu {
            admins_melden(&state, chat).await?;
        }
        return Ok(Json(json!({ "status": "angefragt" })));
    }

    let zeile = aufnehmen(&mut tx, chat, user.id(), Some(link.id), None).await?;
    tx.commit().await?;
    ausliefern(&state, zeile).await?;
    broadcast_conversation(&state, chat, None).await?;
    Ok(Json(
        json!({ "status": "beigetreten", "conversationId": chat }),
    ))
}

/// In der Transaktion des Aufrufers: Mitglied werden, den Link zählen, die
/// Systemzeile anlegen. Wer dazukommt, sieht ab jetzt (`sieht_ab`), wie bei
/// jedem anderen Weg in eine Gruppe.
async fn aufnehmen(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    chat: Uuid,
    person: Uuid,
    link: Option<Uuid>,
    freigegeben_von: Option<Uuid>,
) -> AppResult<crate::services::messages::Angelegt> {
    sqlx::query(
        "insert into conversation_members (conversation_id, user_id, sieht_ab)
         values ($1, $2, now()) on conflict (conversation_id, user_id) do nothing",
    )
    .bind(chat)
    .bind(person)
    .execute(&mut **tx)
    .await?;
    if let Some(link) = link {
        sqlx::query("update conversation_invites set uses = uses + 1 where id = $1")
            .bind(link)
            .execute(&mut **tx)
            .await?;
    }
    let zeile = match freigegeben_von {
        Some(admin) => NewMessage::system(chat, admin, "member.approved", vec![person]),
        None => NewMessage::system(chat, person, "member.joined", vec![]),
    };
    nachricht_anlegen(tx, zeile).await
}

/// Die Admins erfahren von einer neuen Anfrage – ohne Inhalt, sie holen sich
/// die Liste.
async fn admins_melden(state: &AppState, chat: Uuid) -> AppResult<()> {
    let admins: Vec<Uuid> = sqlx::query_scalar(
        "select user_id from conversation_members
          where conversation_id = $1 and role in ('admin', 'owner')",
    )
    .bind(chat)
    .fetch_all(&state.pool)
    .await?;
    state
        .hub
        .publish(
            admins,
            Event::new("beitritt.anfrage", json!({ "conversationId": chat })),
        )
        .await;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnfrageDto {
    id: Uuid,
    user: UserDto,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn anfragen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<AnfrageDto>>> {
    admin_einer_gruppe(&state, id, user.id()).await?;
    let zeilen: Vec<(Uuid, Uuid, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "select id, user_id, created_at from beitrittsanfragen
          where conversation_id = $1 and status = 'offen' order by created_at",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let ids: Vec<Uuid> = zeilen.iter().map(|(_, person, _)| *person).collect();
    let mut profile =
        crate::services::users::load_users_by_ids(&state.pool, &ids, &state.config).await?;
    crate::services::privatsphaere::fuer_betrachter(
        &state.pool,
        user.id(),
        profile.values_mut(),
        false,
    )
    .await?;
    Ok(Json(ListResult::new(
        zeilen
            .into_iter()
            .filter_map(|(anfrage, person, created_at)| {
                profile.get(&person).cloned().map(|user| AnfrageDto {
                    id: anfrage,
                    user,
                    created_at,
                })
            })
            .collect(),
    )))
}

#[derive(Debug, Deserialize)]
struct EntscheidungInput {
    annehmen: bool,
}

async fn anfrage_entscheiden(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, anfrage_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<EntscheidungInput>,
) -> AppResult<StatusCode> {
    admin_einer_gruppe(&state, id, user.id()).await?;
    let mut tx = state.pool.begin().await?;
    // Unter Sperre und nur „offen“: Zwei Admins, die gleichzeitig entscheiden,
    // nehmen nicht zweimal auf (und der zweite bekommt 404 statt eines
    // Widerspruchs).
    let anfrage: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "select user_id, invite_id from beitrittsanfragen
          where id = $1 and conversation_id = $2 and status = 'offen'
          for update",
    )
    .bind(anfrage_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((person, link)) = anfrage else {
        return Err(AppError::not_found("Diese Anfrage ist schon entschieden"));
    };
    sqlx::query(
        "update beitrittsanfragen
            set status = $2, entschieden_von = $3, entschieden_at = now()
          where id = $1",
    )
    .bind(anfrage_id)
    .bind(if input.annehmen {
        "angenommen"
    } else {
        "abgelehnt"
    })
    .bind(user.id())
    .execute(&mut *tx)
    .await?;
    let zeile = if input.annehmen {
        Some(aufnehmen(&mut tx, id, person, link, Some(user.id())).await?)
    } else {
        None
    };
    tx.commit().await?;

    if let Some(zeile) = zeile {
        ausliefern(&state, zeile).await?;
        broadcast_conversation(&state, id, None).await?;
    }
    admins_melden(&state, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
