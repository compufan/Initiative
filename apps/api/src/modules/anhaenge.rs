//! Medienübersicht und Export eines Chats – die Routen.
//!
//! Die Regeln (was sichtbar ist, wie der Export aussieht) stehen in
//! `services::anhaenge`.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{jwt, AuthUser};
use crate::drossel::regeln;
use crate::dto::ListResult;
use crate::error::{AppError, AppResult};
use crate::services::anhaenge::{self, Art, ExportWunsch};
use crate::services::conversations::assert_membership;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/conversations/{id}/anhaenge", get(uebersicht))
        .route("/conversations/{id}/export", post(export_ausstellen))
        .route("/chat-export/{karte}", get(export_liefern))
}

#[derive(Debug, Deserialize)]
struct UebersichtAbfrage {
    art: String,
    vor: Option<String>,
    limit: Option<i64>,
}

/// `GET /conversations/{id}/anhaenge?art=medien|dokumente|links|audio&vor=…`
async fn uebersicht(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(abfrage): Query<UebersichtAbfrage>,
) -> AppResult<Json<ListResult<Value>>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let art = Art::aus(&abfrage.art).ok_or_else(|| {
        AppError::bad_request("art muss medien, dokumente, links oder audio sein")
    })?;
    let (eintraege, weiter) = anhaenge::uebersicht(
        &state.pool,
        &state.config,
        id,
        user.id(),
        art,
        abfrage.vor.as_deref(),
        abfrage.limit.unwrap_or(anhaenge::SEITE_VORGABE),
    )
    .await?;
    Ok(Json(ListResult::paged(eintraege, weiter)))
}

/// Wie lange die Adresse eines Exports gilt.
const EXPORT_KARTE_S: i64 = 300;

fn karten_typ(conversation_id: Uuid) -> String {
    format!("chat-export:{conversation_id}")
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEingabe {
    #[serde(default)]
    mit_medien: bool,
    /// `Date.getTimezoneOffset()` des Geräts.
    #[serde(default)]
    zeitzone_versatz: i32,
}

/**
 * `POST /conversations/{id}/export` – eine Adresse, unter der der Export für
 * fünf Minuten abholbar ist.
 *
 * # Warum eine Adresse und nicht gleich die Datei
 *
 * Ein Export mit Medien kann Gigabytes haben. Über `fetch` müsste die App ihn
 * ganz in den Arbeitsspeicher holen, bevor sie ihn speichern kann – auf einem
 * Telefon das sichere Ende. Eine Adresse kann der Browser selbst
 * herunterladen, im Strom auf die Platte, mit seiner eigenen Fortschritts-
 * anzeige. Sie trägt eine Karte (signiert, an Person und Chat gebunden, fünf
 * Minuten gültig) – wie die Fernsehkarte (`auth::fernsehticket`).
 */
async fn export_ausstellen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    eingabe: Option<Json<ExportEingabe>>,
) -> AppResult<Json<Value>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let eingabe = eingabe.map(|Json(e)| e).unwrap_or_default();
    let karte = jwt::encode(
        &user.id().to_string(),
        &karten_typ(id),
        &state.config.jwt_secret,
        EXPORT_KARTE_S,
    );
    let url = format!(
        "{}/api/v1/chat-export/{karte}?medien={}&tz={}",
        state.config.public_api_url,
        if eingabe.mit_medien { 1 } else { 0 },
        eingabe.zeitzone_versatz.clamp(-14 * 60, 14 * 60),
    );
    Ok(Json(json!({
        "url": url,
        "gueltigBis": chrono::Utc::now() + chrono::Duration::seconds(EXPORT_KARTE_S),
    })))
}

#[derive(Debug, Deserialize)]
struct LieferAbfrage {
    medien: Option<u8>,
    tz: Option<i32>,
}

/// Höchstens so viele Exporte gleichzeitig – jeder hält eine Datenbank-
/// verbindung je Seite und liest die Ablage.
static EXPORT_PLAETZE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));

/// `GET /chat-export/{karte}` – das ZIP, im Strom.
async fn export_liefern(
    State(state): State<AppState>,
    Path(karte): Path<String>,
    Query(abfrage): Query<LieferAbfrage>,
) -> AppResult<Response> {
    let claims = jwt::decode(&karte, &state.config.jwt_secret)
        .ok_or_else(|| AppError::unauthorized("Die Export-Adresse ist abgelaufen"))?;
    let person = Uuid::parse_str(&claims.sub)
        .map_err(|_| AppError::unauthorized("Die Export-Adresse ist ungültig"))?;
    let conversation_id = claims
        .typ
        .strip_prefix("chat-export:")
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(|| AppError::unauthorized("Die Export-Adresse ist ungültig"))?;
    // Die HEUTIGE Mitgliedschaft: Wer inzwischen ausgetreten ist, bekommt
    // auch mit einer noch gültigen Karte nichts mehr.
    assert_membership(&state.pool, conversation_id, person).await?;

    if !state
        .drossel
        .erlaubt(&format!("export:{person}"), regeln::CHAT_EXPORT)
    {
        return Err(AppError::too_many(
            "Zu viele Exporte – bitte später noch einmal",
        ));
    }
    let platz = EXPORT_PLAETZE.clone().try_acquire_owned().map_err(|_| {
        AppError::too_many("Gerade laufen zu viele Exporte – bitte gleich noch einmal")
    })?;

    let titel = export_titel(&state, conversation_id, person).await?;
    let wunsch = ExportWunsch {
        conversation_id,
        person,
        mit_medien: abfrage.medien.unwrap_or(0) == 1,
        versatz_min: abfrage.tz.unwrap_or(0),
    };
    let (schreiber, leser) = tokio::io::duplex(256 * 1024);
    let dienst = state.clone();
    tokio::spawn(async move {
        let _platz = platz;
        if let Err(fehler) = anhaenge::exportieren(&dienst, wunsch, schreiber).await {
            tracing::info!(%fehler, "Chat-Export abgebrochen");
        }
    });

    let name = anhaenge::exportname(&titel);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"chat-export.zip\"; filename*=UTF-8''{}",
                urlencoding::encode(&name)
            ),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(leser)))
        .map_err(|fehler| AppError::internal(fehler.to_string()))
}

/// Der Name des Chats aus Sicht dieser Person (Gruppe: Titel, Direkt: das
/// Gegenüber).
async fn export_titel(state: &AppState, conversation_id: Uuid, person: Uuid) -> AppResult<String> {
    let titel: Option<String> = sqlx::query_scalar(
        "select coalesce(
           case when c.type = 'group' then c.title end,
           (select u.display_name from conversation_members cm
              join users u on u.id = cm.user_id
             where cm.conversation_id = c.id and cm.user_id <> $2
             order by cm.joined_at limit 1),
           c.title)
         from conversations c where c.id = $1",
    )
    .bind(conversation_id)
    .bind(person)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    Ok(titel.unwrap_or_default())
}
