//! Selbstlöschende Nachrichten: der Aufräumdienst.
//!
//! Eine Nachricht in einem Chat mit eingeschalteter Einstellung bekommt beim
//! Anlegen ein `expires_at` (`nachricht_anlegen`). Dieser Dienst löscht sie
//! danach **wirklich** – nicht nur `deleted_at` wie „Für alle löschen“, denn
//! auch die Platzhalterzeile „Diese Nachricht wurde gelöscht“ wäre ein Rest
//! dessen, was verschwinden sollte.
//!
//! * **Anhänge** fallen über die Kaskade (`attachments.message_id`), und der
//!   Auslöser aus Migration 0013/0020 legt ihre Schlüssel in `storage_muell` –
//!   den Weg, den alles Gelöschte nimmt. Eine weitergeleitete Kopie mit
//!   denselben Bytes hält sie am Leben (derselbe Auslöser prüft das).
//! * **Genau einmal**: Ein Durchgang beansprucht seine Zeilen mit
//!   `for update skip locked`; zwei Instanzen löschen nie dieselbe Nachricht
//!   doppelt, und was eine abgebrochene Runde liegen liess, holt die nächste.
//! * **Meldung** nach dem Commit: `message.deleted` an die Mitglieder, und wo
//!   eine angeheftete Nachricht wegfiel, die Anheft-Meldung.
//!
//! Der Client entfernt abgelaufene Nachrichten schon selbst zur Ablaufzeit; der
//! Dienst sorgt dafür, dass sie auch beim Server fort sind.
//!
//! Ehrlich bleibt: Ohne Ende-zu-Ende-Verschlüsselung schützt das nicht vor
//! Kopien (Bildschirmfoto, Weiterleiten vor dem Ablauf, Sicherung des
//! Servers bis zur nächsten Runde). Die Oberfläche sagt das dazu.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use uuid::Uuid;

use crate::error::AppResult;
use crate::realtime::Event;
use crate::state::AppState;

/// Wie viele Nachrichten ein Durchgang höchstens löscht. Ein Rückstau (Server
/// war lange aus) wird in Happen abgebaut, nicht in einer Riesentransaktion.
const STAPEL: i64 = 500;
/// Takt des Dienstes. Eine Minute genügt: Der Client blendet abgelaufene
/// Nachrichten zur Sekunde aus.
const TAKT: Duration = Duration::from_secs(60);

/// Ein Durchgang: abgelaufene Nachrichten löschen und melden. Liefert, wie
/// viele es waren.
pub async fn durchgang(state: &AppState) -> AppResult<usize> {
    let mut tx = state.pool.begin().await?;
    let faellig: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select id, conversation_id from messages
          where expires_at is not null and expires_at <= now()
          order by expires_at
          limit $1
          for update skip locked",
    )
    .bind(STAPEL)
    .fetch_all(&mut *tx)
    .await?;
    if faellig.is_empty() {
        tx.rollback().await?;
        return Ok(0);
    }
    let ids: Vec<Uuid> = faellig.iter().map(|(id, _)| *id).collect();
    let angeheftet: HashSet<Uuid> = sqlx::query_scalar(
        "select distinct conversation_id from conversation_pins where message_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    sqlx::query("delete from messages where id = any($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut je_chat: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (id, chat) in &faellig {
        je_chat.entry(*chat).or_default().push(*id);
    }
    for (chat, nachrichten) in je_chat {
        let mitglieder = match crate::services::conversations::member_ids(&state.pool, chat).await {
            Ok(ids) => ids,
            Err(fehler) => {
                tracing::warn!(%fehler, "Selbstlöschen: Mitglieder nicht lesbar");
                continue;
            }
        };
        for id in nachrichten {
            state
                .hub
                .publish(mitglieder.clone(), Event::message_deleted(chat, id))
                .await;
        }
        if angeheftet.contains(&chat) {
            state
                .hub
                .publish(
                    mitglieder.clone(),
                    Event::new(
                        "conversation.angeheftet",
                        serde_json::json!({ "conversationId": chat }),
                    ),
                )
                .await;
        }
        // Die Vorschauzeile der Chatliste kann die gelöschte Nachricht sein.
        if let Err(fehler) =
            crate::services::conversations::broadcast_conversation(state, chat, Some(mitglieder))
                .await
        {
            tracing::warn!(%fehler, "Selbstlöschen: Chat nicht neu gemeldet");
        }
    }
    Ok(ids.len())
}

/// Startet den Dienst. Wie die anderen Dienste ohne Abbruchsignal: Ein
/// Durchgang ist wiederholbar, ein Abbruch mittendrin rollt zurück.
pub fn starten(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TAKT).await;
            let fuer = state.clone();
            match tokio::spawn(async move { durchgang(&fuer).await }).await {
                Ok(Ok(0)) => {}
                Ok(Ok(anzahl)) => tracing::info!(anzahl, "Selbstlöschende Nachrichten entfernt"),
                Ok(Err(fehler)) => tracing::warn!(%fehler, "Selbstlöschen: Durchgang gescheitert"),
                Err(fehler) => tracing::error!(%fehler, "Selbstlöschen: Durchgang abgebrochen"),
            }
        }
    })
}
