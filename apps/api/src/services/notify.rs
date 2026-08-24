//! Push notifications for chat activity.

use uuid::Uuid;

use crate::constants::{message_preview, truncate};
use crate::dto::{MessageDto, PushPayload};
use crate::state::AppState;

#[derive(sqlx::FromRow)]
struct NotificationTarget {
    id: Uuid,
    settings: serde_json::Value,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Push notification for a freshly created message.
pub async fn notify_new_message(state: &AppState, message: &MessageDto, member_ids: &[Uuid]) {
    if !state.push.enabled() {
        return;
    }
    let recipients: Vec<Uuid> = member_ids
        .iter()
        .copied()
        .filter(|id| Some(*id) != message.sender_id)
        .collect();
    if recipients.is_empty() {
        return;
    }

    let targets = match sqlx::query_as::<_, NotificationTarget>(
        "select u.id, u.settings, cm.muted_until
         from users u
         join conversation_members cm on cm.user_id = u.id and cm.conversation_id = $1
         where u.id = any($2)",
    )
    .bind(message.conversation_id)
    .bind(&recipients)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "loading notification targets failed");
            return;
        }
    };

    let now = chrono::Utc::now();
    let mut with_preview: Vec<Uuid> = Vec::new();
    let mut without_preview: Vec<Uuid> = Vec::new();

    for target in targets {
        if target.muted_until.is_some_and(|until| until > now) {
            continue;
        }
        let settings = super::users::merge_settings(&target.settings);
        let notifications = settings.get("notifications");
        let push_enabled = notifications
            .and_then(|value| value.get("push"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if !push_enabled {
            continue;
        }
        let previews = notifications
            .and_then(|value| value.get("previews"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if previews {
            with_preview.push(target.id);
        } else {
            without_preview.push(target.id);
        }
    }

    if with_preview.is_empty() && without_preview.is_empty() {
        return;
    }

    let sender_name = match message.sender_id {
        Some(sender_id) => sqlx::query_as::<_, (String,)>(
            "select display_name from users where id = $1",
        )
        .bind(sender_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .map(|(name,)| name)
        .unwrap_or_else(|| "Initiative".to_string()),
        None => "Initiative".to_string(),
    };

    let conversation = sqlx::query_as::<_, (Option<String>, String)>(
        "select title, type from conversations where id = $1",
    )
    .bind(message.conversation_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let title = match conversation {
        Some((Some(chat_title), kind)) if kind == "group" => format!("{sender_name} · {chat_title}"),
        _ => sender_name,
    };

    let preview = truncate(
        &message_preview(
            &message.r#type,
            message.body.as_deref(),
            message.deleted_at.is_some(),
        ),
        140,
    );

    if !with_preview.is_empty() {
        let payload = PushPayload {
            title: title.clone(),
            body: preview,
            tag: Some(format!("conversation:{}", message.conversation_id)),
            url: format!("/chats/{}", message.conversation_id),
            conversation_id: Some(message.conversation_id),
            message_id: Some(message.id),
            kind: "message".to_string(),
        };
        state.push.send_to_users(&state.pool, &with_preview, &payload).await;
    }

    if !without_preview.is_empty() {
        let payload = PushPayload {
            title: "Initiative".to_string(),
            body: "Neue Nachricht".to_string(),
            tag: Some(format!("conversation:{}", message.conversation_id)),
            url: format!("/chats/{}", message.conversation_id),
            conversation_id: Some(message.conversation_id),
            message_id: None,
            kind: "message".to_string(),
        };
        state.push.send_to_users(&state.pool, &without_preview, &payload).await;
    }
}

/// Generic helper for modules (your turn, poll closed, event reminder …).
pub async fn notify_users(state: &AppState, user_ids: &[Uuid], payload: &PushPayload) {
    if !state.push.enabled() || user_ids.is_empty() {
        return;
    }
    state.push.send_to_users(&state.pool, user_ids, payload).await;
}
