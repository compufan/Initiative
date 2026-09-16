//! Der Fernseher als zweiter Bildschirm – Fotos, Videos, Diashow.
//!
//! # Warum es diesen Weg neben dem Streamen gibt
//!
//! Ein VIDEO schickt der Browser von sich aus auf den Fernseher: Remote
//! Playback in Chrome, AirPlay in Safari, beides eingebaut und ohne fremden
//! Code (siehe `auth::fernsehticket`). Ein FOTO nicht – beide Wege kennen
//! ausschliesslich Medienelemente. Eine Diashow schon gar nicht; dafür
//! bräuchte es eine Warteschlange, und die gibt es nur im Google-Cast-SDK.
//! Das liegt auf gstatic.com und müsste dauerhaft in `script-src`; in CSP.md
//! steht über genau diese Zeile „Die wichtigste Zeile. Kein fremdes Skript".
//!
//! Also der Weg, der ohne all das auskommt und obendrein der weitestreichende
//! ist: Jeder Fernseher der letzten zehn Jahre hat einen Browser. Das Blatt
//! unter `/tv` ist eine gewöhnliche Seite; dieses Modul ist das Band zwischen
//! ihr und dem Telefon.
//!
//! # Der Ablauf
//!
//! 1. Der Fernseher öffnet `/tv` und holt sich hier eine Sitzung. Er bekommt
//!    einen **Code** (den zeigt er gross an) und ein **Geheimnis** (das zeigt
//!    er nie).
//! 2. Am Telefon: Sammlung öffnen, „Auf den Fernseher", Code eintippen. Damit
//!    gehört die Sitzung dieser Person, und die Liste steht.
//! 3. Der Fernseher fragt im Sekundentakt nach der Fassungsnummer und holt
//!    die Liste, wenn sie sich bewegt hat.
//!
//! # Warum zwei Stücke und nicht nur der Code
//!
//! Der Code steht gross auf dem Bildschirm, ist also kurz – und damit auch
//! ratbar. Wer ihn errät, dürfte sonst die Diashow eines Fremden mitsehen.
//! Deshalb: Der Code taugt nur zum VERBINDEN, das Geheimnis zum ABHOLEN. Wer
//! den Code errät, kann eine fremde Sitzung stören, aber kein Bild sehen.
//!
//! # Warum die Liste hier liegt und nicht nur die Sammlung
//!
//! Weil die Rechte beim Einstellen geprüft werden. Beim Abholen ist niemand
//! mehr da, den man fragen könnte – der Fernseher hat kein Konto. Was in der
//! Liste steht, ist damit genau das, was die Person am Telefon in dem Moment
//! sehen durfte.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{fernsehticket, password, AuthUser};
use crate::db::{AttachmentRow, CollectionItemRow};
use crate::drossel::{regeln, Absender};
use crate::error::{AppError, AppResult};
use crate::services::attachments::darf_anhang_sehen;
use crate::services::permissions::{require_collection, Level};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tv/sitzungen", post(sitzung_anlegen))
        .route("/tv/sitzungen/{code}/stand", get(stand))
        .route(
            "/tv/sitzungen/{code}/programm",
            get(programm).post(einstellen),
        )
        .route(
            "/tv/sitzungen/{code}",
            axum::routing::patch(steuern).delete(beenden),
        )
}

/// Wie lange eine Sitzung lebt, auch ohne dass jemand etwas tut.
///
/// Zwölf Stunden: Ein Fernseher, der morgens eingeschaltet wurde, soll abends
/// noch dieselbe Sitzung haben. Länger wäre sinnlos – ein Gerät, das einen Tag
/// lang niemand benutzt hat, lädt das Blatt ohnehin neu.
const SITZUNG_STUNDEN: i64 = 12;

/// Wie viele Einzeldateien man ohne Sammlung schicken darf.
///
/// Jede davon kostet eine eigene Rechteprüfung. Für „dieses eine Video" und
/// „diese fünf Fotos" reicht das weit; alles Grössere geht über eine Sammlung,
/// und dort wird EINMAL geprüft statt fünfhundertmal.
const EINZELN_MAX: usize = 50;

/// Wie viele Stücke eine Diashow höchstens hat.
const STUECKE_MAX: usize = 1000;

/// Ein Stück der Diashow, so wie es gespeichert wird (ohne Karte).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stueck {
    id: Uuid,
    art: String,
    mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    breite: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hoehe: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dauer_ms: Option<i32>,
    /// Die eingebettete Vorschau – damit auf dem Fernseher sofort etwas steht,
    /// während das grosse Bild noch lädt.
    #[serde(skip_serializing_if = "Option::is_none")]
    vorschau: Option<String>,
}

impl Stueck {
    fn aus(row: &AttachmentRow) -> Self {
        Self {
            id: row.id,
            art: row.kind.clone(),
            mime: row.mime.clone(),
            name: row.file_name.clone(),
            breite: row.width,
            hoehe: row.height,
            dauer_ms: row.duration_ms,
            vorschau: row.preview_data_url.clone(),
        }
    }
}

/// Eine Zeile aus `fernsehsitzungen`, so weit sie hier gebraucht wird.
#[derive(Debug, sqlx::FromRow)]
struct SitzungRow {
    code: String,
    geheim_hash: String,
    besitzer_id: Option<Uuid>,
    stuecke: Value,
    modus: String,
    saat: i64,
    sekunden: i32,
    stelle: i32,
    pausiert: bool,
    fassung: i64,
}

/**
 * Das Alphabet, aus dem ein Fernsehcode besteht.
 *
 * Vierundzwanzig Zeichen, und die Auswahl ist hier wichtiger als sonst: Dieser
 * Code wird nicht kopiert, sondern aus drei Metern Abstand vom Fernseher
 * ABGELESEN und am Telefon abgetippt. Raus sind deshalb alle Paare, die dabei
 * wirklich zusammenfallen:
 *
 *   `0 O Q` · `1 I L` · `5 S` · `8 B` · `2 Z`
 *
 * Der bestehende Einladungscode (`admin.rs`) nimmt 32 Zeichen und lässt L, S,
 * B und 2 stehen. Dort stimmt das – ein Einladungscode wird verschickt und
 * eingefügt, nicht abgelesen.
 */
const CODE_ALPHABET: &[u8] = b"34679ACDEFGHJKMNPRTUVWXY";

/**
 * Ein Code, den man vorlesen und mit einer Fernbedienung abtippen kann.
 *
 * Acht Zeichen aus vierundzwanzig sind gut 2^36 Möglichkeiten. Mit der Bremse
 * an `einstellen` (zwanzig Versuche je Stunde) ist Raten aussichtslos – und
 * selbst ein Treffer brächte kein einziges Bild, sondern nur eine gestörte
 * fremde Sitzung: Zum Abholen gehört das Geheimnis.
 *
 * # Warum verworfen statt gerechnet wird
 *
 * `byte % 24` wäre naheliegend und leicht schief: 256 ist kein Vielfaches von
 * 24, also kämen die ersten sechzehn Zeichen häufiger vor als die letzten
 * acht. Das kostet zwar nur einen Bruchteil eines Bits – aber es kostet
 * nichts, es richtig zu machen: Bytes ab 240 werden weggeworfen, und der Rest
 * ist gleichverteilt.
 */
fn code_erzeugen() -> String {
    const GRENZE: u8 = 240; // 10 * 24
                            // Erst die acht Zeichen, dann der Strich. Andersherum – den Strich mitten
                            // in der Schleife – stand hier zuerst, und bei einem verworfenen Byte an
                            // der richtigen Stelle kam er zweimal: `NJFT--6URW`.
    let mut zeichen = String::with_capacity(8);
    while zeichen.len() < 8 {
        for byte in password::random_bytes(16) {
            if byte >= GRENZE {
                continue;
            }
            zeichen.push(CODE_ALPHABET[byte as usize % CODE_ALPHABET.len()] as char);
            if zeichen.len() == 8 {
                break;
            }
        }
    }
    zeichen
}

/// Gross schreiben und Striche wegwerfen – „k7m4qp2r" ist derselbe Code.
fn code_normal(roh: &str) -> String {
    roh.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

/**
 * Der gespeicherte Code, aber mit Strich – so, wie er auf dem Schirm steht.
 *
 * Der Strich ist AUSSCHLIESSLICH zum Anschauen da. Gespeichert und
 * nachgeschlagen wird immer die Form ohne ihn (`code_normal`): Wer einmal die
 * eine und einmal die andere Form ablegt, sucht hinterher mit der falschen –
 * das kostete beim ersten Anlauf drei Prüfungen mit „Sitzung nicht gefunden",
 * und es lag nicht an den Rechten.
 */
fn code_lesbar(code: &str) -> String {
    if code.len() > 4 {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_string()
    }
}

#[derive(Debug, Deserialize)]
struct GeheimFrage {
    geheim: String,
}

/// Die Sitzung holen – und dabei prüfen, dass wirklich dieser Fernseher fragt.
async fn sitzung_mit_geheimnis(
    state: &AppState,
    code: &str,
    geheim: &str,
) -> AppResult<SitzungRow> {
    let row = sitzung(state, code).await?;
    /*
     * Zeichenweise gleich, aber ohne frühen Abbruch.
     *
     * Ein gewöhnlicher Vergleich zweier Abdrücke verrät über die Antwortzeit,
     * wie viele Zeichen schon stimmen – und ein Geheimnis, das man zeichenweise
     * erraten kann, ist keines.
     */
    let abdruck = password::sha256_hex(geheim);
    if !crate::auth::jwt::constant_time_eq(abdruck.as_bytes(), row.geheim_hash.as_bytes()) {
        return Err(AppError::not_found("Sitzung nicht gefunden"));
    }
    Ok(row)
}

async fn sitzung(state: &AppState, code: &str) -> AppResult<SitzungRow> {
    sqlx::query_as::<_, SitzungRow>(
        "select * from fernsehsitzungen where code = $1 and gueltig_bis > now()",
    )
    .bind(code_normal(code))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Sitzung nicht gefunden"))
}

/**
 * Der Fernseher meldet sich an.
 *
 * Ohne Konto – er hat keines und bekommt auch keines. Was er bekommt, ist ein
 * Code zum Vorzeigen und ein Geheimnis zum Behalten.
 */
async fn sitzung_anlegen(
    State(state): State<AppState>,
    Absender(absender): Absender,
) -> AppResult<(StatusCode, Json<Value>)> {
    if !state.drossel.erlaubt(
        &format!("tv-sitzung:{absender}"),
        regeln::FERNSEHER_ANMELDEN,
    ) {
        return Err(AppError::too_many(
            "Zu viele Anfragen. Bitte gleich noch einmal.",
        ));
    }

    // Beim Anlegen einmal wegräumen, was abgelaufen ist. Das ist die
    // billigste Stelle dafür: Es geschieht selten und braucht keinen zweiten
    // Dienst, der nach der Uhr aufräumt.
    sqlx::query("delete from fernsehsitzungen where gueltig_bis < now()")
        .execute(&state.pool)
        .await?;

    let geheim = password::random_token(32);
    let gueltig_bis = Utc::now() + Duration::hours(SITZUNG_STUNDEN);

    // Ein Code kann schon vergeben sein. Drei Versuche, dann ist etwas anderes
    // faul – lieber ein ehrlicher Fehler als eine Schleife ohne Ende.
    for _ in 0..3 {
        let code = code_erzeugen();
        let ergebnis = sqlx::query(
            "insert into fernsehsitzungen (code, geheim_hash, gueltig_bis)
             values ($1, $2, $3)
             on conflict (code) do nothing",
        )
        .bind(&code)
        .bind(password::sha256_hex(&geheim))
        .bind(gueltig_bis)
        .execute(&state.pool)
        .await?;
        if ergebnis.rows_affected() == 1 {
            return Ok((
                StatusCode::CREATED,
                Json(json!({
                    "code": code_lesbar(&code),
                    "geheim": geheim,
                    "gueltigBis": gueltig_bis,
                })),
            ));
        }
    }
    Err(AppError::internal("Kein freier Code"))
}

/**
 * Wie weit ist es – die kleine Auskunft, die im Sekundentakt abgefragt wird.
 *
 * Bewusst ohne die Liste. Eine Diashow kann tausend Stücke haben; jedes mit
 * Adresse und Vorschaubild sind ein paar hundert Kilobyte, und die alle zwei
 * Sekunden über eine Fernsehverbindung zu schicken wäre absurd. Hier steht nur
 * die Fassungsnummer – bewegt sie sich, holt der Fernseher die Liste.
 */
async fn stand(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(frage): Query<GeheimFrage>,
) -> AppResult<Json<Value>> {
    let row = sitzung_mit_geheimnis(&state, &code, &frage.geheim).await?;

    // „Der Fernseher ist noch da" – das Telefon zeigt es an.
    sqlx::query("update fernsehsitzungen set gesehen_at = now() where code = $1")
        .bind(&row.code)
        .execute(&state.pool)
        .await?;

    let anzahl = row.stuecke.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(Json(json!({
        "fassung": row.fassung,
        "verbunden": row.besitzer_id.is_some(),
        "stueckzahl": anzahl,
        "stelle": row.stelle,
        "pausiert": row.pausiert,
        "modus": row.modus,
        "sekunden": row.sekunden,
    })))
}

/**
 * Die Liste – mit Adressen, die der Fernseher selbst abrufen kann.
 *
 * Die Karten entstehen HIER und nicht beim Einstellen: Eine Karte gilt sechs
 * Stunden, eine Sitzung zwölf. Würden sie beim Einstellen ausgestellt, stünde
 * die Diashow nach sechs Stunden still. So bekommt der Fernseher bei jedem
 * Holen frische.
 */
async fn programm(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(frage): Query<GeheimFrage>,
) -> AppResult<Json<Value>> {
    let row = sitzung_mit_geheimnis(&state, &code, &frage.geheim).await?;
    let Some(besitzer) = row.besitzer_id else {
        return Err(AppError::not_found("Noch nichts eingestellt"));
    };
    let stuecke: Vec<Stueck> = serde_json::from_value(row.stuecke.clone()).unwrap_or_default();
    let basis = state.config.public_api_url.trim_end_matches('/');

    let mit_karte: Vec<Value> = stuecke
        .iter()
        .map(|stueck| {
            let karte = fernsehticket::ausstellen(besitzer, stueck.id, &state.config.jwt_secret);
            json!({
                "id": stueck.id,
                "art": stueck.art,
                "mime": stueck.mime,
                "name": stueck.name,
                "breite": stueck.breite,
                "hoehe": stueck.hoehe,
                "dauerMs": stueck.dauer_ms,
                "vorschau": stueck.vorschau,
                "url": format!("{basis}/api/v1/media/{}?{}={karte}", stueck.id, fernsehticket::FELD),
            })
        })
        .collect();

    Ok(Json(json!({
        "fassung": row.fassung,
        "modus": row.modus,
        "saat": row.saat,
        "sekunden": row.sekunden,
        "stelle": row.stelle,
        "pausiert": row.pausiert,
        "stuecke": mit_karte,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EinstellenInput {
    /// Eine ganze Sammlung – dann wird EINMAL geprüft statt je Datei.
    collection_id: Option<Uuid>,
    /// Oder eine Handvoll einzelner Dateien.
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
    /// `linear` oder `zufall`.
    modus: Option<String>,
    /// Wie lange ein Foto stehen bleibt.
    sekunden: Option<i32>,
}

/**
 * Das Telefon verbindet sich und stellt ein, was laufen soll.
 *
 * Verbinden und Einstellen sind derselbe Schritt, und das mit Absicht: Ein
 * „verbunden, aber leer" gäbe es sonst als eigenen Zustand, den jemand auf dem
 * Fernseher anzeigen und erklären müsste.
 */
async fn einstellen(
    State(state): State<AppState>,
    user: AuthUser,
    Absender(absender): Absender,
    Path(code): Path<String>,
    Json(input): Json<EinstellenInput>,
) -> AppResult<Json<Value>> {
    /*
     * Die Bremse sitzt HIER und nicht am Abholen.
     *
     * Dies ist die einzige Stelle, an der ein Code geraten werden kann: Alles
     * andere verlangt das Geheimnis, und das hat 256 Bit. Ohne Bremse liesse
     * sich der Coderaum in Stunden durchprobieren.
     */
    if !state.drossel.erlaubt(
        &format!("tv-verbinden:{absender}"),
        regeln::FERNSEHER_VERBINDEN,
    ) {
        return Err(AppError::too_many(
            "Zu viele Versuche. Bitte gleich noch einmal.",
        ));
    }

    let row = sitzung(&state, &code).await?;
    if let Some(besitzer) = row.besitzer_id {
        if besitzer != user.id() {
            // Nicht verraten, dass es diese Sitzung gibt.
            return Err(AppError::not_found("Sitzung nicht gefunden"));
        }
    }

    let stuecke = stuecke_sammeln(&state, user.id(), &input).await?;
    if stuecke.is_empty() {
        return Err(AppError::bad_request(
            "Hier ist nichts, was sich zeigen liesse – weder Fotos noch Videos.",
        ));
    }

    let modus = match input.modus.as_deref() {
        Some("zufall") => "zufall",
        _ => "linear",
    };
    let sekunden = input.sekunden.unwrap_or(6).clamp(2, 60);
    // Die Saat wandert mit, damit Fernseher und Telefon dieselbe Reihenfolge
    // errechnen. Bei jedem Einstellen neu – sonst käme bei „Zufall" zweimal
    // dieselbe Mischung.
    let saat = i64::from(u32::from_le_bytes(
        password::random_bytes(4).try_into().expect("vier Bytes"),
    ));

    sqlx::query(
        "update fernsehsitzungen
            set besitzer_id = $2,
                stuecke = $3,
                modus = $4,
                sekunden = $5,
                saat = $6,
                stelle = 0,
                pausiert = false,
                fassung = fassung + 1
          where code = $1",
    )
    .bind(&row.code)
    .bind(user.id())
    .bind(serde_json::json!(stuecke))
    .bind(modus)
    .bind(sekunden)
    .bind(saat)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "code": code_lesbar(&row.code),
        "stueckzahl": stuecke.len(),
        "modus": modus,
        "sekunden": sekunden,
    })))
}

/// Was gezeigt werden soll – aus einer Sammlung oder aus einer Handvoll Dateien.
async fn stuecke_sammeln(
    state: &AppState,
    user_id: Uuid,
    input: &EinstellenInput,
) -> AppResult<Vec<Stueck>> {
    if let Some(sammlung) = input.collection_id {
        /*
         * Einmal fragen statt fünfhundertmal.
         *
         * Das ist der ganze Grund, warum eine Sammlung ihren eigenen Weg hat:
         * Bei `attachment_ids` kostet jede Datei eine eigene Rechteprüfung,
         * und ein Urlaubsordner hat leicht fünfhundert Fotos.
         */
        require_collection(&state.pool, sammlung, user_id, Level::View).await?;
        let zeilen = sqlx::query_as::<_, CollectionItemRow>(
            "select * from collection_items
              where collection_id = $1 and deleted_at is null
              order by sort_key asc, created_at asc",
        )
        .bind(sammlung)
        .fetch_all(&state.pool)
        .await?;
        let ids: Vec<Uuid> = zeilen.iter().map(|z| z.attachment_id).collect();
        let anhaenge = sqlx::query_as::<_, AttachmentRow>(
            "select * from attachments where id = any($1) and status = 'ready'",
        )
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;

        // In der Reihenfolge der Sammlung, nicht in der der Datenbank.
        let mut raus = Vec::new();
        for zeile in zeilen {
            let Some(anhang) = anhaenge.iter().find(|a| a.id == zeile.attachment_id) else {
                continue;
            };
            if !zeigbar(anhang) {
                continue;
            }
            raus.push(Stueck::aus(anhang));
            if raus.len() >= STUECKE_MAX {
                break;
            }
        }
        return Ok(raus);
    }

    if input.attachment_ids.len() > EINZELN_MAX {
        return Err(AppError::bad_request(format!(
            "Höchstens {EINZELN_MAX} einzelne Dateien – für mehr nimm eine Sammlung."
        )));
    }
    let mut raus = Vec::new();
    for id in &input.attachment_ids {
        let anhang = crate::services::attachments::load_attachment(&state.pool, *id).await?;
        if anhang.status != "ready" || !zeigbar(&anhang) {
            continue;
        }
        if !darf_anhang_sehen(&state.pool, anhang.id, user_id).await? {
            return Err(AppError::not_found("Datei nicht gefunden"));
        }
        raus.push(Stueck::aus(&anhang));
    }
    Ok(raus)
}

/// Was sich auf einem Fernseher zeigen lässt: Bild oder Video, sonst nichts.
fn zeigbar(row: &AttachmentRow) -> bool {
    matches!(row.kind.as_str(), "image" | "video")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SteuernInput {
    stelle: Option<i32>,
    pausiert: Option<bool>,
    modus: Option<String>,
    sekunden: Option<i32>,
}

/// Die Fernbedienung: weiter, zurück, Pause, Reihenfolge, Tempo.
async fn steuern(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
    Json(input): Json<SteuernInput>,
) -> AppResult<Json<Value>> {
    let row = besitz_pruefen(&state, &code, user.id()).await?;
    let anzahl = row.stuecke.as_array().map(|a| a.len()).unwrap_or(0) as i32;

    /*
     * Die Stelle wird im Kreis geführt, nicht geklemmt.
     *
     * Wer am Ende „weiter" drückt, will wieder von vorn – eine Diashow, die am
     * letzten Bild stehen bleibt, sieht aus wie ein Absturz. `rem_euclid`,
     * nicht `%`: Bei „zurück" auf Stelle null ist der Rest in Rust negativ.
     */
    let stelle = match input.stelle {
        Some(wert) if anzahl > 0 => wert.rem_euclid(anzahl),
        Some(_) => 0,
        None => row.stelle,
    };
    let modus = match input.modus.as_deref() {
        Some("zufall") => "zufall".to_string(),
        Some("linear") => "linear".to_string(),
        _ => row.modus.clone(),
    };
    // Beim Wechsel auf „Zufall" eine neue Mischung – sonst wäre es dieselbe
    // wie beim letzten Mal.
    let saat = if modus == "zufall" && row.modus != "zufall" {
        i64::from(u32::from_le_bytes(
            password::random_bytes(4).try_into().expect("vier Bytes"),
        ))
    } else {
        row.saat
    };

    sqlx::query(
        "update fernsehsitzungen
            set stelle = $2,
                pausiert = coalesce($3, pausiert),
                modus = $4,
                saat = $5,
                sekunden = coalesce($6, sekunden),
                fassung = fassung + 1
          where code = $1",
    )
    .bind(&row.code)
    .bind(stelle)
    .bind(input.pausiert)
    .bind(&modus)
    .bind(saat)
    .bind(input.sekunden.map(|s| s.clamp(2, 60)))
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "stelle": stelle, "modus": modus })))
}

/// Schluss – der Fernseher zeigt wieder seinen Code.
async fn beenden(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> AppResult<StatusCode> {
    let row = besitz_pruefen(&state, &code, user.id()).await?;
    sqlx::query(
        "update fernsehsitzungen
            set besitzer_id = null,
                stuecke = '[]'::jsonb,
                stelle = 0,
                pausiert = false,
                fassung = fassung + 1
          where code = $1",
    )
    .bind(&row.code)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn besitz_pruefen(state: &AppState, code: &str, user_id: Uuid) -> AppResult<SitzungRow> {
    let row = sitzung(state, code).await?;
    if row.besitzer_id != Some(user_id) {
        return Err(AppError::not_found("Sitzung nicht gefunden"));
    }
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ein_code_ist_gut_abzutippen() {
        let code = code_erzeugen();
        // Acht Zeichen, OHNE Strich: Der gehört zur Anzeige, nicht zum Code.
        assert_eq!(code.len(), 8, "{code}");
        assert!(!code.contains('-'), "{code}");
        // Aus vier Metern Abstand ist das der Unterschied zwischen „geht" und
        // „geht nicht". Der bestehende Einladungscode lässt L, S, B und 2
        // stehen – für einen Code, den man einfügt, ist das richtig; für
        // einen, den man abliest, nicht.
        for zeichen in code.chars().filter(|c| *c != '-') {
            assert!(
                !"0OQ1IL5S8B2Z".contains(zeichen),
                "verwechselbares Zeichen {zeichen} in {code}"
            );
        }
    }

    #[test]
    fn jedes_zeichen_kommt_ungefaehr_gleich_oft() {
        /*
         * Gegen den schiefen Rest.
         *
         * Mit `byte % 24` kämen die ersten sechzehn Zeichen des Alphabets in
         * 11 von 256 Fällen vor und die letzten acht nur in 10 – ein
         * Unterschied von zehn Prozent, den man einer einzelnen Stichprobe
         * nicht ansieht. Über zwanzigtausend Zeichen sieht man ihn: Der
         * Erwartungswert je Zeichen ist dann 833, die Streuung rund 28, und
         * ein Schiefstand von zehn Prozent verschöbe die beiden Gruppen um
         * gut 40 auseinander – also weit über zwei Streuungen.
         */
        let mut zaehler = std::collections::HashMap::new();
        for _ in 0..2500 {
            for zeichen in code_erzeugen().chars().filter(|c| *c != '-') {
                *zaehler.entry(zeichen).or_insert(0usize) += 1;
            }
        }
        assert_eq!(
            zaehler.len(),
            CODE_ALPHABET.len(),
            "nicht jedes Zeichen kam vor"
        );
        let erwartet = 20_000.0 / CODE_ALPHABET.len() as f64;
        for (zeichen, wie_oft) in &zaehler {
            let abweichung = (*wie_oft as f64 - erwartet).abs() / erwartet;
            assert!(
                abweichung < 0.12,
                "{zeichen} kam {wie_oft}-mal statt {erwartet:.0} – das Alphabet ist schief"
            );
        }
    }

    #[test]
    fn zwei_codes_sind_verschieden() {
        let viele: std::collections::HashSet<String> = (0..50).map(|_| code_erzeugen()).collect();
        assert_eq!(viele.len(), 50, "ein Code wiederholte sich");
    }

    #[test]
    fn beim_eintippen_ist_alles_erlaubt() {
        // Wer den Code abtippt, tippt klein, vergisst den Strich oder setzt
        // ein Leerzeichen. Alles dasselbe.
        for eingabe in ["K7M4-QP2R", "k7m4qp2r", "K7M4 QP2R", " k7m4-QP2r "] {
            assert_eq!(code_normal(eingabe), "K7M4QP2R", "{eingabe}");
        }
    }

    #[test]
    fn der_strich_kommt_zum_anzeigen_zurueck() {
        assert_eq!(code_lesbar("K7M4QP2R"), "K7M4-QP2R");
        // Und nichts bricht bei einem zu kurzen Code.
        assert_eq!(code_lesbar("AB"), "AB");
    }
}
