//! Hochladen in Stücken – fortsetzbar, für Dateien bis in die Gigabytes.
//!
//! # Warum ein zweiter Weg neben `/media/uploads`
//!
//! Der alte Weg schickt die Datei in EINER Anfrage, und der Server liest sie
//! dabei ganz in den Arbeitsspeicher (`field.bytes()` in `media.rs`). Das ist
//! für ein Foto richtig und für ein Video von 4 GiB unmöglich: zu viel
//! Speicher, und jeder Netzabriss fängt bei null an. Er bleibt für kleine
//! Dateien bestehen – ältere Clients sprechen ihn, und für ein Foto ist eine
//! Anfrage schlicht schneller als drei.
//!
//! # Der Ablauf
//!
//! ```text
//! POST   /media/stuecke                    { kind, mime, size, fileName?, sha256? }
//!                                          → 201 Stand (sitzungId, stueckGroesse …)
//! PUT    /media/stuecke/{id}               Content-Range: bytes a-b/size, Rumpf roh
//!                                          → 200 Stand
//! GET    /media/stuecke/{id}               → Stand (welche Stücke schon da sind)
//! POST   /media/stuecke/{id}/abschliessen  { width?, height?, … } → Attachment
//! DELETE /media/stuecke/{id}               → 204
//! ```
//!
//! Stücke dürfen in beliebiger Reihenfolge, gleichzeitig und doppelt kommen.
//! Jedes wird im Strom an seinen Platz in einer Teildatei geschrieben – nie
//! mehr als ein Netzpaket liegt dabei im Speicher. Erst wenn es vollständig
//! und auf der Platte ist (`sync_data`), wird es als empfangen gebucht; ein
//! abgerissenes Stück ist also einfach nicht da und wird wiederholt.
//!
//! Die Sitzung lebt in der Datenbank (Migration 0033), damit ein Neustart des
//! Servers oder der App nichts verliert. Nach `UPLOAD_SITZUNG_STUNDEN` ohne
//! Bewegung räumt [`aufraeumen`] sie samt Teildatei weg.

use std::collections::HashSet;
use std::path::{Path as DateiPfad, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{allowed_mime, max_stueck_upload_bytes, STUECK_GROESSE};
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};
use crate::modules::media::{fertig_melden, metadaten_pruefen, CompleteUploadInput};
use crate::services::attachments::{load_attachment, to_attachment_dto};
use crate::state::AppState;
use crate::storage::{extension_for, sanitise_file_name, storage_key_for};
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/media/grenzen", get(grenzen))
        .route("/media/stuecke", post(anlegen))
        .route(
            "/media/stuecke/{id}",
            get(stand_abfragen).put(stueck_empfangen).delete(abbrechen),
        )
        .route("/media/stuecke/{id}/abschliessen", post(abschliessen))
}

/// Was in Stücken hochgeladen werden darf. Sticker nicht – die sind klein und
/// haben ihren eigenen Weg mit eigenen Prüfungen (`services::stickers`).
const ARTEN: &[&str] = &["image", "video", "audio", "file"];

/// Wie viele offene Sitzungen ein Konto höchstens hat. Neben der Bytegrenze,
/// weil jede Sitzung eine Datei und eine Zeile kostet, auch eine kleine.
const OFFEN_HOECHSTZAHL: i64 = 20;

/// Wie lange zwischen zwei Netzpaketen eines Stückes höchstens Stille sein
/// darf. Ein echtes Netz liefert in einer Minute etwas; ein Slowloris-Versuch,
/// der Verbindungen mit einem Byte je Minute offen hält, fliegt hier raus.
const STILLE_MAX: Duration = Duration::from_secs(60);

/// Ein Abschluss, der so lange in `abschluss` steht, gilt als abgestürzt
/// (Server neu gestartet) und darf neu versucht werden.
const ABSCHLUSS_HAENGT_MIN: i64 = 60;

#[derive(Debug, Clone, sqlx::FromRow)]
struct Sitzung {
    id: Uuid,
    user_id: Uuid,
    attachment_id: Uuid,
    kind: String,
    mime: String,
    groesse: i64,
    stueck_groesse: i32,
    sha256: Option<String>,
    status: String,
    aktualisiert_at: chrono::DateTime<chrono::Utc>,
}

impl Sitzung {
    fn anzahl_stuecke(&self) -> i64 {
        stueck_anzahl(self.groesse, self.stueck_groesse as i64)
    }

    /// Wie lang Stück `nr` sein muss – das letzte ist meist kürzer.
    fn laenge_von(&self, nr: i64) -> i64 {
        let start = nr * self.stueck_groesse as i64;
        (self.groesse - start).min(self.stueck_groesse as i64)
    }
}

fn stueck_anzahl(groesse: i64, stueck: i64) -> i64 {
    (groesse + stueck - 1) / stueck
}

fn teil_pfad(state: &AppState, id: Uuid) -> PathBuf {
    PathBuf::from(&state.config.upload_teile_dir).join(format!("{}.teil", id.simple()))
}

async fn eigene_sitzung(state: &AppState, id: Uuid, user: Uuid) -> AppResult<Sitzung> {
    let sitzung: Option<Sitzung> = sqlx::query_as(
        "select id, user_id, attachment_id, kind, mime, groesse, stueck_groesse, sha256,
                status, aktualisiert_at
           from upload_sitzungen where id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    match sitzung {
        // Fremd und nicht vorhanden sehen gleich aus: Ob es eine Sitzung mit
        // dieser Kennung gibt, geht nur ihren Eigentümer etwas an.
        Some(s) if s.user_id == user => Ok(s),
        _ => Err(AppError::not_found("Upload-Sitzung nicht gefunden")),
    }
}

/// Der Stand einer Sitzung – Antwort auf alles ausser Abschluss und Abbruch.
async fn stand(state: &AppState, sitzung: &Sitzung) -> AppResult<Value> {
    let stuecke: Vec<(i32, i32)> =
        sqlx::query_as("select nr, laenge from upload_stuecke where sitzung_id = $1 order by nr")
            .bind(sitzung.id)
            .fetch_all(&state.pool)
            .await?;
    let empfangen_bytes: i64 = stuecke.iter().map(|(_, l)| *l as i64).sum();
    let ablauf =
        sitzung.aktualisiert_at + chrono::Duration::hours(state.config.upload_sitzung_stunden);
    Ok(json!({
        "sitzungId": sitzung.id,
        "attachmentId": sitzung.attachment_id,
        "groesse": sitzung.groesse,
        "stueckGroesse": sitzung.stueck_groesse,
        "anzahl": sitzung.anzahl_stuecke(),
        "empfangen": stuecke.iter().map(|(nr, _)| *nr).collect::<Vec<_>>(),
        "empfangenBytes": empfangen_bytes,
        "status": sitzung.status,
        "ablaufAt": ablauf,
    }))
}

/**
 * `GET /media/grenzen` – die Upload-Grenzen, die dieser Server WIRKLICH
 * durchsetzt.
 *
 * # Warum der Client sie fragt
 *
 * `UPLOAD_MAX_BYTES` ist einstellbar. Der Client kannte bisher nur die
 * Vorgabe (4 GiB) aus dem gemeinsamen Paket: Bei einem Server mit 1 GiB hätte
 * die App eine 3-GiB-Datei zugelassen, eine Stunde hochgeladen und wäre dann
 * erst beim Anlegen der Sitzung abgewiesen worden. Mit dieser Antwort
 * stimmt die Vorabprüfung mit der Entscheidung des Servers überein.
 *
 * Angemeldet, weil der Client ohnehin nur dann hochlädt; nichts Geheimes,
 * aber auch kein Grund, es Unbekannten zu zeigen.
 */
async fn grenzen(State(state): State<AppState>, _user: AuthUser) -> Json<Value> {
    let gross = state.config.upload_max_bytes;
    let arten = ["image", "video", "audio", "file", "sticker"];
    let mut stuecke = serde_json::Map::new();
    let mut direkt = serde_json::Map::new();
    for art in arten {
        stuecke.insert(art.into(), json!(max_stueck_upload_bytes(art, gross)));
        // Der Weg in einer Anfrage hat feste, kleine Grenzen (`media.rs`
        // kennt UPLOAD_MAX_BYTES nicht) – genau das wird gemeldet.
        direkt.insert(art.into(), json!(crate::constants::max_upload_bytes(art)));
    }
    Json(json!({
        "maxUploadBytes": stuecke,
        "direktUploadMax": direkt,
        "stueckGroesse": STUECK_GROESSE,
        "uploadMaxBytes": gross,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnlegenInput {
    kind: String,
    mime: String,
    size: i64,
    file_name: Option<String>,
    sha256: Option<String>,
}

async fn anlegen(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<AnlegenInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    Validator::new()
        .one_of("kind", &input.kind, ARTEN)
        .require("size", input.size > 0, "Dateigröße fehlt")
        .finish()?;

    let sha256 = match input.sha256.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(wert) if wert.len() == 64 && wert.chars().all(|c| c.is_ascii_hexdigit()) => {
            Some(wert.to_ascii_lowercase())
        }
        Some(_) => return Err(AppError::bad_request("sha256 muss 64 Hex-Zeichen haben")),
    };

    let erlaubt = allowed_mime(&input.kind);
    let typ = input
        .mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !erlaubt.is_empty() && !erlaubt.contains(&typ.as_str()) {
        return Err(AppError::unsupported_media(format!(
            "{} ist für {} nicht erlaubt",
            input.mime, input.kind
        )));
    }
    let grenze = max_stueck_upload_bytes(&input.kind, state.config.upload_max_bytes);
    if input.size > grenze {
        return Err(AppError::too_large(format!(
            "Maximal {} für {}",
            menschlich(grenze),
            input.kind
        )));
    }

    /*
     * Die Bremse je Konto.
     *
     * Eine Sitzung reserviert noch keinen Platz (die Teildatei ist dünn
     * besetzt), aber sie VERSPRICHT ihn – und die Prüfung des freien Platzes
     * darunter rechnet mit allen Versprechen. Ohne Grenze je Konto könnte
     * einer mit zehn leeren Sitzungen à 4 GiB allen anderen das Hochladen
     * verbauen, ohne ein Byte zu schicken.
     */
    let (offen_bytes, offen_anzahl): (i64, i64) = sqlx::query_as(
        "select coalesce(sum(groesse), 0)::bigint, count(*)
           from upload_sitzungen where user_id = $1 and status <> 'fertig'",
    )
    .bind(user.id())
    .fetch_one(&state.pool)
    .await?;
    if offen_anzahl >= OFFEN_HOECHSTZAHL {
        return Err(AppError::too_many(
            "Zu viele unfertige Uploads – schliesse erst welche ab oder brich sie ab",
        ));
    }
    if offen_bytes + input.size > state.config.upload_offen_max_bytes {
        return Err(AppError::too_large(format!(
            "Deine unfertigen Uploads hielten zusammen mehr als {} – schliesse erst welche ab",
            menschlich(state.config.upload_offen_max_bytes)
        )));
    }

    platz_pruefen(&state, input.size).await?;

    let file_name = input
        .file_name
        .as_deref()
        .map(sanitise_file_name)
        .filter(|value| !value.is_empty());
    let extension = extension_for(file_name.as_deref(), &input.mime);
    let storage_key = storage_key_for(&input.kind, &user.id(), &extension);
    let attachment_id = Uuid::now_v7();
    let sitzung_id = Uuid::now_v7();

    // Die Teildatei zuerst: Scheitert sie (Rechte, Platte), soll keine
    // Zeile ohne Datei zurückbleiben.
    let pfad = teil_pfad(&state, sitzung_id);
    tokio::fs::create_dir_all(&state.config.upload_teile_dir).await?;
    {
        let datei = tokio::fs::File::create(&pfad).await?;
        // Dünn besetzt: belegt nichts, bis Stücke kommen – und jedes Stück
        // kann gleich an seine Stelle, egal in welcher Reihenfolge.
        datei.set_len(input.size as u64).await?;
    }

    let mut tx = state.pool.begin().await?;
    let gespeichert = async {
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
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "insert into upload_sitzungen
               (id, user_id, attachment_id, kind, mime, file_name, groesse, stueck_groesse, sha256)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(sitzung_id)
        .bind(user.id())
        .bind(attachment_id)
        .bind(&input.kind)
        .bind(&input.mime)
        .bind(&file_name)
        .bind(input.size)
        .bind(STUECK_GROESSE as i32)
        .bind(&sha256)
        .execute(&mut *tx)
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(fehler) = gespeichert {
        let _ = tokio::fs::remove_file(&pfad).await;
        return Err(fehler);
    }
    tx.commit().await?;

    let sitzung = eigene_sitzung(&state, sitzung_id, user.id()).await?;
    Ok((StatusCode::CREATED, Json(stand(&state, &sitzung).await?)))
}

/// Was offene Sitzungen noch schicken werden (die Teildateien sind dünn
/// besetzt und wachsen erst) – die Versprechen, mit denen die Platzrechnung
/// rechnen muss.
pub async fn ausstehende_bytes(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select coalesce(sum(s.groesse - coalesce(
                  (select sum(laenge) from upload_stuecke t where t.sitzung_id = s.id), 0)), 0)::bigint
           from upload_sitzungen s where s.status <> 'fertig'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0)
}

/**
 * Ist auf der Platte genug Platz für das, was kommen soll – oder lässt er sich
 * schaffen?
 *
 * Gerechnet wird nicht nur mit dieser Datei, sondern mit allem, was offene
 * Sitzungen noch schicken werden (die Teildateien sind dünn besetzt und
 * wachsen erst). Bei eingeschalteter Verschlüsselung liegt eine Datei beim
 * Abschluss kurz zweimal da (Klartext und Geheimtext), also doppelt.
 *
 * # Warme Platte voll, Storage Box leer
 *
 * Früher war das eine Absage. Das ist falsch, sobald es eine kalte Ablage
 * gibt: Alles, was schon fertig auf der Platte liegt, kann auf die Box
 * wandern und macht Platz. Die Regel jetzt:
 *
 *   1. Reicht der freie Platz: weiter wie bisher.
 *   2. Sonst, mit kalter Ablage: Was an fertigen Originalen warm liegt, kann
 *      im Notfall ALLES gehen (auch „hoch" – die Klassen regeln, was bei
 *      voller Platte zuerst geht, nicht ob eine volle Platte überhaupt
 *      Uploads abweist). Reicht frei + auslagerbar, wird die Sitzung
 *      angenommen und der Auslagerungsdienst SOFORT geweckt, statt auf seinen
 *      Viertelstundentakt zu warten.
 *   3. Nur wenn auch das nicht reicht, oder die Box erkennbar nicht
 *      erreichbar ist oder selbst zu wenig Platz meldet: klare Absage, die
 *      sagt, WELCHE der beiden Seiten nicht reicht.
 *
 * Warum die Datei nicht „gleich kalt" landet: Die Stücke kommen in beliebiger
 * Reihenfolge und müssen irgendwo hin, bevor die Datei vollständig ist – das
 * ist die Teildatei auf DIESER Platte, in voller Grösse. Der Abschluss
 * (`rename`) braucht danach keinen Platz mehr. Direkt in die Box zu schreiben
 * hiesse, die Abschlussanfrage um die Dauer des Hinüberschreibens zu
 * verlängern – bei vier Gigabyte Minuten, länger als jeder Proxy wartet.
 * Der Umzug im Hintergrund direkt nach dem Abschluss ist dasselbe ohne diesen
 * Haken.
 *
 * Lässt sich der Platz nicht ermitteln (kein Unix), wird nicht geprüft – die
 * Sitzungsgrenzen gelten trotzdem.
 */
async fn platz_pruefen(state: &AppState, groesse: i64) -> AppResult<()> {
    let ausstehend = ausstehende_bytes(&state.pool).await;
    let faktor = if state.config.media_key.is_some() {
        2
    } else {
        1
    };
    let noetig = ausstehend
        .saturating_add(groesse.saturating_mul(faktor))
        .saturating_add(state.config.upload_platte_reserve_bytes);
    tokio::fs::create_dir_all(&state.config.upload_teile_dir).await?;
    let Some(frei) = frei_auf_platte(DateiPfad::new(&state.config.upload_teile_dir)) else {
        return Ok(());
    };
    let fehlt = noetig.saturating_sub(frei as i64);
    if fehlt <= 0 {
        return Ok(());
    }
    let voll = |zusatz: &str| {
        AppError::platte_voll(format!(
            "Auf dem Server ist gerade nicht genug Platz für {} (frei: {}). {zusatz}",
            menschlich(groesse),
            menschlich(frei as i64)
        ))
    };
    let Some(kalt) = state.speicher.kalt.clone() else {
        return Err(voll("Versuch es später."));
    };
    if !crate::services::auslagern::kalt_erreichbar() {
        return Err(voll(
            "Die Storage Box ist gerade nicht erreichbar, deshalb lässt sich auch nichts auslagern. Versuch es später.",
        ));
    }
    // Hat die Box selbst zu wenig Platz? Nicht jede Box sagt es (statvfs ist
    // eine Erweiterung) – dann wird optimistisch angenommen.
    if let Ok(Some((box_frei, _))) =
        tokio::time::timeout(Duration::from_secs(10), kalt.kapazitaet()).await
    {
        if (box_frei as i64) < fehlt {
            return Err(voll(&format!(
                "Auch die Storage Box hat nur noch {} frei.",
                menschlich(box_frei as i64)
            )));
        }
    }
    let schaffbar = crate::services::auslagern::auslagerbar(&state.pool).await;
    if schaffbar < fehlt {
        return Err(voll(&format!(
            "Es liesse sich nur {} auf die Storage Box auslagern, benötigt werden {}.",
            menschlich(schaffbar),
            menschlich(fehlt)
        )));
    }
    tracing::info!(
        fehlt = fehlt,
        schaffbar = schaffbar,
        "Platte knapp – Upload angenommen, Auslagerung wird sofort angestossen"
    );
    crate::services::auslagern::wecken();
    Ok(())
}

/// `true`, wenn der Fehler „Platte voll" heisst.
fn ist_platte_voll(fehler: &std::io::Error) -> bool {
    fehler.raw_os_error() == Some(libc::ENOSPC)
}

/// Gesamtgrösse des Dateisystems in Bytes – für die Anzeige der Speicherprüfung.
#[cfg(unix)]
pub fn gesamt_auf_platte(pfad: &DateiPfad) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(pfad.as_os_str().as_bytes()).ok()?;
    // SAFETY: wie in `frei_auf_platte`.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(st.f_blocks as u64 * st.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn gesamt_auf_platte(_pfad: &DateiPfad) -> Option<u64> {
    None
}

/// Freier Platz für Nicht-root in Bytes – `statvfs`, wie `df` es zeigt.
#[cfg(unix)]
pub fn frei_auf_platte(pfad: &DateiPfad) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(pfad.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` schreibt nur in die übergebene Struktur; der Pfad ist
    // ein gültiger, nullterminierter C-String und lebt über den Aufruf hinaus.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let ergebnis = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if ergebnis != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn frei_auf_platte(_pfad: &DateiPfad) -> Option<u64> {
    None
}

fn menschlich(bytes: i64) -> String {
    let gib = 1024.0 * 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= gib {
        format!("{:.1} GB", b / gib)
    } else {
        format!("{} MB", (b / 1024.0 / 1024.0).round() as i64)
    }
}

async fn stand_abfragen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let sitzung = eigene_sitzung(&state, id, user.id()).await?;
    Ok(Json(stand(&state, &sitzung).await?))
}

/// `bytes a-b/gesamt` → (a, b, gesamt).
fn content_range_lesen(wert: &str) -> Option<(i64, i64, i64)> {
    let rest = wert.trim().strip_prefix("bytes ")?;
    let (bereich, gesamt) = rest.split_once('/')?;
    let (a, b) = bereich.split_once('-')?;
    let a = a.trim().parse::<i64>().ok()?;
    let b = b.trim().parse::<i64>().ok()?;
    let gesamt = gesamt.trim().parse::<i64>().ok()?;
    (a >= 0 && b >= a && gesamt > 0).then_some((a, b, gesamt))
}

/**
 * Ein Stück empfangen – im Strom auf die Platte.
 *
 * `Content-Range` sagt, wohin es gehört. Es muss genau auf einer
 * Stückgrenze anfangen und genau ein Stück lang sein: Dann ist „empfangen"
 * eine Frage nach einer Nummer, und doppelte oder vertauschte Stücke sind
 * von selbst harmlos.
 */
async fn stueck_empfangen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<Value>> {
    let sitzung = eigene_sitzung(&state, id, user.id()).await?;
    if sitzung.status != "offen" {
        return Err(AppError::conflict("Dieser Upload wird schon abgeschlossen"));
    }

    let (start, ende, gesamt) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|w| w.to_str().ok())
        .and_then(content_range_lesen)
        .ok_or_else(|| AppError::bad_request("Content-Range fehlt oder ist unlesbar"))?;
    if gesamt != sitzung.groesse {
        return Err(AppError::bad_request(format!(
            "Falsche Gesamtgrösse: Die Sitzung erwartet {} Bytes",
            sitzung.groesse
        )));
    }
    let stueck = sitzung.stueck_groesse as i64;
    if start % stueck != 0 {
        return Err(AppError::bad_request(format!(
            "Ein Stück muss auf einer Grenze von {stueck} Bytes anfangen"
        )));
    }
    let nr = start / stueck;
    if nr >= sitzung.anzahl_stuecke() {
        return Err(AppError::bad_request("Stück liegt hinter dem Dateiende"));
    }
    let laenge = sitzung.laenge_von(nr);
    if ende - start + 1 != laenge {
        return Err(AppError::bad_request(format!(
            "Stück {nr} muss genau {laenge} Bytes lang sein"
        )));
    }
    if let Some(angesagt) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|w| w.to_str().ok())
        .and_then(|w| w.parse::<i64>().ok())
    {
        if angesagt != laenge {
            return Err(AppError::bad_request(
                "Content-Length passt nicht zum Bereich",
            ));
        }
    }

    let schon: Option<(i32,)> =
        sqlx::query_as("select nr from upload_stuecke where sitzung_id = $1 and nr = $2")
            .bind(id)
            .bind(nr as i32)
            .fetch_optional(&state.pool)
            .await?;

    let mut strom = body.into_data_stream();
    if schon.is_some() {
        /*
         * Schon da. Den Rumpf trotzdem lesen (und wegwerfen), statt sofort zu
         * antworten: Ein Browser, dem mitten im Senden die Verbindung
         * zugemacht wird, meldet einen Netzfehler statt der Antwort – und
         * wiederholte dann ein Stück, das längst angekommen ist.
         */
        let mut gezaehlt: i64 = 0;
        while let Some(paket) = tokio::time::timeout(STILLE_MAX, strom.next())
            .await
            .map_err(|_| AppError::bad_request("Stück kam zu langsam"))?
        {
            gezaehlt += paket
                .map_err(|e| AppError::bad_request(e.to_string()))?
                .len() as i64;
            if gezaehlt > laenge {
                return Err(AppError::too_large("Stück ist länger als angesagt"));
            }
        }
        return Ok(Json(stand(&state, &sitzung).await?));
    }

    let pfad = teil_pfad(&state, id);
    let mut datei = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&pfad)
        .await
        .map_err(|_| AppError::conflict("Die Teildatei fehlt – der Upload muss neu beginnen"))?;
    datei.seek(std::io::SeekFrom::Start(start as u64)).await?;

    let mut geschrieben: i64 = 0;
    while let Some(paket) = tokio::time::timeout(STILLE_MAX, strom.next())
        .await
        .map_err(|_| AppError::bad_request("Stück kam zu langsam"))?
    {
        let paket = paket.map_err(|e| AppError::bad_request(format!("Stück abgerissen: {e}")))?;
        geschrieben += paket.len() as i64;
        if geschrieben > laenge {
            // Nicht weiterschreiben – sonst überschriebe es den Anfang des
            // nächsten Stückes.
            return Err(AppError::too_large("Stück ist länger als angesagt"));
        }
        if let Err(fehler) = datei.write_all(&paket).await {
            if ist_platte_voll(&fehler) {
                // Das Stück bleibt „nicht empfangen"; der Client kann nach einer
                // Weile fortsetzen, sobald die Auslagerung Platz gemacht hat.
                crate::services::auslagern::wecken();
                return Err(AppError::platte_voll(
                    "Auf dem Server ist die Platte voll geworden. Die Auslagerung auf die Storage Box wurde angestossen – setze den Upload in einigen Minuten fort.",
                ));
            }
            return Err(fehler.into());
        }
    }
    if geschrieben != laenge {
        return Err(AppError::bad_request(format!(
            "Stück unvollständig: {geschrieben} von {laenge} Bytes"
        )));
    }
    datei.flush().await?;
    // Erst auf der Platte, dann gebucht. Andersherum stünde nach einem
    // Absturz ein Stück als empfangen da, das nie geschrieben wurde.
    datei.sync_data().await?;
    drop(datei);

    sqlx::query(
        "insert into upload_stuecke (sitzung_id, nr, laenge) values ($1, $2, $3)
         on conflict do nothing",
    )
    .bind(id)
    .bind(nr as i32)
    .bind(laenge as i32)
    .execute(&state.pool)
    .await?;
    sqlx::query("update upload_sitzungen set aktualisiert_at = now() where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    Ok(Json(stand(&state, &sitzung).await?))
}

/**
 * Passt der Inhalt zur Art?
 *
 * Nur ein Blick auf die ersten Bytes, kein Dekodieren. Er verhindert nicht,
 * dass jemand ein kaputtes Video hochlädt – aber dass unter „Video" ein
 * Programm oder eine HTML-Seite landet, die dann mit `video/mp4` und ohne
 * Rückfrage im Abspieler des Empfängers steht. Für `file` gilt alles: Dort
 * ist jeder Typ erlaubt, und die Auslieferung bietet ihn zum Herunterladen an.
 */
pub fn inhalt_passt(kind: &str, kopf: &[u8]) -> bool {
    let bei =
        |ab: usize, was: &[u8]| kopf.len() >= ab + was.len() && &kopf[ab..ab + was.len()] == was;
    let iso_box = bei(4, b"ftyp");
    let ebml = bei(0, &[0x1a, 0x45, 0xdf, 0xa3]);
    match kind {
        "file" => true,
        "image" | "sticker" => {
            bei(0, &[0xff, 0xd8, 0xff])
                || bei(0, &[0x89, b'P', b'N', b'G'])
                || bei(0, b"GIF8")
                || (bei(0, b"RIFF") && bei(8, b"WEBP"))
                || iso_box
        }
        "video" => {
            iso_box
                || ebml
                // Ältere QuickTime-Dateien fangen mit einer anderen Box an.
                || [b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"]
                    .iter()
                    .any(|typ| bei(4, *typ))
        }
        "audio" => {
            bei(0, b"ID3")
                || (kopf.len() >= 2 && kopf[0] == 0xff && kopf[1] & 0xe0 == 0xe0)
                || bei(0, b"OggS")
                || (bei(0, b"RIFF") && bei(8, b"WAVE"))
                || bei(0, b"fLaC")
                || iso_box
                || ebml
        }
        _ => false,
    }
}

/// sha256 einer Datei, im Strom – blockierend, also aus `spawn_blocking`.
fn sha256_datei(pfad: &DateiPfad) -> std::io::Result<String> {
    use sha2::Digest;
    use std::io::Read;
    let mut datei = std::fs::File::open(pfad)?;
    let mut hasher = sha2::Sha256::new();
    let mut puffer = vec![0u8; 1024 * 1024];
    loop {
        let n = datei.read(&mut puffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&puffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn abschliessen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<CompleteUploadInput>,
) -> AppResult<Json<AttachmentDto>> {
    let sitzung = eigene_sitzung(&state, id, user.id()).await?;
    metadaten_pruefen(&input)?;

    // Schon fertig? Dann ist die Antwort nur unterwegs verloren gegangen.
    if sitzung.status == "fertig" {
        let row = load_attachment(&state.pool, sitzung.attachment_id).await?;
        return Ok(Json(to_attachment_dto(&row, &state.config)));
    }

    /*
     * Sperren gegen einen zweiten Abschluss.
     *
     * Ein Client, der nach einer Zeitüberschreitung wiederholt, darf nicht
     * dieselbe Teildatei ein zweites Mal verschieben wollen, während der
     * erste Versuch noch verschlüsselt. Hängt ein Abschluss eine Stunde, war
     * es ein Absturz – dann darf es neu versucht werden.
     */
    let gesperrt: Option<(Uuid,)> = sqlx::query_as(
        "update upload_sitzungen set status = 'abschluss', aktualisiert_at = now()
          where id = $1
            and (status = 'offen'
                 or (status = 'abschluss' and aktualisiert_at < now() - make_interval(mins => $2)))
          returning id",
    )
    .bind(id)
    .bind(ABSCHLUSS_HAENGT_MIN as i32)
    .fetch_optional(&state.pool)
    .await?;
    if gesperrt.is_none() {
        return Err(AppError::conflict(
            "Der Abschluss läuft schon – gleich noch einmal fragen",
        ));
    }

    match abschluss_durchfuehren(&state, &sitzung, input).await {
        Ok(dto) => Ok(Json(dto)),
        Err((fehler, verwerfen)) => {
            if verwerfen {
                verwerfen_ganz(&state, &sitzung).await;
            } else {
                let _ = sqlx::query(
                    "update upload_sitzungen set status = 'offen', aktualisiert_at = now()
                      where id = $1 and status = 'abschluss'",
                )
                .bind(id)
                .execute(&state.pool)
                .await;
            }
            Err(fehler)
        }
    }
}

/// Der eigentliche Abschluss. Der Fehler sagt, ob die Sitzung damit erledigt
/// ist (`true`: Inhalt unbrauchbar, alles weg) oder nur zurück auf `offen`.
async fn abschluss_durchfuehren(
    state: &AppState,
    sitzung: &Sitzung,
    input: CompleteUploadInput,
) -> Result<AttachmentDto, (AppError, bool)> {
    let behalten = |fehler: AppError| (fehler, false);

    let (anzahl, summe): (i64, i64) = sqlx::query_as(
        "select count(*), coalesce(sum(laenge), 0)::bigint from upload_stuecke where sitzung_id = $1",
    )
    .bind(sitzung.id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| behalten(e.into()))?;
    if anzahl != sitzung.anzahl_stuecke() || summe != sitzung.groesse {
        return Err(behalten(AppError::conflict(format!(
            "Es fehlen noch Stücke: {anzahl} von {} empfangen",
            sitzung.anzahl_stuecke()
        ))));
    }

    let pfad = teil_pfad(state, sitzung.id);
    let laenge = tokio::fs::metadata(&pfad)
        .await
        .map_err(|_| {
            (
                AppError::conflict("Die Teildatei fehlt – der Upload muss neu beginnen"),
                true,
            )
        })?
        .len();
    if laenge as i64 != sitzung.groesse {
        return Err((
            AppError::conflict(
                "Die Teildatei hat die falsche Grösse – der Upload muss neu beginnen",
            ),
            true,
        ));
    }

    // Die ersten Bytes gegen die Art.
    let kopf = {
        use tokio::io::AsyncReadExt;
        let mut datei = tokio::fs::File::open(&pfad)
            .await
            .map_err(|e| behalten(e.into()))?;
        let mut kopf = vec![0u8; 64];
        let mut n = 0;
        while n < kopf.len() {
            let gelesen = datei
                .read(&mut kopf[n..])
                .await
                .map_err(|e| behalten(e.into()))?;
            if gelesen == 0 {
                break;
            }
            n += gelesen;
        }
        kopf.truncate(n);
        kopf
    };
    if !inhalt_passt(&sitzung.kind, &kopf) {
        return Err((
            AppError::unsupported_media(format!(
                "Der Inhalt sieht nicht nach {} aus",
                match sitzung.kind.as_str() {
                    "video" => "einem Video",
                    "audio" => "Ton",
                    "image" => "einem Bild",
                    _ => "der angegebenen Art",
                }
            )),
            true,
        ));
    }

    if let Some(erwartet) = &sitzung.sha256 {
        let pfad_faden = pfad.clone();
        let ist = tokio::task::spawn_blocking(move || sha256_datei(&pfad_faden))
            .await
            .map_err(|_| behalten(AppError::internal("Prüfsumme ist abgestürzt")))?
            .map_err(|e| behalten(e.into()))?;
        if &ist != erwartet {
            return Err((
                AppError::validation(vec![(
                    "sha256",
                    "Die Prüfsumme stimmt nicht – die Datei kam beschädigt an. Bitte neu senden."
                        .to_string(),
                )]),
                true,
            ));
        }
    }

    let anhang = load_attachment(&state.pool, sitzung.attachment_id)
        .await
        .map_err(|e| (e, true))?;
    state
        .storage
        .uebernehmen(&anhang.storage_key, &pfad, &sitzung.mime)
        .await
        .map_err(behalten)?;

    let dto = fertig_melden(state, sitzung.attachment_id, input)
        .await
        .map_err(behalten)?;
    let _ = sqlx::query(
        "update upload_sitzungen set status = 'fertig', aktualisiert_at = now() where id = $1",
    )
    .bind(sitzung.id)
    .execute(&state.pool)
    .await;
    // Die Stückliste braucht niemand mehr; die Sitzung bleibt als Quittung.
    let _ = sqlx::query("delete from upload_stuecke where sitzung_id = $1")
        .bind(sitzung.id)
        .execute(&state.pool)
        .await;
    /*
     * Wird die Platte knapp, soll die neue Datei (oder eine ältere) nicht erst
     * in einer Viertelstunde auf die Box wandern: Der Dienst wird gleich
     * angestossen und rechnet den Bedarf selbst aus.
     */
    if state.speicher.kalt.is_some()
        && crate::services::auslagern::platzbedarf(&state.pool, &state.config).await > 0
    {
        crate::services::auslagern::wecken();
    }
    Ok(dto)
}

/// Sitzung, Teildatei und den unfertigen Anhang wegräumen.
async fn verwerfen_ganz(state: &AppState, sitzung: &Sitzung) {
    let _ = tokio::fs::remove_file(teil_pfad(state, sitzung.id)).await;
    // Der Anhang nimmt die Sitzung mit (`on delete cascade`). Nur einen
    // unfertigen: Ein fertiger gehört schon jemandem.
    let _ = sqlx::query(
        "delete from attachments where id = $1 and status = 'pending' and message_id is null",
    )
    .bind(sitzung.attachment_id)
    .execute(&state.pool)
    .await;
    let _ = sqlx::query("delete from upload_sitzungen where id = $1")
        .bind(sitzung.id)
        .execute(&state.pool)
        .await;
}

async fn abbrechen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let sitzung = eigene_sitzung(&state, id, user.id()).await?;
    if sitzung.status == "abschluss" {
        return Err(AppError::conflict("Der Upload wird gerade abgeschlossen"));
    }
    verwerfen_ganz(&state, &sitzung).await;
    Ok(StatusCode::NO_CONTENT)
}

/**
 * Ein Durchgang des Aufräumdienstes. Gibt zurück, wie viele Sitzungen und
 * Teildateien weg sind.
 *
 * Drei Sorten Reste:
 *
 * 1. **Verwaiste Sitzungen** – seit `stunden` keine Bewegung. Der unfertige
 *    Anhang geht mit (und nimmt die Sitzung per Kaskade mit).
 * 2. **Alte Quittungen** – fertige Sitzungen, deren Anhang längst steht.
 * 3. **Teildateien ohne Sitzung** – ein Absturz zwischen Datei und Zeile,
 *    oder ein Anhang, der auf anderem Weg gelöscht wurde. Nur wenn sie älter
 *    als eine Viertelstunde sind: Beim Anlegen entsteht die Datei kurz VOR
 *    der Zeile.
 */
pub async fn aufraeumen(pool: &PgPool, teile_dir: &str, stunden: i64) -> usize {
    let mut weg = 0usize;

    let verwaist: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select id, attachment_id from upload_sitzungen
          where status <> 'fertig' and aktualisiert_at < now() - make_interval(hours => $1)",
    )
    .bind(stunden as i32)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (sitzung, anhang) in verwaist {
        let _ = tokio::fs::remove_file(
            PathBuf::from(teile_dir).join(format!("{}.teil", sitzung.simple())),
        )
        .await;
        let _ = sqlx::query(
            "delete from attachments where id = $1 and status = 'pending' and message_id is null",
        )
        .bind(anhang)
        .execute(pool)
        .await;
        let _ = sqlx::query("delete from upload_sitzungen where id = $1")
            .bind(sitzung)
            .execute(pool)
            .await;
        weg += 1;
    }

    if let Ok(ergebnis) = sqlx::query(
        "delete from upload_sitzungen
          where status = 'fertig' and aktualisiert_at < now() - make_interval(hours => $1)",
    )
    .bind(stunden as i32)
    .execute(pool)
    .await
    {
        weg += ergebnis.rows_affected() as usize;
    }

    let lebend: HashSet<String> =
        sqlx::query_scalar::<_, Uuid>("select id from upload_sitzungen where status <> 'fertig'")
            .fetch_all(pool)
            .await
            .map(|ids| ids.into_iter().map(|id| id.simple().to_string()).collect())
            .unwrap_or_default();

    if let Ok(mut eintraege) = tokio::fs::read_dir(teile_dir).await {
        while let Ok(Some(eintrag)) = eintraege.next_entry().await {
            let name = eintrag.file_name().to_string_lossy().into_owned();
            // `<id>.teil` und die Geheimtext-Zwischendatei `<id>.teil.<…>.vlt`.
            let kennung = name.split('.').next().unwrap_or_default().to_string();
            if lebend.contains(&kennung) {
                continue;
            }
            let alt = eintrag
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|zeit| zeit.elapsed().ok())
                .is_some_and(|alter| alter > Duration::from_secs(15 * 60));
            if alt && tokio::fs::remove_file(eintrag.path()).await.is_ok() {
                weg += 1;
            }
        }
    }
    weg
}

/// Startet den Aufräumdienst. Läuft, solange der Server läuft – im Stil von
/// `storage::muell::starten`.
pub fn aufraeumer_starten(pool: PgPool, teile_dir: String, stunden: i64, takt: Duration) {
    tokio::spawn(async move {
        loop {
            let weg = aufraeumen(&pool, &teile_dir, stunden).await;
            if weg > 0 {
                tracing::info!(anzahl = weg, "verwaiste Uploads in Stücken weggeräumt");
            }
            tokio::time::sleep(takt).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_wird_gelesen() {
        assert_eq!(content_range_lesen("bytes 0-9/100"), Some((0, 9, 100)));
        assert_eq!(content_range_lesen(" bytes 10-19/20 "), Some((10, 19, 20)));
        assert_eq!(content_range_lesen("bytes 9-0/100"), None);
        assert_eq!(content_range_lesen("bytes */100"), None);
        assert_eq!(content_range_lesen("items 0-9/100"), None);
    }

    #[test]
    fn stueckzahl_rundet_auf() {
        assert_eq!(stueck_anzahl(1, 8), 1);
        assert_eq!(stueck_anzahl(8, 8), 1);
        assert_eq!(stueck_anzahl(9, 8), 2);
    }

    #[test]
    fn inhalt_und_art() {
        let mp4 = [
            0, 0, 0, 0x20, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm',
        ];
        assert!(inhalt_passt("video", &mp4));
        assert!(inhalt_passt("video", &[0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
        assert!(!inhalt_passt("video", b"<html><script>"));
        assert!(inhalt_passt("audio", b"ID3\x04"));
        assert!(inhalt_passt("audio", b"OggS\0"));
        assert!(!inhalt_passt("audio", b"MZ\x90\0"));
        assert!(inhalt_passt("image", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(!inhalt_passt("image", b"<svg"));
        assert!(inhalt_passt("file", b"irgendwas"));
    }
}
