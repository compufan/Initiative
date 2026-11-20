//! Medienübersicht und Export eines Chats.
//!
//! Beide lesen dasselbe: den Verlauf, wie ihn EINE Person sieht. Deshalb steht
//! die Regel, was dazugehört, hier einmal ([`SICHTBAR`]) und nicht in jeder
//! Abfrage neu:
//!
//! * nur ab der eigenen Verlaufsgrenze (`sieht_ab`; „Chat leeren“ zieht sie
//!   mit, siehe `services::conversations::leeren`),
//! * nichts „für mich gelöscht“ (`message_hidden`) und nichts für alle
//!   gelöscht (`deleted_at`),
//! * nichts Abgelaufenes (selbstlöschende Nachrichten, `expires_at`),
//! * nichts einmal Ansehbares (`metadata.einmalAnsehen`) – das gibt es genau
//!   einmal über seinen eigenen Weg und gehört weder in ein Raster noch in
//!   eine Datei, die man aufheben kann.
//!
//! Geplante Nachrichten liegen in einer eigenen Tabelle, bis sie gesendet
//! sind – sie tauchen hier also von selbst erst danach auf.

use std::collections::HashMap;

use chrono::{DateTime, FixedOffset, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::AsyncWrite;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{AttachmentRow, MessageRow};
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};
use crate::services::attachments::to_attachment_dto;
use crate::services::zip_strom::ZipStrom;
use crate::state::AppState;

/// Was eine Person von einer Nachricht `m` in Chat `$1` sehen darf; `$2` ist
/// die Person. Als SQL-Baustein, damit die Seitengrösse stimmt (siehe
/// `modules::messages::list_messages`).
pub const SICHTBAR: &str = "m.conversation_id = $1
      and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
      and (m.metadata->>'einmalAnsehen') is distinct from 'true'
      and exists (
        select 1 from conversation_members cm
         where cm.conversation_id = m.conversation_id and cm.user_id = $2
           and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab))
      and not exists (
        select 1 from message_hidden h where h.message_id = m.id and h.user_id = $2)";

/// Die Reiter der Medienübersicht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Art {
    Medien,
    Dokumente,
    Links,
    Audio,
}

impl Art {
    pub fn aus(text: &str) -> Option<Self> {
        match text {
            "medien" => Some(Self::Medien),
            "dokumente" => Some(Self::Dokumente),
            "links" => Some(Self::Links),
            "audio" => Some(Self::Audio),
            _ => None,
        }
    }

    fn arten(self) -> &'static [&'static str] {
        match self {
            Self::Medien => &["image", "video"],
            Self::Dokumente => &["file"],
            Self::Audio => &["audio"],
            Self::Links => &[],
        }
    }
}

pub const SEITE_VORGABE: i64 = 60;
pub const SEITE_MAX: i64 = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnhangEintrag {
    pub message_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub attachment: AttachmentDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEintrag {
    pub message_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub url: String,
    /// Der Text drumherum, gekürzt – damit man den Link wiedererkennt.
    pub text: String,
}

#[derive(sqlx::FromRow)]
struct AnhangZeile {
    #[sqlx(flatten)]
    anhang: AttachmentRow,
    nachricht_id: Uuid,
    absender_id: Option<Uuid>,
    gesendet_at: DateTime<Utc>,
}

/// Eine Seite der Übersicht. `vor` ist der `nextCursor` der vorigen Seite.
pub async fn uebersicht(
    pool: &PgPool,
    config: &Config,
    conversation_id: Uuid,
    person: Uuid,
    art: Art,
    vor: Option<&str>,
    grenze: i64,
) -> AppResult<(Vec<Value>, Option<String>)> {
    let grenze = grenze.clamp(1, SEITE_MAX);
    if art == Art::Links {
        return links(pool, conversation_id, person, vor, grenze).await;
    }
    // Zeiger: „Nachricht:Anhang“ – innerhalb einer Nachricht nach Anhang.
    let (vor_nachricht, vor_anhang) = match vor {
        Some(zeiger) => {
            let (n, a) = zeiger
                .split_once(':')
                .ok_or_else(|| AppError::bad_request("Ungültiger Zeiger"))?;
            (
                Some(Uuid::parse_str(n).map_err(|_| AppError::bad_request("Ungültiger Zeiger"))?),
                Some(Uuid::parse_str(a).map_err(|_| AppError::bad_request("Ungültiger Zeiger"))?),
            )
        }
        None => (None, None),
    };
    let zeilen = sqlx::query_as::<_, AnhangZeile>(&format!(
        "select a.*, m.id as nachricht_id, m.sender_id as absender_id,
                m.created_at as gesendet_at
           from messages m
           join attachments a on a.message_id = m.id
          where {SICHTBAR}
            and a.status = 'ready' and a.kind = any($3)
            and ($4::uuid is null or (m.id, a.id) < ($4, $5))
          order by m.id desc, a.id desc
          limit $6"
    ))
    .bind(conversation_id)
    .bind(person)
    .bind(art.arten())
    .bind(vor_nachricht)
    .bind(vor_anhang)
    .bind(grenze)
    .fetch_all(pool)
    .await?;
    let weiter = if zeilen.len() as i64 == grenze {
        zeilen
            .last()
            .map(|zeile| format!("{}:{}", zeile.nachricht_id, zeile.anhang.id))
    } else {
        None
    };
    let eintraege = zeilen
        .iter()
        .map(|zeile| {
            json!(AnhangEintrag {
                message_id: zeile.nachricht_id,
                sender_id: zeile.absender_id,
                created_at: zeile.gesendet_at,
                attachment: to_attachment_dto(&zeile.anhang, config),
            })
        })
        .collect();
    Ok((eintraege, weiter))
}

async fn links(
    pool: &PgPool,
    conversation_id: Uuid,
    person: Uuid,
    vor: Option<&str>,
    grenze: i64,
) -> AppResult<(Vec<Value>, Option<String>)> {
    let vor = match vor {
        Some(zeiger) => {
            Some(Uuid::parse_str(zeiger).map_err(|_| AppError::bad_request("Ungültiger Zeiger"))?)
        }
        None => None,
    };
    /*
     * Links werden beim Lesen gefunden, nicht beim Schreiben verbucht.
     *
     * Ein eigener Index hiesse: eine Tabelle, die bei jedem Bearbeiten,
     * Löschen, Leeren und Ablaufen mitgezogen werden muss – fünf Stellen, an
     * denen sie veralten kann. Der Vorfilter in SQL (`~*`) lässt nur
     * Nachrichten mit einem Link-Anfang durch; was genau ein Link ist,
     * entscheidet [`links_finden`]. Gelesen wird seitenweise rückwärts über
     * den Index `(conversation_id, id)`.
     */
    let zeilen = sqlx::query_as::<_, MessageRow>(&format!(
        "select m.* from messages m
          where {SICHTBAR}
            and m.body ~* '(https?://|www\\.)'
            and ($3::uuid is null or m.id < $3)
          order by m.id desc
          limit $4"
    ))
    .bind(conversation_id)
    .bind(person)
    .bind(vor)
    .bind(grenze)
    .fetch_all(pool)
    .await?;
    let weiter = if zeilen.len() as i64 == grenze {
        zeilen.last().map(|zeile| zeile.id.to_string())
    } else {
        None
    };
    let mut eintraege = Vec::new();
    for zeile in &zeilen {
        let text = zeile.body.as_deref().unwrap_or_default();
        let ohne = crate::services::messages::formatierung::ohne_formatierung(text);
        for url in links_finden(text) {
            eintraege.push(json!(LinkEintrag {
                message_id: zeile.id,
                sender_id: zeile.sender_id,
                created_at: zeile.created_at,
                url,
                text: kuerzen(&ohne, 200),
            }));
        }
    }
    Ok((eintraege, weiter))
}

fn kuerzen(text: &str, zeichen: usize) -> String {
    if text.chars().count() <= zeichen {
        return text.to_string();
    }
    let mut kurz: String = text.chars().take(zeichen).collect();
    kurz.push('…');
    kurz
}

/**
 * Die Links in einem Text – `http://`, `https://` und `www.`.
 *
 * Bewusst einfach und ohne Regex-Bibliothek: Ein Link endet am ersten
 * Leerraum oder an `<>"`, und Satzzeichen am Ende gehören zum Satz, nicht zum
 * Link („Schau mal: https://x.de.“). Eine schliessende Klammer bleibt nur,
 * wenn der Link selbst eine öffnet (Wikipedia-Adressen).
 */
pub fn links_finden(text: &str) -> Vec<String> {
    let mut gefunden = Vec::new();
    let klein = text.to_lowercase();
    // `to_lowercase` kann Längen ändern (selten, z. B. „İ“); dann lieber
    // nichts finden als an falscher Stelle schneiden.
    if klein.len() != text.len() {
        return gefunden;
    }
    let mut ab = 0;
    while ab < text.len() {
        let rest = &klein[ab..];
        let naechster = ["https://", "http://", "www."]
            .iter()
            .filter_map(|anfang| rest.find(anfang))
            .min();
        let Some(versatz) = naechster else { break };
        let anfang = ab + versatz;
        // `www.` mitten in einem Wort (`awww.`) ist kein Link.
        let davor = text[..anfang].chars().next_back();
        let mut ende = anfang;
        for (i, zeichen) in text[anfang..].char_indices() {
            if zeichen.is_whitespace() || matches!(zeichen, '<' | '>' | '"') {
                break;
            }
            ende = anfang + i + zeichen.len_utf8();
        }
        let mut kandidat = &text[anfang..ende];
        while let Some(letztes) = kandidat.chars().next_back() {
            let weg = match letztes {
                '.' | ',' | ';' | ':' | '!' | '?' | '\'' | ']' | '}' | '*' | '_' | '~' => true,
                ')' => kandidat.matches('(').count() < kandidat.matches(')').count(),
                _ => false,
            };
            if !weg {
                break;
            }
            kandidat = &kandidat[..kandidat.len() - letztes.len_utf8()];
        }
        let wortanfang = davor.is_none_or(|c| !c.is_alphanumeric());
        let ist_www = kandidat.to_lowercase().starts_with("www.");
        let lang_genug = if ist_www {
            kandidat.len() > 4 && kandidat[4..].contains('.')
        } else {
            kandidat
                .split_once("://")
                .is_some_and(|(_, r)| !r.is_empty())
        };
        if wortanfang && lang_genug {
            let url = if ist_www {
                format!("https://{kandidat}")
            } else {
                kandidat.to_string()
            };
            if !gefunden.contains(&url) {
                gefunden.push(url);
            }
        }
        ab = ende.max(anfang + 1);
        while !text.is_char_boundary(ab) && ab < text.len() {
            ab += 1;
        }
    }
    gefunden
}

/* ---------- Export ------------------------------------------------------- */

/// Höchstens so viele Bytes Medien in einem Export. Darüber steht in
/// `chat.txt`, was fehlt – ein Export von 40 GB wäre keine Sicherung, sondern
/// eine Last für Server und Telefon.
pub const EXPORT_MEDIEN_MAX: i64 = 2 * 1024 * 1024 * 1024;
/// Höchstens so viele Mediendateien (ohne ZIP64 sind 65 535 Einträge Schluss).
pub const EXPORT_DATEIEN_MAX: usize = 10_000;
/// Nachrichten je Datenbankseite beim Export.
const EXPORT_SEITE: i64 = 500;

#[derive(Debug, Clone)]
pub struct ExportWunsch {
    pub conversation_id: Uuid,
    pub person: Uuid,
    pub mit_medien: bool,
    /// Wie `Date.getTimezoneOffset()`: Minuten von lokal nach UTC
    /// (Mitteleuropa im Winter: -60).
    pub versatz_min: i32,
}

/// Was nach `chat.txt` noch ins Archiv gehört.
struct Medium {
    name: String,
    schluessel: String,
    zeit: chrono::NaiveDateTime,
}

fn zone(versatz_min: i32) -> FixedOffset {
    // Echte Zonen liegen zwischen -12 und +14 Stunden.
    FixedOffset::east_opt(-versatz_min.clamp(-14 * 60, 12 * 60) * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"))
}

/// Ein Dateiname, der in jedem Entpacker und auf jedem System geht.
fn dateiname(nr: usize, anhang: &AttachmentRow) -> String {
    let roh = anhang
        .file_name
        .as_deref()
        .map(crate::storage::sanitise_file_name)
        .filter(|name| !name.is_empty() && name != "." && name != "..");
    let name = match roh {
        Some(name) => name.replace(['/', '\\', ':'], "_"),
        None => {
            let art = match anhang.kind.as_str() {
                "image" => "Foto",
                "video" => "Video",
                "audio" => "Audio",
                _ => "Datei",
            };
            format!("{art}{}", crate::storage::extension_for(None, &anhang.mime))
        }
    };
    format!("{nr:04}-{name}")
}

/// Systemzeilen im Export – kurz, in der dritten Person.
fn systemtext(zeile: &MessageRow, namen: &HashMap<Uuid, String>) -> String {
    if let Some(text) = zeile.body.as_deref().filter(|t| !t.trim().is_empty()) {
        return text.to_string();
    }
    let system = zeile.metadata.get("system");
    let wer = system
        .and_then(|s| s.get("actorId"))
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .or(zeile.sender_id)
        .and_then(|id| namen.get(&id).cloned())
        .unwrap_or_else(|| "Jemand".to_string());
    let ziele: Vec<String> = system
        .and_then(|s| s.get("targetIds"))
        .and_then(Value::as_array)
        .map(|liste| {
            liste
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|id| Uuid::parse_str(id).ok())
                .map(|id| namen.get(&id).cloned().unwrap_or_else(|| "jemand".into()))
                .collect()
        })
        .unwrap_or_default();
    let ziele = ziele.join(", ");
    match system.and_then(|s| s.get("kind")).and_then(Value::as_str) {
        Some("conversation.created") => format!("{wer} hat den Chat erstellt"),
        Some("members.added") => format!("{wer} hat {ziele} hinzugefügt"),
        Some("member.left") => format!("{wer} hat den Chat verlassen"),
        Some("member.removed") => format!("{wer} hat {ziele} entfernt"),
        Some("member.joined") => format!("{wer} ist beigetreten"),
        Some("conversation.renamed") => format!("{wer} hat die Gruppe umbenannt"),
        _ => "Der Chat wurde aktualisiert".to_string(),
    }
}

async fn namen_nachladen(
    pool: &PgPool,
    namen: &mut HashMap<Uuid, String>,
    zeilen: &[MessageRow],
) -> AppResult<()> {
    let mut fehlend: Vec<Uuid> = Vec::new();
    for zeile in zeilen {
        let mut ids: Vec<Uuid> = zeile.sender_id.into_iter().collect();
        if let Some(liste) = zeile
            .metadata
            .get("system")
            .and_then(|s| s.get("targetIds"))
            .and_then(Value::as_array)
        {
            ids.extend(
                liste
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|id| Uuid::parse_str(id).ok()),
            );
        }
        for id in ids {
            if !namen.contains_key(&id) && !fehlend.contains(&id) {
                fehlend.push(id);
            }
        }
    }
    if fehlend.is_empty() {
        return Ok(());
    }
    let gefunden: Vec<(Uuid, String)> =
        sqlx::query_as("select id, display_name from users where id = any($1)")
            .bind(&fehlend)
            .fetch_all(pool)
            .await?;
    for id in fehlend {
        let name = gefunden
            .iter()
            .find(|(gid, _)| *gid == id)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| "Gelöschtes Konto".to_string());
        namen.insert(id, name);
    }
    Ok(())
}

/// Der Text einer Nachricht im Export – ohne Anhänge (die stehen davor).
fn nachrichtentext(zeile: &MessageRow) -> String {
    let rumpf = zeile.body.as_deref().map(str::trim).unwrap_or_default();
    let art = match zeile.r#type.as_str() {
        "poll" => Some("Umfrage"),
        "event" => Some("Termin"),
        "game" => Some("Spiel"),
        "sticker" => Some("Sticker"),
        "location" => Some("Standort"),
        "contact" => Some("Kontakt"),
        _ => None,
    };
    match (art, rumpf.is_empty()) {
        (Some(art), true) => format!("[{art}]"),
        (Some(art), false) => format!("[{art}] {rumpf}"),
        (None, _) => rumpf.to_string(),
    }
}

fn io(fehler: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(fehler.to_string())
}

/**
 * Den Export schreiben: `chat.txt` im WhatsApp-ähnlichen Format, danach die
 * Medien. Alles im Strom – Seite für Seite aus der Datenbank, Stück für Stück
 * aus der Ablage. Bricht der Empfänger ab, scheitert das nächste Schreiben,
 * und der Export endet.
 */
pub async fn exportieren<W: AsyncWrite + Unpin + Send>(
    state: &AppState,
    wunsch: ExportWunsch,
    ziel: W,
) -> std::io::Result<()> {
    let zone = zone(wunsch.versatz_min);
    let lokal = |zeit: DateTime<Utc>| zeit.with_timezone(&zone);
    let jetzt = lokal(Utc::now()).naive_local();
    let mut zip = ZipStrom::neu(ziel);
    zip.datei_beginnen("chat.txt", jetzt).await?;

    let mut namen: HashMap<Uuid, String> = HashMap::new();
    let mut medien: Vec<Medium> = Vec::new();
    let mut medien_bytes: i64 = 0;
    let mut nach: Option<Uuid> = None;
    loop {
        let zeilen = sqlx::query_as::<_, MessageRow>(&format!(
            "select m.* from messages m
              where {SICHTBAR}
                and ($3::uuid is null or m.id > $3)
              order by m.id asc
              limit $4"
        ))
        .bind(wunsch.conversation_id)
        .bind(wunsch.person)
        .bind(nach)
        .bind(EXPORT_SEITE)
        .fetch_all(&state.pool)
        .await
        .map_err(io)?;
        if zeilen.is_empty() {
            break;
        }
        nach = zeilen.last().map(|zeile| zeile.id);
        namen_nachladen(&state.pool, &mut namen, &zeilen)
            .await
            .map_err(io)?;
        let ids: Vec<Uuid> = zeilen.iter().map(|zeile| zeile.id).collect();
        let anhaenge = sqlx::query_as::<_, AttachmentRow>(
            "select * from attachments where message_id = any($1) and status = 'ready'
              order by created_at asc, id asc",
        )
        .bind(&ids)
        .fetch_all(&state.pool)
        .await
        .map_err(io)?;

        let mut text = String::new();
        for zeile in &zeilen {
            let zeit = lokal(zeile.created_at);
            let stempel = zeit.format("%d.%m.%y, %H:%M");
            if zeile.r#type == "system" {
                text.push_str(&format!("{stempel} - {}\n", systemtext(zeile, &namen)));
                continue;
            }
            let name = zeile
                .sender_id
                .and_then(|id| namen.get(&id).cloned())
                .unwrap_or_else(|| "Gelöschtes Konto".to_string());
            let mut teile: Vec<String> = Vec::new();
            for anhang in anhaenge
                .iter()
                .filter(|a| a.message_id == Some(zeile.id) && a.kind != "sticker")
            {
                let passt = wunsch.mit_medien
                    && medien.len() < EXPORT_DATEIEN_MAX
                    && medien_bytes.saturating_add(anhang.size) <= EXPORT_MEDIEN_MAX;
                if passt {
                    let datei = dateiname(medien.len() + 1, anhang);
                    teile.push(format!("{datei} (Datei angehängt)"));
                    medien_bytes += anhang.size.max(0);
                    medien.push(Medium {
                        name: format!("medien/{datei}"),
                        schluessel: anhang.storage_key.clone(),
                        zeit: zeit.naive_local(),
                    });
                } else if wunsch.mit_medien {
                    teile.push("<Medien nicht im Export – zu gross>".to_string());
                } else {
                    teile.push("<Medien ausgeschlossen>".to_string());
                }
            }
            let rumpf = nachrichtentext(zeile);
            if !rumpf.is_empty() {
                teile.push(rumpf);
            }
            if teile.is_empty() {
                teile.push("<leer>".to_string());
            }
            let bearbeitet = if zeile.edited_at.is_some() {
                " <Diese Nachricht wurde bearbeitet.>"
            } else {
                ""
            };
            text.push_str(&format!(
                "{stempel} - {name}: {}{bearbeitet}\n",
                teile.join("\n")
            ));
        }
        zip.schreiben(text.as_bytes()).await?;
        if (zeilen.len() as i64) < EXPORT_SEITE {
            break;
        }
    }
    zip.datei_beenden().await?;

    for medium in medien {
        let objekt = match state.storage.read(&medium.schluessel, None).await {
            Ok(Some(objekt)) => objekt,
            Ok(None) => {
                tracing::warn!(schluessel = %medium.schluessel, "Export: Datei fehlt in der Ablage");
                continue;
            }
            Err(fehler) => {
                tracing::warn!(%fehler, "Export: Datei nicht lesbar");
                continue;
            }
        };
        zip.datei_beginnen(&medium.name, medium.zeit).await?;
        let mut strom = objekt.stream;
        use futures_util::StreamExt;
        while let Some(stueck) = strom.next().await {
            zip.schreiben(&stueck?).await?;
        }
        zip.datei_beenden().await?;
    }
    zip.abschliessen().await?;
    Ok(())
}

/// Ein Dateiname für den Export: „Chat mit Anna.zip“.
pub fn exportname(titel: &str) -> String {
    let sauber: String = titel
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '"' | '*' | '?' | '<' | '>' | '|')
        })
        .take(60)
        .collect();
    let sauber = sauber.trim();
    if sauber.is_empty() {
        "Chat-Export.zip".to_string()
    } else {
        format!("Chat mit {sauber}.zip")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_werden_gefunden_und_satzzeichen_bleiben_draussen() {
        assert_eq!(
            links_finden("Schau mal: https://example.org/a?b=1. Und www.test.de, ok?"),
            vec!["https://example.org/a?b=1", "https://www.test.de"]
        );
        assert_eq!(
            links_finden("(siehe https://de.wikipedia.org/wiki/Klammer_(Zeichen))"),
            vec!["https://de.wikipedia.org/wiki/Klammer_(Zeichen)"]
        );
        assert_eq!(
            links_finden("awww.nein und http:// und www.x"),
            Vec::<String>::new()
        );
        assert_eq!(
            links_finden("doppelt https://a.de https://a.de"),
            vec!["https://a.de"]
        );
        assert_eq!(links_finden("HTTPS://GROSS.DE"), vec!["HTTPS://GROSS.DE"]);
        assert_eq!(links_finden("Grüße <https://ä.de>"), vec!["https://ä.de"]);
    }

    #[test]
    fn zeitzone_wie_im_browser() {
        // Mitteleuropa im Winter: getTimezoneOffset() = -60.
        let zeit = DateTime::parse_from_rfc3339("2026-11-20T13:03:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            zeit.with_timezone(&zone(-60))
                .format("%d.%m.%y, %H:%M")
                .to_string(),
            "20.11.26, 14:03"
        );
        // Unsinnige Werte werden geklemmt, nicht zum Absturz.
        let _ = zone(i32::MAX);
    }

    #[test]
    fn exportnamen_sind_harmlos() {
        assert_eq!(exportname("Anna"), "Chat mit Anna.zip");
        assert_eq!(exportname("../a:b"), "Chat mit ..ab.zip");
        assert_eq!(exportname("  "), "Chat-Export.zip");
    }
}
