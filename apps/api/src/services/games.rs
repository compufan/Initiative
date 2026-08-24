//! Mini-Spiel-Sitzungen. Züge werden ausschließlich serverseitig validiert.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

use crate::db::{json_to_uuid_vec, GameSessionRow, MessageRow};
use crate::dto::{GamePlayerDto, GameSessionDto};
use crate::error::{AppError, AppResult};
use crate::games::{get_game, GameSeat};
use crate::realtime::Event;
use crate::state::AppState;

use super::expanders::{metadata_id, referenced_ids, Expansion, MessageExpander};

pub fn players_of(row: &GameSessionRow) -> Vec<GamePlayerDto> {
    serde_json::from_value(row.players.clone()).unwrap_or_default()
}

pub fn seats_of(row: &GameSessionRow) -> Vec<GameSeat> {
    players_of(row)
        .into_iter()
        .map(|player| GameSeat { seat: player.seat, user_id: player.user_id })
        .collect()
}

pub fn to_session_dto(row: &GameSessionRow) -> GameSessionDto {
    GameSessionDto {
        id: row.id,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        game_key: row.game_key.clone(),
        status: row.status.clone(),
        players: players_of(row),
        state: row.state.clone(),
        turn_user_id: row.turn_user_id,
        winner_user_ids: json_to_uuid_vec(&row.winner_user_ids),
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version: row.version,
    }
}

pub async fn require_session(state: &AppState, session_id: Uuid) -> AppResult<GameSessionRow> {
    sqlx::query_as::<_, GameSessionRow>("select * from game_sessions where id = $1")
        .bind(session_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Spiel nicht gefunden"))
}

pub async fn create_session(
    state: &AppState,
    conversation_id: Uuid,
    game_key: &str,
    created_by: Uuid,
    opponent_ids: &[Uuid],
) -> AppResult<GameSessionDto> {
    let definition = get_game(game_key).ok_or_else(|| AppError::bad_request("Unbekanntes Spiel"))?;

    let mut user_ids = vec![created_by];
    for id in opponent_ids {
        if !user_ids.contains(id) {
            user_ids.push(*id);
        }
    }
    if user_ids.len() > definition.max_players() {
        return Err(AppError::bad_request("Zu viele Mitspieler"));
    }

    let now = chrono::Utc::now();
    let players: Vec<GamePlayerDto> = user_ids
        .iter()
        .enumerate()
        .map(|(seat, user_id)| GamePlayerDto { user_id: *user_id, seat: seat as i32, joined_at: now })
        .collect();
    let seats: Vec<GameSeat> = players
        .iter()
        .map(|player| GameSeat { seat: player.seat, user_id: player.user_id })
        .collect();

    let initial_state = definition.initial_state(&seats);
    let active = players.len() >= definition.min_players();
    let turn_user_id = if active {
        crate::games::user_of_seat(&seats, definition.current_seat(&initial_state))
    } else {
        None
    };
    let session_id = Uuid::now_v7();

    sqlx::query(
        "insert into game_sessions
           (id, conversation_id, game_key, status, state, players, turn_user_id,
            winner_user_ids, created_by, version)
         values ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8, 0)",
    )
    .bind(session_id)
    .bind(conversation_id)
    .bind(game_key)
    .bind(if active { "active" } else { "open" })
    .bind(&initial_state)
    .bind(serde_json::to_value(&players).unwrap_or(Value::Array(vec![])))
    .bind(turn_user_id)
    .bind(created_by)
    .execute(&state.pool)
    .await?;

    let message = super::messages::create_message(
        state,
        super::messages::NewMessage::entity(
            conversation_id,
            created_by,
            "game",
            "gameSessionId",
            session_id,
        ),
    )
    .await?;
    sqlx::query("update game_sessions set message_id = $1 where id = $2")
        .bind(message.id)
        .bind(session_id)
        .execute(&state.pool)
        .await?;

    let session = to_session_dto(&require_session(state, session_id).await?);
    broadcast_session(state, &session).await?;
    Ok(session)
}

pub struct SessionUpdate {
    pub state: Value,
    pub status: String,
    pub turn_user_id: Option<Uuid>,
    pub winner_user_ids: Vec<Uuid>,
    pub players: Option<Vec<GamePlayerDto>>,
}

/// Optimistic concurrency: the update only lands when the version still matches.
pub async fn persist_session(
    state: &AppState,
    row: &GameSessionRow,
    update: SessionUpdate,
) -> AppResult<GameSessionDto> {
    let players = match update.players {
        Some(players) => serde_json::to_value(players).unwrap_or(Value::Array(vec![])),
        None => row.players.clone(),
    };

    let updated = sqlx::query_as::<_, GameSessionRow>(
        "update game_sessions
         set state = $1, status = $2, turn_user_id = $3, winner_user_ids = $4,
             players = $5, version = version + 1, updated_at = now()
         where id = $6 and version = $7
         returning *",
    )
    .bind(&update.state)
    .bind(&update.status)
    .bind(update.turn_user_id)
    .bind(serde_json::json!(update.winner_user_ids))
    .bind(players)
    .bind(row.id)
    .bind(row.version)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::bad_request("Der Spielstand hat sich geändert – bitte neu laden."))?;

    let session = to_session_dto(&updated);
    broadcast_session(state, &session).await?;
    Ok(session)
}

pub async fn broadcast_session(state: &AppState, session: &GameSessionDto) -> AppResult<()> {
    let members = super::conversations::member_ids(&state.pool, session.conversation_id).await?;
    state.hub.publish(members, Event::game_updated(session)).await;
    super::messages::republish_message(
        state,
        session.message_id,
        session.created_by.unwrap_or_else(Uuid::nil),
    )
    .await
}

/// Embeds the referenced match into every `game` message.
pub struct GameExpander;

#[async_trait]
impl MessageExpander for GameExpander {
    fn key(&self) -> &'static str {
        "games"
    }

    async fn expand(
        &self,
        state: &AppState,
        _viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        let ids = referenced_ids(messages, "gameSessionId");
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows =
            sqlx::query_as::<_, GameSessionRow>("select * from game_sessions where id = any($1)")
                .bind(&ids)
                .fetch_all(&state.pool)
                .await?;
        let sessions: HashMap<Uuid, GameSessionDto> = rows
            .into_iter()
            .map(|row| (row.id, to_session_dto(&row)))
            .collect();

        let mut result = HashMap::new();
        for message in messages {
            if let Some(session_id) = metadata_id(message, "gameSessionId") {
                if let Some(session) = sessions.get(&session_id) {
                    result.insert(
                        message.id,
                        Expansion { game: Some(session.clone()), ..Default::default() },
                    );
                }
            }
        }
        Ok(result)
    }
}
