//! Mini-Spiele im Chat.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::GameSessionRow;
use crate::dto::{GameInfoDto, GameSessionDto, ListResult, PushPayload};
use crate::error::{AppError, AppResult};
use crate::games::{get_game, list_games, seat_of, user_of_seat, MoveContext};
use crate::services::conversations::assert_membership;
use crate::services::games::{
    create_session, dto_fuer, dtos_fuer, persist_session, players_of, require_session, seats_of,
    SessionUpdate,
};
use crate::services::notify::notify_users;
use crate::services::pressen_statistik::{self, laeufe_aus_zug, Filter, Sortierung, Statistik};
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
        .route("/games/pressen/statistik", get(pressen_statistik))
        .route("/games/pressen/laeufe", get(pressen_laeufe))
        .route("/games/pressen/laeufe/{id}", get(pressen_lauf))
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
        // Die Grenze gehört in die Abfrage: Wer erst danach filtert, zählt
        // Zeilen mit, die er gleich wieder wegwirft – und eine halbe Seite
        // sieht dann aus wie das Ende der Liste.
        // Die eigenen Übungen ohne Chat (`besitzer_id`) stehen neben den Partien
        // aus Chats; ein Chat-Filter blendet sie aus.
        "select g.*
         from game_sessions g
         left join conversation_members cm
           on cm.conversation_id = g.conversation_id and cm.user_id = $1
         left join messages gm on gm.id = g.message_id
         where ($2::uuid is null or g.conversation_id = $2)
           and ((g.conversation_id is null and g.besitzer_id = $1)
                or (cm.user_id is not null
                    and (cm.sieht_ab is null
                         or coalesce(gm.created_at, g.created_at) >= cm.sieht_ab)))
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
        dtos_fuer(&state, &rows, user.id()).await?,
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionInput {
    /// Fehlt er, ist es eine Übung allein ohne Chat (nur Pressen gegen den Spiegel).
    #[serde(default)]
    conversation_id: Option<Uuid>,
    game_key: String,
    #[serde(default)]
    opponent_ids: Vec<Uuid>,
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateSessionInput>,
) -> AppResult<(StatusCode, Json<GameSessionDto>)> {
    let mitspielend = input.opponent_ids.iter().any(|id| *id != user.id());
    let spiel = get_game(&input.game_key);
    // Allein gegen den Spiegel braucht keinen Chat – und gehört in keinen: Auch
    // ein älterer Client, der noch einen Chat mitschickt, bekommt eine Übung
    // ohne Karte. (Seine Antwort trägt `conversationId: null`.)
    let uebung = !mitspielend && spiel.is_some_and(|spiel| spiel.min_players() <= 1);
    let conversation_id = if uebung { None } else { input.conversation_id };
    if let Some(conversation_id) = conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
        for opponent in &input.opponent_ids {
            assert_membership(&state.pool, conversation_id, *opponent).await?;
        }
    } else if !uebung {
        return Err(AppError::bad_request("Dazu gehört ein Chat"));
    }

    let session = create_session(
        &state,
        conversation_id,
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
    crate::services::games::assert_session_access(&state.pool, &row, user.id()).await?;
    Ok(Json(dto_fuer(&state, &row, user.id()).await?))
}

async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<GameSessionDto>> {
    let row = require_session(&state, id).await?;
    crate::services::games::assert_session_access(&state.pool, &row, user.id()).await?;

    let definition =
        get_game(&row.game_key).ok_or_else(|| AppError::bad_request("Unbekanntes Spiel"))?;
    if row.status == "finished" || row.status == "aborted" {
        return Err(AppError::bad_request("Das Spiel ist beendet"));
    }
    let mut players = players_of(&row);
    if players.iter().any(|player| player.user_id == user.id()) {
        return Ok(Json(dto_fuer(&state, &row, user.id()).await?));
    }
    if players.len() >= definition.max_players() {
        return Err(AppError::bad_request("Das Spiel ist schon voll"));
    }
    definition
        .can_join(&row.state)
        .map_err(AppError::bad_request)?;

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
                laeufe: Vec::new(),
            },
            user.id(),
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
    crate::services::games::assert_session_access(&state.pool, &row, user.id()).await?;

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
    // Schließt dieser Zug eine Runde ab, gehören ihre Läufe in die Statistik.
    let laeufe = if row.game_key == "pressen" {
        match (
            serde_json::from_value::<crate::games::pressen::State>(row.state.clone()),
            serde_json::from_value::<crate::games::pressen::State>(next_state.clone()),
        ) {
            (Ok(vorher), Ok(nachher)) => laeufe_aus_zug(row.id, &seats, &vorher, &nachher),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };
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
            laeufe,
        },
        user.id(),
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
                    conversation_id: session.conversation_id,
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
    crate::services::games::assert_session_access(&state.pool, &row, user.id()).await?;

    let seats = seats_of(&row);
    if seat_of(&seats, user.id()).is_none() && row.created_by != Some(user.id()) {
        return Err(AppError::forbidden(
            "Nur Mitspieler können das Spiel beenden",
        ));
    }
    if row.status == "finished" || row.status == "aborted" {
        return Ok(Json(dto_fuer(&state, &row, user.id()).await?));
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
                laeufe: Vec::new(),
            },
            user.id(),
        )
        .await?,
    ))
}

/// Rematch: same game, same chat, same players. Eine Übung ohne Chat beginnt
/// wieder eine Übung ohne Chat.
async fn rematch(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<GameSessionDto>)> {
    let row = require_session(&state, id).await?;
    crate::services::games::assert_session_access(&state.pool, &row, user.id()).await?;

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

/* ---------- Pressen: Statistik (nur die eigenen Läufe) ---------- */

/// Filter, die Statistik und Laufliste teilen. Zeiten als RFC 3339.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaufFilterQuery {
    von: Option<chrono::DateTime<chrono::Utc>>,
    bis: Option<chrono::DateTime<chrono::Utc>>,
    modus: Option<String>,
    art: Option<String>,
    ausgang: Option<String>,
}

impl LaufFilterQuery {
    fn filter(self) -> AppResult<Filter> {
        let filter = Filter {
            von: self.von,
            bis: self.bis,
            modus: self.modus,
            art: self.art,
            ausgang: self.ausgang,
        };
        filter.pruefen().map_err(AppError::bad_request)?;
        Ok(filter)
    }
}

/// Aggregate über die eigenen Läufe: Kopfzahlen, Rekorde, Aufschlüsselung nach
/// Modus, Gegner und Malus, dazu der Verlauf (die jüngsten Läufe).
///
/// Es gibt keinen Weg, die Läufe eines anderen Kontos abzufragen: Die Abfrage
/// ist immer auf `user.id()` begrenzt.
async fn pressen_statistik(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<LaufFilterQuery>,
) -> AppResult<Json<Statistik>> {
    let filter = query.filter()?;
    let laeufe = pressen_statistik::laden(&state.pool, user.id(), &filter).await?;
    let mut gegner: Vec<Uuid> = laeufe
        .iter()
        .flat_map(|l| l.gegner_ids.iter().copied())
        .collect();
    gegner.sort();
    gegner.dedup();
    let namen = pressen_statistik::namen(&state.pool, &gegner).await?;
    Ok(Json(pressen_statistik::berechne(&laeufe, &namen)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaufListeQuery {
    #[serde(flatten)]
    filter: LaufFilterQuery,
    cursor: Option<String>,
    limit: Option<i64>,
    sortierung: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonDto {
    user_id: Uuid,
    /// Leer, wenn das Konto nicht mehr besteht.
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaufDto {
    id: Uuid,
    /// Leer, wenn die Übung inzwischen aufgeräumt wurde.
    session_id: Option<Uuid>,
    runde: i32,
    sitz: i32,
    modus: String,
    start_art: String,
    gegner: Vec<PersonDto>,
    team: Vec<PersonDto>,
    dauer_ms: i32,
    verschuettet_dezi: i32,
    wertung_ms: i32,
    reaktion_ms: Option<i32>,
    vorzeitig: bool,
    getruemmert: bool,
    malus_ms: i32,
    versatz_ms: i32,
    ausgang: String,
    team_wertung_ms: Option<i64>,
    gegner_wertung_ms: Option<i64>,
    gespielt_am: chrono::DateTime<chrono::Utc>,
}

async fn lauf_dtos(
    pool: &sqlx::PgPool,
    zeilen: Vec<pressen_statistik::LaufZeile>,
) -> AppResult<Vec<LaufDto>> {
    let mut ids: Vec<Uuid> = zeilen
        .iter()
        .flat_map(|l| l.gegner_ids.iter().chain(l.team_ids.iter()).copied())
        .collect();
    ids.sort();
    ids.dedup();
    let namen = pressen_statistik::namen(pool, &ids).await?;
    let personen = |ids: &[Uuid]| -> Vec<PersonDto> {
        ids.iter()
            .map(|id| PersonDto {
                user_id: *id,
                name: namen.get(id).cloned(),
            })
            .collect()
    };
    Ok(zeilen
        .into_iter()
        .map(|l| LaufDto {
            gegner: personen(&l.gegner_ids),
            team: personen(&l.team_ids),
            id: l.id,
            session_id: l.session_id,
            runde: l.runde,
            sitz: l.sitz,
            modus: l.modus,
            start_art: l.start_art,
            dauer_ms: l.dauer_ms,
            verschuettet_dezi: l.verschuettet_dezi,
            wertung_ms: l.wertung_ms,
            reaktion_ms: l.reaktion_ms,
            vorzeitig: l.vorzeitig,
            getruemmert: l.getruemmert,
            malus_ms: l.malus_ms,
            versatz_ms: l.versatz_ms,
            ausgang: l.ausgang,
            team_wertung_ms: l.team_wertung_ms,
            gegner_wertung_ms: l.gegner_wertung_ms,
            gespielt_am: l.gespielt_am,
        })
        .collect())
}

/// Eine Seite der Laufliste; `nextCursor` fehlt (null) auf der letzten.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaufSeite {
    items: Vec<LaufDto>,
    next_cursor: Option<String>,
}

/// Die eigenen Läufe, seitenweise (Cursor) und sortierbar.
async fn pressen_laeufe(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<LaufListeQuery>,
) -> AppResult<Json<LaufSeite>> {
    let sortierung = Sortierung::lesen(query.sortierung.as_deref())
        .ok_or_else(|| AppError::bad_request("Unbekannte Sortierung"))?;
    let cursor = match query.cursor.as_deref() {
        None | Some("") => None,
        Some(roh) => Some(
            pressen_statistik::cursor_lesen(roh)
                .ok_or_else(|| AppError::bad_request("Ungültiger Cursor"))?,
        ),
    };
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let filter = query.filter.filter()?;
    let (zeilen, weiter) =
        pressen_statistik::seite(&state.pool, user.id(), &filter, sortierung, cursor, limit)
            .await?;
    Ok(Json(LaufSeite {
        items: lauf_dtos(&state.pool, zeilen).await?,
        next_cursor: weiter,
    }))
}

/// Ein Lauf im Einzelnen. Fremde (und unbekannte) Läufe gibt es nicht: 404.
async fn pressen_lauf(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<LaufDto>> {
    let zeile = pressen_statistik::einzeln(&state.pool, user.id(), id)
        .await?
        .ok_or_else(|| AppError::not_found("Lauf nicht gefunden"))?;
    let mut dtos = lauf_dtos(&state.pool, vec![zeile]).await?;
    Ok(Json(dtos.remove(0)))
}
