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
use crate::services::conversations::assert_membership;
use crate::services::permissions::{require_collection, Level};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tv/sitzungen", post(sitzung_anlegen))
        .route("/tv/meine", get(meine))
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

/**
 * Wie viele Nachrichten auf einmal auf dem Fernseher stehen.
 *
 * Zwölf, und die Zahl kommt aus der Schriftgrösse: Das Blatt rechnet für vier
 * Meter Abstand, eine Zeile ist rund 2 vw hoch, und mehr als ein Dutzend
 * Nachrichten wären auf 1080 Zeilen entweder zu klein zum Lesen oder unten
 * abgeschnitten. Wer weiter zurück will, blättert mit der Fernbedienung.
 */
const CHAT_PRO_SEITE: i64 = 12;

/**
 * Wie weit sich zurückblättern lässt.
 *
 * Zehn Seiten. Nicht aus technischer Not – es ist eine Frage, was ein
 * Fernseher im Wohnzimmer sein soll: ein Blick auf das Gespräch, nicht ein
 * Archiv. Wer den Verlauf vom letzten Sommer sucht, sucht ihn am Telefon, wo
 * es eine Suche gibt.
 */
const CHAT_SEITEN_MAX: i32 = 10;

/**
 * Wie lange ein Chat ohne ein Lebenszeichen auf dem Schirm bleibt.
 *
 * Eine Sitzung lebt zwölf Stunden (`SITZUNG_STUNDEN`), und für Fotos ist das
 * richtig. Für Nachrichten ist es das Gegenteil: Der Fernseher im Wohnzimmer
 * zeigt sie sonst weiter, während alle längst woanders sind.
 *
 * Als Lebenszeichen zählt jeder Griff an die Fernbedienung UND jede neue
 * Nachricht im Gespräch. Das zweite ist wichtig: Wer eine halbe Stunde
 * nebeneinander sitzt und schreibt, rührt die Fernbedienung nicht an – aber
 * ein leeres Wohnzimmer schreibt auch nicht.
 */
const CHAT_MINUTEN: i64 = 30;

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
    /// `diashow` oder `chat` – siehe Migration 0021.
    art: String,
    /// Nur beim Chat gesetzt. Die KENNUNG, nie der Inhalt.
    gespraech_id: Option<Uuid>,
    /// Bis wann ein Chat-Programm stehen darf. Kürzer als die Sitzung.
    chat_bis: Option<chrono::DateTime<Utc>>,
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

    /*
     * Beim Chat setzt sich die Fassung aus zwei Teilen zusammen.
     *
     * Der eine ist `fassung` – sie steigt, wenn jemand am Telefon blättert.
     * Der andere ist der Abdruck des Sichtbaren – er ändert sich, wenn jemand
     * schreibt, berichtigt oder löscht. Beide zusammen als EINE Zeichenkette,
     * damit der Fernseher weiter nur zwei Werte vergleicht statt drei.
     */
    if row.art == "chat" {
        let (Some(gespraech), Some(besitzer)) = (row.gespraech_id, row.besitzer_id) else {
            // Die Bedingung in 0021 schliesst das aus. Falls doch: wie „nichts
            // eingestellt" behandeln, nicht mit einem Fehler um sich werfen.
            return Ok(Json(json!({
                "fassung": row.fassung,
                "marke": row.fassung.to_string(),
                "verbunden": false,
            })));
        };
        let chat = chat_stand(&state, gespraech, besitzer, row.stelle).await?;
        let bis = chat_laeuft_bis(row.chat_bis, chat.letzte);
        let abgelaufen = bis <= Utc::now();
        return Ok(Json(json!({
            "art": "chat",
            "fassung": row.fassung,
            /*
             * Die Marke NEBEN der Fassung, nicht an ihrer Stelle.
             *
             * Der Fernseher vergleicht nur auf Gleichheit – für ihn wäre
             * beides dasselbe. Aber `fassung` ist eine Zahl, die STEIGT, und
             * daran hängen Zusicherungen („nach einem Griff an die
             * Fernbedienung ist sie grösser"). Eine Zeichenkette an ihrer
             * Stelle machte aus dem Grösser-Vergleich einen alphabetischen,
             * und der ist stillschweigend etwas anderes: „10" ist kleiner als
             * „9".
             */
            "marke": format!("{}:{}", row.fassung, chat.marke.as_deref().unwrap_or("leer")),
            // Ist die Frist um, meldet der Stand „niemand verbunden". Damit
            // fällt der Fernseher auf das Wartebild zurück, ohne dass er eine
            // zweite Regel dafür kennen muss – und die Sitzung bleibt am
            // Leben, sodass ein neues Programm sofort läuft.
            "verbunden": !abgelaufen,
            "abgelaufen": abgelaufen,
            "stelle": row.stelle,
            "stueckzahl": chat.anzahl,
        })));
    }

    let anzahl = row.stuecke.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(Json(json!({
        "art": "diashow",
        "fassung": row.fassung,
        // Bei einer Diashow ist die Marke die Fassung – der Fernseher
        // vergleicht dann für beide Arten dasselbe Feld und braucht keine
        // Fallunterscheidung dafür.
        "marke": row.fassung.to_string(),
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
    if row.art == "chat" {
        return chat_programm(&state, &row, besitzer).await;
    }
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
        "art": "diashow",
        "fassung": row.fassung,
        "marke": row.fassung.to_string(),
        "modus": row.modus,
        "saat": row.saat,
        "sekunden": row.sekunden,
        "stelle": row.stelle,
        "pausiert": row.pausiert,
        "stuecke": mit_karte,
    })))
}

/* ---------- Der Chat auf dem Fernseher ---------- */

/**
 * Die Bedingungen, unter denen eine Nachricht auf den Fernseher darf.
 *
 * Als SQL-Baustein und nicht als Filter in Rust – aus demselben Grund wie in
 * `messages::list_messages`: Sie bestimmen die Seitengrösse. Nachträglich
 * auszusieben ergäbe Seiten mit Löchern, und auf dem Fernseher hiesse das
 * sichtbar: zwölf Zeilen bestellt, sieben angezeigt, fünf leere Plätze.
 *
 * Drei Filter, und jeder einzelne ist ein Weg, auf dem etwas auf den Schirm
 * käme, das in der App nicht mehr steht:
 *
 *   * `deleted_at` – zurückgenommene Nachrichten. Die App zeigt dafür einen
 *     Platzhalter; auf einem Fernseher aus vier Metern wäre eine Reihe von
 *     „Nachricht gelöscht" nur Rauschen zwischen dem, was zählt.
 *   * `message_hidden` – was DIESE Person für sich ausgeblendet hat
 *     (Migration 0008). Ihr Fernseher darf es nicht zeigen.
 *   * `sieht_ab` – die Verlaufsgrenze (Migration 0016). Wer erst gestern
 *     beigetreten ist, sieht auch hier nicht, was vorher war.
 *
 * `$1` ist das Gespräch, `$2` der Besitzer der Sitzung.
 */
const CHAT_SICHTBAR: &str = "m.conversation_id = $1
        and m.deleted_at is null
        and not exists (
          select 1 from message_hidden h
           where h.message_id = m.id and h.user_id = $2
        )
        and exists (
          select 1 from conversation_members cm
           where cm.conversation_id = m.conversation_id
             and cm.user_id = $2
             and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
        )";

/// Was `chat_stand` zurückgibt: ein Fingerabdruck und das Alter des Neuesten.
#[derive(Debug, sqlx::FromRow)]
struct ChatStand {
    /// Ändert sich, sobald sich auf dem Schirm etwas ändern würde.
    marke: Option<String>,
    /// Wann die jüngste sichtbare Nachricht kam – das Lebenszeichen.
    letzte: Option<chrono::DateTime<Utc>>,
    /// Wie viele Nachrichten insgesamt sichtbar sind – für das Blättern.
    anzahl: i64,
}

/**
 * Der Fingerabdruck des Sichtbaren – die kleine Auskunft im Zwei-Sekunden-Takt.
 *
 * # Warum nicht `fassung`
 *
 * Weil `fassung` steigt, wenn jemand die SITZUNG ändert. Eine neue Nachricht
 * tut das nicht. Ohne eine eigene Ableitung bliebe der Fernseher auf dem Stand
 * vom Einstellen stehen – lautlos, ohne Fehler, und niemand käme auf die Idee,
 * die Sitzung zu verdächtigen.
 *
 * # Warum ein Abdruck und keine Zahl
 *
 * Eine Zahl (etwa die Anzahl) übersähe eine BEARBEITETE Nachricht: Es kommt
 * keine dazu, und es geht keine weg. Der Abdruck fasst Kennung und
 * Änderungszeitpunkt jeder sichtbaren Zeile zusammen; damit schlägt er bei
 * neu, bearbeitet, gelöscht und ausgeblendet gleichermassen an.
 *
 * # Warum nur über das Fenster
 *
 * `limit` über dieselbe Zahl, die auch gezeigt wird. Eine Änderung ausserhalb
 * des Fensters würde den Abdruck sonst bewegen, ohne dass sich auf dem Schirm
 * etwas täte – der Fernseher lüde die Liste neu, für nichts, alle zwei
 * Sekunden.
 */
async fn chat_stand(
    state: &AppState,
    gespraech: Uuid,
    besitzer: Uuid,
    stelle: i32,
) -> AppResult<ChatStand> {
    let versatz = i64::from(stelle.max(0)) * CHAT_PRO_SEITE;
    Ok(sqlx::query_as::<_, ChatStand>(&format!(
        "with sichtbar as (
             select m.id, m.created_at, m.edited_at
               from messages m
              where {CHAT_SICHTBAR}
         ), fenster as (
             select * from sichtbar order by id desc limit $3 offset $4
         )
         select
           (select md5(string_agg(f.id::text || coalesce(f.edited_at, f.created_at)::text, ',' order by f.id))
              from fenster f) as marke,
           (select max(s.created_at) from sichtbar s) as letzte,
           (select count(*) from sichtbar) as anzahl"
    ))
    .bind(gespraech)
    .bind(besitzer)
    .bind(CHAT_PRO_SEITE)
    .bind(versatz)
    .fetch_one(&state.pool)
    .await?)
}

/**
 * Bis wann der Chat noch stehen darf.
 *
 * Der spätere der beiden Zeitpunkte: der letzte Griff an die Fernbedienung
 * (`chat_bis`) und die jüngste Nachricht plus dieselbe Frist. Wer eine halbe
 * Stunde nebeneinander sitzt und schreibt, rührt die Fernbedienung nicht an –
 * ein leeres Wohnzimmer schreibt aber auch nicht.
 */
fn chat_laeuft_bis(
    chat_bis: Option<chrono::DateTime<Utc>>,
    letzte: Option<chrono::DateTime<Utc>>,
) -> chrono::DateTime<Utc> {
    let aus_nachricht = letzte.map(|zeit| zeit + Duration::minutes(CHAT_MINUTEN));
    match (chat_bis, aus_nachricht) {
        (Some(a), Some(b)) => a.max(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        // Kein Zeitpunkt heisst: Es wurde nie ein Chat eingestellt. Dann ist
        // auch nichts abzulaufen, und die Vergangenheit ist die ehrlichste
        // Antwort – der Fernseher zeigt wieder seinen Code.
        (None, None) => Utc::now() - Duration::seconds(1),
    }
}

/// Eine Nachricht, wie sie auf den Fernseher geht.
#[derive(Debug, sqlx::FromRow)]
struct ChatZeile {
    id: Uuid,
    sender_id: Option<Uuid>,
    r#type: String,
    body: Option<String>,
    created_at: chrono::DateTime<Utc>,
    edited_at: Option<chrono::DateTime<Utc>>,
    absender: Option<String>,
}

/**
 * Der Gesprächsverlauf, wie ihn der Fernseher holt.
 *
 * # Was hier ANDERS ist als bei Fotos
 *
 * Bei einer Diashow steht die Liste seit dem Einstellen fest, und beim Abholen
 * wird nicht mehr gefragt – die Begründung steht oben im Modulkopf. Hier wird
 * bei JEDEM Abruf geprüft, ob der Besitzer noch Mitglied des Gesprächs ist.
 * Das ist strenger und kostet nichts: Der Besitzer steht ohnehin in der Zeile.
 *
 * Die Folge ist die richtige: Wer aus der Gruppe austritt oder entfernt wird,
 * dessen Fernseher geht in derselben Sekunde dunkel – nicht erst, wenn
 * jemandem einfällt, ihn auszuschalten.
 *
 * # Was hier NICHT passiert
 *
 * `melde_gelesen` wird nicht aufgerufen. Das ist die stillste Falle des ganzen
 * Weges: Läse der Fernseher mit, verschwänden Ungelesen-Punkte, weil ein Gerät
 * mitgelaufen ist, vor dem niemand sass – und das fiele erst Wochen später
 * auf, als „meine Nachrichten sind schon gelesen, bevor ich sie sehe".
 */
async fn chat_programm(
    state: &AppState,
    row: &SitzungRow,
    besitzer: Uuid,
) -> AppResult<Json<Value>> {
    let Some(gespraech) = row.gespraech_id else {
        return Err(AppError::not_found("Noch nichts eingestellt"));
    };

    /*
     * Die Mitgliedschaft ZUERST – vor jeder Zeile aus `messages`.
     *
     * `assert_membership` gibt einen 403 mit „Du bist kein Mitglied dieses
     * Chats". Der Fernseher bekommt daraus einen 404: Er hat kein Konto und
     * keine Person, der ein „du" gälte, und die Auskunft, dass es dieses
     * Gespräch gibt, geht ihn nichts an.
     */
    if assert_membership(&state.pool, gespraech, besitzer)
        .await
        .is_err()
    {
        return Err(AppError::not_found("Der Chat steht nicht mehr zur Verfügung"));
    }

    let stand = chat_stand(state, gespraech, besitzer, row.stelle).await?;
    if chat_laeuft_bis(row.chat_bis, stand.letzte) <= Utc::now() {
        return Err(AppError::not_found("Der Chat lief zu lange ohne jemanden"));
    }

    let titel = gespraechsname(state, gespraech, besitzer).await?;
    /*
     * Die Stelle wird HIER noch einmal begrenzt, obwohl `steuern` es schon tut.
     *
     * Zwischen dem Blättern und dem Abholen kann jemand Nachrichten gelöscht
     * haben. Die Sitzung stünde dann auf Seite drei eines Verlaufs, der nur
     * noch zwei hat, und der Fernseher zeigte eine leere Liste – ohne Fehler,
     * ohne Erklärung, und ohne dass ein Druck auf „Später" ihn herausholte,
     * weil `steuern` von derselben Stelle aus weiterrechnet.
     */
    let letzte_seite = i32::try_from((stand.anzahl - 1).max(0).div_euclid(CHAT_PRO_SEITE))
        .unwrap_or(0)
        .min(CHAT_SEITEN_MAX);
    let stelle = row.stelle.clamp(0, letzte_seite);
    let versatz = i64::from(stelle) * CHAT_PRO_SEITE;
    let mut zeilen = sqlx::query_as::<_, ChatZeile>(&format!(
        "select m.id, m.sender_id, m.type, m.body, m.created_at, m.edited_at,
                u.display_name as absender
           from messages m
           left join users u on u.id = m.sender_id
          where {CHAT_SICHTBAR}
          order by m.id desc
          limit $3 offset $4"
    ))
    .bind(gespraech)
    .bind(besitzer)
    .bind(CHAT_PRO_SEITE)
    .bind(versatz)
    .fetch_all(&state.pool)
    .await?;
    // Von unten geholt (die jüngsten zuerst), von oben gezeigt – wie im Chat.
    zeilen.reverse();

    /*
     * Die Anhänge in EINER Abfrage für alle Zeilen, nicht je Zeile eine.
     *
     * Zwölf Nachrichten, zwölf Abfragen – das wäre hier nicht einmal langsam,
     * aber es wäre ein Muster, das mitwächst: Dieselbe Schleife mit einer
     * grösseren Seite ist dann plötzlich ein Problem.
     */
    let ids: Vec<Uuid> = zeilen.iter().map(|z| z.id).collect();
    let anhaenge = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments
          where message_id = any($1) and status = 'ready'
          order by created_at asc",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    let basis = state.config.public_api_url.trim_end_matches('/');
    let nachrichten: Vec<Value> = zeilen
        .iter()
        .map(|zeile| {
            let bilder: Vec<Value> = anhaenge
                .iter()
                .filter(|a| a.message_id == Some(zeile.id) && zeigbar(a))
                .map(|a| {
                    // Je Datei eine eigene Karte, wie bei der Diashow. Eine
                    // Karte auf das GESPRÄCH wäre ein Generalschlüssel, der im
                    // Verlauf des Fernsehers und in jedem Protokoll dazwischen
                    // landet – siehe `auth::fernsehticket`.
                    let karte =
                        fernsehticket::ausstellen(besitzer, a.id, &state.config.jwt_secret);
                    json!({
                        "id": a.id,
                        "art": a.kind,
                        "breite": a.width,
                        "hoehe": a.height,
                        "url": format!(
                            "{basis}/api/v1/media/{}?{}={karte}",
                            a.id,
                            fernsehticket::FELD
                        ),
                    })
                })
                .collect();
            json!({
                "id": zeile.id,
                "art": zeile.r#type,
                "text": zeile.body,
                "absender": zeile.absender,
                "eigen": zeile.sender_id == Some(besitzer),
                "zeit": zeile.created_at,
                "bearbeitet": zeile.edited_at.is_some(),
                "bilder": bilder,
            })
        })
        .collect();

    Ok(Json(json!({
        "art": "chat",
        "fassung": row.fassung,
        "marke": format!("{}:{}", row.fassung, stand.marke.as_deref().unwrap_or("leer")),
        "titel": titel,
        "stelle": stelle,
        "anzahl": stand.anzahl,
        "proSeite": CHAT_PRO_SEITE,
        "nachrichten": nachrichten,
    })))
}

/**
 * Wie das Gespräch auf dem Fernseher heisst.
 *
 * Bei einer Gruppe steht der Titel in der Zeile. Bei einem Zweiergespräch
 * steht dort nichts – der Name ist dann „die andere Person", und die ist je
 * nach Blickrichtung eine andere. Deshalb wird sie hier gesucht, und zwar aus
 * Sicht des Besitzers der Sitzung.
 *
 * Der Name ist nicht Beiwerk: Er steht auf dem Fernseher, bevor die erste
 * Nachricht kommt, und das Telefon fragt einmal nach, ob es der richtige ist.
 * Ein vertippter Code trifft sonst mit sehr kleiner Wahrscheinlichkeit eine
 * fremde Sitzung – bei Urlaubsfotos wäre das peinlich, bei Nachrichten ein
 * Leck in eine fremde Wohnung.
 */
async fn gespraechsname(state: &AppState, gespraech: Uuid, besitzer: Uuid) -> AppResult<String> {
    let titel: Option<(Option<String>, String)> =
        sqlx::query_as("select title, type from conversations where id = $1")
            .bind(gespraech)
            .fetch_optional(&state.pool)
            .await?;
    let Some((titel, art)) = titel else {
        return Ok("Chat".to_string());
    };
    if let Some(name) = titel.filter(|t| !t.trim().is_empty()) {
        return Ok(name);
    }
    if art == "direct" {
        let gegenueber: Option<(String,)> = sqlx::query_as(
            "select u.display_name
               from conversation_members cm
               join users u on u.id = cm.user_id
              where cm.conversation_id = $1 and cm.user_id <> $2
              order by u.display_name asc
              limit 1",
        )
        .bind(gespraech)
        .bind(besitzer)
        .fetch_optional(&state.pool)
        .await?;
        if let Some((name,)) = gegenueber {
            return Ok(name);
        }
    }
    Ok("Chat".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EinstellenInput {
    /// Eine ganze Sammlung – dann wird EINMAL geprüft statt je Datei.
    collection_id: Option<Uuid>,
    /// Oder eine Handvoll einzelner Dateien.
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
    /**
     * Oder ein Gespräch – dann zeigt der Fernseher den Verlauf statt Bilder.
     *
     * Schliesst die beiden anderen aus, und zwar ausdrücklich: „Diashow UND
     * Chat" wäre ein dritter Zustand, den jemand auf dem Fernseher anzeigen,
     * auf dem Telefon steuern und hier prüfen müsste. Es gibt keinen Wunsch
     * dahinter – wer beides will, macht es nacheinander.
     */
    conversation_id: Option<Uuid>,
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

    /*
     * Der Chat-Weg endet hier – er teilt mit der Diashow nur den Code.
     *
     * Was er NICHT tut: Stücke sammeln. Der Inhalt eines Gesprächs wird nicht
     * eingefroren, sondern bei jedem Abruf frisch geholt und frisch geprüft.
     * Die Begründung steht in Migration 0021.
     */
    if let Some(gespraech) = input.conversation_id {
        if input.collection_id.is_some() || !input.attachment_ids.is_empty() {
            return Err(AppError::bad_request(
                "Entweder ein Chat oder Bilder – beides zusammen geht nicht.",
            ));
        }
        assert_membership(&state.pool, gespraech, user.id()).await?;
        sqlx::query(
            "update fernsehsitzungen
                set besitzer_id = $2,
                    art = 'chat',
                    gespraech_id = $3,
                    chat_bis = now() + make_interval(mins => $4),
                    stuecke = '[]'::jsonb,
                    stelle = 0,
                    pausiert = false,
                    fassung = fassung + 1
              where code = $1",
        )
        .bind(&row.code)
        .bind(user.id())
        .bind(gespraech)
        .bind(i32::try_from(CHAT_MINUTEN).unwrap_or(30))
        .execute(&state.pool)
        .await?;
        return Ok(Json(json!({
            "code": code_lesbar(&row.code),
            "art": "chat",
            "stueckzahl": 0,
            "minuten": CHAT_MINUTEN,
        })));
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
        // `art`, `gespraech_id` und `chat_bis` zurück auf Diashow: Auf
        // demselben Fernseher lief vielleicht eben noch ein Chat, und eine
        // Sitzung mit `art = 'chat'` und einer Bilderliste wäre ein Zustand,
        // den die Bedingung in 0021 zu Recht nicht kennt.
        "update fernsehsitzungen
            set besitzer_id = $2,
                art = 'diashow',
                gespraech_id = null,
                chat_bis = null,
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

    /*
     * Beim Chat bedeutet die Stelle etwas anderes – und wird anders begrenzt.
     *
     * In der Diashow ist sie die Nummer des Bildes und läuft im Kreis: Wer am
     * Ende „weiter" drückt, will wieder von vorn. Im Verlauf eines Gesprächs
     * wäre das eine Falle. Wer am Anfang des Verlaufs noch einmal „zurück"
     * drückt, landete beim Neuesten – und hielte das für einen Sprung, den er
     * nicht gemacht hat. Hier wird also GEKLEMMT, nicht gedreht.
     *
     * Und jeder Griff an die Fernbedienung ist ein Lebenszeichen: Die Frist,
     * nach der ein Chat vom Schirm fällt, beginnt von vorn.
     */
    if row.art == "chat" {
        let seiten = match (row.gespraech_id, row.besitzer_id) {
            (Some(gespraech), Some(besitzer)) => {
                let stand = chat_stand(&state, gespraech, besitzer, 0).await?;
                /*
                 * Die Nummer der LETZTEN Seite, nicht ihre Anzahl.
                 *
                 * Seite 0 zeigt die jüngsten zwölf. Bei genau zwölf
                 * Nachrichten gibt es also keine Seite 1 – `12 / 12 = 1`
                 * hätte eine erlaubt, und wer „zurück" drückte, bekäme eine
                 * leere Seite und hielte den Fernseher für abgestürzt.
                 * Deshalb `(anzahl - 1) / pro_seite`.
                 */
                i32::try_from((stand.anzahl - 1).max(0).div_euclid(CHAT_PRO_SEITE)).unwrap_or(0)
            }
            _ => 0,
        };
        let stelle = input
            .stelle
            .unwrap_or(row.stelle)
            .clamp(0, seiten.min(CHAT_SEITEN_MAX));
        sqlx::query(
            "update fernsehsitzungen
                set stelle = $2,
                    chat_bis = now() + make_interval(mins => $3),
                    fassung = fassung + 1
              where code = $1",
        )
        .bind(&row.code)
        .bind(stelle)
        .bind(i32::try_from(CHAT_MINUTEN).unwrap_or(30))
        .execute(&state.pool)
        .await?;
        return Ok(Json(json!({ "stelle": stelle, "art": "chat" })));
    }

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
                art = 'diashow',
                gespraech_id = null,
                chat_bis = null,
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

/**
 * Was gerade auf einem Fernseher läuft – für DIESE Person.
 *
 * # Der Fehler, den diese Route behebt
 *
 * Die Fernbedienung lebte allein im Blatt auf dem Telefon: `useState`, und
 * beim Schliessen weg. Ein Anwender hat berichtet, dass sie sich „schliessen,
 * aber nicht wieder öffnen" lässt, während weiter gestreamt wird – und das
 * stimmte. Der Code stand nur noch im Blatt, und am Fernseher stand er auch
 * nicht mehr: Dort lief ja die Diashow.
 *
 * Ihn auf dem Telefon zu merken wäre die halbe Antwort gewesen. Die ganze
 * steht hier, weil der Server es ohnehin weiss: `fernsehsitzungen.besitzer_id`
 * ist genau diese Auskunft, und der Index dafür liegt seit Migration 0017.
 * Damit findet auch ein zweites Telefon die laufende Schau – und ein Telefon,
 * dessen Speicher der Browser geleert hat.
 *
 * `gesehen_at` kommt mit: Ein Fernseher, der sich seit Minuten nicht gemeldet
 * hat, ist wahrscheinlich aus. Das Telefon kann das sagen, statt eine
 * Fernbedienung ins Leere anzubieten.
 *
 * `jsonb_array_length(stuecke) > 0` ist ein Gürtel zum Hosenträger und als
 * solcher nicht geprüft: Eine Sitzung bekommt ihren Besitzer und ihre Stücke
 * in derselben Anweisung (`einstellen`), und `beenden` nimmt beides zusammen
 * wieder weg. Eine Sitzung mit Besitzer und ohne Stücke entsteht also nicht –
 * aber falls doch einmal, wäre eine Fernbedienung für nichts das Letzte, was
 * jemand braucht.
 *
 * Seit es Chat-Programme gibt, gilt diese Bedingung nur noch für die Diashow:
 * Ein Chat HAT keine Stücke, und mit der alten Bedingung wäre seine
 * Fernbedienung nie zurückzuholen gewesen.
 */
#[derive(Debug, sqlx::FromRow)]
struct MeineZeile {
    code: String,
    stuecke: Value,
    stelle: i32,
    pausiert: bool,
    modus: String,
    sekunden: i32,
    gesehen_at: chrono::DateTime<chrono::Utc>,
    art: String,
    gespraech_id: Option<Uuid>,
}

async fn meine(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let zeilen = sqlx::query_as::<_, MeineZeile>(
        /*
         * Die Bedingung „hat Stücke" gilt nur noch für die Diashow.
         *
         * Ein Chat-Programm hat keine – seine Liste steht nicht hier, sondern
         * wird bei jedem Abruf frisch geholt. Stünde die alte Bedingung noch
         * für beide, fände der Balken am unteren Rand eine laufende
         * Chat-Sitzung nie, und die Fernbedienung dafür wäre nicht
         * zurückzuholen. Genau der Fehler, den `meine` behoben hat.
         */
        "select code, stuecke, stelle, pausiert, modus, sekunden, gesehen_at,
                art, gespraech_id
           from fernsehsitzungen
          where besitzer_id = $1
            and gueltig_bis > now()
            and (art = 'chat' or jsonb_array_length(stuecke) > 0)
          order by gesehen_at desc
          limit 8",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;

    let jetzt = chrono::Utc::now();
    let sitzungen: Vec<Value> = zeilen
        .into_iter()
        .map(|zeile| {
            json!({
                "code": zeile.code,
                "art": zeile.art,
                "gespraechId": zeile.gespraech_id,
                "stueckzahl": zeile.stuecke.as_array().map(|a| a.len()).unwrap_or(0),
                "stelle": zeile.stelle,
                "pausiert": zeile.pausiert,
                "modus": zeile.modus,
                "sekunden": zeile.sekunden,
                "gesehenVorSekunden": (jetzt - zeile.gesehen_at).num_seconds().max(0),
            })
        })
        .collect();

    Ok(Json(json!({ "items": sitzungen })))
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
    fn ein_chat_laeuft_weiter_solange_jemand_schreibt() {
        /*
         * Der Fall, um den es geht: Vier Leute sitzen im Wohnzimmer, der Chat
         * steht auf dem Fernseher, und niemand rührt die Fernbedienung an –
         * sie schreiben ja. Endete der Chat dreissig Minuten nach dem letzten
         * KNOPFDRUCK, ginge der Schirm mitten im Abend aus.
         *
         * Umgekehrt ist die Frist genau dafür da, dass ein leeres Wohnzimmer
         * nicht stundenlang Nachrichten zeigt. Und ein leeres Wohnzimmer
         * schreibt auch nicht.
         */
        let jetzt = Utc::now();
        let alter_knopfdruck = jetzt - Duration::minutes(20);
        let frische_nachricht = jetzt - Duration::minutes(1);
        assert!(
            chat_laeuft_bis(Some(alter_knopfdruck), Some(frische_nachricht)) > jetzt,
            "die neue Nachricht muss den Chat am Leben halten"
        );

        /*
         * Und andersherum: Wer blättert, hält ihn ebenso am Leben, auch wenn
         * seit Stunden niemand geschrieben hat.
         *
         * `chat_bis` ist der ZEITPUNKT DES ABLAUFS, nicht der des Knopfdrucks
         * – `steuern` schreibt `now() + CHAT_MINUTEN` hinein. Wer hier den
         * Knopfdruck selbst einsetzt, prüft eine Frist, die es nicht gibt.
         */
        let alte_nachricht = jetzt - Duration::hours(5);
        assert!(
            chat_laeuft_bis(Some(jetzt + Duration::minutes(CHAT_MINUTEN)), Some(alte_nachricht))
                > jetzt,
            "der Griff an die Fernbedienung muss den Chat am Leben halten"
        );

        // Beides lange her: Schluss. Die Frist ist abgelaufen UND die jüngste
        // Nachricht liegt länger zurück als die Frist.
        assert!(
            chat_laeuft_bis(Some(jetzt - Duration::hours(2)), Some(alte_nachricht)) <= jetzt,
            "ein Chat ohne jedes Lebenszeichen muss vom Schirm fallen"
        );
    }

    #[test]
    fn ohne_jeden_zeitpunkt_laeuft_kein_chat() {
        /*
         * `None, None` heisst: Es wurde nie ein Chat eingestellt. Die
         * Vergangenheit ist die ehrlichste Antwort – ein `Utc::now()` hätte
         * einer Sitzung ohne Programm eine Frist gegeben, die es nicht gibt,
         * und der Fernseher zeigte einen leeren Chat statt seines Codes.
         */
        assert!(chat_laeuft_bis(None, None) <= Utc::now());
    }

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
