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

/// Beim Abhaken gibt es eine Stufe mehr: `nobody` fuer eine Liste, die nur
/// gelesen wird.
pub const CHECK_SCOPES: &[&str] = &["nobody", "author", "members", "listed"];

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

/// Die namentlich Benannten für ein Recht: `edit`, `add` oder `check`.
pub async fn note_editor_ids(pool: &PgPool, note_id: Uuid, rolle: &str) -> AppResult<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        "select user_id from event_note_editors where note_id = $1 and role = $2",
    )
    .bind(note_id)
    .bind(rolle)
    .fetch_all(pool)
    .await?)
}

/// Darf diese Person das, was `scope` beschreibt?
///
/// Drei Rechte, eine Regel – geschrieben statt dreimal abgeschrieben. Bei
/// einer Liste fallen „ändern“, „hinzufügen“ und „abhaken“ auseinander: An
/// einer Packliste dürfen alle abhaken, aber nur der Verfasser Punkte
/// ergänzen, sonst steht am Abreisetag eine Liste da, die niemand mehr
/// überblickt.
async fn erlaubt(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: &EventNoteRow,
    user_id: Uuid,
    scope: &str,
    rolle: &str,
) -> AppResult<bool> {
    // Der Verfasser darf alles an seiner Notiz – sonst könnte er sich mit
    // „nur die Genannten“ selbst aussperren.
    if note.author_id == Some(user_id) {
        return Ok(true);
    }
    match scope {
        "members" => is_attendee(pool, event, user_id).await,
        "listed" => Ok(sqlx::query_scalar::<_, bool>(
            "select exists (
               select 1 from event_note_editors
                where note_id = $1 and user_id = $2 and role = $3
             )",
        )
        .bind(note.id)
        .bind(user_id)
        .bind(rolle)
        .fetch_one(pool)
        .await?),
        // "author", "nobody" – und alles Unbekannte, das wäre ein Datenfehler
        // und darf nicht versehentlich Rechte geben.
        _ => Ok(false),
    }
}

pub async fn may_add_item(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: &EventNoteRow,
    user_id: Uuid,
) -> AppResult<bool> {
    erlaubt(pool, event, note, user_id, &note.add_scope, "add").await
}

pub async fn may_check_item(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: &EventNoteRow,
    user_id: Uuid,
) -> AppResult<bool> {
    // `nobody` gilt auch für den Verfasser: Eine Liste zum Nachlesen soll
    // niemand versehentlich abhaken – auch er nicht.
    if note.check_scope == "nobody" {
        return Ok(false);
    }
    erlaubt(pool, event, note, user_id, &note.check_scope, "check").await
}

/// Wie viele Leute sind eingeladen? Das ist die Zahl hinter „alle“.
///
/// Bewusst jedes Mal frisch gezählt und nicht am Punkt festgeschrieben:
/// „Alle“ soll mitwachsen. Wer morgen eingeladen wird, muss ebenfalls abhaken.
pub async fn attendee_count(pool: &PgPool, event: &CalendarEventRow) -> AppResult<i64> {
    let am_termin: i64 =
        sqlx::query_scalar("select count(*) from event_attendees where event_id = $1")
            .bind(event.id)
            .fetch_one(pool)
            .await?;
    if am_termin > 0 {
        return Ok(am_termin);
    }
    // Ohne eigene Teilnehmerliste sind es alle im Chat des Termins.
    match event.conversation_id {
        Some(conversation_id) => Ok(sqlx::query_scalar(
            "select count(*) from conversation_members where conversation_id = $1",
        )
        .bind(conversation_id)
        .fetch_one(pool)
        .await?),
        None => Ok(1),
    }
}

/// Die Punkte einer Liste, samt Haken.
pub async fn note_items(
    pool: &PgPool,
    note_id: Uuid,
    viewer: Uuid,
    eingeladene: i64,
) -> AppResult<Vec<crate::dto::EventNoteItemDto>> {
    let rows = sqlx::query_as::<_, crate::db::EventNoteItemRow>(
        "select * from event_note_items where note_id = $1 order by position, created_at",
    )
    .bind(note_id)
    .fetch_all(pool)
    .await?;

    let mut punkte = Vec::with_capacity(rows.len());
    for row in rows {
        let checked_by: Vec<Uuid> = sqlx::query_scalar(
            "select user_id from event_note_checks where item_id = $1 order by checked_at",
        )
        .bind(row.id)
        .fetch_all(pool)
        .await?;

        // „Alle“ wird hier aufgelöst, nicht in der Oberfläche: Die Zahl hängt
        // an der Einladungsliste, und die kennt nur der Server verlässlich.
        let needed = if row.required_all {
            eingeladene.max(0) as i32
        } else {
            row.required_checks
        };
        punkte.push(crate::dto::EventNoteItemDto {
            id: row.id,
            text: row.text,
            position: row.position,
            required_checks: row.required_checks,
            required_all: row.required_all,
            checked_by_me: checked_by.contains(&viewer),
            done: needed > 0 && checked_by.len() as i32 >= needed,
            checked_by,
            needed,
        });
    }
    Ok(punkte)
}

pub async fn to_note_dto(
    pool: &PgPool,
    event: &CalendarEventRow,
    note: EventNoteRow,
    viewer: Uuid,
) -> AppResult<EventNoteDto> {
    let can_edit = may_edit_note(pool, event, &note, viewer).await?;
    let can_add = may_add_item(pool, event, &note, viewer).await?;
    let can_check = may_check_item(pool, event, &note, viewer).await?;

    let benannte = |scope: &str, rolle: &'static str| {
        let listed = scope == "listed";
        async move {
            if listed {
                note_editor_ids(pool, note.id, rolle).await
            } else {
                Ok(Vec::new())
            }
        }
    };
    let editor_ids = benannte(&note.edit_scope, "edit").await?;
    let adder_ids = benannte(&note.add_scope, "add").await?;
    let checker_ids = benannte(&note.check_scope, "check").await?;

    let eingeladene = attendee_count(pool, event).await?;
    let items = note_items(pool, note.id, viewer, eingeladene).await?;

    Ok(EventNoteDto {
        id: note.id,
        event_id: note.event_id,
        author_id: note.author_id,
        title: note.title,
        body: note.body,
        edit_scope: note.edit_scope,
        add_scope: note.add_scope,
        check_scope: note.check_scope,
        editor_ids,
        adder_ids,
        checker_ids,
        can_edit,
        can_add,
        can_check,
        items,
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
