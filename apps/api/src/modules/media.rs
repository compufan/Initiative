//! Uploads, Auslieferung und Streaming von Medien.

use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

use crate::auth::{medienkeks, AuthUser};
use crate::constants::{allowed_mime, max_upload_bytes, ATTACHMENT_KINDS, PREVIEW_DATA_URL_MAX};
use crate::db::AttachmentRow;
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};
use crate::services::attachments::{darf_anhang_sehen, load_attachment, to_attachment_dto};
use crate::state::AppState;
use crate::storage::{
    extension_for, sanitise_file_name, storage_key_for, ByteRange, DownloadOptions,
};
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/media/uploads", post(create_upload))
        .route(
            "/media/uploads/{id}/data",
            post(upload_data).layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route("/media/uploads/{id}/complete", post(complete_upload))
        .route("/media/{id}", get(deliver).delete(remove))
        .route("/media/{id}/download", get(download))
        .route("/media/{id}/bytes", get(bytes_through_api))
}

/**
 * Wie gross ein Upload über die API höchstens sein darf.
 *
 * Axum lässt ohne diese Angabe 2 MiB durch – und keinen Bildpunkt mehr. Mit
 * einem Objektspeicher fiel das nie auf: Dort lädt der Browser mit einer
 * signierten Adresse direkt in den Bucket, und diese Route wird gar nicht
 * benutzt. Auf einem eigenen Server ist sie der einzige Weg, und jedes Foto
 * über 2 MB scheiterte mit einer Meldung, die nichts erklärt.
 *
 * Der Wert ist die grösste Obergrenze aus `max_upload_bytes` (Video, 200 MB)
 * plus etwas Luft für den Rahmen der mehrteiligen Übertragung. Die eigentliche
 * Grenze je Art prüft `upload_data` weiterhin selbst – und sagt dann auch,
 * welche es war.
 */
const UPLOAD_BODY_LIMIT: usize = 210 * 1024 * 1024;

/**
 * Wie viele Uploads gleichzeitig durch die API dürfen.
 *
 * `field.bytes()` liest die ganze Datei in den Arbeitsspeicher, bevor sie
 * abgelegt wird. Solange der Deckel bei 2 MiB lag, war das harmlos; mit 210 MB
 * kann eine einzige Anfrage so viel belegen, und ein paar gleichzeitige Videos
 * reichen auf einer 8-GB-Maschine mit laufendem Postgres für den
 * Speicherfresser des Systems.
 *
 * Zwei Plätze heisst: höchstens gut 400 MB Spitze. Wer als Dritter kommt,
 * wartet – und das ist deutlich besser, als wenn der Dienst stirbt und
 * ausgerechnet die Datenbank mitreisst.
 *
 * Die saubere Lösung wäre, im Strom auf die Platte zu schreiben, statt zu
 * puffern. Das braucht einen zweiten Weg im Speicher-Trait und ist hier
 * bewusst nicht getan – die Grenze wirkt sofort und kostet nichts.
 */
static UPLOAD_PLAETZE: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(2));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUploadInput {
    kind: String,
    mime: String,
    size: i64,
    file_name: Option<String>,
}

async fn create_upload(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateUploadInput>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    Validator::new()
        .one_of("kind", &input.kind, ATTACHMENT_KINDS)
        .require("size", input.size > 0, "Dateigröße fehlt")
        .finish()?;

    let allowed = allowed_mime(&input.kind);
    let normalised = input
        .mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !allowed.is_empty() && !allowed.contains(&normalised.as_str()) {
        return Err(AppError::unsupported_media(format!(
            "{} ist für {} nicht erlaubt",
            input.mime, input.kind
        )));
    }
    let limit = max_upload_bytes(&input.kind);
    if input.size > limit {
        return Err(AppError::too_large(format!(
            "Maximal {} MB für {}",
            limit / 1024 / 1024,
            input.kind
        )));
    }

    let file_name = input
        .file_name
        .as_deref()
        .map(sanitise_file_name)
        .filter(|value| !value.is_empty());
    let extension = extension_for(file_name.as_deref(), &input.mime);
    let storage_key = storage_key_for(&input.kind, &user.id(), &extension);
    let attachment_id = Uuid::now_v7();

    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, file_name, storage_key, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending')",
    )
    .bind(attachment_id)
    .bind(user.id())
    .bind(&input.kind)
    .bind(&input.mime)
    .bind(input.size)
    .bind(&file_name)
    .bind(&storage_key)
    .execute(&state.pool)
    .await?;

    // Opportunistic housekeeping keeps abandoned uploads from piling up.
    let pool = state.pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "delete from attachments
             where status = 'pending' and message_id is null
               and created_at < now() - interval '24 hours'",
        )
        .execute(&pool)
        .await;
    });

    let body = if state.storage.supports_presigned_upload() {
        let target = state.storage.presign_upload(&storage_key, &input.mime)?;
        json!({
            "attachmentId": attachment_id,
            "strategy": "presigned",
            "uploadUrl": target.url,
            "headers": target.headers.into_iter().collect::<std::collections::HashMap<_, _>>(),
            "expiresAt": target.expires_at,
        })
    } else {
        json!({
            "attachmentId": attachment_id,
            "strategy": "direct",
            "uploadUrl": format!(
                "{}/api/v1/media/uploads/{}/data",
                state.config.public_api_url, attachment_id
            ),
            "headers": {},
            "expiresAt": chrono::Utc::now() + chrono::Duration::hours(1),
        })
    };

    Ok((StatusCode::CREATED, Json(body)))
}

async fn require_own(state: &AppState, id: Uuid, user_id: Uuid) -> AppResult<AttachmentRow> {
    let attachment = load_attachment(&state.pool, id).await?;
    if attachment.uploader_id != Some(user_id) {
        return Err(AppError::forbidden("Fremder Upload"));
    }
    Ok(attachment)
}

async fn upload_data(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<Json<AttachmentDto>> {
    let attachment = require_own(&state, id, user.id()).await?;
    if attachment.message_id.is_some() {
        return Err(AppError::bad_request("Upload wurde bereits abgeschlossen"));
    }

    let limit = max_upload_bytes(&attachment.kind);
    let mut stored = false;
    let mut original_name: Option<String> = None;

    // Ab hier wird gepuffert – erst der Platz, dann die Bytes.
    let _platz = UPLOAD_PLAETZE
        .acquire()
        .await
        .map_err(|_| AppError::internal("Upload-Warteschlange nicht verfügbar"))?;

    // Ein Zeitlimit, das sich nach der angemeldeten Grösse richtet.
    //
    // Ein fester Deckel geht hier nicht: Bilder sind in Sekunden da, ein Video
    // darf 200 MiB haben (`constants.rs`). Zwanzig Sekunden für beides hiesse,
    // dass jedes Video über etwa 50 MB zuverlässig scheitert – und zwar mit
    // einer Meldung, die nach schlechtem Netz aussieht, nicht nach einem
    // falschen Grenzwert.
    //
    // Also: mindestens 25 KiB/s zugestehen. Das liegt weit unter jeder echten
    // Verbindung und weit über dem, was ein Slowloris-Versuch schickt – der
    // hält die Leitung mit ein paar Bytes je Minute offen. Untergrenze eine
    // Minute, Obergrenze eine Viertelstunde, damit weder ein winziger Upload
    // sofort abbricht noch ein Platz unbegrenzt belegt bleibt.
    let frist = Duration::from_secs((attachment.size.max(0) as u64 / (25 * 1024)).clamp(60, 900));

    timeout(frist, async {
        while let Some(field) = multipart
            .next_field()
            .await
            .map_err(|error| AppError::bad_request(format!("Upload fehlgeschlagen: {error}")))?
        {
            if field.name() != Some("file") {
                continue;
            }
            original_name = field.file_name().map(sanitise_file_name);
            let bytes = field.bytes().await.map_err(|error| {
                AppError::bad_request(format!("Upload fehlgeschlagen: {error}"))
            })?;
            if bytes.len() as i64 > limit {
                state.storage.delete(&attachment.storage_key).await.ok();
                sqlx::query("delete from attachments where id = $1")
                    .bind(id)
                    .execute(&state.pool)
                    .await?;
                return Err(AppError::too_large("Datei überschreitet das Upload-Limit"));
            }
            state
                .storage
                .put(&attachment.storage_key, bytes.clone(), &attachment.mime)
                .await?;
            sqlx::query("update attachments set size = $2 where id = $1")
                .bind(id)
                .bind(bytes.len() as i64)
                .execute(&state.pool)
                .await?;
            stored = true;
            break;
        }
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|_| AppError::bad_request("Upload-Timeout: Anfrage dauerte zu lange"))??;

    if !stored {
        return Err(AppError::bad_request("Es wurde keine Datei übertragen"));
    }

    let row = sqlx::query_as::<_, AttachmentRow>(
        "update attachments set status = 'ready', file_name = coalesce(file_name, $2)
         where id = $1 returning *",
    )
    .bind(id)
    .bind(original_name)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(to_attachment_dto(&row, &state.config)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadInput {
    width: Option<i32>,
    height: Option<i32>,
    duration_ms: Option<i32>,
    waveform: Option<Vec<f32>>,
    preview_data_url: Option<String>,
}

async fn complete_upload(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<CompleteUploadInput>,
) -> AppResult<Json<AttachmentDto>> {
    require_own(&state, id, user.id()).await?;

    if let Some(preview) = &input.preview_data_url {
        if preview.len() > PREVIEW_DATA_URL_MAX {
            return Err(AppError::bad_request("Vorschaubild ist zu groß"));
        }
        if !preview.starts_with("data:") {
            return Err(AppError::bad_request(
                "Vorschaubild muss eine data-URL sein",
            ));
        }
    }

    let row = sqlx::query_as::<_, AttachmentRow>(
        "update attachments set
           status = 'ready',
           width = coalesce($2, width),
           height = coalesce($3, height),
           duration_ms = coalesce($4, duration_ms),
           waveform = coalesce($5, waveform),
           preview_data_url = coalesce($6, preview_data_url)
         where id = $1
         returning *",
    )
    .bind(id)
    .bind(input.width)
    .bind(input.height)
    .bind(input.duration_ms)
    .bind(input.waveform.map(|values| serde_json::json!(values)))
    .bind(input.preview_data_url)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(to_attachment_dto(&row, &state.config)))
}

fn parse_range(header: Option<&str>, total: Option<u64>) -> Option<ByteRange> {
    let value = header?.strip_prefix("bytes=")?;
    let (start_raw, end_raw) = value.split_once('-')?;
    let end = end_raw.trim().parse::<u64>().ok();
    match start_raw.trim().parse::<u64>() {
        Ok(start) => Some(ByteRange { start, end }),
        // Suffix range ("bytes=-500") is only answerable with a known size.
        Err(_) => match (end, total) {
            (Some(length), Some(total)) => Some(ByteRange {
                start: total.saturating_sub(length),
                end: None,
            }),
            _ => None,
        },
    }
}

/**
 * Die Auslieferung – und die Stelle, an der entschieden wird, wer etwas sieht.
 *
 * Lange stand hier, die Anhangskennung sei eine „capability URL": 74
 * Zufallsbits, und wer sie kennt, bekommt die Datei. Das war die einzige
 * Antwort, die es damals gab – `<img>`, `<video>` und der Dienst-Arbeiter
 * können keinen `Authorization`-Kopf setzen, und ohne Ausweis lässt sich
 * niemand fragen.
 *
 * Seit dem Medien-Keks (`auth::medienkeks`) gibt es diesen Ausweis: Der
 * Browser schickt ihn bei genau diesen Anfragen von selbst mit. Damit ist ein
 * weitergegebener Verweis nicht mehr auf Dauer gültig, und `darf_anhang_sehen`
 * entscheidet nach der HEUTIGEN Lage – ein Austritt aus einem Gespräch entzieht
 * den Zugriff rückwirkend.
 *
 * Die Kennung bleibt trotzdem schwer zu raten. Sie ist jetzt nur nicht mehr
 * der einzige Riegel.
 */
async fn serve(
    state: AppState,
    id: Uuid,
    headers: HeaderMap,
    betrachter: Option<AuthUser>,
    as_download: bool,
    direkt: bool,
) -> AppResult<Response> {
    let attachment = load_attachment(&state.pool, id).await?;

    /*
     * Wer darf das hier sehen?
     *
     * Bis hierher war die Anhangskennung der Schlüssel: Wer sie kannte, bekam
     * die Datei – ohne Konto, ohne Ablauf, für immer. Das war kein Versehen,
     * sondern der Preis dafür, dass `<img>`, `<video>` und der Dienst-Arbeiter
     * keinen `Authorization`-Kopf setzen können.
     *
     * Der Keks löst genau diesen Knoten (siehe `auth::medienkeks`): Ihn
     * schickt der Browser bei einem `<img>` von selbst mit. Damit lässt sich
     * die Frage stellen, die vorher niemand stellen konnte – und `$2` ist
     * dabei die HEUTIGE Mitgliedschaft, ein Austritt entzieht den Zugriff also
     * rückwirkend.
     *
     * `not_found` statt `forbidden`: Ob es eine Datei mit dieser Kennung gibt,
     * geht den Fragenden nichts an.
     */
    /*
     * Zwei Wege zur selben Auskunft.
     *
     * Der Kopf trägt, was die App selbst holt (`fetch` im Foto-Editor, im
     * Sticker-Studio). Der Keks trägt alles, was der BROWSER holt – jedes
     * `<img>`, jedes `<video>`, jeder Herunterladen-Anker, jede Anfrage des
     * Dienst-Arbeiters. Beide führen auf dieselbe Person; keiner taugt für den
     * Weg des anderen (`medienkeks` prüft `typ`).
     */
    let wer = betrachter
        .map(|user| user.id())
        .or_else(|| medienkeks::betrachter(&headers, &state.config.jwt_secret));

    if state.config.media_auth {
        let Some(user) = wer else {
            return Err(AppError::unauthorized("Nicht angemeldet"));
        };
        if !darf_anhang_sehen(&state.pool, attachment.id, user).await? {
            return Err(AppError::not_found("Datei nicht gefunden"));
        }
    }

    /*
     * Ein unbestätigter Upload gehört nur dem, der ihn hochlädt.
     *
     * Der Fall ist schmal, aber er existiert: Beim Hochladen über eine
     * signierte Adresse liegen die Bytes im Speicher, sobald der Browser
     * fertig ist – `status` wird aber erst von `complete_upload` auf `ready`
     * gesetzt. Bleibt dieser Aufruf aus (Netz weg, App geschlossen), steht
     * eine Datei im Speicher, die niemand je abgeschickt hat und die trotzdem
     * über ihre Kennung vollständig abrufbar war.
     *
     * Beim Weg durch die API ist der Zustand folgenlos – dort gibt es ohne
     * `ready` auch keine Bytes –, und für fertige Anhänge ändert sich nichts.
     * Die Kennung bleibt für sie der Schlüssel; das ist Absicht und der Grund,
     * warum `<img>` und der Service Worker ohne Anmeldung funktionieren.
     */
    if attachment.status != "ready" {
        let eigen = wer == attachment.uploader_id && attachment.uploader_id.is_some();
        if !eigen {
            return Err(AppError::not_found("Datei nicht gefunden"));
        }
    }
    let options = DownloadOptions {
        file_name: attachment.file_name.clone(),
        mime: Some(attachment.mime.clone()),
        download: as_download,
    };

    // Nur auf dem Umleitungsweg fragen wir den Speicher nach einer Adresse;
    // ein Fehler dabei bleibt ein Fehler und wird nicht stillschweigend zum
    // Weiterreichen umgedeutet.
    /*
     * Umgeleitet wird nur, was auch angezeigt werden darf.
     *
     * Der ganze Schutz gegen eine hochgeladene `.html` – die Positivliste,
     * `nosniff`, die `sandbox`-CSP und `Content-Disposition: attachment` –
     * entsteht weiter unten beim Zusammenbauen der Antwort. Auf dem
     * Umleitungsweg wurde davon nichts gesetzt: Die Antwort ist ein 307, und
     * über Typ und Darstellung entschied allein der Speicher. Die signierte
     * Adresse trägt `response-content-type` aus der Datenbank, also brav
     * `text/html` – ohne `nosniff`, ohne CSP, ohne Anhang-Kopfzeile.
     *
     * Dass der Eimer meist auf einer anderen Herkunft liegt, hat das bisher
     * entschärft. Darauf ist aber kein Verlass: Mit `S3_PUBLIC_BASE_URL` auf
     * derselben Domain fällt auch das weg.
     *
     * Deshalb: Was nicht auf der Positivliste steht, geht durch die API. Das
     * kostet Bandbreite für Dateien, die ohnehin heruntergeladen werden – und
     * lässt den Schutz überall gleich wirken statt nur bei einer von zwei
     * Speicherarten.
     */
    let umleitung = if direkt && darf_angezeigt_werden(&attachment.mime) {
        state
            .storage
            .download_url(&attachment.storage_key, &options)?
    } else {
        None
    };

    if let Some(url) = umleitung {
        // R2/S3 serve the bytes directly – the API never proxies media.
        return Ok((
            [(header::CACHE_CONTROL, "private, max-age=60")],
            Redirect::temporary(&url),
        )
            .into_response());
    }

    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // Die Gesamtgrösse steht in der Datenbank. Früher wurde dafür das Objekt
    // ein zweites Mal gelesen und der Strom weggeworfen – bei einem lokalen
    // Dateisystem ist das billig, seit der S3-Treiber wirklich liest aber eine
    // vollständige Anfrage an den Speicher, deren Antwort niemand ansieht.
    // Bei jedem Vorspulen in einem Video.
    let total = if range_header.is_some() && attachment.size > 0 {
        Some(attachment.size as u64)
    } else {
        None
    };
    let range = parse_range(range_header.as_deref(), total);

    /*
     * Ein Bereich jenseits des Dateiendes ist nicht erfüllbar – und wird auch
     * so beantwortet.
     *
     * Vorher entstand daraus eine in sich widersprüchliche Antwort: Der
     * Speicher klemmt den Anfang auf das letzte Byte (`local.rs`), die
     * Kopfzeile nannte aber weiter den ANGEFRAGTEN Anfang. Bei einer Datei von
     * 100 Byte und `Range: bytes=999999-` stand da `Content-Range: bytes
     * 999999-99/100` mit `Content-Length: 1` und Status 206 – ein Bereich,
     * dessen Anfang hinter seinem Ende liegt, mit einem Byte Inhalt, das
     * niemand angefragt hat. RFC 7233 sieht dafür 416 vor.
     *
     * Die Prüfung steht vor dem Lesen: Sie spart dem Speicher die Anfrage.
     */
    if let (Some(bereich), Some(gesamt)) = (range, total) {
        if bereich.start >= gesamt {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{gesamt}"))],
            )
                .into_response());
        }
    }

    let object = state
        .storage
        .read(&attachment.storage_key, range)
        .await?
        .ok_or_else(|| AppError::not_found("Datei nicht gefunden"))?;

    // Der Typ, mit dem wirklich ausgeliefert wird – nicht der aus der
    // Datenbank. Beide können auseinanderlaufen (der lokale Speicher rät ihn
    // aus der Dateiendung), und die Entscheidung darüber, was im Browser
    // angezeigt werden darf, muss sich auf das beziehen, was tatsächlich im
    // Content-Type steht.
    let typ = object
        .mime
        .clone()
        .unwrap_or_else(|| attachment.mime.clone());

    // Alles, was nicht ausdrücklich anzeigbar ist, wird zum Herunterladen
    // angeboten statt dargestellt.
    let als_anhang = as_download || !darf_angezeigt_werden(&typ);

    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, &typ)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header("x-content-type-options", "nosniff")
        /*
         * Nicht in einen Suchindex.
         *
         * Diese Adressen tragen ihre Berechtigung in sich: Wer sie kennt,
         * bekommt die Datei (siehe der Kommentar weiter oben). Das ist
         * gewollt – nur so lassen sich Bilder über `<img src>` anzeigen,
         * ohne dass ein Token mitfahren müsste. Die Kehrseite: Eine einmal
         * weitergegebene Adresse bleibt gültig.
         *
         * Wenigstens soll sie nicht auch noch auffindbar werden. Landet ein
         * Link versehentlich in einem öffentlichen Beitrag, sagt diese
         * Kopfzeile jedem Suchdienst, dass er ihn weder aufnehmen noch
         * archivieren soll. Das schützt nicht vor dem, der die Adresse hat –
         * aber davor, dass sie jemand FINDET, ohne sie zu haben.
         */
        .header("x-robots-tag", "noindex, nofollow, noarchive, noimageindex");

    // `sandbox` steckt die Antwort in einen eigenen, leeren Ursprung: Selbst
    // wenn ein Browser sie doch als Dokument darstellt, läuft darin kein
    // Skript und es gibt keinen Zugriff auf das, was der App gehört.
    //
    // Für Bilder, Videos und Ton ist das folgenlos – die sind keine Dokumente,
    // die Kopfzeile greift dort gar nicht. PDFs sind ausgenommen, weil der
    // eingebaute Betrachter sonst je nach Browser nichts mehr anzeigt; ein PDF
    // kann ohnehin kein Skript im Ursprung der Seite ausführen.
    if !typ.starts_with("application/pdf") {
        response = response.header(
            "content-security-policy",
            "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'",
        );
    }

    if als_anhang {
        let name = sanitise_file_name(attachment.file_name.as_deref().unwrap_or("datei"));
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        );
    }

    /*
     * Die Gesamtgrösse aus der Datenbank springt ein, wenn der Speicher keine
     * meldet.
     *
     * Sonst fiel eine Bereichsanfrage in den `_`-Zweig und wurde mit 200 und
     * dem Rumpf beantwortet, den der Speicher für den BEREICH geliefert hat –
     * der Client hielte ein Stück für die ganze Datei. Ein Video lüde still
     * von vorn, eine Datei käme abgeschnitten an. Dieselbe Zahl hat schon
     * `parse_range` benutzt, sie passt also zum geklemmten Bereich.
     */
    let response = match (range, object.total_size.or(total)) {
        (Some(range), Some(total)) => {
            let end = range
                .end
                .unwrap_or(total.saturating_sub(1))
                .min(total.saturating_sub(1));
            response
                .status(StatusCode::PARTIAL_CONTENT)
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", range.start, end, total),
                )
                .header(
                    header::CONTENT_LENGTH,
                    object.size.unwrap_or(end - range.start + 1).to_string(),
                )
        }
        _ => match object.size {
            Some(size) => response.header(header::CONTENT_LENGTH, size.to_string()),
            None => response,
        },
    };

    response
        .body(Body::from_stream(object.stream))
        .map_err(|error| AppError::internal(error.to_string()))
}

async fn deliver(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    betrachter: Option<AuthUser>,
    headers: HeaderMap,
) -> AppResult<Response> {
    serve(state, id, headers, betrachter, false, true).await
}

/**
 * Dieselben Bytes, aber garantiert über die API statt per Umleitung.
 *
 * Für `<img src>` ist die Umleitung zum Speicher richtig – der Browser holt
 * dort direkt, die API bleibt aus dem Weg. Für alles, was die Bilddaten
 * *lesen* muss (Bearbeiten, Sticker daraus machen), ist sie ein Problem:
 * Nach einer Umleitung auf eine andere Herkunft schickt der Browser
 * `Origin: null` mit, und eine CORS-Regel, die auf die Adresse der App
 * ausgestellt ist, greift dann nicht mehr. Das Ergebnis wäre ein Bild, das
 * man sehen, aber nicht anfassen kann.
 *
 * Deshalb hier der gerade Weg. Er kostet Bandbreite auf dem Server, aber nur
 * beim Bearbeiten – nicht beim Anschauen.
 */
async fn bytes_through_api(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    betrachter: Option<AuthUser>,
    headers: HeaderMap,
) -> AppResult<Response> {
    serve(state, id, headers, betrachter, false, false).await
}

async fn download(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    betrachter: Option<AuthUser>,
    headers: HeaderMap,
) -> AppResult<Response> {
    serve(state, id, headers, betrachter, true, true).await
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let attachment = require_own(&state, id, user.id()).await?;
    if attachment.message_id.is_some() {
        return Err(AppError::forbidden(
            "Bereits gesendete Anhänge können nicht gelöscht werden",
        ));
    }
    state.storage.delete(&attachment.storage_key).await.ok();
    sqlx::query("delete from attachments where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Darf dieser Typ im Browser dargestellt werden, statt heruntergeladen?
///
/// # Warum es diese Liste gibt
///
/// Für `kind: "file"` ist jeder MIME-Typ erlaubt – das ist Absicht, in einen
/// Chat gehört auch mal ein Kalendereintrag oder eine Tabelle. Solange die
/// Dateien von einer anderen Domain kamen (Vercel für die App, R2 für die
/// Medien), war das folgenlos.
///
/// Auf einem eigenen Server liegen App und Dateien unter **derselben** Domain.
/// Damit wird aus einer hochgeladenen `.html` ein Dokument im Ursprung der App:
/// Es liest den Anmelde-Token aus dem Speicher des Browsers und schickt ihn
/// weg. Seit dem Medien-Keks braucht es dafür zwar ein Konto – aber das hat
/// jeder, dem man eine Datei schicken kann, und ein Angreifer schickt sie
/// gerade jemandem, der eines hat.
///
/// `nosniff` allein hilft dagegen nicht: Es verhindert, dass der Browser einen
/// Typ *errät*, nicht dass er einen mitgeschickten befolgt. Wenn im
/// Content-Type `text/html` steht, ist es HTML.
///
/// Deshalb wird hier ausdrücklich aufgezählt, statt `image/*` zu erlauben:
/// `image/svg+xml` ist ein Bild und gleichzeitig ein Dokument, in dem Skript
/// läuft. Es steht bewusst nicht auf der Liste.
fn darf_angezeigt_werden(mime: &str) -> bool {
    let basis = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        basis.as_str(),
        "image/jpeg"
            | "image/pjpeg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "image/avif"
            | "image/heic"
            | "image/heif"
            | "application/pdf"
    ) || basis.starts_with("video/")
        || basis.starts_with("audio/")
}

#[cfg(test)]
mod anzeige_tests {
    use super::darf_angezeigt_werden;

    #[test]
    fn bilder_videos_und_ton_werden_angezeigt() {
        for typ in [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/quicktime",
            "audio/mpeg",
            "application/pdf",
        ] {
            assert!(darf_angezeigt_werden(typ), "{typ} sollte anzeigbar sein");
        }
    }

    #[test]
    fn was_skript_ausfuehren_koennte_wird_heruntergeladen() {
        // Der eigentliche Grund für diese Funktion. Alle vier waren über
        // `kind: "file"` erlaubt und wären auf einer gemeinsamen Domain als
        // Dokument im Ursprung der App gelandet.
        for typ in [
            "text/html",
            "application/xhtml+xml",
            "image/svg+xml",
            "text/xml",
            "application/xml",
            "application/javascript",
        ] {
            assert!(
                !darf_angezeigt_werden(typ),
                "{typ} darf nicht angezeigt werden"
            );
        }
    }

    #[test]
    fn der_zusatz_hinter_dem_semikolon_aendert_nichts() {
        // `text/html; charset=utf-8` ist derselbe Typ. Ein Vergleich auf die
        // ganze Zeichenkette hätte hier danebengegriffen.
        assert!(!darf_angezeigt_werden("text/html; charset=utf-8"));
        assert!(darf_angezeigt_werden("image/jpeg; charset=binary"));
    }

    #[test]
    fn grossschreibung_hilft_niemandem_daran_vorbei() {
        assert!(!darf_angezeigt_werden("TEXT/HTML"));
        assert!(darf_angezeigt_werden("Image/PNG"));
    }

    #[test]
    fn unbekanntes_wird_im_zweifel_heruntergeladen() {
        assert!(!darf_angezeigt_werden(""));
        assert!(!darf_angezeigt_werden("application/octet-stream"));
        assert!(!darf_angezeigt_werden("text/plain"));
    }
}
