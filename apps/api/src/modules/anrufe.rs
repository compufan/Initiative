//! 1:1-Anrufe – die HTTP-Seite. Die Signalisierung selbst läuft über die
//! Echtzeit-Leitung (`anruf.*`, siehe `services::anrufe`).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::services::anrufe;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/anrufe/ice", get(ice))
        .route("/anrufe/{id}", get(einer))
}

/// `GET /anrufe/ice` – STUN/TURN für `RTCPeerConnection`, mit kurzlebigen
/// TURN-Zugangsdaten (coturn `use-auth-secret`).
async fn ice(State(state): State<AppState>, user: AuthUser) -> Json<Value> {
    Json(anrufe::ice_server(&state.config, user.id()))
}

/// `GET /anrufe/{id}` – Zustand und Sitzungsbeschreibungen eines Anrufs, nur
/// für die beiden Beteiligten.
async fn einer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let zeile = anrufe::fuer(&state, id, user.id()).await?;
    Ok(Json(json!(zeile)))
}
