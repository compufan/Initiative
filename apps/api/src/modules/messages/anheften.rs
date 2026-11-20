//! Nachrichten im Chat anheften – bis zu drei je Chat, für alle sichtbar.
//!
//! # Wer darf
//!
//! Im Direktchat beide. In einer Gruppe hängt es an derselben Einstellung wie
//! Titel und Bild: „Nur Admins ändern Gruppeninfo“. Ein angehefteter Hinweis
//! steht oben im Chat aller – das ist Gruppeninfo, kein privates Lesezeichen
//! (dafür gibt es die Sterne).
//!
//! # Die Grenze von drei
//!
//! Wie bei WhatsApp fällt beim vierten die älteste heraus, statt das Anheften
//! zu verweigern: Wer etwas Neues anheftet, will es oben haben. Einfügen und
//! Kürzen stehen in einer Transaktion, unter einer Sperre je Chat – zwei
//! gleichzeitige Anheftungen lassen so nicht vier stehen.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::ANGEHEFTET_MAX;
use crate::db::MessageRow;
use crate::dto::{ListResult, MessageDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::{assert_membership, member_ids, require_conversation};
use crate::services::messages::{
    ausliefern, hydrate_messages, nachricht_anlegen, require_message, NewMessage,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/messages/{id}/anheften", put(anheften).delete(loesen))
        .route("/conversations/{id}/angeheftet", get(liste))
}

/// Darf diese Person in diesem Chat Gruppeninfo ändern (und damit anheften)?
pub(crate) async fn darf_gruppeninfo(state: &AppState, chat: Uuid, person: Uuid) -> AppResult<()> {
    let mitglied = assert_membership(&state.pool, chat, person).await?;
    let gespraech = require_conversation(&state.pool, chat).await?;
    if gespraech.r#type == "group"
        && mitglied.role == "member"
        && crate::dto::GruppenEinstellungen::aus(&gespraech.settings).nur_admins_info
    {
        return Err(AppError::forbidden(
            "In dieser Gruppe ändern nur Admins die Gruppeninfo.",
        ));
    }
    Ok(())
}

/// Allen Mitgliedern melden, dass sich die angehefteten Nachrichten geändert
/// haben. Nur die Kennung des Chats – was angeheftet ist, holt jeder selbst
/// (`/conversations/{id}/angeheftet`), gefiltert nach seiner Verlaufsgrenze.
pub(crate) async fn angeheftet_melden(state: &AppState, chat: Uuid) {
    match member_ids(&state.pool, chat).await {
        Ok(ids) => {
            state
                .hub
                .publish(
                    ids,
                    Event::new("conversation.angeheftet", json!({ "conversationId": chat })),
                )
                .await;
        }
        Err(fehler) => tracing::warn!(%fehler, "Anheften: Meldung gescheitert"),
    }
}

async fn sichtbare_nachricht(state: &AppState, id: Uuid, person: Uuid) -> AppResult<MessageRow> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, person).await?;
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, id, person).await? {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    Ok(row)
}

async fn anheften(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let row = sichtbare_nachricht(&state, id, user.id()).await?;
    if row.deleted_at.is_some() || row.r#type == "system" {
        return Err(AppError::bad_request(
            "Diese Nachricht lässt sich nicht anheften",
        ));
    }
    if crate::services::messages::ist_einmal(&row.metadata) {
        return Err(AppError::bad_request(
            "Einmal ansehbare Medien lassen sich nicht anheften",
        ));
    }
    darf_gruppeninfo(&state, row.conversation_id, user.id()).await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('anheften:' || $1::text, 0))")
        .bind(row.conversation_id)
        .execute(&mut *tx)
        .await?;
    let neu = sqlx::query(
        "insert into conversation_pins (conversation_id, message_id, pinned_by)
         values ($1, $2, $3) on conflict do nothing",
    )
    .bind(row.conversation_id)
    .bind(id)
    .bind(user.id())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if !neu {
        // Schon angeheftet: ein Neuversuch, kein zweites Ereignis.
        tx.rollback().await?;
        return Ok((StatusCode::OK, Json(json!({ "angeheftet": true }))));
    }
    // Über der Grenze fällt die älteste heraus.
    sqlx::query(
        "delete from conversation_pins
          where conversation_id = $1
            and message_id in (
              select message_id from conversation_pins
               where conversation_id = $1
               order by pinned_at desc, message_id desc
               offset $2)",
    )
    .bind(row.conversation_id)
    .bind(ANGEHEFTET_MAX)
    .execute(&mut *tx)
    .await?;
    // Die Systemzeile „X hat eine Nachricht angeheftet“ – in derselben
    // Transaktion: Ohne Anheften keine Zeile, ohne Zeile kein Anheften.
    let mut zeile =
        NewMessage::system(row.conversation_id, user.id(), "message.pinned", Vec::new());
    zeile.metadata["system"]["value"] = json!(id.to_string());
    let angelegt = nachricht_anlegen(&mut tx, zeile).await?;
    tx.commit().await?;

    ausliefern(&state, angelegt).await?;
    angeheftet_melden(&state, row.conversation_id).await;
    Ok((StatusCode::CREATED, Json(json!({ "angeheftet": true }))))
}

async fn loesen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_message(&state.pool, id).await?;
    darf_gruppeninfo(&state, row.conversation_id, user.id()).await?;
    let weg =
        sqlx::query("delete from conversation_pins where conversation_id = $1 and message_id = $2")
            .bind(row.conversation_id)
            .bind(id)
            .execute(&state.pool)
            .await?
            .rows_affected();
    if weg > 0 {
        angeheftet_melden(&state, row.conversation_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Die angehefteten Nachrichten, neueste zuerst – nur, was der Betrachter
/// sehen darf (Verlaufsgrenze, „nur für mich gelöscht“).
async fn liste(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let zeilen = sqlx::query_as::<_, MessageRow>(
        "select m.* from conversation_pins p
           join messages m on m.id = p.message_id
           join conversation_members cm on cm.conversation_id = p.conversation_id and cm.user_id = $2
          where p.conversation_id = $1
            and m.deleted_at is null
            and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
            and not exists (select 1 from message_hidden h
                             where h.message_id = m.id and h.user_id = $2)
          order by p.pinned_at desc, p.message_id desc",
    )
    .bind(id)
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(
        hydrate_messages(&state, zeilen, user.id()).await?,
    )))
}
