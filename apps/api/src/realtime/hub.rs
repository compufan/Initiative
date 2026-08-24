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
        let mut change = PresenceChange::Unchanged;
        if let Some(mut entry) = self.connections.get_mut(&user_id) {
            entry.retain(|connection| connection.id != connection_id);
            if entry.is_empty() {
                change = PresenceChange::WentOffline;
            }
        }
        if change == PresenceChange::WentOffline {
            self.connections.remove(&user_id);
        }
        change
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
