//! Fan-out between API instances.
//!
//! `postgres` uses LISTEN/NOTIFY so the API scales horizontally on Fly.io or
//! Koyeb without an extra Redis; `memory` is for single-instance setups and tests.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::postgres::PgListener;
use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use super::hub::Hub;
use super::Event;
use crate::config::RealtimeBus as BusKind;

const CHANNEL: &str = "initiative_realtime";
/// Postgres NOTIFY payloads are limited to 8000 bytes.
const MAX_NOTIFY_BYTES: usize = 7000;

#[derive(Debug, Clone)]
pub struct BusMessage {
    pub user_ids: Vec<Uuid>,
    pub event: Event,
}

#[derive(Serialize, Deserialize)]
struct WireMessage {
    user_ids: Vec<Uuid>,
    r#type: String,
    payload: Value,
}

pub struct RealtimeBus {
    kind: BusKind,
    pool: PgPool,
    hub: OnceCell<Arc<Hub>>,
    /// Ob der LISTEN-Kanal gerade wirklich steht. Ohne das meldet `/healthz`
    /// „bus: postgres“ auch dann, wenn überhaupt nichts zugestellt wird.
    listening: AtomicBool,
}

impl RealtimeBus {
    pub fn new(kind: BusKind, pool: PgPool) -> Self {
        Self {
            kind,
            pool,
            hub: OnceCell::new(),
            listening: AtomicBool::new(false),
        }
    }

    /// `true`, sobald der LISTEN-Kanal steht. Bei `memory` immer `true`, weil
    /// dort lokal zugestellt wird und es nichts zu verbinden gibt.
    pub fn listening(&self) -> bool {
        match self.kind {
            BusKind::Memory => true,
            BusKind::Postgres => self.listening.load(Ordering::Relaxed),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self.kind {
            BusKind::Memory => "memory",
            BusKind::Postgres => "postgres",
        }
    }

    /// Wires the hub in after construction (they reference each other).
    pub fn attach_hub(&self, hub: Arc<Hub>) {
        let _ = self.hub.set(hub);
    }

    pub async fn publish(&self, message: BusMessage) {
        match self.kind {
            BusKind::Memory => self.deliver(message),
            BusKind::Postgres => {
                let frame = message.event.to_frame();
                let wire = WireMessage {
                    user_ids: message.user_ids.clone(),
                    r#type: message.event.r#type.to_string(),
                    payload: message.event.payload.clone(),
                };
                let mut encoded = serde_json::to_string(&wire).unwrap_or_default();

                if encoded.len() > MAX_NOTIFY_BYTES {
                    // Too large for NOTIFY – ask clients to refetch instead of
                    // silently dropping the update.
                    let conversation_id = message
                        .event
                        .payload
                        .get("conversationId")
                        .and_then(|value| value.as_str())
                        .and_then(|value| Uuid::parse_str(value).ok());
                    let hint = Event::sync_hint(message.event.r#type, conversation_id);
                    encoded = serde_json::to_string(&WireMessage {
                        user_ids: message.user_ids.clone(),
                        r#type: hint.r#type.to_string(),
                        payload: hint.payload.clone(),
                    })
                    .unwrap_or_default();
                    // Local sockets can still receive the full payload.
                    if let Some(hub) = self.hub.get() {
                        hub.deliver_local(&message.user_ids, &frame);
                    }
                    self.notify(&encoded).await;
                    return;
                }

                self.notify(&encoded).await;
            }
        }
    }

    async fn notify(&self, payload: &str) {
        if let Err(error) = sqlx::query("select pg_notify($1, $2)")
            .bind(CHANNEL)
            .bind(payload)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(%error, "realtime notify failed");
        }
    }

    fn deliver(&self, message: BusMessage) {
        if let Some(hub) = self.hub.get() {
            hub.deliver_local(&message.user_ids, &message.event.to_frame());
        }
    }

    /// Background task: receives NOTIFY payloads and delivers them locally.
    pub async fn listen(self: Arc<Self>, database_url: String) {
        if self.kind != BusKind::Postgres {
            return;
        }
        if is_pooled_url(&database_url) {
            tracing::error!(
                "REALTIME_BUS=postgres zeigt auf einen Verbindungs-Pooler. PgBouncer im \
                 Transaction-Mode unterstuetzt LISTEN/NOTIFY nicht, Nachrichten kaemen nie \
                 in Echtzeit an. Setze REALTIME_DATABASE_URL auf die direkte \
                 (nicht gepoolte) Verbindung."
            );
        }
        loop {
            match PgListener::connect(&database_url).await {
                Ok(mut listener) => {
                    if let Err(error) = listener.listen(CHANNEL).await {
                        tracing::warn!(%error, "realtime listen failed, retrying");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                    self.listening.store(true, Ordering::Relaxed);
                    tracing::info!("realtime bus listening on {CHANNEL}");
                    loop {
                        match listener.recv().await {
                            Ok(notification) => {
                                let Ok(wire) =
                                    serde_json::from_str::<WireMessage>(notification.payload())
                                else {
                                    continue;
                                };
                                if let Some(hub) = self.hub.get() {
                                    let envelope = serde_json::json!({
                                        "v": crate::constants::PROTOCOL_VERSION,
                                        "type": wire.r#type,
                                        "ts": chrono::Utc::now().to_rfc3339(),
                                        "payload": wire.payload,
                                    });
                                    hub.deliver_local(&wire.user_ids, &envelope.to_string());
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "realtime listener dropped, reconnecting");
                                break;
                            }
                        }
                    }
                    self.listening.store(false, Ordering::Relaxed);
                }
                Err(error) => {
                    tracing::warn!(%error, "realtime listener connect failed, retrying");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
}

/// Erkennt die Pooler-Endpunkte der verbreiteten Anbieter.
///
/// Neon haengt `-pooler` an den Host, Supabase nutzt `pgbouncer=true` bzw. den
/// Port 6543. Alle drei sprechen PgBouncer im Transaction-Mode, der
/// LISTEN/NOTIFY nicht unterstuetzt.
fn is_pooled_url(url: &str) -> bool {
    url.contains("-pooler.")
        || url.contains("pgbouncer=true")
        || url.contains(":6543/")
        || url.ends_with(":6543")
}

/// Leitet aus einer gepoolten Verbindung die direkte ab, damit LISTEN/NOTIFY
/// funktioniert. Greift nur bei Neon (`-pooler` im Hostnamen); alles andere
/// bleibt unveraendert und muss ueber `REALTIME_DATABASE_URL` gesetzt werden.
pub fn direct_url(database_url: &str) -> String {
    if database_url.contains("-pooler.") {
        database_url.replace("-pooler.", ".")
    } else {
        database_url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{direct_url, is_pooled_url};

    #[test]
    fn recognises_pooled_endpoints() {
        assert!(is_pooled_url(
            "postgres://u:p@ep-x-123-pooler.eu-central-1.aws.neon.tech/db?sslmode=require"
        ));
        assert!(is_pooled_url("postgres://u:p@db.supabase.co:6543/postgres"));
        assert!(is_pooled_url(
            "postgres://u:p@db.example.com/postgres?pgbouncer=true"
        ));
        assert!(!is_pooled_url(
            "postgres://u:p@ep-x-123.eu-central-1.aws.neon.tech/db?sslmode=require"
        ));
        assert!(!is_pooled_url("postgres://u:p@127.0.0.1:5432/initiative"));
    }

    #[test]
    fn derives_the_direct_neon_endpoint() {
        assert_eq!(
            direct_url(
                "postgres://u:p@ep-x-123-pooler.eu-central-1.aws.neon.tech/db?sslmode=require"
            ),
            "postgres://u:p@ep-x-123.eu-central-1.aws.neon.tech/db?sslmode=require"
        );
        // Ohne Pooler bleibt alles, wie es ist.
        assert_eq!(
            direct_url("postgres://u:p@127.0.0.1:5432/initiative"),
            "postgres://u:p@127.0.0.1:5432/initiative"
        );
    }
}
