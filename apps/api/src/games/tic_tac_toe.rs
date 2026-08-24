//! Drei in einer Reihe.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{GameDefinition, GameSeat, MoveContext, Outcome};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub board: Vec<Option<i32>>,
    pub turn: i32,
    pub winner: Option<i32>,
    pub draw: bool,
    /// Indexes of the winning line, for highlighting.
    pub line: Option<Vec<usize>>,
}

#[derive(Debug, Deserialize)]
struct Move {
    cell: usize,
}

const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

pub struct TicTacToe;

impl GameDefinition for TicTacToe {
    fn key(&self) -> &'static str {
        "tic-tac-toe"
    }
    fn name(&self) -> &'static str {
        "Tic Tac Toe"
    }
    fn description(&self) -> &'static str {
        "Drei in einer Reihe – der Klassiker für zwischendurch."
    }
    fn emoji(&self) -> &'static str {
        "⭕"
    }
    fn min_players(&self) -> usize {
        2
    }
    fn max_players(&self) -> usize {
        2
    }

    fn initial_state(&self, _players: &[GameSeat]) -> Value {
        serde_json::to_value(State {
            board: vec![None; 9],
            turn: 0,
            winner: None,
            draw: false,
            line: None,
        })
        .expect("state serialises")
    }

    fn apply_move(
        &self,
        state: &Value,
        mv: &Value,
        ctx: &MoveContext<'_>,
    ) -> Result<Value, String> {
        let state: State = serde_json::from_value(state.clone())
            .map_err(|_| "Ungültiger Spielstand".to_string())?;
        let mv: Move =
            serde_json::from_value(mv.clone()).map_err(|_| "Ungültiger Zug".to_string())?;

        if state.winner.is_some() || state.draw {
            return Err("Das Spiel ist beendet.".into());
        }
        if ctx.seat != state.turn {
            return Err("Du bist nicht am Zug.".into());
        }
        if mv.cell > 8 {
            return Err("Ungültiger Zug".into());
        }
        if state.board[mv.cell].is_some() {
            return Err("Feld ist bereits belegt.".into());
        }

        let mut board = state.board.clone();
        board[mv.cell] = Some(ctx.seat);

        let mut winner = None;
        let mut line = None;
        for candidate in LINES.iter() {
            let [a, b, c] = *candidate;
            if board[a].is_some() && board[a] == board[b] && board[a] == board[c] {
                winner = board[a];
                line = Some(candidate.to_vec());
                break;
            }
        }
        let draw = winner.is_none() && board.iter().all(Option::is_some);
        let turn = if winner.is_none() && !draw {
            if state.turn == 0 {
                1
            } else {
                0
            }
        } else {
            state.turn
        };

        serde_json::to_value(State {
            board,
            turn,
            winner,
            draw,
            line,
        })
        .map_err(|_| "Spielstand konnte nicht gespeichert werden".to_string())
    }

    fn current_seat(&self, state: &Value) -> Option<i32> {
        let state: State = serde_json::from_value(state.clone()).ok()?;
        if state.winner.is_none() && !state.draw {
            Some(state.turn)
        } else {
            None
        }
    }

    fn outcome(&self, state: &Value) -> Outcome {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return Outcome::default();
        };
        Outcome {
            finished: state.winner.is_some() || state.draw,
            draw: state.draw,
            winner_seats: state.winner.into_iter().collect(),
        }
    }

    fn describe(&self, state: &Value) -> String {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return "Spiel".to_string();
        };
        match (state.winner, state.draw) {
            (Some(seat), _) => format!("Sieg für Spieler {}", seat + 1),
            (None, true) => "Unentschieden".to_string(),
            _ => format!("Spieler {} ist am Zug", state.turn + 1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn seats() -> Vec<GameSeat> {
        vec![
            GameSeat {
                seat: 0,
                user_id: Uuid::now_v7(),
            },
            GameSeat {
                seat: 1,
                user_id: Uuid::now_v7(),
            },
        ]
    }

    #[test]
    fn plays_a_full_game() {
        let game = TicTacToe;
        let players = seats();
        let mut state = game.initial_state(&players);

        for (index, cell) in [0usize, 3, 1, 4, 2].iter().enumerate() {
            let seat = (index % 2) as i32;
            let ctx = MoveContext {
                seat,
                user_id: players[seat as usize].user_id,
                players: &players,
            };
            state = game
                .apply_move(&state, &serde_json::json!({ "cell": cell }), &ctx)
                .expect("legal move");
        }

        let outcome = game.outcome(&state);
        assert!(outcome.finished);
        assert_eq!(outcome.winner_seats, vec![0]);
        assert!(game.current_seat(&state).is_none());
    }

    #[test]
    fn rejects_playing_out_of_turn_and_occupied_cells() {
        let game = TicTacToe;
        let players = seats();
        let state = game.initial_state(&players);

        let wrong = MoveContext {
            seat: 1,
            user_id: players[1].user_id,
            players: &players,
        };
        assert!(game
            .apply_move(&state, &serde_json::json!({ "cell": 0 }), &wrong)
            .is_err());

        let right = MoveContext {
            seat: 0,
            user_id: players[0].user_id,
            players: &players,
        };
        let state = game
            .apply_move(&state, &serde_json::json!({ "cell": 0 }), &right)
            .unwrap();

        let second = MoveContext {
            seat: 1,
            user_id: players[1].user_id,
            players: &players,
        };
        assert!(game
            .apply_move(&state, &serde_json::json!({ "cell": 0 }), &second)
            .is_err());
        assert!(game
            .apply_move(&state, &serde_json::json!({ "cell": 99 }), &second)
            .is_err());
        assert!(game
            .apply_move(&state, &serde_json::json!({ "nope": 1 }), &second)
            .is_err());
    }
}
