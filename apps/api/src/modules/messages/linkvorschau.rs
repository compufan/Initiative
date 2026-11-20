//! `POST /link-vorschau` – der Absender lässt eine Vorschau erzeugen.
//!
//! Nur mit eingeschalteter Einstellung „Link-Vorschauen erzeugen“
//! (`settings.linkVorschauen`, Standard aus). Die Oberfläche fragt, während
//! jemand einen Link tippt; das Ergebnis kommt in die Nachricht
//! (`metadata.linkVorschau`), das Bild verkleinert als eigener Anhang in den
//! Medienspeicher. Was hier gegen SSRF schützt, steht in
//! `services::messages::linkvorschau`.

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::services::messages::linkvorschau::{bild_abrufen, seite_abrufen, Fehler};
use crate::services::messages::regeln::VORSCHAU_URL_MAX;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/link-vorschau", post(erzeugen))
}

#[derive(Debug, Deserialize)]
struct Eingabe {
    url: String,
}

/// Zwanzig Vorschauen in der Minute je Person – genug für jeden, der tippt,
/// zu wenig, um den Server als Abrufdienst zu benutzen.
const VORSCHAUEN: crate::drossel::Regel =
    crate::drossel::Regel::neu(20, std::time::Duration::from_secs(60));

/// Kantenlänge des abgelegten Vorschaubilds.
const BILD_KANTE: u32 = 320;

/// Ist die Einstellung an? Ohne Angabe: aus.
pub fn eingeschaltet(settings: &Value) -> bool {
    settings.get("linkVorschauen").and_then(Value::as_bool) == Some(true)
}

async fn erzeugen(
    State(state): State<AppState>,
    user: AuthUser,
    Json(eingabe): Json<Eingabe>,
) -> AppResult<Json<Value>> {
    let settings: Value = sqlx::query_scalar("select settings from users where id = $1")
        .bind(user.id())
        .fetch_one(&state.pool)
        .await?;
    if !eingeschaltet(&settings) {
        return Err(AppError::forbidden(
            "Link-Vorschauen sind in deinen Einstellungen ausgeschaltet",
        ));
    }
    let url = eingabe.url.trim().to_string();
    if url.is_empty() || url.len() > VORSCHAU_URL_MAX {
        return Err(AppError::bad_request("Ungültige Adresse"));
    }
    if !state
        .drossel
        .erlaubt(&format!("linkvorschau:{}", user.id()), VORSCHAUEN)
    {
        return Err(AppError::too_many(
            "Zu viele Vorschauen. Warte einen Moment.",
        ));
    }

    let (seite, bild_url) = seite_abrufen(&url).await.map_err(|fehler| match fehler {
        Fehler::Verboten(grund) => AppError::bad_request(format!("Adresse nicht erlaubt: {grund}")),
        Fehler::NichtErreichbar(grund) => {
            AppError::upstream(format!("Keine Vorschau verfügbar ({grund})"))
        }
    })?;
    if seite.titel.is_none() && seite.beschreibung.is_none() {
        return Err(AppError::upstream("Die Seite sagt nichts über sich"));
    }

    // Das Bild: holen, verkleinern, im eigenen Speicher ablegen. Scheitert
    // irgendetwas daran, gibt es die Vorschau eben ohne Bild.
    let mut bild_id: Option<Uuid> = None;
    if let Some(bild_url) = bild_url {
        match bild_ablegen(&state, user.id(), bild_url).await {
            Ok(id) => bild_id = Some(id),
            Err(fehler) => tracing::debug!(%fehler, "Link-Vorschau ohne Bild"),
        }
    }

    Ok(Json(json!({
        "url": url,
        "titel": seite.titel,
        "beschreibung": seite.beschreibung,
        "seite": seite.seitenname,
        "bildId": bild_id,
        "bildUrl": bild_id.map(|id| state.config.media_url(&id)),
    })))
}

async fn bild_ablegen(state: &AppState, person: Uuid, url: reqwest::Url) -> AppResult<Uuid> {
    let roh = bild_abrufen(url)
        .await
        .map_err(|_| AppError::upstream("Bild nicht erreichbar"))?;
    let (jpeg, breite, hoehe) = tokio::task::spawn_blocking(move || {
        let klein = crate::services::miniatur::rechnen(&roh, BILD_KANTE)?;
        let masse = image::load_from_memory(&klein)
            .map(|b| (b.width() as i32, b.height() as i32))
            .unwrap_or((0, 0));
        Ok::<_, AppError>((klein, masse.0, masse.1))
    })
    .await
    .map_err(|_| AppError::internal("Bild konnte nicht gerechnet werden"))??;

    let id = Uuid::now_v7();
    let schluessel = crate::storage::storage_key_for("image", &person, ".jpg");
    let groesse = jpeg.len() as i64;
    state
        .storage
        .put(&schluessel, Bytes::from(jpeg), "image/jpeg")
        .await?;
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, file_name, storage_key,
                                  width, height, status)
         values ($1, $2, 'image', 'image/jpeg', $3, 'vorschau.jpg', $4, $5, $6, 'ready')",
    )
    .bind(id)
    .bind(person)
    .bind(groesse)
    .bind(&schluessel)
    .bind(breite)
    .bind(hoehe)
    .execute(&state.pool)
    .await?;
    Ok(id)
}
