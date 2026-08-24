//! Web Push delivery.
//!
//! Works on Android/Chrome/Firefox out of the box and on iOS 16.4+ once the PWA
//! has been added to the home screen.

pub mod ece;
pub mod vapid;

use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::db::PushSubscriptionRow;
use crate::dto::PushPayload;

pub struct PushService {
    config: std::sync::Arc<Config>,
    http: reqwest::Client,
}

impl PushService {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.push_enabled()
    }

    pub fn public_key(&self) -> Option<&str> {
        self.config.vapid.as_ref().map(|vapid| vapid.public_key.as_str())
    }

    /// Sends to every device of the given users. Dead subscriptions (404/410)
    /// are removed so the table does not grow stale.
    pub async fn send_to_users(&self, pool: &PgPool, user_ids: &[Uuid], payload: &PushPayload) -> usize {
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
