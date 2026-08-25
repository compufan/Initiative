//! Notizen und Dokumente an einem Termin.
//!
//! Der interessante Teil sind die Notizen. Jede bestimmt selbst, wer sie
//! ändern darf – daran unterscheidet sich die Einkaufsliste, an der alle
//! mitschreiben, von der Ansprache, an der niemand herumbessert.

use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{CalendarEventRow, EventNoteRow};
use crate::dto::EventNoteDto;
use crate::error::{AppError, AppResult};

/// Wer eine Notiz ändern darf.
pub const NOTE_SCOPES: &[&str] = &["author", "members", "listed"];

/// Ist diese Person zum Termin eingeladen?
///
/// Auch der Ersteller zählt dazu, selbst wenn er sich selbst nie als
/// Teilnehmer eingetragen hat.
pub async fn is_attendee(
    pool: &PgPool,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<bool> {
    if event.created_by == Some(user_id) {
        return Ok(true);
    }
    let dabei: bool = sqlx::query_scalar(
        "select exists (select 1 from event_attendees where event_id = $1 and user_id = $2)",
    )
    .bind(event.id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if dabei {
        return Ok(true);
    }
    // Ein Termin an einem Chat gehört allen im Chat, auch wenn jemand erst
    // später dazugekommen ist.
    if let Some(conversation_id) = event.conversation_id {
        let mitglied: bool = sqlx::query_scalar(
            "select exists (
               select 1 from conversation_members where conversation_id = $1 and user_id = $2
             )",
        )
        .bind(conversation_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        return Ok(mitglied);
    }
    Ok(false)
}

/// Wirft, wenn die Person mit dem Termin nichts zu tun hat.
///
/// 404 statt 403: Ein Termin, zu dem man nicht eingeladen ist, geht einen
/// nichts an – auch nicht seine Existenz.
pub async fn assert_attendee(
    pool: &PgPool,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<()> {
    if is_attendee(pool, event, user_id).await? {
        return Ok(());
    }
    Err(AppError::not_found("Termin nicht gefunden"))
}

/// Darf diese Person diese Notiz ändern?
pub async fn may_edit_note(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: &EventNoteRow,
    user_id: Uuid,
) -> AppResult<bool> {
    // Wer sie geschrieben hat, darf sie immer ändern – sonst könnte man sich
    // mit „nur die Genannten“ selbst aussperren.
    if note.author_id == Some(user_id) {
        return Ok(true);
    }
    match note.edit_scope.as_str() {
        "members" => is_attendee(pool, event, user_id).await,
        "listed" => {
            let genannt: bool = sqlx::query_scalar(
                "select exists (
                   select 1 from event_note_editors where note_id = $1 and user_id = $2
                 )",
            )
            .bind(note.id)
            .bind(user_id)
            .fetch_one(pool)
            .await?;
            Ok(genannt)
        }
        // "author" – und alles Unbekannte, das wäre ein Datenfehler und darf
        // nicht versehentlich Rechte geben.
        _ => Ok(false),
    }
}

pub async fn note_editor_ids(pool: &PgPool, note_id: Uuid) -> AppResult<Vec<Uuid>> {
    Ok(
        sqlx::query_scalar("select user_id from event_note_editors where note_id = $1")
            .bind(note_id)
            .fetch_all(pool)
            .await?,
    )
}

pub async fn to_note_dto(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: EventNoteRow,
    viewer: Uuid,
) -> AppResult<EventNoteDto> {
    let can_edit = may_edit_note(pool, event, &note, viewer).await?;
    let editor_ids = if note.edit_scope == "listed" {
        note_editor_ids(pool, note.id).await?
    } else {
        Vec::new()
    };
    Ok(EventNoteDto {
        id: note.id,
        event_id: note.event_id,
        author_id: note.author_id,
        title: note.title,
        body: note.body,
        edit_scope: note.edit_scope,
        editor_ids,
        can_edit,
        position: note.position,
        created_at: note.created_at,
        updated_at: note.updated_at,
    })
}

pub async fn require_note(pool: &PgPool, event_id: Uuid, note_id: Uuid) -> AppResult<EventNoteRow> {
    sqlx::query_as::<_, EventNoteRow>(
        "select * from event_notes where id = $1 and event_id = $2 and deleted_at is null",
    )
    .bind(note_id)
    .bind(event_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("Notiz nicht gefunden"))
}
