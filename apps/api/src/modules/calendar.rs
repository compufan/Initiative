//! Termine, Zu-/Absagen und Kalender-Abonnement (ICS).

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX, RSVP_STATUSES};
use crate::db::{CalendarEventRow, UserRow};
use crate::dto::{CalendarEventDto, ListResult};
use crate::error::{AppError, AppResult};
use crate::ical::{build_calendar, IcsCalendar, IcsEvent};
use crate::realtime::Event;
use crate::recurrence::expand_occurrences;
use crate::services::calendar::{
    broadcast_event, create_event, load_event_dto, load_events_for_user, require_event, NewEvent,
};
use crate::services::conversations::{assert_membership, member_ids};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/calendar/events", get(list).post(create))
        .route(
            "/calendar/events/{id}",
            get(by_id).patch(update).delete(remove),
        )
        .route("/calendar/events/{id}/rsvp", post(rsvp))
        .route("/calendar/events/{id}/occurrences", get(occurrences))
        .route("/calendar/events/{id}/event.ics", get(event_ics))
        .route("/calendar/{token}/feed.ics", get(feed_ics))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    conversation_id: Option<Uuid>,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<CalendarEventDto>>> {
    if let Some(conversation_id) = query.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }
    let items =
        load_events_for_user(&state, user.id(), query.from, query.to, query.conversation_id).await?;
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateEventInput {
    conversation_id: Option<Uuid>,
    title: String,
    description: Option<String>,
    location: Option<String>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    #[serde(default)]
    all_day: bool,
    rrule: Option<String>,
    color: Option<String>,
    #[serde(default)]
    reminder_minutes: Vec<i32>,
    #[serde(default)]
    attendee_ids: Vec<Uuid>,
    announce: Option<bool>,
}

fn validate_event(title: &str, description: Option<&str>, starts: DateTime<Utc>, ends: DateTime<Utc>) -> AppResult<()> {
    let mut validator = Validator::new();
    validator.length("title", title, 1, EVENT_TITLE_MAX);
    if let Some(description) = description {
        validator.length("description", description, 0, EVENT_DESCRIPTION_MAX);
    }
    validator.require("endsAt", ends >= starts, "Ende liegt vor dem Beginn");
    validator.finish()
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateEventInput>,
) -> AppResult<(StatusCode, Json<CalendarEventDto>)> {
    let title = input.title.trim().to_string();
    validate_event(&title, input.description.as_deref(), input.starts_at, input.ends_at)?;
    if let Some(conversation_id) = input.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }

    let event = create_event(
        &state,
        NewEvent {
            conversation_id: input.conversation_id,
            created_by: user.id(),
            title,
            description: input.description,
            location: input.location,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
            all_day: input.all_day,
            rrule: input.rrule,
            color: input.color,
            reminder_minutes: input.reminder_minutes,
            source_poll_id: None,
            attendee_ids: input.attendee_ids,
            attendee_statuses: Default::default(),
            announce: input.announce,
        },
    )
    .await?;

    Ok((StatusCode::CREATED, Json(event)))
}

async fn assert_visible(state: &AppState, event: &CalendarEventRow, user_id: Uuid) -> AppResult<()> {
    if event.created_by == Some(user_id) {
        return Ok(());
    }
    if let Some(conversation_id) = event.conversation_id {
        assert_membership(&state.pool, conversation_id, user_id).await?;
        return Ok(());
    }
    let invited: Option<(Uuid,)> =
        sqlx::query_as("select user_id from event_attendees where event_id = $1 and user_id = $2")
            .bind(event.id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    invited
        .map(|_| ())
        .ok_or_else(|| AppError::forbidden("Kein Zugriff auf diesen Termin"))
}

async fn assert_editable(state: &AppState, event: &CalendarEventRow, user_id: Uuid) -> AppResult<()> {
    if event.created_by == Some(user_id) {
        return Ok(());
    }
    if let Some(conversation_id) = event.conversation_id {
        let membership = assert_membership(&state.pool, conversation_id, user_id).await?;
        if membership.role != "member" {
            return Ok(());
        }
    }
    Err(AppError::forbidden("Nur der Ersteller darf den Termin ändern"))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CalendarEventDto>> {
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;
    Ok(Json(load_event_dto(&state, id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEventInput {
    title: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    location: Option<Option<String>>,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    all_day: Option<bool>,
    #[serde(default, deserialize_with = "super::double_option")]
    rrule: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    color: Option<Option<String>>,
    reminder_minutes: Option<Vec<i32>>,
    attendee_ids: Option<Vec<Uuid>>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateEventInput>,
) -> AppResult<Json<CalendarEventDto>> {
    let row = require_event(&state, id).await?;
    assert_editable(&state, &row, user.id()).await?;

    let starts_at = input.starts_at.unwrap_or(row.starts_at);
    let ends_at = input.ends_at.unwrap_or(row.ends_at);
    let title = input
        .title
        .clone()
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| row.title.clone());
    validate_event(&title, None, starts_at, ends_at)?;

    sqlx::query(
        "update calendar_events set
           title = coalesce($2, title),
           description = case when $3 then $4 else description end,
           location = case when $5 then $6 else location end,
           starts_at = coalesce($7, starts_at),
           ends_at = coalesce($8, ends_at),
           all_day = coalesce($9, all_day),
           rrule = case when $10 then $11 else rrule end,
           color = case when $12 then $13 else color end,
           reminder_minutes = coalesce($14, reminder_minutes),
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(input.title.map(|value| value.trim().to_string()))
    .bind(input.description.is_some())
    .bind(input.description.clone().flatten())
    .bind(input.location.is_some())
    .bind(input.location.clone().flatten())
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(input.all_day)
    .bind(input.rrule.is_some())
    .bind(input.rrule.clone().flatten())
    .bind(input.color.is_some())
    .bind(input.color.clone().flatten())
    .bind(input.reminder_minutes.map(|values| json!(values)))
    .execute(&state.pool)
    .await?;

    if let Some(attendee_ids) = input.attendee_ids {
        for attendee in attendee_ids {
            sqlx::query(
                "insert into event_attendees (event_id, user_id, status) values ($1, $2, 'pending')
                 on conflict (event_id, user_id) do nothing",
            )
            .bind(id)
            .bind(attendee)
            .execute(&state.pool)
            .await?;
        }
    }

    let dto = load_event_dto(&state, id).await?;
    broadcast_event(&state, &dto).await?;
    Ok(Json(dto))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_event(&state, id).await?;
    assert_editable(&state, &row, user.id()).await?;

    sqlx::query("update calendar_events set deleted_at = now() where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    let mut audience: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "select user_id from event_attendees where event_id = $1",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(user_id,)| user_id)
    .collect();
    if let Some(conversation_id) = row.conversation_id {
        audience.extend(member_ids(&state.pool, conversation_id).await?);
    }
    state
        .hub
        .publish(audience, Event::event_deleted(id, row.conversation_id))
        .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct RsvpInput {
    status: String,
}

async fn rsvp(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<RsvpInput>,
) -> AppResult<Json<CalendarEventDto>> {
    Validator::new()
        .one_of("status", &input.status, RSVP_STATUSES)
        .finish()?;
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;

    sqlx::query(
        "insert into event_attendees (event_id, user_id, status, responded_at)
         values ($1, $2, $3, now())
         on conflict (event_id, user_id) do update
         set status = excluded.status, responded_at = excluded.responded_at",
    )
    .bind(id)
    .bind(user.id())
    .bind(&input.status)
    .execute(&state.pool)
    .await?;

    let dto = load_event_dto(&state, id).await?;
    broadcast_event(&state, &dto).await?;
    Ok(Json(dto))
}

#[derive(Debug, Deserialize)]
struct WindowQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

async fn occurrences(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<WindowQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;

    let from = query.from.unwrap_or_else(Utc::now);
    let to = query.to.unwrap_or_else(|| Utc::now() + Duration::days(90));
    let items: Vec<serde_json::Value> =
        expand_occurrences(row.starts_at, row.ends_at, row.rrule.as_deref(), from, to)
            .into_iter()
            .map(|occurrence| {
                json!({
                    "index": occurrence.index,
                    "startsAt": occurrence.starts_at,
                    "endsAt": occurrence.ends_at,
                })
            })
            .collect();

    Ok(Json(json!({ "items": items })))
}

fn to_ics_event(event: &CalendarEventDto, app_url: &str) -> IcsEvent {
    IcsEvent {
        id: event.id.to_string(),
        title: event.title.clone(),
        description: event.description.clone(),
        location: event.location.clone(),
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        all_day: event.all_day,
        rrule: event.rrule.clone(),
        url: Some(format!("{app_url}/kalender/termin/{}", event.id)),
        updated_at: event.updated_at,
        reminder_minutes: event.reminder_minutes.clone(),
    }
}

fn ics_response(body: String, filename: &str, inline: bool) -> Response {
    let disposition = if inline {
        format!("inline; filename=\"{filename}\"")
    } else {
        format!("attachment; filename=\"{filename}\"")
    };
    (
        [
            (header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "private, max-age=300".to_string()),
        ],
        body,
    )
        .into_response()
}

/// Single event download ("zum Kalender hinzufügen"). The event id acts as a
/// capability, because calendar apps cannot send an Authorization header.
async fn event_ics(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<Response> {
    let event = load_event_dto(&state, id).await?;
    let domain = domain_of(&state.config.public_app_url);
    let body = build_calendar(
        &[to_ics_event(&event, &state.config.public_app_url)],
        &IcsCalendar {
            name: event.title.clone(),
            description: None,
            refresh_interval: None,
            domain,
        },
    );
    Ok(ics_response(body, "termin.ics", false))
}

/// Personal calendar feed, authenticated by an unguessable token.
async fn feed_ics(State(state): State<AppState>, Path(token): Path<String>) -> AppResult<Response> {
    let user = sqlx::query_as::<_, UserRow>("select * from users where calendar_token = $1")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Kalender nicht gefunden"))?;

    let events = load_events_for_user(
        &state,
        user.id,
        Some(Utc::now() - Duration::days(365)),
        Some(Utc::now() + Duration::days(730)),
        None,
    )
    .await?;

    let body = build_calendar(
        &events
            .iter()
            .map(|event| to_ics_event(event, &state.config.public_app_url))
            .collect::<Vec<_>>(),
        &IcsCalendar {
            name: format!("Initiative – {}", user.display_name),
            description: Some("Termine aus deinen Chats und persönliche Termine".to_string()),
            refresh_interval: Some("PT1H".to_string()),
            domain: domain_of(&state.config.public_app_url),
        },
    );
    Ok(ics_response(body, "initiative.ics", true))
}

fn domain_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "initiative.app".to_string())
}
