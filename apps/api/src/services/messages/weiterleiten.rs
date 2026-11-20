//! Nachrichten weiterleiten – mit denselben Rechten, die das Sehen verlangt.
//!
//! # Was sich weiterleiten lässt
//!
//! Text, Fotos (auch mit Bearbeitung), Videos, Sprachnachrichten, Dateien
//! und Sticker. **Nicht** Umfragen, Termine, Spiele und Systemzeilen: Diese
//! Karten sind nur eine Ansicht auf etwas, das an IHREM Chat hängt (wer
//! abstimmen, zusagen, mitspielen darf). Eine Kopie wäre entweder tot (eine
//! Umfrage, in der niemand abstimmen darf) oder ein Loch (die Expander laden,
//! was die Kennung nennt – Frage, Stimmen und Teilnehmer gingen an Leute
//! ausserhalb). WhatsApp verbietet das Weiterleiten von Umfragen aus
//! demselben Grund. Wer auf so etwas hinweisen will, kann zitieren oder die
//! Frage abschreiben.
//!
//! # Rechte
//!
//! Das Original muss die Person sehen dürfen: Mitglied, nach der eigenen
//! Grenze (`sieht_ab`), nicht gelöscht, nicht „für mich gelöscht“. In jedem
//! Ziel muss sie Mitglied sein. Anhänge werden nicht über die Leitung kopiert,
//! sondern wie bei „In einem Chat teilen“ als zweite Zeile auf dieselbe Datei
//! angelegt (`quelle_id`) – mit `for share` gesperrt, damit ein gleichzeitiges
//! Löschen des Originals die Bytes nicht unter der Kopie wegräumt.
//!
//! # Atomar
//!
//! Alle Ziele in EINER Transaktion: Entweder kommt die Nachricht in allen
//! gewählten Chats an oder in keinem. Gemeldet wird erst nach dem Commit
//! (`alle_ausliefern`). Mit `clientId` ist ein Neuversuch folgenlos – je Chat
//! greift der gewohnte Wiederholungsschlüssel.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::MessageRow;
use crate::dto::MessageDto;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{alle_ausliefern_mit_ergebnis, nachricht_anlegen, NewMessage};

/// Diese Arten lassen sich weiterleiten (siehe Modulkommentar).
pub const WEITERLEITBAR: &[&str] = &[
    "text", "image", "video", "audio", "file", "sticker", "rezept",
];

/// Höchstens so viele Ziele auf einmal – wie bei WhatsApp eine Handvoll, und
/// eine Grenze gegen das Fluten vieler Chats mit einem Klick.
pub const ZIELE_MAX: usize = 20;

pub struct Auftrag {
    pub message_id: Uuid,
    pub ziele: Vec<Uuid>,
    /// Mit Herkunft: „Weitergeleitet von Anna“. Ohne: nur „Weitergeleitet“.
    pub herkunft: bool,
    pub client_id: Option<String>,
}

pub async fn weiterleiten(
    state: &AppState,
    user_id: Uuid,
    auftrag: Auftrag,
) -> AppResult<Vec<MessageDto>> {
    let mut ziele = auftrag.ziele.clone();
    ziele.sort();
    ziele.dedup();
    if ziele.is_empty() {
        return Err(AppError::bad_request("Kein Chat ausgewählt"));
    }
    if ziele.len() > ZIELE_MAX {
        return Err(AppError::bad_request(format!(
            "Höchstens {ZIELE_MAX} Chats auf einmal"
        )));
    }

    let original = sqlx::query_as::<_, MessageRow>("select * from messages where id = $1")
        .bind(auftrag.message_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Nachricht nicht gefunden"))?;
    // Ein und dieselbe Antwort für „gibt es nicht“ und „darfst du nicht
    // sehen“ – sonst verriete die Fehlermeldung, dass es die Kennung gibt.
    let sichtbar: bool = sqlx::query_scalar(
        "select exists (
           select 1 from messages m
             join conversation_members cm
               on cm.conversation_id = m.conversation_id and cm.user_id = $2
            where m.id = $1
              and m.deleted_at is null
              and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
              and not exists (select 1 from message_hidden h
                               where h.message_id = m.id and h.user_id = $2)
         )",
    )
    .bind(original.id)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    if !sichtbar {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    // Einmal ansehbar heisst: bei genau diesem Empfänger, genau einmal. Eine
    // Weiterleitung wäre eine zweite, dauerhafte Kopie.
    if super::ist_einmal(&original.metadata) {
        return Err(AppError::bad_request(
            "Einmal ansehbare Fotos und Videos lassen sich nicht weiterleiten",
        ));
    }
    if !WEITERLEITBAR.contains(&original.r#type.as_str()) {
        return Err(AppError::bad_request(
            "Umfragen, Termine, Spiele und Systemhinweise lassen sich nicht weiterleiten",
        ));
    }

    // Dieselbe Prüfung wie beim gewöhnlichen Senden: Mitglied, und in einer
    // Gruppe, in der nur Verwalter schreiben (oder im langsamen Modus), gilt
    // das auch für Weitergeleitetes.
    for ziel in &ziele {
        crate::services::conversations::senden_erlaubt(
            &state.pool,
            *ziel,
            user_id,
            auftrag.client_id.as_deref(),
        )
        .await?;
    }

    // Ein Sticker aus einem privaten Paket darf nicht über einen Umweg in
    // einen Chat, in dem ihn niemand sehen dürfte (siehe `sticker_pruefen`).
    let sticker_id = original
        .metadata
        .get("stickerId")
        .and_then(Value::as_str)
        .and_then(|text| Uuid::parse_str(text).ok());
    if let Some(sticker_id) = sticker_id {
        for ziel in &ziele {
            crate::modules::messages::sticker_pruefen(state, sticker_id, *ziel, user_id).await?;
        }
    }

    let kennzeichen = if auftrag.herkunft {
        // Eine Kette behält ihren Ursprung: Wer eine weitergeleitete Nachricht
        // weiterleitet, nennt den ersten Absender, nicht sich selbst.
        let von = match original
            .metadata
            .get("weitergeleitet")
            .and_then(|w| w.get("von"))
            .and_then(Value::as_str)
        {
            Some(von) => Some(von.to_string()),
            None if original
                .metadata
                .get("weitergeleitet")
                .is_some_and(|w| w.get("von").is_none()) =>
            {
                // Schon einmal ohne Herkunft weitergeleitet: Die verborgene
                // Herkunft bleibt verborgen.
                None
            }
            None => match original.sender_id {
                Some(absender) => {
                    sqlx::query_scalar::<_, String>("select display_name from users where id = $1")
                        .bind(absender)
                        .fetch_optional(&state.pool)
                        .await?
                }
                None => None,
            },
        };
        match von {
            Some(von) => json!({ "von": von }),
            None => json!({}),
        }
    } else {
        json!({})
    };

    let mut metadata = serde_json::Map::new();
    if let Some(sticker_id) = sticker_id {
        metadata.insert("stickerId".into(), json!(sticker_id));
    }
    // Was Module der Nachricht mitgeben (etwa die Bearbeitung eines Fotos in
    // `rezept`), gehört zum Inhalt und reist mit.
    if let Some(modul) = original.metadata.get("module") {
        metadata.insert("module".into(), modul.clone());
    }
    metadata.insert("weitergeleitet".into(), kennzeichen);
    let metadata = Value::Object(metadata);

    let mut tx = state.pool.begin().await?;
    let quellen: Vec<Uuid> = sqlx::query_scalar(
        "select id from attachments
          where message_id = $1 and status = 'ready'
          order by created_at asc, id asc
          for share",
    )
    .bind(original.id)
    .fetch_all(&mut *tx)
    .await?;

    let mut angelegte = Vec::with_capacity(ziele.len());
    for ziel in &ziele {
        // Ein Neuversuch mit demselben Schlüssel bekommt die schon gesendete
        // Nachricht zurück (`nachricht_anlegen`). Kopien dafür anzulegen hiesse,
        // Anhänge ohne Nachricht zu hinterlassen.
        let schon_da = match auftrag.client_id.as_deref() {
            Some(schluessel) => {
                sqlx::query_scalar::<_, bool>(
                    "select exists (select 1 from messages
                                 where conversation_id = $1 and sender_id = $2 and client_id = $3)",
                )
                .bind(ziel)
                .bind(user_id)
                .bind(schluessel)
                .fetch_one(&mut *tx)
                .await?
            }
            None => false,
        };
        let mut kopien = Vec::with_capacity(quellen.len());
        for quelle in quellen.iter().filter(|_| !schon_da) {
            let neu = Uuid::now_v7();
            sqlx::query(
                "insert into attachments
                   (id, message_id, uploader_id, kind, mime, size, file_name, storage_key,
                    width, height, duration_ms, waveform, preview_data_url, status,
                    ablage, prioritaet, ausgelagert_at, quelle_id)
                 select $1, null, $2, kind, mime, size, file_name, storage_key,
                        width, height, duration_ms, waveform, preview_data_url, 'ready',
                        ablage, prioritaet, ausgelagert_at, coalesce(quelle_id, id)
                   from attachments where id = $3",
            )
            .bind(neu)
            .bind(user_id)
            .bind(quelle)
            .execute(&mut *tx)
            .await?;
            kopien.push(neu);
        }
        let angelegt = nachricht_anlegen(
            &mut tx,
            NewMessage {
                conversation_id: *ziel,
                sender_id: Some(user_id),
                r#type: original.r#type.clone(),
                body: original.body.clone(),
                attachment_ids: kopien,
                reply_to_id: None,
                client_id: auftrag.client_id.clone(),
                metadata: metadata.clone(),
                silent: false,
            },
        )
        .await?;
        angelegte.push(angelegt);
    }
    tx.commit().await?;
    Ok(alle_ausliefern_mit_ergebnis(state, angelegte).await)
}
