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
/// Wie viele Empfänger in einem NOTIFY stehen.
///
/// Die Empfängerliste steht im selben Text wie die Nutzlast: 39 Byte je Kennung
/// (36 Zeichen, Anführungszeichen, Komma). Bei 180 Personen sprengte sie die
/// 7000 Byte allein – ein Termin mit vielen Eingeladenen hätte nie einen
/// Rundruf bekommen, nicht einmal den gekürzten. Hundert je Stück bleiben bei
/// 3,9 KB und lassen der Nutzlast den Rest.
const EMPFAENGER_JE_STUECK: usize = 100;

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
                for stueck in stuecke(&message.user_ids, &message.event) {
                    if stueck.gekuerzt {
                        // Local sockets can still receive the full payload.
                        if let Some(hub) = self.hub.get() {
                            hub.deliver_local(&stueck.user_ids, &frame);
                        }
                    }
                    self.notify(&stueck.encoded).await;
                }
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

/// Ein NOTIFY: die Empfänger und der Text, der wirklich gesendet wird.
#[derive(Debug)]
pub(super) struct Stueck {
    pub user_ids: Vec<Uuid>,
    pub encoded: String,
    /// `true`, wenn die Nutzlast nicht hineinpasste und nur ein Hinweis geht.
    pub gekuerzt: bool,
}

/// Teilt eine Zustellung in Stücke, die je in ein NOTIFY passen.
///
/// Passt die Nutzlast auch mit hundert Empfängern nicht hinein, geht statt
/// ihrer ein Hinweis: lieber „lade nach“ als ein stilles Verschlucken.
/// Bei Terminen trägt der Hinweis die Kennung, denn sie steht in der Nutzlast
/// nicht auf oberster Ebene – ohne sie wüsste der Client nicht, was er holen soll.
pub(super) fn stuecke(user_ids: &[Uuid], event: &Event) -> Vec<Stueck> {
    // Bei Nachrichten steht der Chat nicht auf oberster Ebene, sondern in der
    // Nachricht. Eine Termin-Karte trägt den ganzen Termin samt Teilnehmerliste
    // und ist bei vielen Eingeladenen allein schon grösser als das NOTIFY:
    // Ohne die Kennung des Chats wüsste der Client nach dem Hinweis nicht, wo
    // er nachladen soll.
    let conversation_id = kennung_in(&event.payload, &["conversationId"])
        .or_else(|| kennung_in(&event.payload, &["message", "conversationId"]));
    let event_id = kennung_in(&event.payload, &["eventId"])
        .or_else(|| kennung_in(&event.payload, &["event", "id"]));
    let stand = event
        .payload
        .get("event")
        .and_then(|termin| termin.get("stand"))
        .and_then(Value::as_i64);

    user_ids
        .chunks(EMPFAENGER_JE_STUECK)
        .map(|teil| {
            let voll = serde_json::to_string(&WireMessage {
                user_ids: teil.to_vec(),
                r#type: event.r#type.to_string(),
                payload: event.payload.clone(),
            })
            .unwrap_or_default();
            if voll.len() <= MAX_NOTIFY_BYTES {
                return Stueck {
                    user_ids: teil.to_vec(),
                    encoded: voll,
                    gekuerzt: false,
                };
            }
            // Too large for NOTIFY – ask clients to refetch instead of
            // silently dropping the update.
            let hint = Event::sync_hint_fuer(event.r#type, conversation_id, event_id, stand);
            Stueck {
                user_ids: teil.to_vec(),
                encoded: serde_json::to_string(&WireMessage {
                    user_ids: teil.to_vec(),
                    r#type: hint.r#type.to_string(),
                    payload: hint.payload,
                })
                .unwrap_or_default(),
                gekuerzt: true,
            }
        })
        .collect()
}

/// Die Kennung unter einem Pfad in der Nutzlast, falls es eine ist.
fn kennung_in(payload: &Value, pfad: &[&str]) -> Option<Uuid> {
    let mut stelle = payload;
    for schluessel in pfad {
        stelle = stelle.get(*schluessel)?;
    }
    stelle.as_str().and_then(|text| Uuid::parse_str(text).ok())
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
    use super::{direct_url, is_pooled_url, stuecke, MAX_NOTIFY_BYTES};
    use crate::realtime::Event;
    use serde_json::json;
    use uuid::Uuid;

    fn empfaenger(anzahl: usize) -> Vec<Uuid> {
        (0..anzahl).map(|_| Uuid::now_v7()).collect()
    }

    #[test]
    fn viele_empfaenger_werden_in_stuecke_geteilt_die_hineinpassen() {
        let event = Event::new(
            "event.updated",
            json!({ "event": { "text": "x".repeat(2000) } }),
        );
        let stuecke = stuecke(&empfaenger(250), &event);

        // Hundert, hundert, fünfzig – jedes für sich unter der Grenze.
        let groessen: Vec<usize> = stuecke.iter().map(|stueck| stueck.user_ids.len()).collect();
        assert_eq!(groessen, vec![100, 100, 50]);
        for stueck in &stuecke {
            assert!(!stueck.gekuerzt);
            assert!(
                stueck.encoded.len() < MAX_NOTIFY_BYTES,
                "{} Byte",
                stueck.encoded.len()
            );
        }
    }

    #[test]
    fn ohne_teilung_sprengte_die_empfaengerliste_die_grenze() {
        // Der Beleg für die Teilung: 250 Kennungen allein sind über 9 KB.
        let ids = empfaenger(250);
        let roh = serde_json::to_string(&ids).unwrap();
        assert!(roh.len() > MAX_NOTIFY_BYTES, "{} Byte", roh.len());
    }

    #[test]
    fn ein_zu_grosser_termin_wird_zum_hinweis_mit_kennung() {
        let termin = Uuid::now_v7();
        let event = Event::new(
            "event.updated",
            json!({ "event": { "id": termin, "stand": 7, "text": "x".repeat(9000) } }),
        );
        let stuecke = stuecke(&empfaenger(3), &event);
        assert_eq!(stuecke.len(), 1);
        assert!(stuecke[0].gekuerzt);
        assert!(stuecke[0].encoded.len() < MAX_NOTIFY_BYTES);
        let wire: serde_json::Value = serde_json::from_str(&stuecke[0].encoded).unwrap();
        assert_eq!(wire["type"], "sync.hint");
        assert_eq!(wire["payload"]["scope"], "event.updated");
        assert_eq!(wire["payload"]["eventId"], termin.to_string());
        // Der Stand der gekürzten Fassung geht mit: Wer sie schon hat, lädt
        // nichts nach.
        assert_eq!(wire["payload"]["stand"], 7);
    }

    #[test]
    fn der_hinweis_zu_einem_geloeschten_termin_traegt_die_kennung() {
        let termin = Uuid::now_v7();
        let mut event = Event::event_deleted_grund(termin, None, "geloescht");
        // Künstlich gross, damit gekürzt wird – in der Wirklichkeit ist dieses
        // Ereignis klein, der Weg soll aber für beide Termin-Ereignisse gelten.
        event.payload["fuellung"] = json!("x".repeat(9000));
        let stuecke = stuecke(&empfaenger(2), &event);
        assert!(stuecke[0].gekuerzt);
        let wire: serde_json::Value = serde_json::from_str(&stuecke[0].encoded).unwrap();
        assert_eq!(wire["payload"]["eventId"], termin.to_string());
    }

    #[test]
    fn der_hinweis_zu_einer_grossen_nachricht_kennt_den_chat() {
        let chat = Uuid::now_v7();
        let event = Event::new(
            "message.new",
            json!({ "message": { "conversationId": chat, "text": "x".repeat(9000) } }),
        );
        let stuecke = stuecke(&empfaenger(1), &event);
        assert!(stuecke[0].gekuerzt);
        let wire: serde_json::Value = serde_json::from_str(&stuecke[0].encoded).unwrap();
        assert_eq!(wire["payload"]["conversationId"], chat.to_string());
    }

    #[test]
    fn ein_ereignis_ohne_termin_traegt_keine_kennung_im_hinweis() {
        let chat = Uuid::now_v7();
        let event = Event::new(
            "message.new",
            json!({ "conversationId": chat, "text": "x".repeat(9000) }),
        );
        let stuecke = stuecke(&empfaenger(1), &event);
        let wire: serde_json::Value = serde_json::from_str(&stuecke[0].encoded).unwrap();
        assert_eq!(wire["payload"]["conversationId"], chat.to_string());
        assert!(wire["payload"].get("eventId").is_none());
    }

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
