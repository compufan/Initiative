//! Mini-Spiele im Chat.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::GameSessionRow;
use crate::dto::{GameInfoDto, GameSessionDto, ListResult, PushPayload};
use crate::error::{AppError, AppResult};
use crate::games::{get_game, list_games, seat_of, user_of_seat, MoveContext};
use crate::services::conversations::assert_membership;
use crate::services::games::{
    create_session, persist_session, players_of, require_session, seats_of, to_session_dto,
    SessionUpdate,
};
use crate::services::notify::notify_users;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/games", get(catalog))
        .route("/games/sessions", get(list_sessions).post(create))
        .route("/games/sessions/{id}", get(by_id))
        .route("/games/sessions/{id}/join", post(join))
        .route("/games/sessions/{id}/moves", post(make_move))
        .route("/games/sessions/{id}/abort", post(abort))
        .route("/games/sessions/{id}/rematch", post(rematch))
}

/// Catalog of everything registered in `src/games`.
async fn catalog() -> Json<ListResult<GameInfoDto>> {
    Json(ListResult::new(
        list_games()
            .iter()
            .map(|game| GameInfoDto {
                key: game.key().to_string(),
                name: game.name().to_string(),
                description: game.description().to_string(),
                emoji: game.emoji().to_string(),
                min_players: game.min_players(),
                max_players: game.max_players(),
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQuery {
    conversation_id: Option<Uuid>,
    status: Option<String>,
}

async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SessionQuery>,
) -> AppResult<Json<ListResult<GameSessionDto>>> {
    if let Some(conversation_id) = query.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }

    let rows = sqlx::query_as::<_, GameSessionRow>(
        "select g.*
         from game_sessions g
         join conversation_members cm
           on cm.conversation_id = g.conversation_id and cm.user_id = $1
         where ($2::uuid is null or g.conversation_id = $2)
           and (($3::text is null and g.status in ('open', 'active')) or g.status = $3)
         order by g.updated_at desc
         limit 50",
    )
    .bind(user.id())
    .bind(query.conversation_id)
    .bind(query.status)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(
        rows.iter().map(to_session_dto).collect(),
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionInput {
    conversation_id: Uuid,
    game_key: String,
    #[serde(default)]
    opponent_ids: Vec<Uuid>,
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateSessionInput>,
) -> AppResult<(StatusCode, Json<GameSessionDto>)> {
    assert_membership(&state.pool, input.conversation_id, user.id()).await?;
    for opponent in &input.opponent_ids {
        assert_membership(&state.pool, input.conversation_id, *opponent).await?;
    }

    let session = create_session(
        &state,
        input.conversation_id,
        &input.game_key,
        user.id(),
        &input.opponent_ids,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<GameSessionDto>> {
    let row = require_session(&state, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    Ok(Json(to_session_dto(&row)))
}

async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<GameSessionDto>> {
    let row = require_session(&state, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    let definition =
        get_game(&row.game_key).ok_or_else(|| AppError::bad_request("Unbekanntes Spiel"))?;
    if row.status == "finished" || row.status == "aborted" {
        return Err(AppError::bad_request("Das Spiel ist beendet"));
    }
    let mut players = players_of(&row);
    if players.iter().any(|player| player.user_id == user.id()) {
        return Ok(Json(to_session_dto(&row)));
    }
    if players.len() >= definition.max_players() {
        return Err(AppError::bad_request("Das Spiel ist schon voll"));
    }

    players.push(crate::dto::GamePlayerDto {
        user_id: user.id(),
        seat: players.len() as i32,
        joined_at: chrono::Utc::now(),
    });
    let seats: Vec<crate::games::GameSeat> = players
        .iter()
        .map(|player| crate::games::GameSeat {
            seat: player.seat,
            user_id: player.user_id,
        })
        .collect();
    let active = players.len() >= definition.min_players();

    Ok(Json(
        persist_session(
            &state,
            &row,
            SessionUpdate {
                turn_user_id: if active {
                    user_of_seat(&seats, definition.current_seat(&row.state))
                } else {
                    None
                },
                state: row.state.clone(),
                status: if active {
                    "active".into()
                } else {
                    "open".into()
                },
                winner_user_ids: Vec::new(),
                players: Some(players),
            },
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct MoveInput {
    #[serde(rename = "move")]
    r#move: Value,
    version: Option<i32>,
}

/// Authoritative move handling: the rules decide, never the client.
async fn make_move(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<MoveInput>,
) -> AppResult<Json<GameSessionDto>> {
    let row = require_session(&state, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    if input.version.is_some_and(|version| version != row.version) {
        return Err(AppError::bad_request(
            "Der Spielstand hat sich geändert – bitte neu laden.",
        ));
    }
    if row.status != "active" {
        return Err(AppError::bad_request("Das Spiel läuft gerade nicht"));
    }

    let definition =
        get_game(&row.game_key).ok_or_else(|| AppError::bad_request("Unbekanntes Spiel"))?;
    let seats = seats_of(&row);
    let seat =
        seat_of(&seats, user.id()).ok_or_else(|| AppError::forbidden("Du spielst nicht mit"))?;

    let next_state = definition
        .apply_move(
            &row.state,
            &input.r#move,
            &MoveContext {
                seat,
                user_id: user.id(),
                players: &seats,
            },
        )
        .map_err(AppError::bad_request)?;

    let outcome = definition.outcome(&next_state);
    let next_seat = definition.current_seat(&next_state);
    let session = persist_session(
        &state,
        &row,
        SessionUpdate {
            status: if outcome.finished {
                "finished".into()
            } else {
                "active".into()
            },
            turn_user_id: if outcome.finished {
                None
            } else {
                user_of_seat(&seats, next_seat)
            },
            winner_user_ids: outcome
                .winner_seats
                .iter()
                .filter_map(|seat| user_of_seat(&seats, Some(*seat)))
                .collect(),
            state: next_state,
            players: None,
        },
    )
    .await?;

    // Nudge the player whose turn it is now.
    if let Some(turn_user_id) = session.turn_user_id {
        if turn_user_id != user.id() {
            notify_users(
                &state,
                &[turn_user_id],
                &PushPayload {
                    title: definition.name().to_string(),
                    body: "Du bist am Zug".to_string(),
                    tag: Some(format!("game:{}", session.id)),
                    url: format!("/spiele/{}", session.id),
                    conversation_id: Some(session.conversation_id),
                    message_id: None,
                    kind: "game".to_string(),
                },
            )
            .await;
        }
    }

    Ok(Json(session))
}

async fn abort(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<GameSessionDto>> {
    let row = require_session(&state, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    let seats = seats_of(&row);
    if seat_of(&seats, user.id()).is_none() && row.created_by != Some(user.id()) {
        return Err(AppError::forbidden(
            "Nur Mitspieler können das Spiel beenden",
        ));
    }
    if row.status == "finished" || row.status == "aborted" {
        return Ok(Json(to_session_dto(&row)));
    }

    Ok(Json(
        persist_session(
            &state,
            &row,
            SessionUpdate {
                state: row.state.clone(),
                status: "aborted".into(),
                turn_user_id: None,
                winner_user_ids: seats
                    .iter()
                    .filter(|seat| seat.user_id != user.id())
                    .map(|seat| seat.user_id)
                    .collect(),
                players: None,
            },
        )
        .await?,
    ))
}

/// Rematch: same game, same chat, same players.
async fn rematch(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<GameSessionDto>)> {
    let row = require_session(&state, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    let opponents: Vec<Uuid> = players_of(&row)
        .into_iter()
        .map(|player| player.user_id)
        .filter(|player| *player != user.id())
        .collect();

    let session = create_session(
        &state,
        row.conversation_id,
        &row.game_key,
        user.id(),
        &opponents,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(session)))
}
