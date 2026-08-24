//! Mini-game engine.
//!
//! Rules live on the server so a client can never fake a move. Adding a game
//! means one file here plus one line in [`registry`] – the messenger, the
//! transport and the database stay untouched.

pub mod connect_four;
pub mod tic_tac_toe;

use std::sync::LazyLock;

use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub struct GameSeat {
    pub seat: i32,
    pub user_id: Uuid,
}

pub struct MoveContext<'a> {
    pub seat: i32,
    pub user_id: Uuid,
    pub players: &'a [GameSeat],
}

#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub finished: bool,
    pub draw: bool,
    /// Seat indexes that won; empty on draws or while the match is running.
    pub winner_seats: Vec<i32>,
}

pub trait GameDefinition: Send + Sync {
    fn key(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn emoji(&self) -> &'static str;
    fn min_players(&self) -> usize;
    fn max_players(&self) -> usize;

    fn initial_state(&self, players: &[GameSeat]) -> Value;
    /// Validates and applies one move. `Err` carries a message for the player.
    fn apply_move(&self, state: &Value, mv: &Value, ctx: &MoveContext<'_>) -> Result<Value, String>;
    /// Seat that has to move next, or `None` when nobody has to.
    fn current_seat(&self, state: &Value) -> Option<i32>;
    fn outcome(&self, state: &Value) -> Outcome;
    /// One-line summary for the chat bubble and push notifications.
    fn describe(&self, state: &Value) -> String;
}

static REGISTRY: LazyLock<Vec<Box<dyn GameDefinition>>> = LazyLock::new(|| {
    vec![
        Box::new(tic_tac_toe::TicTacToe) as Box<dyn GameDefinition>,
        Box::new(connect_four::ConnectFour) as Box<dyn GameDefinition>,
    ]
});

pub fn list_games() -> &'static [Box<dyn GameDefinition>] {
    &REGISTRY
}

pub fn get_game(key: &str) -> Option<&'static dyn GameDefinition> {
    REGISTRY
        .iter()
        .find(|game| game.key() == key)
        .map(|game| game.as_ref())
}

pub fn user_of_seat(players: &[GameSeat], seat: Option<i32>) -> Option<Uuid> {
    let seat = seat?;
    players
        .iter()
        .find(|player| player.seat == seat)
        .map(|player| player.user_id)
}

pub fn seat_of(players: &[GameSeat], user_id: Uuid) -> Option<i32> {
    players
        .iter()
        .find(|player| player.user_id == user_id)
        .map(|player| player.seat)
}
