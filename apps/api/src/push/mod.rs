//! Web Push delivery.
//!
//! Works on Android/Chrome/Firefox out of the box and on iOS 16.4+ once the PWA
//! has been added to the home screen.

pub mod ece;
pub mod vapid;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::db::PushSubscriptionRow;
use crate::dto::PushPayload;

/// Was ein Mitschnitt festhält: an wen welche Mitteilung gegangen wäre.
pub type Mitschnitt = Arc<Mutex<Vec<(Uuid, PushPayload)>>>;

pub struct PushService {
    config: std::sync::Arc<Config>,
    http: reqwest::Client,
    /// Nur für Tests: Ist er gesetzt, wird nicht gesendet, sondern
    /// mitgeschrieben.
    ///
    /// Im Entwicklungsbetrieb fehlen die VAPID-Schlüssel, `enabled()` ist also
    /// falsch, und niemand sähe, WER eine Mitteilung bekäme. Die Naht erlaubt,
    /// die Zielbestimmung (eine Mitteilung je Person, Stummschaltung) am
    /// Ausgang zu prüfen statt am Bildschirm eines Geräts.
    mitschnitt: OnceLock<Mitschnitt>,
}

impl PushService {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            mitschnitt: OnceLock::new(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.mitschnitt.get().is_some() || self.config.push_enabled()
    }

    /// Schaltet den Mitschnitt ein (nur für Tests) und liefert die Liste,
    /// in die geschrieben wird. Ab jetzt sendet dieser Dienst nichts mehr.
    pub fn mitschneiden(&self) -> Mitschnitt {
        self.mitschnitt
            .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
            .clone()
    }

    pub fn public_key(&self) -> Option<&str> {
        self.config
            .vapid
            .as_ref()
            .map(|vapid| vapid.public_key.as_str())
    }

    /// Sendet mehrere Mitteilungen, ohne die Anfrage warten zu lassen.
    ///
    /// Jede Person kann eine eigene Nutzlast haben (der Chat, in dem sie
    /// angesprochen wird, unterscheidet sich). Bei einem Mitschnitt wird sofort
    /// geschrieben: Es gibt nichts zu warten, und ein Test soll danach lesen
    /// können, ohne zu raten, wann der Hintergrund fertig ist.
    pub fn im_hintergrund(self: &Arc<Self>, pool: PgPool, ziele: Vec<(Vec<Uuid>, PushPayload)>) {
        if let Some(mitschnitt) = self.mitschnitt.get() {
            if let Ok(mut liste) = mitschnitt.lock() {
                for (personen, payload) in &ziele {
                    liste.extend(personen.iter().map(|id| (*id, payload.clone())));
                }
            }
            return;
        }
        let dienst = self.clone();
        tokio::spawn(async move {
            for (personen, payload) in ziele {
                dienst.send_to_users(&pool, &personen, &payload).await;
            }
        });
    }

    /// Sends to every device of the given users. Dead subscriptions (404/410)
    /// are removed so the table does not grow stale.
    pub async fn send_to_users(
        &self,
        pool: &PgPool,
        user_ids: &[Uuid],
        payload: &PushPayload,
    ) -> usize {
        if let Some(mitschnitt) = self.mitschnitt.get() {
            if let Ok(mut liste) = mitschnitt.lock() {
                liste.extend(user_ids.iter().map(|id| (*id, payload.clone())));
            }
            return user_ids.len();
        }
        let Some(vapid) = self.config.vapid.as_ref() else {
            return 0;
        };
        if user_ids.is_empty() {
            return 0;
        }

        let subscriptions = match sqlx::query_as::<_, PushSubscriptionRow>(
            "select id, user_id, endpoint, p256dh, auth from push_subscriptions where user_id = any($1)",
        )
        .bind(user_ids)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(%error, "loading push subscriptions failed");
                return 0;
            }
        };
        if subscriptions.is_empty() {
            return 0;
        }

        let body = match serde_json::to_vec(payload) {
            Ok(body) => body,
            Err(error) => {
                tracing::warn!(%error, "push payload not serialisable");
                return 0;
            }
        };

        let mut delivered = 0usize;
        let mut dead: Vec<Uuid> = Vec::new();

        for subscription in subscriptions {
            match self.send_one(vapid, &subscription, &body).await {
                Ok(true) => delivered += 1,
                Ok(false) => dead.push(subscription.id),
                Err(error) => tracing::debug!(%error, "push delivery failed"),
            }
        }

        if !dead.is_empty() {
            let _ = sqlx::query("delete from push_subscriptions where id = any($1)")
                .bind(&dead)
                .execute(pool)
                .await;
        }
        delivered
    }

    /// `Ok(false)` means the subscription is gone and should be deleted.
    async fn send_one(
        &self,
        vapid: &crate::config::VapidConfig,
        subscription: &PushSubscriptionRow,
        payload: &[u8],
    ) -> Result<bool, String> {
        let encrypted = ece::encrypt(&subscription.p256dh, &subscription.auth, payload)
            .map_err(|error| error.to_string())?;
        let authorization = vapid::authorization_header(
            &subscription.endpoint,
            &vapid.subject,
            &vapid.public_key,
            &vapid.private_key,
        )
        .map_err(|error| error.to_string())?;

        let response = self
            .http
            .post(&subscription.endpoint)
            .header("authorization", authorization)
            .header("content-encoding", "aes128gcm")
            .header("content-type", "application/octet-stream")
            .header("ttl", "43200")
            .header("urgency", "high")
            .body(encrypted)
            .send()
            .await
            .map_err(|error| error.to_string())?;

        let status = response.status().as_u16();
        match status {
            200..=299 => Ok(true),
            404 | 410 => Ok(false),
            _ => Err(format!("push service antwortete mit {status}")),
        }
    }
}
