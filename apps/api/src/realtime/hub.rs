//! Tracks the websockets attached to *this* instance.
//!
//! Cross-instance delivery is handled by [`crate::realtime::bus`]: anything
//! published there is fanned out locally here.

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

use super::bus::{BusMessage, RealtimeBus};
use super::Event;

#[derive(Debug, Clone)]
struct Connection {
    id: Uuid,
    sender: UnboundedSender<String>,
}

pub struct Hub {
    connections: DashMap<Uuid, Vec<Connection>>,
    bus: Arc<RealtimeBus>,
}

/// Whether a user just came online or went offline, so the caller can broadcast
/// presence without the hub needing database access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceChange {
    CameOnline,
    WentOffline,
    Unchanged,
}

impl Hub {
    pub fn new(bus: Arc<RealtimeBus>) -> Self {
        Self {
            connections: DashMap::new(),
            bus,
        }
    }

    pub fn register(&self, user_id: Uuid) -> (Uuid, UnboundedReceiver<String>, PresenceChange) {
        let (sender, receiver) = unbounded_channel();
        let id = Uuid::now_v7();
        let mut entry = self.connections.entry(user_id).or_default();
        let change = if entry.is_empty() {
            PresenceChange::CameOnline
        } else {
            PresenceChange::Unchanged
        };
        entry.push(Connection { id, sender });
        (id, receiver, change)
    }

    pub fn unregister(&self, user_id: Uuid, connection_id: Uuid) -> PresenceChange {
        if let Some(mut entry) = self.connections.get_mut(&user_id) {
            entry.retain(|connection| connection.id != connection_id);
        }
        // Entfernt wird nur, was im Augenblick des Entfernens leer ist – unter
        // derselben Sperre geprüft. Hier stand „leer gesehen, Sperre los,
        // dann `remove`“: Meldete sich dazwischen ein neues Gerät desselben
        // Menschen an (Seite neu geladen, zweiter Tab), landete sein Socket in
        // der Liste und wurde mit ihr weggeworfen. Er blieb offen, bekam aber
        // nie wieder ein Ereignis, und die Person galt als abwesend.
        if self
            .connections
            .remove_if(&user_id, |_, entry| entry.is_empty())
            .is_some()
        {
            PresenceChange::WentOffline
        } else {
            PresenceChange::Unchanged
        }
    }

    pub fn is_online(&self, user_id: &Uuid) -> bool {
        self.connections
            .get(user_id)
            .is_some_and(|entry| !entry.is_empty())
    }

    pub fn connection_count(&self) -> usize {
        self.connections
            .iter()
            .map(|entry| entry.value().len())
            .sum()
    }

    /// Send to the given users on every instance.
    pub async fn publish(&self, user_ids: Vec<Uuid>, event: Event) {
        let mut unique = user_ids;
        unique.sort();
        unique.dedup();
        if unique.is_empty() {
            return;
        }
        self.bus
            .publish(BusMessage {
                user_ids: unique,
                event,
            })
            .await;
    }

    /// Send only to sockets attached to this instance.
    pub fn deliver_local(&self, user_ids: &[Uuid], frame: &str) {
        for user_id in user_ids {
            if let Some(entry) = self.connections.get(user_id) {
                for connection in entry.value() {
                    // A closed receiver simply drops the frame; cleanup happens
                    // when the socket task ends.
                    let _ = connection.sender.send(frame.to_string());
                }
            }
        }
    }

    /// Direct send to one freshly opened socket (hello frames).
    pub fn send_to(&self, user_id: Uuid, connection_id: Uuid, event: &Event) {
        if let Some(entry) = self.connections.get(&user_id) {
            for connection in entry.value() {
                if connection.id == connection_id {
                    let _ = connection.sender.send(event.to_frame());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::config::RealtimeBus as BusKind;

    fn hub() -> Arc<Hub> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://niemand@127.0.0.1:1/keine")
            .expect("träger Vorrat");
        Arc::new(Hub::new(Arc::new(RealtimeBus::new(BusKind::Memory, pool))))
    }

    /// Ein Gerät geht, ein anderes desselben Menschen kommt im selben Moment.
    ///
    /// Vorher sah `unregister` die Liste leer, liess die Sperre los und
    /// entfernte sie dann – samt dem Socket, der sich dazwischen eingetragen
    /// hatte. Der Wettlauf ist eng; viele Runden machen ihn sichtbar (mit der
    /// alten Fassung schlug dieser Test zuverlässig fehl).
    #[tokio::test(flavor = "multi_thread")]
    async fn ein_neues_geraet_ueberlebt_das_gleichzeitige_abmelden_des_alten() {
        let hub = hub();
        let person = Uuid::now_v7();
        for runde in 0..5_000 {
            let (alt, _empfang_alt, _) = hub.register(person);
            let schranke = Arc::new(Barrier::new(2));
            let abmelden = {
                let hub = hub.clone();
                let schranke = schranke.clone();
                std::thread::spawn(move || {
                    schranke.wait();
                    hub.unregister(person, alt);
                })
            };
            let anmelden = {
                let hub = hub.clone();
                let schranke = schranke.clone();
                std::thread::spawn(move || {
                    schranke.wait();
                    hub.register(person)
                })
            };
            abmelden.join().expect("abmelden");
            let (neu, _empfang_neu, _) = anmelden.join().expect("anmelden");
            assert!(
                hub.is_online(&person),
                "Runde {runde}: das neue Gerät wurde mit dem alten entfernt"
            );
            assert_eq!(hub.unregister(person, neu), PresenceChange::WentOffline);
        }
    }

    #[tokio::test]
    async fn abwesend_erst_wenn_das_letzte_geraet_geht() {
        let hub = hub();
        let person = Uuid::now_v7();
        let (a, _ra, erst) = hub.register(person);
        let (b, _rb, zweit) = hub.register(person);
        assert_eq!(erst, PresenceChange::CameOnline);
        assert_eq!(zweit, PresenceChange::Unchanged);
        assert_eq!(hub.unregister(person, a), PresenceChange::Unchanged);
        assert_eq!(hub.unregister(person, b), PresenceChange::WentOffline);
        assert!(!hub.is_online(&person));
        // Ein zweites Abmelden derselben Verbindung meldet nichts mehr.
        assert_eq!(hub.unregister(person, b), PresenceChange::Unchanged);
    }
}
