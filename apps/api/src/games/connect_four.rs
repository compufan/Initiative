//! Vier gewinnt.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{GameDefinition, GameSeat, MoveContext, Outcome};

pub const COLS: usize = 7;
pub const ROWS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Column-major stacks; index 0 is the bottom of a column.
    pub columns: Vec<Vec<i32>>,
    pub turn: i32,
    pub winner: Option<i32>,
    pub draw: bool,
    pub last_move: Option<LastMove>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastMove {
    pub col: usize,
    pub row: usize,
}

#[derive(Debug, Deserialize)]
struct Move {
    col: usize,
}

fn cell_at(columns: &[Vec<i32>], col: isize, row: isize) -> Option<i32> {
    if col < 0 || row < 0 {
        return None;
    }
    columns
        .get(col as usize)
        .and_then(|column| column.get(row as usize))
        .copied()
}

fn has_four(columns: &[Vec<i32>], col: usize, row: usize, seat: i32) -> bool {
    const DIRECTIONS: [(isize, isize); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
    for (dc, dr) in DIRECTIONS {
        let mut count = 1;
        for sign in [1isize, -1] {
            let mut c = col as isize + dc * sign;
            let mut r = row as isize + dr * sign;
            while cell_at(columns, c, r) == Some(seat) {
                count += 1;
                c += dc * sign;
                r += dr * sign;
            }
        }
        if count >= 4 {
            return true;
        }
    }
    false
}

pub struct ConnectFour;

impl GameDefinition for ConnectFour {
    fn key(&self) -> &'static str { "connect-four" }
    fn name(&self) -> &'static str { "Vier gewinnt" }
    fn description(&self) -> &'static str {
        "Vier Steine in einer Reihe – waagerecht, senkrecht oder diagonal."
    }
    fn emoji(&self) -> &'static str { "🔴" }
    fn min_players(&self) -> usize { 2 }
    fn max_players(&self) -> usize { 2 }

    fn initial_state(&self, _players: &[GameSeat]) -> Value {
        serde_json::to_value(State {
            columns: vec![Vec::new(); COLS],
            turn: 0,
            winner: None,
            draw: false,
            last_move: None,
        })
        .expect("state serialises")
    }

    fn apply_move(&self, state: &Value, mv: &Value, ctx: &MoveContext<'_>) -> Result<Value, String> {
        let state: State =
            serde_json::from_value(state.clone()).map_err(|_| "Ungültiger Spielstand".to_string())?;
        let mv: Move =
            serde_json::from_value(mv.clone()).map_err(|_| "Ungültiger Zug".to_string())?;

        if state.winner.is_some() || state.draw {
            return Err("Das Spiel ist beendet.".into());
        }
        if ctx.seat != state.turn {
            return Err("Du bist nicht am Zug.".into());
        }
        if mv.col >= COLS {
            return Err("Ungültige Spalte.".into());
        }
        if state.columns[mv.col].len() >= ROWS {
            return Err("Spalte ist voll.".into());
        }

        let mut columns = state.columns.clone();
        columns[mv.col].push(ctx.seat);
        let row = columns[mv.col].len() - 1;

        let won = has_four(&columns, mv.col, row, ctx.seat);
        let full = columns.iter().all(|column| column.len() >= ROWS);
        let turn = if won || full {
            state.turn
        } else if state.turn == 0 {
            1
        } else {
            0
        };

        serde_json::to_value(State {
            columns,
            turn,
            winner: if won { Some(ctx.seat) } else { None },
            draw: !won && full,
            last_move: Some(LastMove { col: mv.col, row }),
        })
        .map_err(|_| "Spielstand konnte nicht gespeichert werden".to_string())
    }

    fn current_seat(&self, state: &Value) -> Option<i32> {
        let state: State = serde_json::from_value(state.clone()).ok()?;
        if state.winner.is_none() && !state.draw { Some(state.turn) } else { None }
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

    #[test]
    fn detects_a_vertical_win() {
        let game = ConnectFour;
        let players = vec![
            GameSeat { seat: 0, user_id: Uuid::now_v7() },
            GameSeat { seat: 1, user_id: Uuid::now_v7() },
        ];
        let mut state = game.initial_state(&players);

        // Seat 0 stacks column 0, seat 1 answers in column 1.
        for (index, col) in [0usize, 1, 0, 1, 0, 1, 0].iter().enumerate() {
            let seat = (index % 2) as i32;
            let ctx = MoveContext { seat, user_id: players[seat as usize].user_id, players: &players };
            state = game
                .apply_move(&state, &serde_json::json!({ "col": col }), &ctx)
                .expect("legal move");
        }

        let outcome = game.outcome(&state);
        assert!(outcome.finished);
        assert_eq!(outcome.winner_seats, vec![0]);
    }

    #[test]
    fn rejects_a_full_column() {
        let game = ConnectFour;
        let players = vec![
            GameSeat { seat: 0, user_id: Uuid::now_v7() },
            GameSeat { seat: 1, user_id: Uuid::now_v7() },
        ];
        let mut state = game.initial_state(&players);
        // Fill column 3 alternately; the 7th drop must be refused.
        for index in 0..ROWS {
            let seat = (index % 2) as i32;
            let ctx = MoveContext { seat, user_id: players[seat as usize].user_id, players: &players };
            state = game
                .apply_move(&state, &serde_json::json!({ "col": 3 }), &ctx)
                .expect("legal move");
        }
        let seat = (ROWS % 2) as i32;
        let ctx = MoveContext { seat, user_id: players[seat as usize].user_id, players: &players };
        assert!(game.apply_move(&state, &serde_json::json!({ "col": 3 }), &ctx).is_err());
    }
}
