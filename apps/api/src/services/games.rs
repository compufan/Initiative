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
        .map(|player| GameSeat {
            seat: player.seat,
            user_id: player.user_id,
        })
        .collect()
}

/// Die Partie, wie `betrachter` sie sehen darf (`None` = Zuschauer ohne Sitz).
///
/// WARUM es keinen Weg ohne Betrachter gibt: Bei Spielen mit verdeckten Zügen
/// (Pressen: fremde Zeiten bis zum Rundenende) darf der rohe Stand nirgends
/// hinausgehen. Jede Stelle, die eine Partie ausliefert – Abfrage, Liste,
/// Echtzeitereignis, Karte im Chat –, geht durch diese Funktion.
pub fn sicht_fuer(
    row: &GameSessionRow,
    betrachter: Option<Uuid>,
    figuren: &HashMap<Uuid, Value>,
) -> GameSessionDto {
    let players = players_of(row);
    let state = match get_game(&row.game_key) {
        Some(spiel) => {
            let sitz = betrachter.and_then(|id| crate::games::seat_of(&seats_of(row), id));
            spiel.fuer_betrachter(&row.state, sitz)
        }
        None => row.state.clone(),
    };
    let figuren_dto: Option<serde_json::Map<String, Value>> = if row.game_key == "pressen" {
        Some(
            players
                .iter()
                .filter_map(|p| {
                    figuren
                        .get(&p.user_id)
                        .map(|f| (p.user_id.to_string(), f.clone()))
                })
                .collect(),
        )
    } else {
        None
    };
    GameSessionDto {
        id: row.id,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        game_key: row.game_key.clone(),
        status: row.status.clone(),
        players,
        state,
        turn_user_id: row.turn_user_id,
        winner_user_ids: json_to_uuid_vec(&row.winner_user_ids),
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version: row.version,
        server_time: chrono::Utc::now(),
        figuren: figuren_dto,
    }
}

/// Die Strichmännchen der Spielenden aus ihren Konten (nur für Spiele, die sie zeigen).
pub async fn figuren_laden(
    pool: &sqlx::PgPool,
    rows: &[&GameSessionRow],
) -> AppResult<HashMap<Uuid, Value>> {
    let mut ids: Vec<Uuid> = rows
        .iter()
        .filter(|row| row.game_key == "pressen")
        .flat_map(|row| players_of(row).into_iter().map(|p| p.user_id))
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let zeilen: Vec<(Uuid, Option<Value>)> = sqlx::query_as(
        "select id, settings #> '{modules,pressenFigur}' from users where id = any($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    Ok(zeilen
        .into_iter()
        .filter_map(|(id, figur)| {
            figur
                .and_then(|f| crate::games::pressen_figur::lesen(&f))
                .map(|f| (id, f))
        })
        .collect())
}

/// Eine Partie für `betrachter`, samt Figuren der Spielenden.
pub async fn dto_fuer(
    state: &AppState,
    row: &GameSessionRow,
    betrachter: Uuid,
) -> AppResult<GameSessionDto> {
    let figuren = figuren_laden(&state.pool, &[row]).await?;
    Ok(sicht_fuer(row, Some(betrachter), &figuren))
}

/// Mehrere Partien für `betrachter` mit einer einzigen Abfrage der Figuren.
pub async fn dtos_fuer(
    state: &AppState,
    rows: &[GameSessionRow],
    betrachter: Uuid,
) -> AppResult<Vec<GameSessionDto>> {
    let refs: Vec<&GameSessionRow> = rows.iter().collect();
    let figuren = figuren_laden(&state.pool, &refs).await?;
    Ok(rows
        .iter()
        .map(|row| sicht_fuer(row, Some(betrachter), &figuren))
        .collect())
}

/// Die Karte im Chat in der Fassung jeder Person (für das Ausspielen).
pub async fn sichten_fuer(
    state: &AppState,
    session_id: Uuid,
    empfaenger: &[Uuid],
) -> AppResult<HashMap<Uuid, GameSessionDto>> {
    let Some(row) =
        sqlx::query_as::<_, GameSessionRow>("select * from game_sessions where id = $1")
            .bind(session_id)
            .fetch_optional(&state.pool)
            .await?
    else {
        return Ok(HashMap::new());
    };
    let figuren = figuren_laden(&state.pool, &[&row]).await?;
    Ok(empfaenger
        .iter()
        .map(|id| (*id, sicht_fuer(&row, Some(*id), &figuren)))
        .collect())
}

pub async fn require_session(state: &AppState, session_id: Uuid) -> AppResult<GameSessionRow> {
    sqlx::query_as::<_, GameSessionRow>("select * from game_sessions where id = $1")
        .bind(session_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Spiel nicht gefunden"))
}

/// Wie lange eine fertige oder abgebrochene Übung ohne Chat noch herumliegen darf.
const UEBUNG_BEHALTEN_TAGE: i32 = 1;

/// Legt eine Partie an.
///
/// Mit `conversation_id` als Karte im Chat. Ohne Chat (`None`) ist es eine
/// Übung allein: Sie braucht niemanden, gehört nur `created_by`, steht in
/// keinem Chat und löst keine Mitteilung aus. Das geht nur für Spiele, die
/// auch mit einer einzigen Person laufen (Pressen gegen den Spiegel).
pub async fn create_session(
    state: &AppState,
    conversation_id: Option<Uuid>,
    game_key: &str,
    created_by: Uuid,
    opponent_ids: &[Uuid],
) -> AppResult<GameSessionDto> {
    let definition =
        get_game(game_key).ok_or_else(|| AppError::bad_request("Unbekanntes Spiel"))?;
    if conversation_id.is_none()
        && (definition.min_players() > 1 || opponent_ids.iter().any(|id| *id != created_by))
    {
        return Err(AppError::bad_request(
            "Ohne Chat gibt es nur eine Übung allein",
        ));
    }

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
        .map(|(seat, user_id)| GamePlayerDto {
            user_id: *user_id,
            seat: seat as i32,
            joined_at: now,
        })
        .collect();
    let seats: Vec<GameSeat> = players
        .iter()
        .map(|player| GameSeat {
            seat: player.seat,
            user_id: player.user_id,
        })
        .collect();

    let initial_state = definition.initial_state(&seats);
    let active = players.len() >= definition.min_players();
    let turn_user_id = if active {
        crate::games::user_of_seat(&seats, definition.current_seat(&initial_state))
    } else {
        None
    };
    let session_id = Uuid::now_v7();

    if conversation_id.is_none() {
        // Eine Übung zur Zeit: Die vorige (meist ein nie beendeter Spiegel) räumt
        // der Start der nächsten ab. Fertige Reste älterer Spiele gehen mit.
        sqlx::query(
            "delete from game_sessions
              where besitzer_id = $1 and conversation_id is null
                and (game_key = $2
                     or (status in ('finished', 'aborted')
                         and updated_at < now() - make_interval(days => $3)))",
        )
        .bind(created_by)
        .bind(game_key)
        .bind(UEBUNG_BEHALTEN_TAGE)
        .execute(&state.pool)
        .await?;
    }

    sqlx::query(
        "insert into game_sessions
           (id, conversation_id, game_key, status, state, players, turn_user_id,
            winner_user_ids, created_by, besitzer_id, version)
         values ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8, $9, 0)",
    )
    .bind(session_id)
    .bind(conversation_id)
    .bind(game_key)
    .bind(if active { "active" } else { "open" })
    .bind(&initial_state)
    .bind(serde_json::to_value(&players).unwrap_or(Value::Array(vec![])))
    .bind(turn_user_id)
    .bind(created_by)
    .bind(if conversation_id.is_none() {
        Some(created_by)
    } else {
        None
    })
    .execute(&state.pool)
    .await?;

    // Nur eine Partie im Chat bekommt eine Karte. Die Übung allein bleibt dem
    // Besitzer vorbehalten: keine Nachricht, keine Vorschau in der Chatliste.
    if let Some(conversation_id) = conversation_id {
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
    }

    let row = require_session(state, session_id).await?;
    broadcast_session(state, &row).await?;
    dto_fuer(state, &row, created_by).await
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
    betrachter: Uuid,
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

    broadcast_session(state, &updated).await?;
    dto_fuer(state, &updated, betrachter).await
}

/// Wer die Partie sehen darf – abgeleitet aus ihrer Karte im Chat.
///
/// Wie bei den Umfragen: Eine Partie erreicht man über die Nachricht, die sie
/// trägt. Vorher hing es an der blossen Mitgliedschaft, und eine Partie von
/// vor dem eigenen Beitritt war damit offen – Spielstand, Mitspieler, Verlauf.
/// Fehlt die Karte (gelöscht), entscheidet das Alter der Partie gegen die
/// eigene Grenze.
pub async fn sichtbar_fuer(pool: &sqlx::PgPool, row: &GameSessionRow) -> AppResult<Vec<Uuid>> {
    // Eine Übung ohne Chat sieht nur ihr Besitzer – kein Chat, keine Mitglieder.
    let Some(conversation_id) = row.conversation_id else {
        return Ok(row.besitzer_id.into_iter().collect());
    };
    let mut ids: Vec<Uuid> = match row.message_id {
        Some(message_id) => {
            crate::services::verlauf::empfaenger_fuer_nachricht(pool, message_id).await?
        }
        None => {
            sqlx::query_scalar(
                "select cm.user_id from conversation_members cm
                  where cm.conversation_id = $1
                    and (cm.sieht_ab is null or $2 >= cm.sieht_ab)",
            )
            .bind(conversation_id)
            .bind(row.created_at)
            .fetch_all(pool)
            .await?
        }
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Darf diese Person die Partie sehen und mitspielen?
pub async fn assert_session_access(
    pool: &sqlx::PgPool,
    row: &GameSessionRow,
    user_id: Uuid,
) -> AppResult<()> {
    if sichtbar_fuer(pool, row).await?.contains(&user_id) {
        return Ok(());
    }
    // Eine fremde Übung gibt es für dich nicht – nicht einmal ihr Dasein verrät sich.
    if row.conversation_id.is_none() {
        return Err(AppError::not_found("Spiel nicht gefunden"));
    }
    Err(AppError::forbidden("Diese Partie gehört nicht zu dir"))
}

/// Schickt den neuen Stand an alle, die die Partie sehen dürfen – jedem in
/// SEINER Fassung (bei Pressen sieht niemand fremde Zeiten vor Rundenende).
pub async fn broadcast_session(state: &AppState, row: &GameSessionRow) -> AppResult<()> {
    let members = sichtbar_fuer(&state.pool, row).await?;
    let figuren = figuren_laden(&state.pool, &[row]).await?;
    for member in members {
        let session = sicht_fuer(row, Some(member), &figuren);
        state
            .hub
            .publish(vec![member], Event::game_updated(&session))
            .await;
    }
    super::messages::republish_message(
        state,
        row.message_id,
        row.created_by.unwrap_or_else(Uuid::nil),
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
        viewer_id: Uuid,
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
        let refs: Vec<&GameSessionRow> = rows.iter().collect();
        let figuren = figuren_laden(&state.pool, &refs).await?;
        let sessions: HashMap<Uuid, GameSessionDto> = rows
            .iter()
            .map(|row| (row.id, sicht_fuer(row, Some(viewer_id), &figuren)))
            .collect();

        let mut result = HashMap::new();
        for message in messages {
            if let Some(session_id) = metadata_id(message, "gameSessionId") {
                if let Some(session) = sessions.get(&session_id) {
                    result.insert(
                        message.id,
                        Expansion {
                            game: Some(session.clone()),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        Ok(result)
    }
}
