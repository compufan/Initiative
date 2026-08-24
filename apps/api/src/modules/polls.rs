//! Umfragen und Terminfindung.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{POLL_KINDS, POLL_OPTIONS_MAX, POLL_OPTION_MAX, POLL_QUESTION_MAX, VOTE_VALUES};
use crate::db::{PollOptionRow, PollRow, PollVoteRow};
use crate::dto::{CalendarEventDto, PollDto};
use crate::error::{AppError, AppResult};
use crate::services::calendar::{create_event, NewEvent};
use crate::services::conversations::{assert_membership, get_membership};
use crate::services::polls::{
    best_option, broadcast_poll, create_poll, is_closed, load_poll_dto, require_poll, set_votes,
    NewPoll, NewPollOption,
};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/polls", post(create))
        .route("/polls/{id}", get(by_id))
        .route("/polls/{id}/vote", post(vote))
        .route("/polls/{id}/options", post(add_option))
        .route("/polls/{id}/close", post(close))
        .route("/polls/{id}/reopen", post(reopen))
        .route("/polls/{id}/event", post(create_event_from_poll))
        .route("/polls/{id}/best-option", get(best))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionInput {
    label: Option<String>,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePollInput {
    conversation_id: Uuid,
    #[serde(default = "default_kind")]
    kind: String,
    question: String,
    description: Option<String>,
    options: Vec<OptionInput>,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    anonymous: bool,
    #[serde(default)]
    allow_add_options: bool,
    closes_at: Option<DateTime<Utc>>,
}

fn default_kind() -> String {
    "choice".to_string()
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreatePollInput>,
) -> AppResult<(StatusCode, Json<PollDto>)> {
    assert_membership(&state.pool, input.conversation_id, user.id()).await?;

    let question = input.question.trim().to_string();
    let mut validator = Validator::new();
    validator
        .one_of("kind", &input.kind, POLL_KINDS)
        .length("question", &question, 1, POLL_QUESTION_MAX)
        .require("options", input.options.len() >= 2, "mindestens zwei Optionen")
        .require(
            "options",
            input.options.len() <= POLL_OPTIONS_MAX,
            "zu viele Optionen",
        );
    for option in &input.options {
        let has_label = option
            .label
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        validator.require(
            "options",
            has_label || option.starts_at.is_some(),
            "Option braucht Text oder Datum",
        );
        if input.kind == "date" {
            validator.require(
                "options",
                option.starts_at.is_some(),
                "Terminvorschläge brauchen ein Datum",
            );
        }
        if let Some(label) = &option.label {
            validator.length("options", label.trim(), 0, POLL_OPTION_MAX);
        }
    }
    validator.finish()?;

    let poll = create_poll(
        &state,
        NewPoll {
            conversation_id: input.conversation_id,
            created_by: user.id(),
            // Date polls always allow one answer per slot.
            multiple: input.kind == "date" || input.multiple,
            kind: input.kind,
            question,
            description: input.description,
            anonymous: input.anonymous,
            allow_add_options: input.allow_add_options,
            closes_at: input.closes_at,
            options: input
                .options
                .into_iter()
                .map(|option| NewPollOption {
                    label: option
                        .label
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty()),
                    starts_at: option.starts_at,
                    ends_at: option.ends_at,
                })
                .collect(),
        },
    )
    .await?;

    Ok((StatusCode::CREATED, Json(poll)))
}

async fn readable_poll(state: &AppState, id: Uuid, viewer: Uuid) -> AppResult<PollRow> {
    let poll = require_poll(state, id).await?;
    assert_membership(&state.pool, poll.conversation_id, viewer).await?;
    Ok(poll)
}

async fn owned_poll(state: &AppState, id: Uuid, viewer: Uuid) -> AppResult<PollRow> {
    let poll = require_poll(state, id).await?;
    let membership = get_membership(&state.pool, poll.conversation_id, viewer)
        .await?
        .ok_or_else(|| AppError::forbidden("Du bist kein Mitglied dieses Chats"))?;
    if poll.created_by != Some(viewer) && membership.role == "member" {
        return Err(AppError::forbidden("Nur der Ersteller darf die Umfrage verwalten"));
    }
    Ok(poll)
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<PollDto>> {
    readable_poll(&state, id, user.id()).await?;
    Ok(Json(load_poll_dto(&state, id, user.id()).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoteEntry {
    option_id: Uuid,
    #[serde(default = "default_vote")]
    value: String,
}

fn default_vote() -> String {
    "yes".to_string()
}

#[derive(Debug, Deserialize)]
struct VoteInput {
    votes: Vec<VoteEntry>,
}

async fn vote(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<VoteInput>,
) -> AppResult<Json<PollDto>> {
    let poll = readable_poll(&state, id, user.id()).await?;
    if is_closed(&poll) {
        return Err(AppError::bad_request("Die Umfrage ist beendet"));
    }
    let mut validator = Validator::new();
    for entry in &input.votes {
        validator.one_of("value", &entry.value, VOTE_VALUES);
    }
    validator.finish()?;

    set_votes(
        &state,
        &poll,
        user.id(),
        input
            .votes
            .into_iter()
            .map(|entry| (entry.option_id, entry.value))
            .collect(),
    )
    .await?;

    let dto = load_poll_dto(&state, id, user.id()).await?;
    broadcast_poll(&state, &dto).await?;
    Ok(Json(dto))
}

async fn add_option(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<OptionInput>,
) -> AppResult<(StatusCode, Json<PollDto>)> {
    let poll = readable_poll(&state, id, user.id()).await?;
    if is_closed(&poll) {
        return Err(AppError::bad_request("Die Umfrage ist beendet"));
    }
    if !poll.allow_add_options && poll.created_by != Some(user.id()) {
        return Err(AppError::forbidden("Hier dürfen keine Optionen ergänzt werden"));
    }
    if poll.kind == "date" && input.starts_at.is_none() {
        return Err(AppError::bad_request("Ein Terminvorschlag braucht ein Datum"));
    }

    let (count,): (i64,) =
        sqlx::query_as("select count(*)::bigint from poll_options where poll_id = $1")
            .bind(id)
            .fetch_one(&state.pool)
            .await?;
    if count as usize >= POLL_OPTIONS_MAX {
        return Err(AppError::bad_request(format!(
            "Maximal {POLL_OPTIONS_MAX} Optionen"
        )));
    }

    sqlx::query(
        "insert into poll_options (id, poll_id, label, starts_at, ends_at, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(input.label.map(|value| value.trim().to_string()))
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(count as i32)
    .bind(user.id())
    .execute(&state.pool)
    .await?;

    let dto = load_poll_dto(&state, id, user.id()).await?;
    broadcast_poll(&state, &dto).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

async fn close(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<PollDto>> {
    owned_poll(&state, id, user.id()).await?;
    sqlx::query("update polls set closed_at = now() where id = $1 and closed_at is null")
        .bind(id)
        .execute(&state.pool)
        .await?;
    let dto = load_poll_dto(&state, id, user.id()).await?;
    broadcast_poll(&state, &dto).await?;
    Ok(Json(dto))
}

async fn reopen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<PollDto>> {
    owned_poll(&state, id, user.id()).await?;
    sqlx::query("update polls set closed_at = null, closes_at = null where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    let dto = load_poll_dto(&state, id, user.id()).await?;
    broadcast_poll(&state, &dto).await?;
    Ok(Json(dto))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventFromPollInput {
    option_id: Uuid,
    title: Option<String>,
    location: Option<String>,
    description: Option<String>,
    #[serde(default = "default_true")]
    close_poll: bool,
}

fn default_true() -> bool {
    true
}

/// Terminfindung → Termin: turns the winning slot into a real calendar event
/// and carries the answers over as RSVP states.
async fn create_event_from_poll(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<EventFromPollInput>,
) -> AppResult<(StatusCode, Json<CalendarEventDto>)> {
    let poll = owned_poll(&state, id, user.id()).await?;
    if poll.kind != "date" {
        return Err(AppError::bad_request(
            "Nur aus einer Terminfindung entsteht ein Termin",
        ));
    }
    if poll.created_event_id.is_some() {
        return Err(AppError::bad_request(
            "Aus dieser Umfrage wurde bereits ein Termin erstellt",
        ));
    }

    let option = sqlx::query_as::<_, PollOptionRow>(
        "select * from poll_options where id = $1 and poll_id = $2",
    )
    .bind(input.option_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::bad_request("Unbekannter Terminvorschlag"))?;

    let Some(starts_at) = option.starts_at else {
        return Err(AppError::bad_request("Unbekannter Terminvorschlag"));
    };

    let votes = sqlx::query_as::<_, PollVoteRow>(
        "select * from poll_votes where poll_id = $1 and option_id = $2",
    )
    .bind(id)
    .bind(option.id)
    .fetch_all(&state.pool)
    .await?;
    let attendee_statuses: HashMap<Uuid, String> = votes
        .iter()
        .map(|vote| (vote.user_id, vote.value.clone()))
        .collect();

    let event = create_event(
        &state,
        NewEvent {
            conversation_id: Some(poll.conversation_id),
            created_by: user.id(),
            title: input
                .title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| poll.question.clone()),
            description: input.description.or_else(|| poll.description.clone()),
            location: input.location,
            starts_at,
            ends_at: option.ends_at.unwrap_or(starts_at + Duration::hours(1)),
            all_day: false,
            rrule: None,
            color: None,
            reminder_minutes: Vec::new(),
            source_poll_id: Some(poll.id),
            attendee_ids: attendee_statuses.keys().copied().collect(),
            attendee_statuses,
            announce: Some(true),
        },
    )
    .await?;

    sqlx::query(
        "update polls set created_event_id = $2, closed_at = case when $3 then now() else closed_at end
         where id = $1",
    )
    .bind(id)
    .bind(event.id)
    .bind(input.close_poll)
    .execute(&state.pool)
    .await?;

    let dto = load_poll_dto(&state, id, user.id()).await?;
    broadcast_poll(&state, &dto).await?;

    Ok((StatusCode::CREATED, Json(event)))
}

async fn best(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    readable_poll(&state, id, user.id()).await?;
    let dto = load_poll_dto(&state, id, user.id()).await?;
    Ok(Json(json!({ "option": best_option(&dto.options, &dto.tally) })))
}
