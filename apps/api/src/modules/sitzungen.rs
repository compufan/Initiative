//! Geräteliste: angemeldete Sitzungen ansehen und beenden.
//!
//! Eine Sitzung ist eine Kette von Erneuerungs-Tokens (`refresh_tokens.sitzung_id`,
//! Migration 0039): Bei jeder Erneuerung entsteht eine neue Zeile, die Kette
//! bleibt. Lebendig ist eine Sitzung, solange ein Glied weder widerrufen noch
//! abgelaufen ist.
//!
//! Beenden heisst: alle Glieder widerrufen – dann scheitert die nächste
//! Erneuerung –, das Zugriffstoken sofort abweisen und die Echtzeit-Leitung
//! schliessen (`auth::sitzungen`). Sonst läse ein abgemeldetes Gerät noch eine
//! Viertelstunde lang jede neue Nachricht mit.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::{sitzungen, AktuelleSitzung};
use crate::dto::ListResult;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/sitzungen", get(liste))
        .route("/auth/sitzungen/andere", post(andere_beenden))
        .route("/auth/sitzungen/{id}", delete(beenden))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct SitzungDto {
    id: Uuid,
    /// Roh – die Oberfläche macht daraus „Firefox auf Linux“.
    user_agent: Option<String>,
    angemeldet_at: Option<chrono::DateTime<chrono::Utc>>,
    zuletzt_aktiv: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(skip)]
    aktuell: bool,
}

async fn liste(
    State(state): State<AppState>,
    ich: AktuelleSitzung,
) -> AppResult<Json<ListResult<SitzungDto>>> {
    let mut liste = sqlx::query_as::<_, SitzungDto>(
        "select coalesce(sitzung_id, id) as id,
                max(user_agent) as user_agent,
                min(coalesce(angemeldet_at, created_at)) as angemeldet_at,
                max(coalesce(zuletzt_aktiv, created_at)) as zuletzt_aktiv
           from refresh_tokens
          where user_id = $1 and revoked_at is null and expires_at > now()
          group by coalesce(sitzung_id, id)
          order by max(coalesce(zuletzt_aktiv, created_at)) desc",
    )
    .bind(ich.user)
    .fetch_all(&state.pool)
    .await?;
    for sitzung in &mut liste {
        sitzung.aktuell = Some(sitzung.id) == ich.sitzung;
    }
    // Das aktuelle Gerät zuerst – dort sucht man es.
    liste.sort_by_key(|sitzung| !sitzung.aktuell);
    Ok(Json(ListResult::new(liste)))
}

/// Alle Glieder dieser Sitzungen entfernen; danach die Tokens im Speicher
/// sperren und die Leitungen schliessen.
///
/// # Löschen statt widerrufen
///
/// Ein widerrufener Token, der noch einmal vorgelegt wird, gilt der Erneuerung
/// als Diebstahl – und beendet ALLE Sitzungen des Kontos (siehe
/// `modules::auth::refresh`). Das abgemeldete Gerät erneuert aber genau das
/// nach seinem nächsten 401, und risse damit das Gerät mit, das es gerade
/// abgemeldet hat. Gelöschte Glieder kennt die Erneuerung nicht: Sie
/// antwortet schlicht „Sitzung abgelaufen“.
async fn widerrufen(state: &AppState, user: Uuid, sitzungen_ids: &[Uuid]) -> AppResult<()> {
    if sitzungen_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "delete from refresh_tokens
          where user_id = $1 and coalesce(sitzung_id, id) = any($2)",
    )
    .bind(user)
    .bind(sitzungen_ids)
    .execute(&state.pool)
    .await?;
    for sitzung in sitzungen_ids {
        sitzungen::beenden(*sitzung);
    }
    Ok(())
}

async fn beenden(
    State(state): State<AppState>,
    ich: AktuelleSitzung,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    // Nur eigene: Die Abfrage in `widerrufen` hängt am Konto, eine fremde
    // Kennung trifft nichts. Damit die Antwort das nicht verschleiert, erst
    // nachsehen.
    let meine: bool = sqlx::query_scalar(
        "select exists (select 1 from refresh_tokens
                         where user_id = $1 and coalesce(sitzung_id, id) = $2)",
    )
    .bind(ich.user)
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    if !meine {
        return Err(AppError::not_found("Sitzung nicht gefunden"));
    }
    widerrufen(&state, ich.user, &[id]).await?;
    tracing::info!(user = %ich.user, sitzung = %id, "Sitzung beendet");
    Ok(StatusCode::NO_CONTENT)
}

/// „Alle anderen Geräte abmelden“.
async fn andere_beenden(
    State(state): State<AppState>,
    ich: AktuelleSitzung,
) -> AppResult<Json<serde_json::Value>> {
    let Some(aktuell) = ich.sitzung else {
        // Ein Token von vor der Geräteliste kennt seine Sitzung nicht – und
        // ohne sie würde „alle anderen“ auch dieses Gerät abmelden.
        return Err(AppError::conflict(
            "Dieses Gerät ist noch mit einer älteren Anmeldung unterwegs. Lade die Seite neu und versuch es dann noch einmal.",
        ));
    };
    // Auch die schon widerrufenen Glieder fremder Ketten: Sie sollen beim
    // Vorlegen nicht als Diebstahl gelten (siehe `widerrufen`).
    let andere: Vec<Uuid> = sqlx::query_scalar(
        "select distinct coalesce(sitzung_id, id) from refresh_tokens
          where user_id = $1 and coalesce(sitzung_id, id) <> $2",
    )
    .bind(ich.user)
    .bind(aktuell)
    .fetch_all(&state.pool)
    .await?;
    widerrufen(&state, ich.user, &andere).await?;
    tracing::info!(user = %ich.user, anzahl = andere.len(), "andere Sitzungen beendet");
    Ok(Json(serde_json::json!({ "beendet": andere.len() })))
}
