//! Einmal ansehbare Fotos und Videos: je Empfänger genau eine Auslieferung.
//!
//! # Wie „genau einmal“ entsteht
//!
//! Die Bytes gibt es nur über diese Route, nie über `/media/{id}` (die
//! Zugriffsprüfung in `services::zugriff` verweigert sie dort, auch dem
//! Absender), und die Nachricht trägt weder Adresse noch Vorschau noch
//! Miniatur (`messages::nachbereiten`). Vor dem Ausliefern schreibt die Route
//! eine Zeile (Anhang, Person) in `einmal_ansichten` – `on conflict do
//! nothing`: Wer schon eine hat, bekommt 410 Gone. Zwei gleichzeitige Abrufe
//! derselben Person entscheidet der Primärschlüssel; einer gewinnt.
//!
//! Scheitert danach das Lesen aus dem Speicher, wird die Zeile wieder
//! entfernt – sonst wäre das Foto „gesehen“, ohne dass je ein Byte ankam.
//!
//! Die Antwort trägt `Cache-Control: no-store`, und der Service Worker lässt
//! diese Route aus (`sw.ts`): Kein Zwischenspeicher hält eine zweite Kopie.
//!
//! # Was das nicht leistet
//!
//! Wer das Foto sieht, kann es abfotografieren oder per Bildschirmfoto
//! festhalten – im Web lässt sich das nicht verhindern. Die Oberfläche sagt
//! das beim Senden.
//!
//! Der Absender sieht seine eigene Aufnahme nicht noch einmal (wie bei
//! WhatsApp), nur, ob und von wie vielen sie geöffnet wurde.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, Response};
use axum::routing::get;
use axum::Router;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::services::conversations::assert_membership;
use crate::services::messages::{
    ist_einmal, load_message, publish_message_update, require_message,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/messages/{id}/einmal/{anhang}", get(oeffnen))
}

async fn oeffnen(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, anhang)): Path<(Uuid, Uuid)>,
) -> AppResult<Response<Body>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, id, user.id()).await?
        || row.deleted_at.is_some()
        || !ist_einmal(&row.metadata)
    {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    if row.sender_id == Some(user.id()) {
        return Err(AppError::forbidden(
            "Eigene einmal ansehbare Medien lassen sich nicht noch einmal öffnen",
        ));
    }
    let datei: Option<(String, String)> = sqlx::query_as(
        "select storage_key, mime from attachments
          where id = $1 and message_id = $2 and status = 'ready'",
    )
    .bind(anhang)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((schluessel, mime)) = datei else {
        return Err(AppError::not_found("Datei nicht gefunden"));
    };

    let neu = sqlx::query(
        "insert into einmal_ansichten (attachment_id, user_id) values ($1, $2)
         on conflict do nothing",
    )
    .bind(anhang)
    .bind(user.id())
    .execute(&state.pool)
    .await?
    .rows_affected()
        > 0;
    if !neu {
        return Err(AppError::gone(
            "Schon geöffnet – einmal ansehbar heisst einmal",
        ));
    }

    let objekt = match state.storage.read(&schluessel, None).await {
        Ok(Some(objekt)) => objekt,
        andere => {
            // Nichts ausgeliefert, also auch nicht verbraucht.
            let _ = sqlx::query(
                "delete from einmal_ansichten where attachment_id = $1 and user_id = $2",
            )
            .bind(anhang)
            .bind(user.id())
            .execute(&state.pool)
            .await;
            return Err(match andere {
                Err(fehler) => fehler,
                _ => AppError::not_found("Datei nicht gefunden"),
            });
        }
    };

    // „Geöffnet“ für den Absender (und die eigene Fassung der Blase).
    if let Ok(Some(nachricht)) = load_message(&state, id, user.id()).await {
        if let Err(fehler) = publish_message_update(&state, &nachricht).await {
            tracing::warn!(%fehler, "Einmal ansehen: Meldung gescheitert");
        }
    }

    let mut antwort = Response::builder()
        .header(header::CONTENT_TYPE, objekt.mime.unwrap_or(mime))
        .header(header::CACHE_CONTROL, "no-store, private, max-age=0")
        .header("x-content-type-options", "nosniff")
        .header(
            "content-security-policy",
            "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'",
        );
    if let Some(groesse) = objekt.size {
        antwort = antwort.header(header::CONTENT_LENGTH, groesse);
    }
    antwort
        .body(Body::from_stream(objekt.stream))
        .map_err(|_| AppError::internal("Antwort konnte nicht gebaut werden"))
}
