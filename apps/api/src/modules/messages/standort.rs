//! Live-Standort: die Nachricht einer laufenden Freigabe nachführen und beenden.
//!
//! Eine Live-Freigabe ist eine gewöhnliche `location`-Nachricht mit
//! `standort.live.bis` (vom Server beim Senden gesetzt, 15 oder 60 Minuten).
//! Solange sie läuft, schickt das Gerät des Absenders neue Punkte; jeder
//! überschreibt den Punkt in der Nachricht und geht als `message.updated` an
//! alle, die sie sehen. Es gibt keinen Verlauf der Punkte – der Empfänger
//! sieht die letzte Position und ihre Zeit, nicht den Weg.
//!
//! Die Freigabe läuft nur, solange die App offen ist: Der Client beendet sie
//! beim Schliessen oder wenn sie in den Hintergrund geht (`beenden`). Kommt
//! dieses Ende nicht an (Akku leer), steht nach `bis` nichts mehr an – die
//! Blase zeigt dann „beendet“ mit der letzten Zeit.

use axum::extract::{Path, State};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::MessageRow;
use crate::dto::MessageDto;
use crate::error::{AppError, AppResult};
use crate::services::messages::{
    hydrate_messages, publish_message_update, regeln, require_message,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/messages/{id}/standort", put(nachfuehren))
        .route("/messages/{id}/standort/beenden", post(beenden))
}

/// Ein Gerät schickt höchstens alle paar Sekunden einen Punkt; die Bremse
/// hält auch einen Fehler im Client davon ab, alle Mitglieder zu fluten.
const NACHFUEHREN: crate::drossel::Regel =
    crate::drossel::Regel::neu(30, std::time::Duration::from_secs(60));

async fn eigene_live(state: &AppState, id: Uuid, person: Uuid) -> AppResult<MessageRow> {
    let row = require_message(&state.pool, id).await?;
    if row.sender_id != Some(person) || row.r#type != "location" || row.deleted_at.is_some() {
        return Err(AppError::forbidden(
            "Nur der eigene Live-Standort lässt sich nachführen",
        ));
    }
    Ok(row)
}

async fn schreiben(
    state: &AppState,
    id: Uuid,
    standort: Value,
    person: Uuid,
) -> AppResult<MessageDto> {
    let zeile = sqlx::query_as::<_, MessageRow>(
        "update messages set metadata = jsonb_set(metadata, '{standort}', $2)
          where id = $1 and deleted_at is null returning *",
    )
    .bind(id)
    .bind(&standort)
    .fetch_one(&state.pool)
    .await?;
    let nachricht = hydrate_messages(state, vec![zeile], person)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("Nachricht konnte nicht geladen werden"))?;
    publish_message_update(state, &nachricht).await?;
    Ok(nachricht)
}

async fn nachfuehren(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(eingabe): Json<Value>,
) -> AppResult<Json<MessageDto>> {
    let row = eigene_live(&state, id, user.id()).await?;
    let jetzt = chrono::Utc::now();
    let mut standort = row.metadata.get("standort").cloned().unwrap_or(json!({}));
    if !regeln::live_laeuft(&standort, jetzt) {
        return Err(AppError::gone("Die Live-Freigabe ist beendet"));
    }
    if !state
        .drossel
        .erlaubt(&format!("standort:{id}"), NACHFUEHREN)
    {
        return Err(AppError::too_many("Zu viele Standort-Meldungen"));
    }
    let punkt = regeln::punkt_lesen(&eingabe).map_err(AppError::bad_request)?;
    standort["lat"] = json!(punkt.breite);
    standort["lon"] = json!(punkt.laenge);
    match punkt.genauigkeit {
        Some(g) => standort["genauigkeit"] = json!(g),
        None => {
            if let Some(f) = standort.as_object_mut() {
                f.remove("genauigkeit");
            }
        }
    }
    // Die Adresse gehörte zum ersten Punkt; nach einer Bewegung stimmt sie nicht mehr.
    if let Some(f) = standort.as_object_mut() {
        f.remove("adresse");
    }
    standort["live"]["aktualisiert"] = json!(jetzt);
    Ok(Json(schreiben(&state, id, standort, user.id()).await?))
}

async fn beenden(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<MessageDto>> {
    let row = eigene_live(&state, id, user.id()).await?;
    let jetzt = chrono::Utc::now();
    let mut standort = row.metadata.get("standort").cloned().unwrap_or(json!({}));
    if standort.get("live").is_none() {
        return Err(AppError::bad_request("Das ist kein Live-Standort"));
    }
    // Schon beendet: wie es ist, ohne neues Ereignis (Neuversuch).
    if !regeln::live_laeuft(&standort, jetzt) {
        return crate::services::messages::load_message(&state, id, user.id())
            .await?
            .map(Json)
            .ok_or_else(|| AppError::not_found("Nachricht nicht gefunden"));
    }
    standort["live"]["beendet"] = json!(jetzt);
    standort["live"]["bis"] = json!(jetzt);
    Ok(Json(schreiben(&state, id, standort, user.id()).await?))
}
