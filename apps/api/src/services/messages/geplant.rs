//! Geplante Nachrichten: der Dienst, der sie zum Zeitpunkt sendet.
//!
//! Gebaut nach dem Muster der Erinnerungsdienste (`services::erinnern`):
//!
//! * **Beanspruchen in einer Anweisung** (`for update skip locked`, Status
//!   `geplant` → `sendet`): Zwei Instanzen nehmen nie dieselbe Zeile.
//! * **Senden wie jede Nachricht**: [`nachricht_anlegen`] in einer Transaktion,
//!   in der auch der Status auf `gesendet` springt, [`ausliefern`] nach dem
//!   Commit. Was nie festgeschrieben wurde, wird nie gemeldet.
//! * **Genau einmal**: Der Wiederholungsschlüssel ist `geplant:<id>`. Bleibt
//!   eine beanspruchte Zeile liegen (Absturz zwischen Commit der Nachricht und
//!   … – den gibt es nicht, beides ist eine Transaktion; aber ein Absturz vor
//!   dem Commit), holt der nächste Durchgang sie nach [`HAENGT_NACH`] erneut,
//!   und schlimmstenfalls bekommt `nachricht_anlegen` die schon geschriebene
//!   Nachricht zurück statt einer zweiten. „Jetzt senden“ und der Dienst
//!   treffen sich an derselben Stelle.
//! * **Prüfungen zum Sendezeitpunkt**: noch Mitglied, darf noch schreiben
//!   (Sperren, „Nur Admins senden“, langsamer Modus – `senden_erlaubt`),
//!   Anhänge noch da und frei. Sonst `fehlgeschlagen` mit dem Grund; der
//!   Mensch sieht ihn in der Liste „Geplant“.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

use super::{ausliefern, nachricht_anlegen, NewMessage};

/// Wie viele fällige Nachrichten ein Durchgang höchstens sendet.
const STAPEL: i64 = 50;
/// Takt des Dienstes. Geplant wird auf die Minute; zwanzig Sekunden halten
/// die Verspätung unter einer halben Minute.
const TAKT: Duration = Duration::from_secs(20);
/// Eine beanspruchte Zeile, die so lange nicht fertig wurde, gilt als liegen
/// geblieben und wird neu beansprucht.
const HAENGT_NACH: &str = "5 minutes";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GeplantRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub typ: String,
    pub body: Option<String>,
    pub attachment_ids: Vec<Uuid>,
    pub reply_to_id: Option<Uuid>,
    pub metadata: Value,
    pub senden_um: DateTime<Utc>,
    pub zeitzone: String,
    pub status: String,
    pub fehler: Option<String>,
    pub beansprucht_at: Option<DateTime<Utc>>,
    pub message_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeplantDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub r#type: String,
    pub body: Option<String>,
    pub attachment_ids: Vec<Uuid>,
    pub reply_to_id: Option<Uuid>,
    pub metadata: Value,
    pub senden_um: DateTime<Utc>,
    pub zeitzone: String,
    pub status: String,
    pub fehler: Option<String>,
    pub message_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl From<GeplantRow> for GeplantDto {
    fn from(zeile: GeplantRow) -> Self {
        Self {
            id: zeile.id,
            conversation_id: zeile.conversation_id,
            r#type: zeile.typ,
            body: zeile.body,
            attachment_ids: zeile.attachment_ids,
            reply_to_id: zeile.reply_to_id,
            metadata: zeile.metadata,
            senden_um: zeile.senden_um,
            zeitzone: zeile.zeitzone,
            status: zeile.status,
            fehler: zeile.fehler,
            message_id: zeile.message_id,
            created_at: zeile.created_at,
        }
    }
}

/// Der Wiederholungsschlüssel der Nachricht zu einer geplanten Zeile. Mit
/// Doppelpunkt – den darf kein Client vergeben (`modules::messages`).
pub fn schluessel(id: Uuid) -> String {
    format!("geplant:{id}")
}

/// Den eigenen Geräten sagen, dass sich die Liste „Geplant“ geändert hat.
pub async fn melden(state: &AppState, person: Uuid, chat: Uuid) {
    state
        .hub
        .publish(
            vec![person],
            Event::new("geplant.updated", json!({ "conversationId": chat })),
        )
        .await;
}

/// Ergebnis eines Sendeversuchs.
#[derive(Debug, PartialEq, Eq)]
pub enum Ausgang {
    Gesendet(Uuid),
    Gescheitert(String),
}

async fn scheitern(state: &AppState, zeile: &GeplantRow, grund: &str) -> AppResult<Ausgang> {
    sqlx::query(
        "update scheduled_messages
            set status = 'fehlgeschlagen', fehler = $2, updated_at = now()
          where id = $1 and status = 'sendet'",
    )
    .bind(zeile.id)
    .bind(grund)
    .execute(&state.pool)
    .await?;
    melden(state, zeile.sender_id, zeile.conversation_id).await;
    Ok(Ausgang::Gescheitert(grund.to_string()))
}

/// Eine BEANSPRUCHTE Zeile (Status `sendet`) senden.
pub async fn senden(state: &AppState, zeile: &GeplantRow) -> AppResult<Ausgang> {
    let client_id = schluessel(zeile.id);
    if let Err(fehler) = crate::services::conversations::senden_erlaubt(
        &state.pool,
        zeile.conversation_id,
        zeile.sender_id,
        Some(&client_id),
    )
    .await
    {
        return scheitern(state, zeile, &fehler.to_string()).await;
    }

    let mut tx = state.pool.begin().await?;
    let angelegt = nachricht_anlegen(
        &mut tx,
        NewMessage {
            conversation_id: zeile.conversation_id,
            sender_id: Some(zeile.sender_id),
            r#type: zeile.typ.clone(),
            body: zeile.body.clone(),
            attachment_ids: zeile.attachment_ids.clone(),
            reply_to_id: zeile.reply_to_id,
            client_id: Some(client_id),
            metadata: zeile.metadata.clone(),
            silent: false,
        },
    )
    .await;
    let angelegt = match angelegt {
        Ok(angelegt) => angelegt,
        Err(AppError::Api { message, .. }) => {
            tx.rollback().await?;
            return scheitern(state, zeile, &message).await;
        }
        Err(fehler) => return Err(fehler),
    };
    let nachricht_id = angelegt.id();
    let fertig = sqlx::query(
        "update scheduled_messages
            set status = 'gesendet', message_id = $2, fehler = null, updated_at = now()
          where id = $1 and status = 'sendet'",
    )
    .bind(zeile.id)
    .bind(nachricht_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if fertig == 0 {
        // Inzwischen gelöscht oder von einem anderen Durchgang erledigt.
        tx.rollback().await?;
        return Ok(Ausgang::Gescheitert("nicht mehr beansprucht".into()));
    }
    tx.commit().await?;
    ausliefern(state, angelegt).await?;
    melden(state, zeile.sender_id, zeile.conversation_id).await;
    Ok(Ausgang::Gesendet(nachricht_id))
}

/// Eine Zeile sofort beanspruchen („Jetzt senden“). `None`, wenn sie nicht
/// (mehr) offen ist oder nicht dieser Person gehört.
pub async fn sofort_beanspruchen(
    state: &AppState,
    id: Uuid,
    person: Uuid,
) -> AppResult<Option<GeplantRow>> {
    Ok(sqlx::query_as::<_, GeplantRow>(
        "update scheduled_messages
            set status = 'sendet', beansprucht_at = now(), updated_at = now()
          where id = $1 and sender_id = $2 and status in ('geplant', 'fehlgeschlagen')
          returning *",
    )
    .bind(id)
    .bind(person)
    .fetch_optional(&state.pool)
    .await?)
}

/// Ein Durchgang: fällige Zeilen beanspruchen und senden. Liefert (gesendet,
/// gescheitert).
pub async fn durchgang(state: &AppState) -> AppResult<(usize, usize)> {
    let zeilen = sqlx::query_as::<_, GeplantRow>(&format!(
        "update scheduled_messages
            set status = 'sendet', beansprucht_at = now(), updated_at = now()
          where id in (
            select id from scheduled_messages
             where (status = 'geplant' and senden_um <= now())
                or (status = 'sendet' and beansprucht_at < now() - interval '{HAENGT_NACH}')
             order by senden_um
             limit $1
             for update skip locked)
          returning *"
    ))
    .bind(STAPEL)
    .fetch_all(&state.pool)
    .await?;
    let mut gesendet = 0;
    let mut gescheitert = 0;
    for zeile in &zeilen {
        match senden(state, zeile).await {
            Ok(Ausgang::Gesendet(_)) => gesendet += 1,
            Ok(Ausgang::Gescheitert(_)) => gescheitert += 1,
            Err(fehler) => {
                // Bleibt `sendet` und wird nach der Frist neu versucht.
                tracing::warn!(%fehler, geplant = %zeile.id, "Geplante Nachricht: Senden gescheitert");
                gescheitert += 1;
            }
        }
    }
    Ok((gesendet, gescheitert))
}

/// Startet den Dienst (nach den Migrationen, wie die anderen).
pub fn starten(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TAKT).await;
            let fuer = state.clone();
            match tokio::spawn(async move { durchgang(&fuer).await }).await {
                Ok(Ok((0, 0))) => {}
                Ok(Ok((gesendet, gescheitert))) => {
                    tracing::info!(gesendet, gescheitert, "Geplante Nachrichten")
                }
                Ok(Err(fehler)) => {
                    tracing::warn!(%fehler, "Geplante Nachrichten: Durchgang gescheitert")
                }
                Err(fehler) => {
                    tracing::error!(%fehler, "Geplante Nachrichten: Durchgang abgebrochen")
                }
            }
        }
    })
}
