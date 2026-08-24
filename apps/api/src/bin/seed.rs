//! Demo-Daten für die lokale Entwicklung.
//!
//! `cargo run --manifest-path apps/api/Cargo.toml --bin seed`
//!
//! Legt drei Benutzer (Passwort `passwort123`), einen Gruppen- und einen
//! Direktchat, Nachrichten, eine Umfrage, eine Terminfindung, einen Termin und
//! eine laufende Partie Tic Tac Toe an. Mehrfache Läufe ändern nichts.

use std::collections::HashMap;

use chrono::{Duration, Utc};
use initiative_api::auth::password::{hash_password, random_token};
use initiative_api::config::Config;
use initiative_api::db::UserRow;
use initiative_api::services::calendar::{create_event, NewEvent};
use initiative_api::services::games::create_session;
use initiative_api::services::messages::{create_message, NewMessage};
use initiative_api::services::polls::{create_poll, set_votes, NewPoll, NewPollOption};
use initiative_api::state::AppState;
use initiative_api::MIGRATOR;
use uuid::Uuid;

const PASSWORD: &str = "passwort123";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if dotenvy::dotenv().is_err() {
        let _ = dotenvy::from_filename("apps/api/.env");
    }
    let config = Config::from_env()?;
    let state = AppState::new(config).await?;
    MIGRATOR.run(&state.pool).await?;

    let anna = ensure_user(&state, "anna", "Anna Berger").await?;
    let ben = ensure_user(&state, "ben", "Ben Kraus").await?;
    let clara = ensure_user(&state, "clara", "Clara Weiss").await?;

    if sqlx::query_scalar::<_, i64>("select count(*)::bigint from conversations")
        .fetch_one(&state.pool)
        .await?
        > 0
    {
        println!("Demo-Daten existieren bereits – nichts zu tun.");
        println!("Anmelden mit anna / ben / clara und Passwort {PASSWORD}");
        return Ok(());
    }

    let group = create_conversation(
        &state,
        "group",
        Some("Wandergruppe"),
        anna,
        &[anna, ben, clara],
    )
    .await?;
    let direct = create_conversation(&state, "direct", None, anna, &[anna, ben]).await?;

    for (sender, text) in [
        (anna, "Servus zusammen! Wollen wir am Wochenende wandern?"),
        (ben, "Klingt gut – ich bin dabei 🥾"),
        (clara, "Ich auch, aber bitte nicht zu früh los."),
    ] {
        create_message(&state, NewMessage::text(group, sender, text)).await?;
    }
    create_message(
        &state,
        NewMessage::text(direct, ben, "Bringst du die Karte mit?"),
    )
    .await?;

    let poll = create_poll(
        &state,
        NewPoll {
            conversation_id: group,
            created_by: anna,
            kind: "choice".into(),
            question: "Welche Route nehmen wir?".into(),
            description: None,
            multiple: false,
            anonymous: false,
            allow_add_options: true,
            closes_at: None,
            options: vec![
                option("Über den Grat (schwer)"),
                option("Am See entlang (leicht)"),
                option("Rundweg (mittel)"),
            ],
        },
    )
    .await?;
    if let Some(easy) = poll.options.get(1) {
        let row = initiative_api::services::polls::require_poll(&state, poll.id).await?;
        set_votes(&state, &row, ben, vec![(easy.id, "yes".into())]).await?;
        set_votes(&state, &row, clara, vec![(easy.id, "yes".into())]).await?;
    }

    let saturday = next_weekday(6).with_time(chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    let date_poll = create_poll(
        &state,
        NewPoll {
            conversation_id: group,
            created_by: anna,
            kind: "date".into(),
            question: "Wann passt es euch?".into(),
            description: Some("Dauer ca. 4 Stunden".into()),
            multiple: true,
            anonymous: false,
            allow_add_options: true,
            closes_at: None,
            options: vec![
                slot(saturday, 0),
                slot(saturday, 1),
                slot(saturday, 7),
            ],
        },
    )
    .await?;
    if let Some(first) = date_poll.options.first() {
        let row = initiative_api::services::polls::require_poll(&state, date_poll.id).await?;
        set_votes(&state, &row, ben, vec![(first.id, "yes".into())]).await?;
        set_votes(&state, &row, clara, vec![(first.id, "maybe".into())]).await?;
    }

    let starts_at = Utc::now() + Duration::days(3);
    create_event(
        &state,
        NewEvent {
            conversation_id: Some(group),
            created_by: anna,
            title: "Ausrüstung checken".into(),
            description: Some("Kurzes Treffen vor der Tour".into()),
            location: Some("Bei Anna".into()),
            starts_at,
            ends_at: starts_at + Duration::hours(1),
            all_day: false,
            rrule: None,
            color: Some("#6d7cff".into()),
            reminder_minutes: vec![60],
            source_poll_id: None,
            attendee_ids: vec![ben, clara],
            attendee_statuses: HashMap::new(),
            announce: Some(true),
        },
    )
    .await?;

    create_session(&state, direct, "tic-tac-toe", anna, &[ben]).await?;

    println!("Demo-Daten angelegt.");
    println!("Anmelden mit anna, ben oder clara – Passwort: {PASSWORD}");
    Ok(())
}

fn option(label: &str) -> NewPollOption {
    NewPollOption { label: Some(label.to_string()), starts_at: None, ends_at: None }
}

fn slot(base: chrono::DateTime<Utc>, offset_days: i64) -> NewPollOption {
    let starts_at = base + Duration::days(offset_days);
    NewPollOption {
        label: None,
        starts_at: Some(starts_at),
        ends_at: Some(starts_at + Duration::hours(4)),
    }
}

/// Next occurrence of the given weekday (0 = Sunday), at midnight UTC.
fn next_weekday(weekday: u32) -> chrono::DateTime<Utc> {
    let today = Utc::now().date_naive();
    let current = chrono::Datelike::weekday(&today).num_days_from_sunday();
    let delta = ((weekday + 7 - current) % 7).max(1) as i64;
    (today + Duration::days(delta))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
}

trait WithTime {
    fn with_time(self, time: chrono::NaiveTime) -> chrono::DateTime<Utc>;
}

impl WithTime for chrono::DateTime<Utc> {
    fn with_time(self, time: chrono::NaiveTime) -> chrono::DateTime<Utc> {
        self.date_naive().and_time(time).and_utc()
    }
}

async fn ensure_user(
    state: &AppState,
    username: &str,
    display_name: &str,
) -> Result<Uuid, Box<dyn std::error::Error>> {
    if let Some(existing) = sqlx::query_as::<_, UserRow>("select * from users where username = $1")
        .bind(username)
        .fetch_optional(&state.pool)
        .await?
    {
        return Ok(existing.id);
    }
    let row = sqlx::query_as::<_, UserRow>(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         values ($1, $2, $3, $4, $5) returning *",
    )
    .bind(Uuid::now_v7())
    .bind(username)
    .bind(display_name)
    .bind(hash_password(PASSWORD)?)
    .bind(random_token(24))
    .fetch_one(&state.pool)
    .await?;
    Ok(row.id)
}

async fn create_conversation(
    state: &AppState,
    kind: &str,
    title: Option<&str>,
    owner: Uuid,
    members: &[Uuid],
) -> Result<Uuid, Box<dyn std::error::Error>> {
    let id = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, title, created_by) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(kind)
        .bind(title)
        .bind(owner)
        .execute(&state.pool)
        .await?;
    for member in members {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id, role) values ($1, $2, $3)",
        )
        .bind(id)
        .bind(member)
        .bind(if *member == owner { "owner" } else { "member" })
        .execute(&state.pool)
        .await?;
    }
    Ok(id)
}
