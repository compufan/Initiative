//! Termine, Zu-/Absagen und Kalender-Abonnement (ICS).

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX, POLL_OPTIONS_MAX, RSVP_STATUSES};
use crate::db::{AttachmentRow, CalendarEventRow, EventAttachmentRow, EventNoteRow, UserRow};
use crate::dto::{CalendarEventDto, EventAttachmentDto, EventNoteDto, ListResult};
use crate::error::{AppError, AppResult};
use crate::ical::{build_calendar, IcsCalendar, IcsEvent};
use crate::modules::double_option;
use crate::realtime::Event;
use crate::recurrence::expand_occurrences;
use crate::services::attachments::to_attachment_dto;
use crate::services::calendar::{
    broadcast_event, create_event, load_event_dto, load_events_for_user, require_event, NewEvent,
};
use crate::services::conversations::{assert_membership, member_ids};
use crate::services::events::{
    assert_attendee, may_edit_note, require_note, to_note_dto, NOTE_SCOPES,
};
use crate::services::permissions::{require_collection, Level};
use crate::services::polls::{
    best_option, broadcast_poll, create_poll, load_poll_dto, place_poll, require_poll, NewPoll,
    NewPollOption,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

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
        // Termin, dessen Zeitpunkt noch abgestimmt wird.
        .route("/calendar/planning", post(create_planning))
        .route("/calendar/events/{id}/notes", get(notes).post(create_note))
        .route(
            "/calendar/events/{id}/notes/{note_id}",
            patch(update_note).delete(remove_note),
        )
        .route(
            "/calendar/events/{id}/documents",
            get(documents).post(add_document),
        )
        .route(
            "/calendar/events/{id}/documents/{document_id}",
            delete(remove_document),
        )
        .route("/calendar/events/{id}/collection", patch(link_collection))
        .route("/calendar/events/{id}/confirm", post(confirm_event))
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
    let items = load_events_for_user(
        &state,
        user.id(),
        query.from,
        query.to,
        query.conversation_id,
    )
    .await?;
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

fn validate_event(
    title: &str,
    description: Option<&str>,
    starts: DateTime<Utc>,
    ends: DateTime<Utc>,
) -> AppResult<()> {
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
    validate_event(
        &title,
        input.description.as_deref(),
        input.starts_at,
        input.ends_at,
    )?;
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
            status: "confirmed".to_string(),
            poll_id: None,
            attendee_ids: input.attendee_ids,
            attendee_statuses: Default::default(),
            announce: input.announce,
        },
    )
    .await?;

    Ok((StatusCode::CREATED, Json(event)))
}

async fn assert_visible(
    state: &AppState,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<()> {
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

async fn assert_editable(
    state: &AppState,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<()> {
    if event.created_by == Some(user_id) {
        return Ok(());
    }
    if let Some(conversation_id) = event.conversation_id {
        let membership = assert_membership(&state.pool, conversation_id, user_id).await?;
        if membership.role != "member" {
            return Ok(());
        }
    }
    Err(AppError::forbidden(
        "Nur der Ersteller darf den Termin ändern",
    ))
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

    let mut audience: Vec<Uuid> =
        sqlx::query_as::<_, (Uuid,)>("select user_id from event_attendees where event_id = $1")
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
            (
                header::CONTENT_TYPE,
                "text/calendar; charset=utf-8".to_string(),
            ),
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

/* ---------- Terminfindung: ein Termin, dessen Zeitpunkt noch offen ist ----- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanningInput {
    conversation_id: Uuid,
    title: String,
    description: Option<String>,
    location: Option<String>,
    /// Die Zeitvorschläge, über die abgestimmt wird.
    slots: Vec<PlanningSlot>,
    /// Zusätzliche Chats, in denen die Abstimmung ebenfalls stehen soll.
    #[serde(default)]
    also_in: Vec<Uuid>,
    closes_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanningSlot {
    starts_at: DateTime<Utc>,
    ends_at: Option<DateTime<Utc>>,
}

/// Legt einen Termin an, dessen Zeitpunkt noch abgestimmt wird.
///
/// Der Termin bekommt den **frühesten Vorschlag** als vorläufigen Zeitpunkt.
/// Das ist kein Behelf, sondern Absicht: Ein Termin ohne Zeitpunkt wäre in
/// jeder Monatsansicht, jedem ICS-Export und jeder Bereichsabfrage ein
/// Sonderfall. So steht er im Kalender – sichtbar als „in Abstimmung“ – und
/// rückt an seinen Platz, sobald entschieden ist.
async fn create_planning(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<PlanningInput>,
) -> AppResult<(StatusCode, Json<CalendarEventDto>)> {
    assert_membership(&state.pool, input.conversation_id, user.id()).await?;
    let title = input.title.trim().to_string();
    Validator::new()
        .length("title", &title, 1, EVENT_TITLE_MAX)
        .require(
            "slots",
            input.slots.len() >= 2,
            "mindestens zwei Vorschläge",
        )
        .require(
            "slots",
            input.slots.len() <= POLL_OPTIONS_MAX,
            "zu viele Vorschläge",
        )
        .finish()?;
    if let Some(description) = input.description.as_deref() {
        Validator::new()
            .length("description", description, 0, EVENT_DESCRIPTION_MAX)
            .finish()?;
    }

    let mut slots = input.slots;
    slots.sort_by_key(|slot| slot.starts_at);
    let erster = slots[0].starts_at;
    let erster_ende = slots[0].ends_at.unwrap_or(erster + Duration::hours(1));

    let poll = create_poll(
        &state,
        NewPoll {
            conversation_id: input.conversation_id,
            created_by: user.id(),
            kind: "date".to_string(),
            question: title.clone(),
            description: input.description.clone(),
            // Terminfindung: zu jedem Vorschlag eine eigene Antwort.
            multiple: true,
            anonymous: false,
            allow_add_options: false,
            closes_at: input.closes_at,
            options: slots
                .iter()
                .map(|slot| NewPollOption {
                    label: None,
                    starts_at: Some(slot.starts_at),
                    ends_at: slot.ends_at,
                })
                .collect(),
        },
    )
    .await?;

    let event = create_event(
        &state,
        NewEvent {
            conversation_id: Some(input.conversation_id),
            created_by: user.id(),
            title,
            description: input.description,
            location: input.location,
            starts_at: erster,
            ends_at: erster_ende,
            all_day: false,
            rrule: None,
            color: None,
            reminder_minutes: Vec::new(),
            source_poll_id: None,
            status: "planning".to_string(),
            poll_id: Some(poll.id),
            attendee_ids: Vec::new(),
            attendee_statuses: Default::default(),
            announce: Some(false),
        },
    )
    .await?;

    // Die Abstimmung zusätzlich in die gewünschten Chats stellen – mit
    // demselben Ergebnis. Wer im Einzelchat antwortet, hat auch für die
    // Gruppe geantwortet.
    if !input.also_in.is_empty() {
        let row = require_poll(&state, poll.id).await?;
        for conversation_id in input.also_in {
            if assert_membership(&state.pool, conversation_id, user.id())
                .await
                .is_err()
            {
                // Einen Chat, in dem man selbst nicht ist, still überspringen
                // statt den ganzen Vorgang scheitern zu lassen.
                continue;
            }
            place_poll(&state, &row, conversation_id, user.id()).await?;
        }
    }

    Ok((StatusCode::CREATED, Json(event)))
}

/* ---------- Notizen ---------- */

async fn notes(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<EventNoteDto>>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let rows = sqlx::query_as::<_, EventNoteRow>(
        "select * from event_notes where event_id = $1 and deleted_at is null
          order by position asc, created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(to_note_dto(&state.pool, &event, row, user.id()).await?);
    }
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteInput {
    title: Option<String>,
    body: String,
    #[serde(default = "default_scope")]
    edit_scope: String,
    /// Bei `listed`: wer sie ändern darf.
    #[serde(default)]
    editor_ids: Vec<Uuid>,
}

fn default_scope() -> String {
    "author".to_string()
}

async fn create_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<NoteInput>,
) -> AppResult<(StatusCode, Json<EventNoteDto>)> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    Validator::new()
        .one_of("editScope", &input.edit_scope, NOTE_SCOPES)
        .length("body", &input.body, 0, EVENT_DESCRIPTION_MAX)
        .finish()?;

    let next: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0) + 1 from event_notes where event_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;

    let note = sqlx::query_as::<_, EventNoteRow>(
        "insert into event_notes (id, event_id, author_id, title, body, edit_scope, position)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(user.id())
    .bind(clean(input.title))
    .bind(&input.body)
    .bind(&input.edit_scope)
    .bind(next)
    .fetch_one(&state.pool)
    .await?;

    set_note_editors(&state, &note, &input.editor_ids).await?;
    let dto = to_note_dto(&state.pool, &event, note, user.id()).await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNoteInput {
    #[serde(default, deserialize_with = "double_option")]
    title: Option<Option<String>>,
    body: Option<String>,
    edit_scope: Option<String>,
    editor_ids: Option<Vec<Uuid>>,
    position: Option<i32>,
}

async fn update_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateNoteInput>,
) -> AppResult<Json<EventNoteDto>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;
    if !may_edit_note(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden("Diese Notiz darfst du nicht ändern"));
    }
    // Wer sie ändern darf, bestimmt der Verfasser – sonst könnte jemand mit
    // Schreibrecht sich selbst zum alleinigen Bearbeiter machen.
    if (input.edit_scope.is_some() || input.editor_ids.is_some())
        && note.author_id != Some(user.id())
    {
        return Err(AppError::forbidden(
            "Wer die Notiz ändern darf, bestimmt ihr Verfasser",
        ));
    }
    if let Some(scope) = input.edit_scope.as_deref() {
        Validator::new()
            .one_of("editScope", scope, NOTE_SCOPES)
            .finish()?;
    }
    if let Some(body) = input.body.as_deref() {
        Validator::new()
            .length("body", body, 0, EVENT_DESCRIPTION_MAX)
            .finish()?;
    }

    let updated = sqlx::query_as::<_, EventNoteRow>(
        "update event_notes set
           title      = case when $3 then $4 else title end,
           body       = coalesce($5, body),
           edit_scope = coalesce($6, edit_scope),
           position   = coalesce($7, position),
           updated_at = now()
         where id = $1 and event_id = $2 and deleted_at is null
         returning *",
    )
    .bind(note_id)
    .bind(id)
    .bind(input.title.is_some())
    .bind(input.title.flatten())
    .bind(input.body)
    .bind(input.edit_scope)
    .bind(input.position)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Notiz nicht gefunden"))?;

    if let Some(editor_ids) = input.editor_ids {
        set_note_editors(&state, &updated, &editor_ids).await?;
    }
    let dto = to_note_dto(&state.pool, &event, updated, user.id()).await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(Json(dto))
}

async fn remove_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;
    // Löschen darf nur der Verfasser oder wer den Termin verwaltet.
    let darf = note.author_id == Some(user.id())
        || assert_editable(&state, &event, user.id()).await.is_ok();
    if !darf {
        return Err(AppError::forbidden("Diese Notiz darfst du nicht löschen"));
    }
    sqlx::query("update event_notes set deleted_at = now(), updated_at = now() where id = $1")
        .bind(note_id)
        .execute(&state.pool)
        .await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_note_editors(state: &AppState, note: &EventNoteRow, ids: &[Uuid]) -> AppResult<()> {
    sqlx::query("delete from event_note_editors where note_id = $1")
        .bind(note.id)
        .execute(&state.pool)
        .await?;
    for user_id in ids {
        sqlx::query(
            "insert into event_note_editors (note_id, user_id) values ($1, $2)
             on conflict do nothing",
        )
        .bind(note.id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/* ---------- Dokumente ---------- */

async fn documents(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<EventAttachmentDto>>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let rows = sqlx::query_as::<_, EventAttachmentRow>(
        "select * from event_attachments where event_id = $1 order by created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let attachment_ids: Vec<Uuid> = rows.iter().map(|row| row.attachment_id).collect();
    let attachments =
        sqlx::query_as::<_, AttachmentRow>("select * from attachments where id = any($1)")
            .bind(&attachment_ids)
            .fetch_all(&state.pool)
            .await?;

    let items = rows
        .into_iter()
        .filter_map(|row| {
            let attachment = attachments.iter().find(|a| a.id == row.attachment_id)?;
            Some(EventAttachmentDto {
                id: row.id,
                event_id: row.event_id,
                added_by: row.added_by,
                title: row.title,
                attachment: to_attachment_dto(attachment, &state.config),
                created_at: row.created_at,
            })
        })
        .collect();
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInput {
    attachment_id: Uuid,
    title: Option<String>,
}

async fn add_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<DocumentInput>,
) -> AppResult<(StatusCode, Json<EventAttachmentDto>)> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let attachment = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments where id = $1 and status = 'ready'",
    )
    .bind(input.attachment_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Datei nicht gefunden oder noch nicht fertig"))?;

    // Nur was man selbst hochgeladen hat oder im Chat sehen darf.
    if attachment.uploader_id != Some(user.id()) {
        let erlaubt: bool = sqlx::query_scalar(
            "select exists (
               select 1 from messages m
                 join conversation_members cm on cm.conversation_id = m.conversation_id
                where m.id = $1 and cm.user_id = $2
             )",
        )
        .bind(attachment.message_id)
        .bind(user.id())
        .fetch_one(&state.pool)
        .await?;
        if !erlaubt {
            return Err(AppError::forbidden(
                "Auf diese Datei hast du keinen Zugriff",
            ));
        }
    }

    let row = sqlx::query_as::<_, EventAttachmentRow>(
        "insert into event_attachments (id, event_id, attachment_id, added_by, title)
         values ($1, $2, $3, $4, $5)
         on conflict (event_id, attachment_id)
         do update set title = coalesce(excluded.title, event_attachments.title)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(input.attachment_id)
    .bind(user.id())
    .bind(clean(input.title))
    .fetch_one(&state.pool)
    .await?;

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok((
        StatusCode::CREATED,
        Json(EventAttachmentDto {
            id: row.id,
            event_id: row.event_id,
            added_by: row.added_by,
            title: row.title,
            attachment: to_attachment_dto(&attachment, &state.config),
            created_at: row.created_at,
        }),
    ))
}

async fn remove_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, document_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let row = sqlx::query_as::<_, EventAttachmentRow>(
        "select * from event_attachments where id = $1 and event_id = $2",
    )
    .bind(document_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Dokument nicht gefunden"))?;

    let darf =
        row.added_by == Some(user.id()) || assert_editable(&state, &event, user.id()).await.is_ok();
    if !darf {
        return Err(AppError::forbidden(
            "Dieses Dokument darfst du nicht entfernen",
        ));
    }
    sqlx::query("delete from event_attachments where id = $1")
        .bind(document_id)
        .execute(&state.pool)
        .await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Verknuepfung mit einer Sammlung ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkCollectionInput {
    #[serde(default, deserialize_with = "double_option")]
    collection_id: Option<Option<Uuid>>,
}

/// Haengt eine Sammlung an den Termin – oder loest die Verknuepfung.
async fn link_collection(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<LinkCollectionInput>,
) -> AppResult<Json<CalendarEventDto>> {
    let event = require_event(&state, id).await?;
    assert_editable(&state, &event, user.id()).await?;

    if let Some(Some(collection_id)) = input.collection_id {
        // Nur eine Sammlung, in die man selbst etwas legen darf – sonst
        // haengte man dem Termin einen Ordner an, den niemand fuellen kann.
        require_collection(&state.pool, collection_id, user.id(), Level::Edit).await?;
    }

    sqlx::query(
        "update calendar_events set
           collection_id = case when $2 then $3 else collection_id end,
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(input.collection_id.is_some())
    .bind(input.collection_id.flatten())
    .execute(&state.pool)
    .await?;

    let dto = load_event_dto(&state, id).await?;
    broadcast_event(&state, &dto).await?;
    Ok(Json(dto))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmInput {
    /// Welcher Vorschlag es wird. Ohne Angabe gewinnt der beste.
    option_id: Option<Uuid>,
    #[serde(default = "default_close")]
    close_poll: bool,
}

fn default_close() -> bool {
    true
}

/// Setzt den Zeitpunkt eines Termins, über den abgestimmt wurde.
///
/// Anders als „Termin aus Umfrage erstellen“ entsteht hier **kein zweiter**
/// Termin: Der bestehende rückt an seinen Platz. Sonst stünde nach der
/// Entscheidung beides im Kalender – der geplante und der bestätigte.
///
/// Die Antworten aus der Abstimmung werden zu Zu- und Absagen: Wer den Termin
/// als passend markiert hat, sagt damit zu.
async fn confirm_event(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<ConfirmInput>,
) -> AppResult<Json<CalendarEventDto>> {
    let event = require_event(&state, id).await?;
    assert_editable(&state, &event, user.id()).await?;

    let Some(poll_id) = event.poll_id else {
        return Err(AppError::bad_request(
            "Für diesen Termin läuft keine Abstimmung",
        ));
    };

    let options = sqlx::query_as::<_, crate::db::PollOptionRow>(
        "select * from poll_options where poll_id = $1 order by position asc",
    )
    .bind(poll_id)
    .fetch_all(&state.pool)
    .await?;
    let votes =
        sqlx::query_as::<_, crate::db::PollVoteRow>("select * from poll_votes where poll_id = $1")
            .bind(poll_id)
            .fetch_all(&state.pool)
            .await?;

    let option = match input.option_id {
        Some(option_id) => options.iter().find(|option| option.id == option_id),
        None => {
            // Ohne Angabe der beste Vorschlag – dieselbe Rechnung wie in der
            // Umfrage selbst, damit „bester Vorschlag“ überall dasselbe heisst.
            let dto = load_poll_dto(&state, poll_id, user.id()).await?;
            best_option(&dto.options, &dto.tally)
                .and_then(|best| options.iter().find(|option| option.id == best.id))
        }
    }
    .ok_or_else(|| AppError::bad_request("Unbekannter Terminvorschlag"))?;

    let Some(starts_at) = option.starts_at else {
        return Err(AppError::bad_request(
            "Dieser Vorschlag hat keinen Zeitpunkt",
        ));
    };
    let ends_at = option.ends_at.unwrap_or(starts_at + Duration::hours(1));

    sqlx::query(
        "update calendar_events set
           starts_at      = $2,
           ends_at        = $3,
           status         = 'confirmed',
           source_poll_id = $4,
           updated_at     = now()
         where id = $1",
    )
    .bind(id)
    .bind(starts_at)
    .bind(ends_at)
    .bind(poll_id)
    .execute(&state.pool)
    .await?;

    // Die Antworten zum gewählten Zeitpunkt werden zu Zu- und Absagen.
    //
    // `insert ... on conflict` und nicht nur `update`: Wer über einen
    // Einzelchat abgestimmt hat, ist nicht Mitglied der Gruppe und steht
    // deshalb noch gar nicht auf der Teilnehmerliste. Ein blosses `update`
    // hätte seine Zusage stillschweigend verworfen – er hätte zugesagt und
    // stünde trotzdem nirgends.
    for vote in votes.iter().filter(|vote| vote.option_id == option.id) {
        sqlx::query(
            "insert into event_attendees (event_id, user_id, status, responded_at)
             values ($1, $2, $3, now())
             on conflict (event_id, user_id)
             do update set status = excluded.status, responded_at = now()",
        )
        .bind(id)
        .bind(vote.user_id)
        .bind(&vote.value)
        .execute(&state.pool)
        .await?;
    }

    sqlx::query(
        "update polls set created_event_id = $2,
                          closed_at = case when $3 then now() else closed_at end
          where id = $1",
    )
    .bind(poll_id)
    .bind(id)
    .bind(input.close_poll)
    .execute(&state.pool)
    .await?;

    let poll_dto = load_poll_dto(&state, poll_id, user.id()).await?;
    broadcast_poll(&state, &poll_dto).await?;

    let dto = load_event_dto(&state, id).await?;
    broadcast_event(&state, &dto).await?;
    Ok(Json(dto))
}
