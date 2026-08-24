//! Termine, Zu-/Absagen und der ICS-Feed.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::db::{json_to_i32_vec, CalendarEventRow, EventAttendeeRow, MessageRow};
use crate::dto::{CalendarEventDto, EventAttendeeDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::recurrence::expand_occurrences;
use crate::state::AppState;

use super::expanders::{metadata_id, referenced_ids, Expansion, MessageExpander};

pub fn to_event_dto(row: &CalendarEventRow, attendees: &[EventAttendeeRow]) -> CalendarEventDto {
    CalendarEventDto {
        id: row.id,
        conversation_id: row.conversation_id,
        created_by: row.created_by,
        title: row.title.clone(),
        description: row.description.clone(),
        location: row.location.clone(),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        all_day: row.all_day,
        rrule: row.rrule.clone(),
        color: row.color.clone(),
        source_poll_id: row.source_poll_id,
        attendees: attendees
            .iter()
            .map(|attendee| EventAttendeeDto {
                user_id: attendee.user_id,
                status: attendee.status.clone(),
                responded_at: attendee.responded_at,
            })
            .collect(),
        reminder_minutes: json_to_i32_vec(&row.reminder_minutes),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub async fn require_event(state: &AppState, event_id: Uuid) -> AppResult<CalendarEventRow> {
    sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = $1 and deleted_at is null",
    )
    .bind(event_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))
}

pub async fn load_event_dtos(
    state: &AppState,
    event_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, CalendarEventDto>> {
    if event_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = any($1) and deleted_at is null",
    )
    .bind(event_ids)
    .fetch_all(&state.pool)
    .await?;
    let attendees = sqlx::query_as::<_, EventAttendeeRow>(
        "select * from event_attendees where event_id = any($1)",
    )
    .bind(event_ids)
    .fetch_all(&state.pool)
    .await?;

    let mut by_event: HashMap<Uuid, Vec<EventAttendeeRow>> = HashMap::new();
    for attendee in attendees {
        by_event.entry(attendee.event_id).or_default().push(attendee);
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let attendees = by_event.remove(&row.id).unwrap_or_default();
            (row.id, to_event_dto(&row, &attendees))
        })
        .collect())
}

pub async fn load_event_dto(state: &AppState, event_id: Uuid) -> AppResult<CalendarEventDto> {
    load_event_dtos(state, &[event_id])
        .await?
        .remove(&event_id)
        .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))
}

/// Every event a user can see in a window: their own, their chats' and the ones
/// they were invited to. Recurring events stay a single row and are returned
/// when *any* occurrence falls into the window.
pub async fn load_events_for_user(
    state: &AppState,
    user_id: Uuid,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    conversation_id: Option<Uuid>,
) -> AppResult<Vec<CalendarEventDto>> {
    let from = from.unwrap_or_else(|| Utc::now() - Duration::days(30));
    let to = to.unwrap_or_else(|| Utc::now() + Duration::days(180));

    let rows = sqlx::query_as::<_, CalendarEventRow>(
        "select distinct e.*
         from calendar_events e
         left join conversation_members cm
           on cm.conversation_id = e.conversation_id and cm.user_id = $1
         left join event_attendees ea on ea.event_id = e.id and ea.user_id = $1
         where e.deleted_at is null
           and (e.created_by = $1 or cm.user_id is not null or ea.user_id is not null)
           and ($4::uuid is null or e.conversation_id = $4)
           and (e.rrule is not null or (e.starts_at <= $3 and e.ends_at >= $2))
         order by e.starts_at asc
         limit 1000",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;

    let in_window: Vec<CalendarEventRow> = rows
        .into_iter()
        .filter(|row| {
            row.rrule.is_none()
                || !expand_occurrences(row.starts_at, row.ends_at, row.rrule.as_deref(), from, to)
                    .is_empty()
        })
        .collect();
    if in_window.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<Uuid> = in_window.iter().map(|row| row.id).collect();
    let attendees = sqlx::query_as::<_, EventAttendeeRow>(
        "select * from event_attendees where event_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;
    let mut by_event: HashMap<Uuid, Vec<EventAttendeeRow>> = HashMap::new();
    for attendee in attendees {
        by_event.entry(attendee.event_id).or_default().push(attendee);
    }

    Ok(in_window
        .into_iter()
        .map(|row| {
            let attendees = by_event.remove(&row.id).unwrap_or_default();
            to_event_dto(&row, &attendees)
        })
        .collect())
}

pub struct NewEvent {
    pub conversation_id: Option<Uuid>,
    pub created_by: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub color: Option<String>,
    pub reminder_minutes: Vec<i32>,
    pub source_poll_id: Option<Uuid>,
    pub attendee_ids: Vec<Uuid>,
    /// Pre-set RSVP answers, e.g. taken over from a date poll.
    pub attendee_statuses: HashMap<Uuid, String>,
    pub announce: Option<bool>,
}

/// Shared by the calendar module and by "Termin aus Umfrage erstellen".
pub async fn create_event(state: &AppState, input: NewEvent) -> AppResult<CalendarEventDto> {
    let event_id = Uuid::now_v7();

    let mut attendees: Vec<Uuid> = input.attendee_ids.clone();
    attendees.push(input.created_by);
    if let Some(conversation_id) = input.conversation_id {
        attendees.extend(super::conversations::member_ids(&state.pool, conversation_id).await?);
    }
    attendees.sort();
    attendees.dedup();

    sqlx::query(
        "insert into calendar_events
           (id, conversation_id, created_by, title, description, location, starts_at, ends_at,
            all_day, rrule, color, reminder_minutes, source_poll_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    )
    .bind(event_id)
    .bind(input.conversation_id)
    .bind(input.created_by)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.location)
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(input.all_day)
    .bind(&input.rrule)
    .bind(&input.color)
    .bind(serde_json::json!(input.reminder_minutes))
    .bind(input.source_poll_id)
    .execute(&state.pool)
    .await?;

    for user_id in &attendees {
        let status = if *user_id == input.created_by {
            "yes".to_string()
        } else {
            input
                .attendee_statuses
                .get(user_id)
                .cloned()
                .unwrap_or_else(|| "pending".to_string())
        };
        let responded_at = if status == "pending" { None } else { Some(Utc::now()) };
        sqlx::query(
            "insert into event_attendees (event_id, user_id, status, responded_at)
             values ($1, $2, $3, $4)
             on conflict (event_id, user_id) do update
             set status = excluded.status, responded_at = excluded.responded_at",
        )
        .bind(event_id)
        .bind(user_id)
        .bind(&status)
        .bind(responded_at)
        .execute(&state.pool)
        .await?;
    }

    let announce = input.announce.unwrap_or(input.conversation_id.is_some());
    if let (true, Some(conversation_id)) = (announce, input.conversation_id) {
        let message = super::messages::create_message(
            state,
            super::messages::NewMessage::entity(
                conversation_id,
                input.created_by,
                "event",
                "eventId",
                event_id,
            ),
        )
        .await?;
        sqlx::query("update calendar_events set message_id = $1 where id = $2")
            .bind(message.id)
            .bind(event_id)
            .execute(&state.pool)
            .await?;
    }

    let dto = load_event_dto(state, event_id).await?;
    broadcast_event(state, &dto).await?;
    Ok(dto)
}

/// Tells every participant (chat members + invitees) that an event changed.
pub async fn broadcast_event(state: &AppState, event: &CalendarEventDto) -> AppResult<()> {
    let mut audience: Vec<Uuid> = event.attendees.iter().map(|a| a.user_id).collect();
    if let Some(conversation_id) = event.conversation_id {
        audience.extend(super::conversations::member_ids(&state.pool, conversation_id).await?);
    }
    state.hub.publish(audience, Event::event_updated(event)).await;
    Ok(())
}

/// Embeds the referenced event into every `event` message.
pub struct EventExpander;

#[async_trait]
impl MessageExpander for EventExpander {
    fn key(&self) -> &'static str {
        "calendar"
    }

    async fn expand(
        &self,
        state: &AppState,
        _viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        let ids = referenced_ids(messages, "eventId");
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let events = load_event_dtos(state, &ids).await?;
        let mut result = HashMap::new();
        for message in messages {
            if let Some(event_id) = metadata_id(message, "eventId") {
                if let Some(event) = events.get(&event_id) {
                    result.insert(
                        message.id,
                        Expansion { event: Some(event.clone()), ..Default::default() },
                    );
                }
            }
        }
        Ok(result)
    }
}
