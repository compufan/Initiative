//! Umfragen und Terminfindung.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{MessageRow, PollOptionRow, PollPlacementRow, PollRow, PollVoteRow};
use crate::dto::{OptionTally, PollDto, PollOptionDto, PollVoteDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

use super::expanders::{metadata_id, referenced_ids, Expansion, MessageExpander};

fn to_option_dto(row: &PollOptionRow) -> PollOptionDto {
    PollOptionDto {
        id: row.id,
        label: row.label.clone().unwrap_or_default(),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        position: row.position,
        created_by: row.created_by,
    }
}

fn to_vote_dto(row: &PollVoteRow) -> PollVoteDto {
    PollVoteDto {
        option_id: row.option_id,
        user_id: row.user_id,
        value: row.value.clone(),
        voted_at: row.voted_at,
    }
}

/// `yes` counts 1 point, `maybe` counts a half – that ranks date-poll slots.
pub fn tally(options: &[PollOptionDto], votes: &[PollVoteDto]) -> HashMap<Uuid, OptionTally> {
    let mut result: HashMap<Uuid, OptionTally> = options
        .iter()
        .map(|option| (option.id, OptionTally::default()))
        .collect();
    for vote in votes {
        if let Some(entry) = result.get_mut(&vote.option_id) {
            match vote.value.as_str() {
                "yes" => entry.yes += 1,
                "maybe" => entry.maybe += 1,
                _ => entry.no += 1,
            }
        }
    }
    for entry in result.values_mut() {
        entry.score = entry.yes as f64 + entry.maybe as f64 * 0.5;
    }
    result
}

/// Highest score wins; ties break on fewer "no" votes and then the earlier slot,
/// so every client shows the same winner.
pub fn best_option<'a>(
    options: &'a [PollOptionDto],
    tally: &HashMap<Uuid, OptionTally>,
) -> Option<&'a PollOptionDto> {
    let mut best: Option<(&PollOptionDto, OptionTally)> = None;
    for option in options {
        let Some(entry) = tally.get(&option.id).copied() else {
            continue;
        };
        match &best {
            None => best = Some((option, entry)),
            Some((current, current_entry)) => {
                let better = entry.score > current_entry.score
                    || (entry.score == current_entry.score && entry.no < current_entry.no)
                    || (entry.score == current_entry.score
                        && entry.no == current_entry.no
                        && matches!((option.starts_at, current.starts_at), (Some(a), Some(b)) if a < b));
                if better {
                    best = Some((option, entry));
                }
            }
        }
    }
    best.map(|(option, _)| option)
}

pub fn is_closed(poll: &PollRow) -> bool {
    poll.closed_at.is_some() || poll.closes_at.is_some_and(|at| at <= chrono::Utc::now())
}

pub fn to_poll_dto(
    poll: &PollRow,
    options: &[PollOptionRow],
    votes: &[PollVoteRow],
    viewer_id: Uuid,
) -> PollDto {
    let mut option_dtos: Vec<PollOptionDto> = options.iter().map(to_option_dto).collect();
    option_dtos.sort_by_key(|option| option.position);
    let vote_dtos: Vec<PollVoteDto> = votes.iter().map(to_vote_dto).collect();
    let my_votes: Vec<PollVoteDto> = vote_dtos
        .iter()
        .filter(|vote| vote.user_id == viewer_id)
        .cloned()
        .collect();
    // Anonymous polls only reveal aggregates – except to their creator.
    let reveal = !poll.anonymous || poll.created_by == Some(viewer_id);
    let voter_count = vote_dtos
        .iter()
        .map(|vote| vote.user_id)
        .collect::<HashSet<_>>()
        .len();

    PollDto {
        id: poll.id,
        conversation_id: poll.conversation_id,
        message_id: poll.message_id,
        created_by: poll.created_by,
        kind: poll.kind.clone(),
        question: poll.question.clone(),
        description: poll.description.clone(),
        multiple: poll.multiple,
        anonymous: poll.anonymous,
        allow_add_options: poll.allow_add_options,
        closes_at: poll.closes_at,
        closed_at: poll.closed_at,
        tally: tally(&option_dtos, &vote_dtos),
        voter_count,
        votes: if reveal { vote_dtos } else { Vec::new() },
        my_votes,
        options: option_dtos,
        created_event_id: poll.created_event_id,
        created_at: poll.created_at,
    }
}

pub async fn require_poll(state: &AppState, poll_id: Uuid) -> AppResult<PollRow> {
    sqlx::query_as::<_, PollRow>("select * from polls where id = $1")
        .bind(poll_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Umfrage nicht gefunden"))
}

pub async fn load_poll_dtos(
    state: &AppState,
    poll_ids: &[Uuid],
    viewer_id: Uuid,
) -> AppResult<HashMap<Uuid, PollDto>> {
    if poll_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let polls = sqlx::query_as::<_, PollRow>("select * from polls where id = any($1)")
        .bind(poll_ids)
        .fetch_all(&state.pool)
        .await?;
    let options = sqlx::query_as::<_, PollOptionRow>(
        "select * from poll_options where poll_id = any($1) order by position asc",
    )
    .bind(poll_ids)
    .fetch_all(&state.pool)
    .await?;
    let votes =
        sqlx::query_as::<_, PollVoteRow>("select * from poll_votes where poll_id = any($1)")
            .bind(poll_ids)
            .fetch_all(&state.pool)
            .await?;

    let mut options_by_poll: HashMap<Uuid, Vec<PollOptionRow>> = HashMap::new();
    for option in options {
        options_by_poll
            .entry(option.poll_id)
            .or_default()
            .push(option);
    }
    let mut votes_by_poll: HashMap<Uuid, Vec<PollVoteRow>> = HashMap::new();
    for vote in votes {
        votes_by_poll.entry(vote.poll_id).or_default().push(vote);
    }

    Ok(polls
        .into_iter()
        .map(|poll| {
            let dto = to_poll_dto(
                &poll,
                options_by_poll
                    .get(&poll.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                votes_by_poll
                    .get(&poll.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                viewer_id,
            );
            (poll.id, dto)
        })
        .collect())
}

pub async fn load_poll_dto(state: &AppState, poll_id: Uuid, viewer_id: Uuid) -> AppResult<PollDto> {
    load_poll_dtos(state, &[poll_id], viewer_id)
        .await?
        .remove(&poll_id)
        .ok_or_else(|| AppError::not_found("Umfrage nicht gefunden"))
}

pub struct NewPollOption {
    pub label: Option<String>,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ends_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub struct NewPoll {
    pub conversation_id: Uuid,
    pub created_by: Uuid,
    pub kind: String,
    pub question: String,
    pub description: Option<String>,
    pub multiple: bool,
    pub anonymous: bool,
    pub allow_add_options: bool,
    pub closes_at: Option<chrono::DateTime<chrono::Utc>>,
    pub options: Vec<NewPollOption>,
}

pub async fn create_poll(state: &AppState, input: NewPoll) -> AppResult<PollDto> {
    let poll_id = Uuid::now_v7();
    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "insert into polls (id, conversation_id, created_by, kind, question, description,
                            multiple, anonymous, allow_add_options, closes_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(poll_id)
    .bind(input.conversation_id)
    .bind(input.created_by)
    .bind(&input.kind)
    .bind(&input.question)
    .bind(&input.description)
    .bind(input.multiple)
    .bind(input.anonymous)
    .bind(input.allow_add_options)
    .bind(input.closes_at)
    .execute(&mut *tx)
    .await?;

    for (position, option) in input.options.iter().enumerate() {
        sqlx::query(
            "insert into poll_options (id, poll_id, label, starts_at, ends_at, position, created_by)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(Uuid::now_v7())
        .bind(poll_id)
        .bind(&option.label)
        .bind(option.starts_at)
        .bind(option.ends_at)
        .bind(position as i32)
        .bind(input.created_by)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let message = super::messages::create_message(
        state,
        super::messages::NewMessage::entity(
            input.conversation_id,
            input.created_by,
            "poll",
            "pollId",
            poll_id,
        ),
    )
    .await?;
    sqlx::query("update polls set message_id = $1 where id = $2")
        .bind(message.id)
        .bind(poll_id)
        .execute(&state.pool)
        .await?;

    let dto = load_poll_dto(state, poll_id, input.created_by).await?;
    broadcast_poll(state, &dto).await?;
    Ok(dto)
}

/// Replaces the viewer's votes; single-choice polls keep exactly one entry.
pub async fn set_votes(
    state: &AppState,
    poll: &PollRow,
    user_id: Uuid,
    votes: Vec<(Uuid, String)>,
) -> AppResult<()> {
    let valid: HashSet<Uuid> =
        sqlx::query_as::<_, (Uuid,)>("select id from poll_options where poll_id = $1")
            .bind(poll.id)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .map(|(id,)| id)
            .collect();

    let mut accepted: Vec<(Uuid, String)> = votes
        .into_iter()
        .filter(|(option_id, _)| valid.contains(option_id))
        .collect();
    if !poll.multiple && poll.kind != "date" {
        accepted.truncate(1);
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("delete from poll_votes where poll_id = $1 and user_id = $2")
        .bind(poll.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    for (option_id, value) in accepted {
        sqlx::query(
            "insert into poll_votes (poll_id, option_id, user_id, value) values ($1, $2, $3, $4)",
        )
        .bind(poll.id)
        .bind(option_id)
        .bind(user_id)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Pushes the updated poll to everyone and refreshes its chat card.
pub async fn broadcast_poll(state: &AppState, poll: &PollDto) -> AppResult<()> {
    // An **alle** beteiligten Chats. Eine gespiegelte Umfrage hat ein
    // gemeinsames Ergebnis; wer nur den Ursprung benachrichtigt, laesst die
    // Einzelchats mit einem veralteten Stand stehen.
    let row = require_poll(state, poll.id).await?;
    let members = poll_audience(&state.pool, &row).await?;
    for user_id in &members {
        if let Ok(view) = load_poll_dto(state, poll.id, *user_id).await {
            state
                .hub
                .publish(vec![*user_id], Event::poll_updated(&view))
                .await;
        }
    }
    // Jede Nachricht, in der die Umfrage steckt, neu ausspielen - die
    // urspruengliche und jeden Auftritt.
    let absender = poll.created_by.unwrap_or_else(Uuid::nil);
    super::messages::republish_message(state, poll.message_id, absender).await?;
    let weitere: Vec<Option<Uuid>> =
        sqlx::query_scalar("select message_id from poll_placements where poll_id = $1")
            .bind(poll.id)
            .fetch_all(&state.pool)
            .await?;
    for message_id in weitere.into_iter().flatten() {
        super::messages::republish_message(state, Some(message_id), absender).await?;
    }
    Ok(())
}

/// Embeds the referenced poll into every `poll` message.
pub struct PollExpander;

#[async_trait]
impl MessageExpander for PollExpander {
    fn key(&self) -> &'static str {
        "polls"
    }

    async fn expand(
        &self,
        state: &AppState,
        viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        let ids = referenced_ids(messages, "pollId");
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let polls = load_poll_dtos(state, &ids, viewer_id).await?;
        let mut result = HashMap::new();
        for message in messages {
            if let Some(poll_id) = metadata_id(message, "pollId") {
                if let Some(poll) = polls.get(&poll_id) {
                    result.insert(
                        message.id,
                        Expansion {
                            poll: Some(poll.clone()),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        Ok(result)
    }
}

/* ---------- Eine Umfrage, mehrere Auftritte ---------- */

/// Alle Chats, in denen diese Umfrage steht: der Ursprung plus jeder Auftritt.
///
/// Damit hat die Terminfindung **einen** Satz Vorschläge und **einen** Satz
/// Antworten, egal ob jemand im Gruppenchat, in einem Einzelchat oder am
/// Termin selbst abstimmt.
pub async fn poll_conversation_ids(pool: &PgPool, poll: &PollRow) -> AppResult<Vec<Uuid>> {
    let mut ids: Vec<Uuid> =
        sqlx::query_scalar("select conversation_id from poll_placements where poll_id = $1")
            .bind(poll.id)
            .fetch_all(pool)
            .await?;
    if !ids.contains(&poll.conversation_id) {
        ids.push(poll.conversation_id);
    }
    Ok(ids)
}

/// Darf diese Person die Umfrage sehen und mitmachen?
///
/// Es genügt, in **einem** der beteiligten Chats zu sein. Wer die Frage in
/// seinem Einzelchat bekommen hat, muss nicht auch noch in der Gruppe sein.
pub async fn assert_poll_access(pool: &PgPool, poll: &PollRow, user_id: Uuid) -> AppResult<()> {
    let erlaubt: bool = sqlx::query_scalar(
        "select exists (
           select 1 from conversation_members m
            where m.user_id = $2
              and (
                m.conversation_id = $1
                or m.conversation_id in (
                  select conversation_id from poll_placements where poll_id = $3
                )
              )
         )",
    )
    .bind(poll.conversation_id)
    .bind(user_id)
    .bind(poll.id)
    .fetch_one(pool)
    .await?;
    if erlaubt {
        return Ok(());
    }
    Err(AppError::forbidden("Diese Umfrage gehört nicht zu dir"))
}

/// Jede Person, die die Umfrage sieht – für den Rundruf.
pub async fn poll_audience(pool: &PgPool, poll: &PollRow) -> AppResult<Vec<Uuid>> {
    let ids = poll_conversation_ids(pool, poll).await?;
    let mut mitglieder: Vec<Uuid> = sqlx::query_scalar(
        "select distinct user_id from conversation_members where conversation_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    mitglieder.sort();
    mitglieder.dedup();
    Ok(mitglieder)
}

/// Stellt die Umfrage in einen weiteren Chat.
///
/// Legt dort eine Nachricht an, damit sie im Verlauf auftaucht. Steht sie dort
/// schon, passiert nichts – zweimal dieselbe Frage im selben Chat wäre nur
/// verwirrend.
pub async fn place_poll(
    state: &AppState,
    poll: &PollRow,
    conversation_id: Uuid,
    by: Uuid,
) -> AppResult<Option<PollPlacementRow>> {
    if conversation_id == poll.conversation_id {
        return Ok(None);
    }
    let vorhanden: Option<PollPlacementRow> =
        sqlx::query_as("select * from poll_placements where poll_id = $1 and conversation_id = $2")
            .bind(poll.id)
            .bind(conversation_id)
            .fetch_optional(&state.pool)
            .await?;
    if vorhanden.is_some() {
        return Ok(vorhanden);
    }

    let message = super::messages::create_message(
        state,
        super::messages::NewMessage::entity(conversation_id, by, "poll", "pollId", poll.id),
    )
    .await?;

    let row = sqlx::query_as::<_, PollPlacementRow>(
        "insert into poll_placements (id, poll_id, conversation_id, message_id, created_by)
         values ($1, $2, $3, $4, $5)
         on conflict (poll_id, conversation_id) do update set message_id = excluded.message_id
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(poll.id)
    .bind(conversation_id)
    .bind(message.id)
    .bind(by)
    .fetch_one(&state.pool)
    .await?;
    Ok(Some(row))
}

/// Nimmt einen Auftritt zurück und löscht die zugehörige Nachricht.
pub async fn unplace_poll(state: &AppState, poll: &PollRow, placement_id: Uuid) -> AppResult<()> {
    let row: Option<PollPlacementRow> =
        sqlx::query_as("select * from poll_placements where id = $1 and poll_id = $2")
            .bind(placement_id)
            .bind(poll.id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(row) = row else { return Ok(()) };

    if let Some(message_id) = row.message_id {
        sqlx::query("update messages set deleted_at = now() where id = $1")
            .bind(message_id)
            .execute(&state.pool)
            .await?;
    }
    sqlx::query("delete from poll_placements where id = $1")
        .bind(placement_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: Uuid, position: i32, starts_at: Option<i64>) -> PollOptionDto {
        PollOptionDto {
            id,
            label: format!("Option {position}"),
            starts_at: starts_at
                .map(|offset| chrono::DateTime::UNIX_EPOCH + chrono::Duration::seconds(offset)),
            ends_at: None,
            position,
            created_by: None,
        }
    }

    fn vote(option_id: Uuid, user: u8, value: &str) -> PollVoteDto {
        PollVoteDto {
            option_id,
            user_id: Uuid::from_u128(user as u128),
            value: value.to_string(),
            voted_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn counts_yes_maybe_and_no() {
        let a = Uuid::now_v7();
        let options = vec![option(a, 0, None)];
        let votes = vec![vote(a, 1, "yes"), vote(a, 2, "maybe"), vote(a, 3, "no")];
        let result = tally(&options, &votes);
        let entry = result[&a];
        assert_eq!((entry.yes, entry.maybe, entry.no), (1, 1, 1));
        assert_eq!(entry.score, 1.5);
    }

    #[test]
    fn picks_the_earlier_slot_when_scores_tie() {
        let early = Uuid::now_v7();
        let late = Uuid::now_v7();
        let options = vec![option(late, 0, Some(2000)), option(early, 1, Some(1000))];
        let votes = vec![vote(early, 1, "yes"), vote(late, 2, "yes")];
        let result = tally(&options, &votes);
        assert_eq!(best_option(&options, &result).unwrap().id, early);
    }

    #[test]
    fn prefers_fewer_rejections_on_equal_score() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let options = vec![option(a, 0, None), option(b, 1, None)];
        let votes = vec![vote(a, 1, "yes"), vote(a, 2, "no"), vote(b, 3, "yes")];
        let result = tally(&options, &votes);
        assert_eq!(best_option(&options, &result).unwrap().id, b);
    }
}
