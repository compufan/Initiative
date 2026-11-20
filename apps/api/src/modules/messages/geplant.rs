//! Geplante Nachrichten („Später senden“): anlegen, auflisten, ändern, sofort
//! senden, löschen. Gesendet wird vom Dienst in `services::messages::geplant`.
//!
//! Beim Planen gelten dieselben Prüfungen wie beim Senden – soweit sie sich
//! schon jetzt beantworten lassen (Mitglied, Zusatzangaben, Anhänge fertig und
//! eigen). Was sich bis zum Zeitpunkt ändern kann (Sperre, „Nur Admins
//! senden“, Austritt), prüft der Dienst beim Senden noch einmal.
//!
//! Nur der Absender sieht seine geplanten Nachrichten. Für alle anderen gibt
//! es sie erst, wenn sie gesendet sind.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::MESSAGE_BODY_MAX;
use crate::dto::ListResult;
use crate::error::{AppError, AppResult};
use crate::services::conversations::assert_membership;
use crate::services::messages::geplant::{
    melden, senden, sofort_beanspruchen, Ausgang, GeplantDto, GeplantRow,
};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/conversations/{id}/geplant", get(liste).post(planen))
        .route("/geplant/{id}", patch(aendern).delete(loeschen))
        .route("/geplant/{id}/jetzt", post(jetzt_senden))
}

/// Was sich planen lässt: Text und Medien. Umfragen, Standorte, Kontakte und
/// einmal ansehbare Medien nicht – sie hängen am Augenblick des Sendens.
const PLANBAR: &[&str] = &["text", "image", "video", "audio", "file"];
/// Wie weit im Voraus höchstens: ein Jahr.
const VORAUS_MAX_TAGE: i64 = 366;
/// Wie viele offene geplante Nachrichten eine Person je Chat haben darf.
const OFFEN_MAX: i64 = 100;
const ZEITZONE_MAX: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanEingabe {
    #[serde(default = "text")]
    r#type: String,
    body: Option<String>,
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
    reply_to_id: Option<Uuid>,
    metadata: Option<Value>,
    senden_um: DateTime<Utc>,
    #[serde(default = "utc")]
    zeitzone: String,
}

fn text() -> String {
    "text".into()
}
fn utc() -> String {
    "UTC".into()
}

fn zeitpunkt_pruefen(senden_um: DateTime<Utc>) -> AppResult<()> {
    let jetzt = Utc::now();
    if senden_um <= jetzt + Duration::seconds(30) {
        return Err(AppError::bad_request(
            "Der Zeitpunkt muss in der Zukunft liegen",
        ));
    }
    if senden_um > jetzt + Duration::days(VORAUS_MAX_TAGE) {
        return Err(AppError::bad_request("Höchstens ein Jahr im Voraus"));
    }
    Ok(())
}

fn zeitzone_pruefen(zeitzone: &str) -> AppResult<()> {
    // Nur Anzeige – aber in einer festen Form (IANA-Namen wie
    // „Europe/Berlin“), damit niemand beliebigen Text unterbringt.
    let gut = !zeitzone.is_empty()
        && zeitzone.len() <= ZEITZONE_MAX
        && zeitzone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c));
    if !gut {
        return Err(AppError::bad_request("Ungültige Zeitzone"));
    }
    Ok(())
}

async fn planen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat): Path<Uuid>,
    Json(eingabe): Json<PlanEingabe>,
) -> AppResult<(StatusCode, Json<GeplantDto>)> {
    assert_membership(&state.pool, chat, user.id()).await?;
    if !PLANBAR.contains(&eingabe.r#type.as_str()) {
        return Err(AppError::bad_request(
            "Planen lassen sich Text, Fotos, Videos, Sprachnachrichten und Dateien",
        ));
    }
    zeitpunkt_pruefen(eingabe.senden_um)?;
    zeitzone_pruefen(&eingabe.zeitzone)?;
    let mut metadata = match eingabe.metadata {
        None | Some(Value::Null) => json!({}),
        Some(m) => m,
    };
    super::client_metadaten_pruefen(&eingabe.r#type, &metadata)?;
    if crate::services::messages::ist_einmal(&metadata) {
        return Err(AppError::bad_request(
            "Einmal ansehbare Medien lassen sich nicht planen",
        ));
    }
    let body = eingabe
        .body
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let mut anhaenge = eingabe.attachment_ids;
    super::metadaten_im_chat(
        &state,
        chat,
        user.id(),
        &eingabe.r#type,
        body.as_deref(),
        &mut metadata,
        &mut anhaenge,
    )
    .await?;
    anhaenge.sort();
    anhaenge.dedup();
    Validator::new()
        .require(
            "body",
            body.is_some() || !anhaenge.is_empty(),
            "Nachricht braucht Text oder Anhang",
        )
        .require(
            "body",
            body.as_deref().map_or(0, |t| t.chars().count()) <= MESSAGE_BODY_MAX,
            "Nachricht ist zu lang",
        )
        .require(
            "attachmentIds",
            anhaenge.len() <= crate::constants::ATTACHMENTS_PER_MESSAGE,
            "zu viele Anhänge",
        )
        .finish()?;
    if !anhaenge.is_empty() {
        let frei: i64 = sqlx::query_scalar(
            "select count(*) from attachments
              where id = any($1) and uploader_id = $2 and status = 'ready' and message_id is null",
        )
        .bind(&anhaenge)
        .bind(user.id())
        .fetch_one(&state.pool)
        .await?;
        if frei != anhaenge.len() as i64 {
            return Err(AppError::bad_request(
                "Mindestens ein Anhang ist nicht (fertig) hochgeladen oder schon vergeben",
            ));
        }
    }
    if let Some(antwort) = eingabe.reply_to_id {
        if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, antwort, user.id()).await? {
            return Err(AppError::bad_request(
                "Antwort bezieht sich auf eine unbekannte Nachricht",
            ));
        }
    }
    let offen: i64 = sqlx::query_scalar(
        "select count(*) from scheduled_messages
          where conversation_id = $1 and sender_id = $2 and status in ('geplant', 'fehlgeschlagen')",
    )
    .bind(chat)
    .bind(user.id())
    .fetch_one(&state.pool)
    .await?;
    if offen >= OFFEN_MAX {
        return Err(AppError::bad_request(
            "Zu viele geplante Nachrichten in diesem Chat",
        ));
    }

    let zeile = sqlx::query_as::<_, GeplantRow>(
        "insert into scheduled_messages
           (id, conversation_id, sender_id, typ, body, attachment_ids, reply_to_id, metadata,
            senden_um, zeitzone)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(chat)
    .bind(user.id())
    .bind(&eingabe.r#type)
    .bind(&body)
    .bind(&anhaenge)
    .bind(eingabe.reply_to_id)
    .bind(&metadata)
    .bind(eingabe.senden_um)
    .bind(&eingabe.zeitzone)
    .fetch_one(&state.pool)
    .await?;
    melden(&state, user.id(), chat).await;
    Ok((StatusCode::CREATED, Json(zeile.into())))
}

async fn liste(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat): Path<Uuid>,
) -> AppResult<Json<ListResult<GeplantDto>>> {
    assert_membership(&state.pool, chat, user.id()).await?;
    let zeilen = sqlx::query_as::<_, GeplantRow>(
        "select * from scheduled_messages
          where conversation_id = $1 and sender_id = $2 and status <> 'gesendet'
          order by senden_um asc, id asc",
    )
    .bind(chat)
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(
        zeilen.into_iter().map(GeplantDto::from).collect(),
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Aenderung {
    body: Option<String>,
    senden_um: Option<DateTime<Utc>>,
    zeitzone: Option<String>,
}

async fn aendern(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(aenderung): Json<Aenderung>,
) -> AppResult<Json<GeplantDto>> {
    let vorher = sqlx::query_as::<_, GeplantRow>(
        "select * from scheduled_messages where id = $1 and sender_id = $2",
    )
    .bind(id)
    .bind(user.id())
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Geplante Nachricht nicht gefunden"))?;
    if let Some(um) = aenderung.senden_um {
        zeitpunkt_pruefen(um)?;
    }
    if let Some(zone) = aenderung.zeitzone.as_deref() {
        zeitzone_pruefen(zone)?;
    }
    let body = match aenderung.body {
        Some(text) => {
            let text = text.trim().to_string();
            if text.chars().count() > MESSAGE_BODY_MAX {
                return Err(AppError::bad_request("Nachricht ist zu lang"));
            }
            if text.is_empty() && vorher.attachment_ids.is_empty() {
                return Err(AppError::bad_request("Nachricht braucht Text oder Anhang"));
            }
            (!text.is_empty()).then_some(text)
        }
        None => vorher.body.clone(),
    };
    // Eine Link-Vorschau, deren Link nicht mehr im Text steht, fällt weg.
    let mut metadata = vorher.metadata.clone();
    let vorschau_weg = metadata
        .get("linkVorschau")
        .and_then(|v| v.get("url"))
        .and_then(Value::as_str)
        .is_some_and(|url| !body.as_deref().is_some_and(|b| b.contains(url)));
    if vorschau_weg {
        if let Some(f) = metadata.as_object_mut() {
            f.remove("linkVorschau");
        }
    }
    // Nur, solange sie noch offen ist – nicht während der Dienst sie gerade
    // sendet. Eine gescheiterte wird durch das Ändern wieder geplant.
    let zeile = sqlx::query_as::<_, GeplantRow>(
        "update scheduled_messages
            set body = $3, senden_um = coalesce($4, senden_um), zeitzone = coalesce($5, zeitzone),
                metadata = $6, status = 'geplant', fehler = null, updated_at = now()
          where id = $1 and sender_id = $2 and status in ('geplant', 'fehlgeschlagen')
          returning *",
    )
    .bind(id)
    .bind(user.id())
    .bind(&body)
    .bind(aenderung.senden_um)
    .bind(aenderung.zeitzone)
    .bind(&metadata)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::conflict("Die Nachricht wird gerade gesendet"))?;
    // Liegt der (alte) Zeitpunkt einer gescheiterten schon zurück, geht sie
    // beim nächsten Durchgang – das ist dann ein neuer Versuch.
    melden(&state, user.id(), zeile.conversation_id).await;
    Ok(Json(zeile.into()))
}

async fn jetzt_senden(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let Some(zeile) = sofort_beanspruchen(&state, id, user.id()).await? else {
        // Schon gesendet (ein Neuversuch) – dann die Kennung zurück.
        let erledigt: Option<(Option<Uuid>,)> = sqlx::query_as(
            "select message_id from scheduled_messages
              where id = $1 and sender_id = $2 and status = 'gesendet'",
        )
        .bind(id)
        .bind(user.id())
        .fetch_optional(&state.pool)
        .await?;
        return match erledigt {
            Some((nachricht,)) => Ok(Json(json!({ "messageId": nachricht }))),
            None => Err(AppError::conflict("Die Nachricht wird gerade gesendet")),
        };
    };
    match senden(&state, &zeile).await? {
        Ausgang::Gesendet(nachricht) => Ok(Json(json!({ "messageId": nachricht }))),
        Ausgang::Gescheitert(grund) => Err(AppError::bad_request(grund)),
    }
}

async fn loeschen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let weg: Option<(Uuid, Vec<Uuid>)> = sqlx::query_as(
        "delete from scheduled_messages
          where id = $1 and sender_id = $2 and status in ('geplant', 'fehlgeschlagen')
          returning conversation_id, attachment_ids",
    )
    .bind(id)
    .bind(user.id())
    .fetch_optional(&mut *tx)
    .await?;
    let Some((chat, anhaenge)) = weg else {
        tx.rollback().await?;
        // Schon weg (Neuversuch) oder gerade unterwegs.
        let gibt_es: bool = sqlx::query_scalar(
            "select exists (select 1 from scheduled_messages where id = $1 and sender_id = $2)",
        )
        .bind(id)
        .bind(user.id())
        .fetch_one(&state.pool)
        .await?;
        return if gibt_es {
            Err(AppError::conflict("Die Nachricht wird gerade gesendet"))
        } else {
            Ok(StatusCode::NO_CONTENT)
        };
    };
    // Die nie gesendeten Anhänge gleich mit: Sie gehören zu nichts mehr, und
    // ungebundene fertige Anhänge räumt sonst niemand weg. Der Auslöser legt
    // sie in `storage_muell`.
    if !anhaenge.is_empty() {
        sqlx::query(
            "delete from attachments
              where id = any($1) and uploader_id = $2 and message_id is null",
        )
        .bind(&anhaenge)
        .bind(user.id())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    melden(&state, user.id(), chat).await;
    Ok(StatusCode::NO_CONTENT)
}
