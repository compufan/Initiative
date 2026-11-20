//! Die Chat-Einstellung „Selbstlöschende Nachrichten“ (aus, 24 Stunden, 7 Tage,
//! 90 Tage). Den Aufräumdienst beschreibt `services::messages::selbstloeschen`.
//!
//! Wer darf: im Direktchat beide, in einer Gruppe wer die Gruppeninfo ändern
//! darf (`anheften::darf_gruppeninfo`). Jede Änderung hinterlässt eine
//! Systemzeile – alle sollen wissen, ab wann ihre Nachrichten verschwinden.

use axum::extract::{Path, State};
use axum::routing::put;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::dto::ConversationDto;
use crate::error::{AppError, AppResult};
use crate::services::messages::{ausliefern, nachricht_anlegen, regeln, NewMessage};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/conversations/{id}/selbstloeschen", put(setzen))
}

#[derive(Debug, Deserialize)]
struct Eingabe {
    /// Lebensdauer in Sekunden aus den festen Stufen; `null` schaltet aus.
    sekunden: Option<i32>,
}

async fn setzen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(eingabe): Json<Eingabe>,
) -> AppResult<Json<ConversationDto>> {
    if let Some(sekunden) = eingabe.sekunden {
        if !regeln::selbstloeschen_stufe_gueltig(sekunden) {
            return Err(AppError::bad_request(
                "Selbstlöschen geht nach 24 Stunden, 7 Tagen oder 90 Tagen",
            ));
        }
    }
    super::anheften::darf_gruppeninfo(&state, id, user.id()).await?;

    let mut tx = state.pool.begin().await?;
    // Nur eine echte Änderung schreibt – und hinterlässt eine Zeile. Ein
    // Neuversuch derselben Einstellung ist folgenlos.
    let geaendert = sqlx::query(
        "update conversations set selbstloeschen_s = $2, updated_at = now()
          where id = $1 and selbstloeschen_s is distinct from $2",
    )
    .bind(id)
    .bind(eingabe.sekunden)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let angelegt = if geaendert {
        let mut zeile =
            NewMessage::system(id, user.id(), "conversation.selbstloeschen", Vec::new());
        zeile.metadata["system"]["value"] = json!(eingabe
            .sekunden
            .map(|s| s.to_string())
            .unwrap_or_else(|| "aus".to_string()));
        Some(nachricht_anlegen(&mut tx, zeile).await?)
    } else {
        None
    };
    tx.commit().await?;

    if let Some(angelegt) = angelegt {
        ausliefern(&state, angelegt).await?;
        crate::services::conversations::broadcast_conversation(&state, id, None).await?;
    }
    Ok(Json(
        crate::services::conversations::load_conversation_dto(&state, user.id(), id).await?,
    ))
}
