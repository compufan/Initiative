//! Tracks the websockets attached to *this* instance.
//!
//! Cross-instance delivery is handled by [`crate::realtime::bus`]: anything
//! published there is fanned out locally here.

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::mpsc::{self, error::TrySendError, Receiver, Sender};
use tokio::sync::Notify;
use uuid::Uuid;

use super::bus::{BusMessage, RealtimeBus};
use super::Event;

/**
 * Wie viele Frames je Verbindung auf dem Weg zum Socket warten dürfen.
 *
 * Vorher war der Kanal unbegrenzt. Ein Gerät, das nicht mehr liest (Funkloch
 * mit halboffener Leitung, eingefrorener Tab), sammelte so jedes Ereignis
 * aller seiner Chats im Speicher des Servers – bis der Herzschlag es nach
 * Minuten bemerkte, oder nie, wenn die Leitung formal offen blieb.
 *
 * Läuft der Puffer voll, wird die Verbindung geschlossen statt still Frames
 * zu verwerfen: Ein Client mit Lücke wüsste nichts davon. Beim Wiederverbinden
 * holt er nach (Chatliste, geladene Chats, Termine) – derselbe Weg wie nach
 * jedem Funkloch.
 */
pub const AUSGANG_PUFFER: usize = 512;

#[derive(Debug, Clone)]
struct Connection {
    id: Uuid,
    sender: Sender<String>,
    schliessen: Arc<Notify>,
}

impl Connection {
    fn senden(&self, frame: &str) {
        match self.sender.try_send(frame.to_string()) {
            Ok(()) => {}
            // Liest nicht mehr mit: zumachen, siehe `AUSGANG_PUFFER`.
            Err(TrySendError::Full(_)) => self.schliessen.notify_one(),
            // Schon zu; aufgeräumt wird, wenn die Socket-Aufgabe endet.
            Err(TrySendError::Closed(_)) => {}
        }
    }
}

/// Was die Socket-Aufgabe zu einer Verbindung bekommt: die Frames, und das
/// Zeichen, sie zu schliessen, weil der Puffer übergelaufen ist.
pub struct Ausgang {
    pub empfang: Receiver<String>,
    pub schliessen: Arc<Notify>,
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

    pub fn register(&self, user_id: Uuid) -> (Uuid, Ausgang, PresenceChange) {
        let (sender, empfang) = mpsc::channel(AUSGANG_PUFFER);
        let schliessen = Arc::new(Notify::new());
        let id = Uuid::now_v7();
        let mut entry = self.connections.entry(user_id).or_default();
        let change = if entry.is_empty() {
            PresenceChange::CameOnline
        } else {
            PresenceChange::Unchanged
        };
        entry.push(Connection {
            id,
            sender,
            schliessen: schliessen.clone(),
        });
        (
            id,
            Ausgang {
                empfang,
                schliessen,
            },
            change,
        )
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
                    connection.senden(frame);
                }
            }
        }
    }

    /// An jede Verbindung dieser Instanz – etwa der Hinweis, nachzuholen,
    /// nachdem der Bus eine Weile taub war (`RealtimeBus::wieder_verbunden`).
    pub fn an_alle_lokal(&self, frame: &str) {
        for entry in self.connections.iter() {
            for connection in entry.value() {
                connection.senden(frame);
            }
        }
    }

    /// Direct send to one freshly opened socket (hello frames).
    pub fn send_to(&self, user_id: Uuid, connection_id: Uuid, event: &Event) {
        if let Some(entry) = self.connections.get(&user_id) {
            for connection in entry.value() {
                if connection.id == connection_id {
                    connection.senden(&event.to_frame());
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

    /// Wer nicht mehr liest, sammelte vorher unbegrenzt Frames im Speicher.
    #[tokio::test]
    async fn ein_voller_puffer_schliesst_die_verbindung() {
        let hub = hub();
        let person = Uuid::now_v7();
        let (_, ausgang, _) = hub.register(person);
        for _ in 0..AUSGANG_PUFFER {
            hub.deliver_local(&[person], "x");
        }
        // Bis hierher passt alles hinein – kein Zeichen zum Schliessen.
        let noch_nicht = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            ausgang.schliessen.notified(),
        )
        .await;
        assert!(noch_nicht.is_err(), "der Puffer war noch nicht voll");

        hub.deliver_local(&[person], "einer zu viel");
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            ausgang.schliessen.notified(),
        )
        .await
        .expect("die Verbindung soll geschlossen werden");
        assert_eq!(ausgang.empfang.len(), AUSGANG_PUFFER);
    }

    #[tokio::test]
    async fn an_alle_lokal_erreicht_jedes_geraet() {
        let hub = hub();
        let (_, mut a, _) = hub.register(Uuid::now_v7());
        let (_, mut b, _) = hub.register(Uuid::now_v7());
        let (_, mut b2, _) = hub.register(Uuid::now_v7());
        hub.an_alle_lokal("hinweis");
        for ausgang in [&mut a, &mut b, &mut b2] {
            assert_eq!(ausgang.empfang.try_recv().as_deref(), Ok("hinweis"));
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
