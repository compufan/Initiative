//! Termine, Zu-/Absagen und Kalender-Abonnement (ICS).

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{
    EVENT_CLIENT_ID_MAX, EVENT_DESCRIPTION_MAX, EVENT_LOCATION_MAX, EVENT_TITLE_MAX,
    POLL_OPTIONS_MAX, RSVP_STATUSES,
};
use crate::db::{AttachmentRow, CalendarEventRow, EventAttachmentRow, EventNoteRow, UserRow};
use crate::drossel::regeln;
use crate::dto::{
    CalendarEventDto, EventAttachmentDto, EventNoteDto, ListResult, TerminAntwort, ZustellungDto,
    ZustellungStandDto,
};
use crate::error::{AppError, AppResult};
use crate::ical::{build_calendar, IcsCalendar, IcsEvent};
use crate::modules::double_option;
use crate::realtime::Event;
use crate::recurrence::expand_occurrences;
use crate::services::attachments::to_attachment_dto;
use crate::services::calendar::{
    anlegen, broadcast_event, create_event, empfaenger_des_termins, load_event_dto,
    load_events_for_user, melde_termin, require_event, wesentlich_geaendert, NewEvent,
};
use crate::services::conversations::{assert_membership, neue_chats_melden};
use crate::services::einladen::{self, Einladungswunsch, Geaendert, Wunsch};
use crate::services::events::{
    assert_attendee, may_edit_note, require_note, to_note_dto, CHECK_SCOPES, NOTE_SCOPES,
};
use crate::services::notify::{
    benachrichtige_einladung, benachrichtige_termin, Aenderung, TerminAnlass,
};
use crate::services::permissions::{require_collection, Level};
use crate::services::polls::{
    best_option, broadcast_poll, create_poll, load_poll_dto, place_poll, require_poll, NewPoll,
    NewPollOption,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/calendar/events", get(list).post(create))
        .route(
            "/calendar/events/{id}",
            get(by_id).patch(update).delete(remove),
        )
        .route("/calendar/events/{id}/rsvp", post(rsvp))
        .route(
            "/calendar/events/{id}/attendees/{user_id}",
            delete(ausladen),
        )
        // Wo der Termin als Karte steht – und das Nachholen, was nicht ankam.
        .route("/calendar/events/{id}/zustellung", get(zustellung_lesen))
        .route(
            "/calendar/events/{id}/zustellung/nachliefern",
            post(zustellung_nachliefern),
        )
        .route("/calendar/events/{id}/occurrences", get(occurrences))
        .route("/calendar/events/{id}/event.ics", get(event_ics))
        .route("/calendar/{token}/feed.ics", get(feed_ics))
        // Termin, dessen Zeitpunkt noch abgestimmt wird.
        .route("/calendar/planning", post(create_planning))
        .route("/calendar/events/{id}/notes", get(notes).post(create_note))
        .route(
            "/calendar/events/{id}/notes/{note_id}",
            patch(update_note).delete(remove_note),
        )
        .route(
            "/calendar/events/{id}/notes/{note_id}/items",
            post(add_item),
        )
        .route(
            "/calendar/events/{id}/notes/{note_id}/items/{item_id}",
            patch(update_item).delete(remove_item),
        )
        .route(
            "/calendar/events/{id}/notes/{note_id}/items/{item_id}/check",
            post(toggle_check),
        )
        .route(
            "/calendar/events/{id}/documents",
            get(documents).post(add_document),
        )
        .route(
            "/calendar/events/{id}/documents/{document_id}",
            delete(remove_document),
        )
        .route("/calendar/events/{id}/collection", patch(link_collection))
        .route("/calendar/events/{id}/confirm", post(confirm_event))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    conversation_id: Option<Uuid>,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<CalendarEventDto>>> {
    if let Some(conversation_id) = query.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }
    let items = load_events_for_user(
        &state,
        user.id(),
        query.from,
        query.to,
        query.conversation_id,
    )
    .await?;
    Ok(Json(ListResult::new(items)))
}

/// Wie eine Einladung zugestellt wird – siehe `services::einladen`.
///
/// Fehlt das Feld ganz, gilt der alte Weg: `conversationId` bestimmt den Chat,
/// alle seine Mitglieder werden eingeladen, eine Karte kommt dorthin. Mit dem
/// Feld ist `attendeeIds` die **volle** Liste (ohne den Ersteller), und leer
/// heisst: niemand.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZustellungInput {
    /// `false`: niemand bekommt eine Karte oder Benachrichtigung; nur Kalender.
    #[serde(default = "wahr")]
    senden: bool,
    /// Karte in die Einzelchats.
    #[serde(default = "wahr")]
    einzelchats: bool,
    /// Gruppenchats, in die die Karte soll. Höchstens zehn.
    #[serde(default)]
    gruppen_chat_ids: Vec<Uuid>,
}

fn wahr() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateEventInput {
    conversation_id: Option<Uuid>,
    title: String,
    description: Option<String>,
    location: Option<String>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    #[serde(default)]
    all_day: bool,
    rrule: Option<String>,
    color: Option<String>,
    #[serde(default)]
    reminder_minutes: Vec<i32>,
    #[serde(default)]
    attendee_ids: Vec<Uuid>,
    announce: Option<bool>,
    zustellung: Option<ZustellungInput>,
    /// Wiederholungsschutz: Wer denselben Schlüssel noch einmal schickt
    /// (Funkloch, Doppeltipp), bekommt den schon angelegten Termin zurück.
    client_id: Option<String>,
}

fn validate_event(
    title: &str,
    description: Option<&str>,
    location: Option<&str>,
    starts: DateTime<Utc>,
    ends: DateTime<Utc>,
) -> AppResult<()> {
    let mut validator = Validator::new();
    validator.length("title", title, 1, EVENT_TITLE_MAX);
    if let Some(description) = description {
        validator.length("description", description, 0, EVENT_DESCRIPTION_MAX);
    }
    // Der Ort steckt in jeder Karte und jeder Chatliste der Eingeladenen: Ohne
    // Grenze trüge ein Fremder mit einer Einladung Megabytes in fremde Chats.
    if let Some(location) = location {
        validator.length("location", location, 0, EVENT_LOCATION_MAX);
    }
    validator.require("endsAt", ends >= starts, "Ende liegt vor dem Beginn");
    validator.finish()
}

const NUR_ERSTELLER_LADET_EIN: &str = "Nur wer den Termin angelegt hat, kann Einladungen ändern";

/// Einladungen ändern darf nur, wer den Termin angelegt hat.
///
/// Der Ersteller ist Absender aller Karten und Gegenüber aller Einzelchats; ein
/// anderer Absender zerlegte die Synchronität und das Erinnern. Inhalte ändern
/// und löschen dürfen auch Gruppen-Admins (`assert_editable`).
///
/// Wer gar nicht eingeladen ist, bekommt 404 und nicht 403: Sonst ließe sich an
/// der Antwort ablesen, ob es einen Termin mit dieser Kennung gibt.
async fn nur_ersteller(state: &AppState, event: &CalendarEventRow, user_id: Uuid) -> AppResult<()> {
    if event.created_by == Some(user_id) {
        return Ok(());
    }
    assert_attendee(&state.pool, event, user_id).await?;
    Err(AppError::forbidden(NUR_ERSTELLER_LADET_EIN))
}

/// Bremst Anfragen, die Einladungen verschicken oder ändern.
fn einladen_bremsen(state: &AppState, user_id: Uuid) -> AppResult<()> {
    if state
        .drossel
        .erlaubt(&format!("einladen:{user_id}"), regeln::EINLADEN)
    {
        Ok(())
    } else {
        Err(AppError::too_many(
            "Zu viele Einladungen in kurzer Zeit. Warte einen Moment.",
        ))
    }
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateEventInput>,
) -> AppResult<(StatusCode, Json<TerminAntwort>)> {
    let title = input.title.trim().to_string();
    validate_event(
        &title,
        input.description.as_deref(),
        input.location.as_deref(),
        input.starts_at,
        input.ends_at,
    )?;
    if let Some(client_id) = input.client_id.as_deref() {
        Validator::new()
            .length("clientId", client_id, 1, EVENT_CLIENT_ID_MAX)
            .finish()?;
    }

    let zustellung = match &input.zustellung {
        Some(eingabe) => {
            // Mit `zustellung` bestimmen die Gruppenchats, wo der Termin steht;
            // ein zusätzlicher `conversationId` wäre eine zweite, womöglich
            // widersprüchliche Angabe.
            if let Some(chat) = input.conversation_id {
                if !eingabe.gruppen_chat_ids.contains(&chat) {
                    return Err(AppError::bad_request(
                        "Bei „zustellung“ bestimmen die Gruppenchats den Chat des Termins.",
                    ));
                }
            }
            Some(Wunsch {
                senden: eingabe.senden,
                einzelchats: eingabe.einzelchats,
                gruppen: eingabe.gruppen_chat_ids.clone(),
            })
        }
        None => {
            if let Some(conversation_id) = input.conversation_id {
                assert_membership(&state.pool, conversation_id, user.id()).await?;
            }
            None
        }
    };
    if zustellung.is_some() || !input.attendee_ids.is_empty() {
        einladen_bremsen(&state, user.id())?;
    }

    let angelegt = anlegen(
        &state,
        NewEvent {
            conversation_id: input.conversation_id,
            created_by: user.id(),
            title,
            description: input.description,
            location: input.location,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
            all_day: input.all_day,
            rrule: input.rrule,
            color: input.color,
            reminder_minutes: input.reminder_minutes,
            source_poll_id: None,
            status: "confirmed".to_string(),
            poll_id: None,
            attendee_ids: input.attendee_ids,
            attendee_statuses: Default::default(),
            announce: input.announce,
            zustellung,
            client_id: input.client_id,
        },
    )
    .await?;

    let status = if angelegt.wiederholt {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(TerminAntwort {
            termin: angelegt.termin,
            zustellung: angelegt.zustellung,
        }),
    ))
}

/// Darf diese Person den Termin sehen?
///
/// Nur wer eingeladen ist (oder ihn angelegt hat). 404 statt 403: Ein Termin,
/// zu dem man nicht eingeladen ist, geht einen nichts an – auch nicht seine
/// Existenz.
async fn assert_visible(
    state: &AppState,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<()> {
    assert_attendee(&state.pool, event, user_id).await
}

/// Darf diese Person Inhalt, Zeit und Bestand des Termins ändern?
///
/// Der Ersteller – und ein Admin eines Gruppenchats, in dem der Termin als
/// Karte steht, **sofern er selbst eingeladen ist**: Wer den Termin nicht sehen
/// darf, bearbeitet nicht, was er nicht sehen darf. Einladungen ändert nur der
/// Ersteller, siehe `nur_ersteller`.
async fn assert_editable(
    state: &AppState,
    event: &CalendarEventRow,
    user_id: Uuid,
) -> AppResult<()> {
    if event.created_by == Some(user_id) {
        return Ok(());
    }
    // Zuerst die Sichtbarkeit: Wer nicht eingeladen ist, erfährt mit 404 nicht,
    // dass es den Termin gibt – eine Rolle als Gruppen-Admin ändert daran nichts.
    assert_attendee(&state.pool, event, user_id).await?;
    let darf: bool = sqlx::query_scalar(
        "select exists (
           select 1 from event_attendees ea
            where ea.event_id = $1 and ea.user_id = $2
              and exists (
                select 1
                  from conversation_members cm
                  join conversations c on c.id = cm.conversation_id
                 where cm.user_id = $2 and cm.role <> 'member' and c.type = 'group'
                   and (cm.conversation_id = $3
                        or cm.conversation_id in (
                             select conversation_id from event_placements
                              where event_id = $1 and art = 'gruppe'))
              )
         )",
    )
    .bind(event.id)
    .bind(user_id)
    .bind(event.conversation_id)
    .fetch_one(&state.pool)
    .await?;
    if darf {
        return Ok(());
    }
    Err(AppError::forbidden(
        "Nur der Ersteller darf den Termin ändern",
    ))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CalendarEventDto>> {
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;
    Ok(Json(load_event_dto(&state, id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEventInput {
    title: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    location: Option<Option<String>>,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    all_day: Option<bool>,
    #[serde(default, deserialize_with = "super::double_option")]
    rrule: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    color: Option<Option<String>>,
    reminder_minutes: Option<Vec<i32>>,
    /// Der SOLLZUSTAND der Eingeladenen (ohne den Ersteller) – nicht ein
    /// Nachtrag. Wer fehlt, ist danach ausgeladen.
    attendee_ids: Option<Vec<Uuid>>,
    zustellung: Option<ZustellungAendern>,
    /// `confirmed` oder `cancelled`: Absagen und Wiederaufnehmen.
    status: Option<String>,
}

/// Was beim Ändern an der Zustellung gilt.
///
/// `senden` und `einzelchats` gelten für die **neu Hinzugefügten** dieser
/// Anfrage; fehlt das ganze Feld (ältere App-Stände), sind beide an und die
/// Gruppenkarten bleiben, wie sie sind. `gruppenChatIds` ist der Sollzustand der
/// Gruppenkarten; **fehlt es, bleibt alles unverändert.**
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZustellungAendern {
    senden: Option<bool>,
    einzelchats: Option<bool>,
    gruppen_chat_ids: Option<Vec<Uuid>>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateEventInput>,
) -> AppResult<Json<TerminAntwort>> {
    let row = require_event(&state, id).await?;
    assert_editable(&state, &row, user.id()).await?;

    let aendert_einladungen = input.attendee_ids.is_some() || input.zustellung.is_some();
    if aendert_einladungen {
        nur_ersteller(&state, &row, user.id()).await?;
    }

    let starts_at = input.starts_at.unwrap_or(row.starts_at);
    let ends_at = input.ends_at.unwrap_or(row.ends_at);
    let title = input
        .title
        .clone()
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| row.title.clone());
    // Auch Beschreibung und Ort: Das Ändern ist derselbe Weg wie das Anlegen und
    // darf die Grenzen nicht umgehen. `null` löscht und braucht keine Prüfung.
    validate_event(
        &title,
        input.description.as_ref().and_then(|text| text.as_deref()),
        input.location.as_ref().and_then(|text| text.as_deref()),
        starts_at,
        ends_at,
    )?;

    // Absagen und Wiederaufnehmen. Ein Termin in Abstimmung hat noch keinen
    // Zeitpunkt, den man absagen könnte.
    let neuer_status = match input.status.as_deref() {
        None => None,
        Some(status @ ("confirmed" | "cancelled")) => {
            if row.status == "planning" {
                return Err(AppError::bad_request(if status == "cancelled" {
                    "Ein Termin in Abstimmung lässt sich nicht absagen – lege zuerst den Zeitpunkt fest."
                } else {
                    "Ein Termin in Abstimmung wird über die Terminfindung bestätigt."
                }));
            }
            (status != row.status).then(|| status.to_string())
        }
        Some(_) => {
            return Err(AppError::bad_request(
                "Ungültiger Status (erlaubt: confirmed, cancelled)",
            ))
        }
    };

    if aendert_einladungen {
        einladen_bremsen(&state, user.id())?;
    }

    let mut tx = state.pool.begin().await?;
    // Gesperrt, damit zwei gleichzeitige Änderungen des Erstellers
    // hintereinander laufen – und damit der Vergleich unten gegen den Stand
    // geht, den diese Anfrage wirklich überschreibt.
    let alt = sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = $1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))?;

    sqlx::query(
        "update calendar_events set
           title = coalesce($2, title),
           description = case when $3 then $4 else description end,
           location = case when $5 then $6 else location end,
           starts_at = coalesce($7, starts_at),
           ends_at = coalesce($8, ends_at),
           all_day = coalesce($9, all_day),
           rrule = case when $10 then $11 else rrule end,
           color = case when $12 then $13 else color end,
           reminder_minutes = coalesce($14, reminder_minutes),
           status = coalesce($15, status),
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(input.title.map(|value| value.trim().to_string()))
    .bind(input.description.is_some())
    .bind(input.description.clone().flatten())
    .bind(input.location.is_some())
    .bind(input.location.clone().flatten())
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(input.all_day)
    .bind(input.rrule.is_some())
    .bind(input.rrule.clone().flatten())
    .bind(input.color.is_some())
    .bind(input.color.clone().flatten())
    .bind(input.reminder_minutes.map(|values| json!(values)))
    .bind(&neuer_status)
    .execute(&mut *tx)
    .await?;

    let aenderung = wesentlich_geaendert(
        &alt,
        starts_at,
        ends_at,
        input.all_day.unwrap_or(alt.all_day),
        match &input.rrule {
            Some(neu) => neu.as_deref(),
            None => alt.rrule.as_deref(),
        },
        match &input.location {
            Some(neu) => neu.as_deref(),
            None => alt.location.as_deref(),
        },
    );

    let geaendert = if aendert_einladungen {
        let z = input.zustellung.as_ref();
        let wunsch = Einladungswunsch {
            personen: input.attendee_ids.clone(),
            ausladen: Vec::new(),
            senden: z.and_then(|z| z.senden).unwrap_or(true),
            einzelchats: z.and_then(|z| z.einzelchats).unwrap_or(true),
            gruppen: z.and_then(|z| z.gruppen_chat_ids.clone()),
        };
        Some(einladen::aendern_vorbereiten(&state, &mut tx, &alt, &wunsch).await?)
    } else {
        None
    };
    tx.commit().await?;

    let abgesagt = neuer_status.as_deref() == Some("cancelled");
    let (dto, zustellung) = abschliessen(
        &state,
        user.id(),
        &alt,
        geaendert,
        // Bei einer Absage zählt die Absage, nicht zusätzlich die Änderung.
        if abgesagt { None } else { aenderung },
        abgesagt,
    )
    .await?;
    Ok(Json(TerminAntwort {
        termin: dto,
        zustellung: if aendert_einladungen {
            zustellung
        } else {
            None
        },
    }))
}

/// Phase 2 nach dem Ändern: Karten zustellen und zurücknehmen, melden,
/// benachrichtigen.
///
/// Gemeinsam für `PATCH` und das Ausladen einer einzelnen Person: Beides ist
/// dieselbe Änderung der Einladungen, und zwei Abschriften gingen
/// auseinander.
async fn abschliessen(
    state: &AppState,
    ausloeser: Uuid,
    alt: &CalendarEventRow,
    geaendert: Option<Geaendert>,
    aenderung: Option<Aenderung>,
    abgesagt: bool,
) -> AppResult<(CalendarEventDto, Option<ZustellungDto>)> {
    let mut zugestellt = einladen::Zugestellt::default();
    let mut hinzu: Vec<Uuid> = Vec::new();
    let mut entfernt: Vec<Uuid> = Vec::new();
    let mut ausgelassen: Vec<(Uuid, Vec<Uuid>)> = Vec::new();
    let mut neue_einzelchats = 0usize;

    if let Some(geaendert) = geaendert {
        einladen::karten_melden(state, geaendert.geloescht).await;
        neue_chats_melden(state, &geaendert.neue_chats).await;
        neue_einzelchats = geaendert.neue_chats.len();
        // Absender der Karten ist immer der Ersteller, auch wenn eine
        // eingeladene Person sich selbst austrägt und dabei offene Karten
        // nachgeholt werden.
        let absender = alt.created_by.unwrap_or(ausloeser);
        zugestellt = einladen::offene_karten_zustellen(state, alt.id, absender, true)
            .await
            .unwrap_or_else(|fehler| {
                tracing::warn!(%fehler, termin = %alt.id, "Karten konnten nicht zugestellt werden");
                einladen::Zugestellt::default()
            });
        hinzu = geaendert.hinzu;
        entfernt = geaendert.entfernt;
        ausgelassen = geaendert.ausgelassen;
    }

    let dto = melde_termin(state, alt.id).await?;

    // Wer ausgeladen wurde, erfährt es über den Rundruf – nicht über eine
    // Mitteilung: Stille ist hier die freundlichere Wahl. Wer nachsieht,
    // findet die Karte weg.
    if !entfernt.is_empty() {
        state
            .hub
            .publish(
                entfernt,
                Event::event_deleted_grund(alt.id, dto.conversation_id, "ausgeladen"),
            )
            .await;
    }

    // Die Einladung: genau eine Mitteilung je neu Eingeladenem.
    let benachrichtigt = if hinzu.is_empty() {
        0
    } else {
        benachrichtige_einladung(state, &dto, ausloeser, &hinzu, &zugestellt.karten).await
    };

    // Änderung oder Absage: an alle, die es angeht – nicht an den Auslöser, nicht
    // an die, die abgesagt haben, und nicht an die gerade erst Eingeladenen
    // (ihnen sagt die Einladung schon alles).
    let anlass = if abgesagt {
        Some(TerminAnlass::Abgesagt)
    } else {
        aenderung.map(TerminAnlass::Geaendert)
    };
    if let Some(anlass) = anlass {
        // Wer an Uhrzeit und Ort feilt, klingelt nicht bei jedem Tippfehler:
        // Weitere Änderungen landen still in den Karten. Ebenso, wer im Wechsel
        // absagt und wieder aufnimmt – jede Absage wäre sonst eine neue
        // Mitteilung an bis zu 200 Personen. Beides zählt für sich: Eine Absage
        // kurz nach einer Zeitänderung soll ankommen.
        let gebremst = match anlass {
            TerminAnlass::Geaendert(_) => !state.drossel.erlaubt(
                &format!("termin-push:{}", alt.id),
                regeln::TERMIN_AENDERUNG_PUSH,
            ),
            TerminAnlass::Abgesagt => !state.drossel.erlaubt(
                &format!("termin-absage:{}", alt.id),
                regeln::TERMIN_AENDERUNG_PUSH,
            ),
            TerminAnlass::Geloescht => false,
        };
        if !gebremst {
            let empfaenger: Vec<Uuid> = dto
                .attendees
                .iter()
                .filter(|teilnehmer| {
                    teilnehmer.status != "no"
                        && teilnehmer.user_id != ausloeser
                        && !hinzu.contains(&teilnehmer.user_id)
                })
                .map(|teilnehmer| teilnehmer.user_id)
                .collect();
            benachrichtige_termin(state, &dto, ausloeser, anlass, &empfaenger).await;
        }
    }

    let einzel_jetzt = zugestellt
        .karten
        .iter()
        .filter(|karte| karte.art == "einzel")
        .count();
    let zustellung = einladen::zustellung_dto(
        &state.pool,
        alt.id,
        &ausgelassen,
        neue_einzelchats,
        benachrichtigt,
        Some(einzel_jetzt),
    )
    .await?;
    Ok((dto, Some(zustellung)))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_event(&state, id).await?;
    assert_editable(&state, &row, user.id()).await?;

    // Vor dem Löschen geladen: Danach liefert `load_event_dto` nichts mehr.
    let dto = load_event_dto(&state, id).await?;
    let geloescht = einladen::termin_loeschen(&state, &row).await?;
    einladen::karten_melden(&state, geloescht).await;

    state
        .hub
        .publish(
            empfaenger_des_termins(&dto),
            Event::event_deleted_grund(id, row.conversation_id, "geloescht"),
        )
        .await;

    // „Entfällt“ geht nur an die, die planen: Wer zugesagt oder vielleicht
    // gesagt hat. Wer abgesagt hat oder nicht geantwortet, braucht keine
    // Nachricht über etwas, das er ohnehin nicht vorhatte.
    let empfaenger: Vec<Uuid> = dto
        .attendees
        .iter()
        .filter(|teilnehmer| {
            matches!(teilnehmer.status.as_str(), "yes" | "maybe") && teilnehmer.user_id != user.id()
        })
        .map(|teilnehmer| teilnehmer.user_id)
        .collect();
    benachrichtige_termin(
        &state,
        &dto,
        user.id(),
        TerminAnlass::Geloescht,
        &empfaenger,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct RsvpInput {
    status: String,
}

/// Jemanden wieder ausladen.
///
/// Das Einladen ging über `attendeeIds` beim Ändern – aber nur hinzufügend
/// (`on conflict do nothing`). Wer versehentlich den Falschen eingeladen hatte,
/// wurde ihn nicht mehr los. Eine Einladung, die sich nicht zurücknehmen lässt,
/// ist keine Einladung, sondern eine Falle.
///
/// Wer ausgeladen wird, verliert damit auch den Zugang zu Notizen, Unterlagen
/// und Abstimmung des Termins – `assert_attendee` prüft dieselbe Tabelle. Das
/// ist gewollt. Seine Einzelkarte wird gelöscht, eine Gruppenkarte bleibt
/// (siehe `einladen::aendern_vorbereiten`).
async fn ausladen(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<TerminAntwort>> {
    let event = require_event(&state, id).await?;
    // Sich selbst austragen darf jede eingeladene Person: Wer eingeladen wurde,
    // ohne gefragt zu werden, hat sonst keine Möglichkeit, den Termin wieder
    // loszuwerden – er bliebe im Kalender, bis der Ersteller ihn entfernt.
    // Andere ausladen darf nur der Ersteller.
    let selbst = user_id == user.id();
    if selbst {
        assert_visible(&state, &event, user.id()).await?;
    } else {
        nur_ersteller(&state, &event, user.id()).await?;
    }

    if event.created_by == Some(user_id) {
        return Err(AppError::bad_request(
            "Wer den Termin angelegt hat, kann sich nicht selbst ausladen",
        ));
    }

    let mut tx = state.pool.begin().await?;
    let alt = sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = $1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))?;
    let wunsch = Einladungswunsch {
        ausladen: vec![user_id],
        ..Einladungswunsch::unveraendert()
    };
    let geaendert = einladen::aendern_vorbereiten(&state, &mut tx, &alt, &wunsch).await?;
    tx.commit().await?;

    let (dto, zustellung) =
        abschliessen(&state, user.id(), &alt, Some(geaendert), None, false).await?;
    Ok(Json(TerminAntwort {
        termin: dto,
        // Wo der Termin überall als Karte steht, geht nur den Ersteller etwas an.
        zustellung: if selbst { None } else { zustellung },
    }))
}

async fn rsvp(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<RsvpInput>,
) -> AppResult<Json<CalendarEventDto>> {
    Validator::new()
        .one_of("status", &input.status, RSVP_STATUSES)
        .finish()?;
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;
    if row.status == "cancelled" {
        return Err(AppError::conflict("Der Termin ist abgesagt."));
    }

    // Prüfen und Schreiben sind ein Schritt: Eine eigene Prüfung davor und ein
    // Einfügen danach ließen eine Zusage, die mit dem Ausladen zusammenfällt,
    // die Teilnehmerzeile neu anlegen – die Person wäre wieder drin, mit Zugang
    // zu Notizen und Unterlagen. Das Ändern wartet auf eine laufende
    // Löschung der Zeile und trifft danach nichts mehr.
    let geschrieben = if row.created_by == Some(user.id()) {
        // Den Ersteller kann niemand ausladen; fehlt seine Zeile (ältere
        // Termine), legt die erste Zusage sie an.
        sqlx::query(
            "insert into event_attendees (event_id, user_id, status, responded_at)
             values ($1, $2, $3, now())
             on conflict (event_id, user_id) do update
             set status = excluded.status, responded_at = excluded.responded_at",
        )
        .bind(id)
        .bind(user.id())
        .bind(&input.status)
        .execute(&state.pool)
        .await?
        .rows_affected()
    } else {
        sqlx::query(
            "update event_attendees set status = $3, responded_at = now()
              where event_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(user.id())
        .bind(&input.status)
        .execute(&state.pool)
        .await?
        .rows_affected()
    };
    if geschrieben == 0 {
        return Err(AppError::not_found("Termin nicht gefunden"));
    }

    Ok(Json(melde_termin(&state, id).await?))
}

/// Wo der Termin als Karte steht – für den Editor beim Bearbeiten.
async fn zustellung_lesen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ZustellungStandDto>> {
    let row = require_event(&state, id).await?;
    nur_ersteller(&state, &row, user.id()).await?;
    Ok(Json(einladen::zustellung_stand(&state.pool, id).await?))
}

/// Legt fehlende Nachrichten zu reservierten Karten an – wiederholbar.
async fn zustellung_nachliefern(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TerminAntwort>> {
    let row = require_event(&state, id).await?;
    nur_ersteller(&state, &row, user.id()).await?;
    Ok(Json(einladen::nachliefern(&state, &row, user.id()).await?))
}

#[derive(Debug, Deserialize)]
struct WindowQuery {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

async fn occurrences(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<WindowQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let row = require_event(&state, id).await?;
    assert_visible(&state, &row, user.id()).await?;

    let from = query.from.unwrap_or_else(Utc::now);
    let to = query.to.unwrap_or_else(|| Utc::now() + Duration::days(90));
    let items: Vec<serde_json::Value> =
        expand_occurrences(row.starts_at, row.ends_at, row.rrule.as_deref(), from, to)
            .into_iter()
            .map(|occurrence| {
                json!({
                    "index": occurrence.index,
                    "startsAt": occurrence.starts_at,
                    "endsAt": occurrence.ends_at,
                })
            })
            .collect();

    Ok(Json(json!({ "items": items })))
}

fn to_ics_event(event: &CalendarEventDto, app_url: &str) -> IcsEvent {
    IcsEvent {
        id: event.id.to_string(),
        title: event.title.clone(),
        description: event.description.clone(),
        location: event.location.clone(),
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        all_day: event.all_day,
        rrule: event.rrule.clone(),
        url: Some(format!("{app_url}/kalender/termin/{}", event.id)),
        updated_at: event.updated_at,
        reminder_minutes: event.reminder_minutes.clone(),
        abgesagt: event.status == "cancelled",
    }
}

fn ics_response(body: String, filename: &str, inline: bool) -> Response {
    let disposition = if inline {
        format!("inline; filename=\"{filename}\"")
    } else {
        format!("attachment; filename=\"{filename}\"")
    };
    (
        [
            (
                header::CONTENT_TYPE,
                "text/calendar; charset=utf-8".to_string(),
            ),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "private, max-age=300".to_string()),
        ],
        body,
    )
        .into_response()
}

/// Single event download ("zum Kalender hinzufügen"). The event id acts as a
/// capability, because calendar apps cannot send an Authorization header.
async fn event_ics(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<Response> {
    let event = load_event_dto(&state, id).await?;
    let domain = domain_of(&state.config.public_app_url);
    let body = build_calendar(
        &[to_ics_event(&event, &state.config.public_app_url)],
        &IcsCalendar {
            name: event.title.clone(),
            description: None,
            refresh_interval: None,
            domain,
        },
    );
    Ok(ics_response(body, "termin.ics", false))
}

/// Personal calendar feed, authenticated by an unguessable token.
async fn feed_ics(State(state): State<AppState>, Path(token): Path<String>) -> AppResult<Response> {
    let user = sqlx::query_as::<_, UserRow>("select * from users where calendar_token = $1")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Kalender nicht gefunden"))?;

    let events = load_events_for_user(
        &state,
        user.id,
        Some(Utc::now() - Duration::days(365)),
        Some(Utc::now() + Duration::days(730)),
        None,
    )
    .await?;

    let body = build_calendar(
        &events
            .iter()
            .map(|event| to_ics_event(event, &state.config.public_app_url))
            .collect::<Vec<_>>(),
        &IcsCalendar {
            name: format!("Initiative – {}", user.display_name),
            description: Some("Termine aus deinen Chats und persönliche Termine".to_string()),
            refresh_interval: Some("PT1H".to_string()),
            domain: domain_of(&state.config.public_app_url),
        },
    );
    Ok(ics_response(body, "initiative.ics", true))
}

fn domain_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "initiative.app".to_string())
}

/* ---------- Terminfindung: ein Termin, dessen Zeitpunkt noch offen ist ----- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanningInput {
    conversation_id: Uuid,
    title: String,
    description: Option<String>,
    location: Option<String>,
    /// Die Zeitvorschläge, über die abgestimmt wird.
    slots: Vec<PlanningSlot>,
    /// Zusätzliche Chats, in denen die Abstimmung ebenfalls stehen soll.
    #[serde(default)]
    also_in: Vec<Uuid>,
    closes_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanningSlot {
    starts_at: DateTime<Utc>,
    ends_at: Option<DateTime<Utc>>,
}

/// Legt einen Termin an, dessen Zeitpunkt noch abgestimmt wird.
///
/// Der Termin bekommt den **frühesten Vorschlag** als vorläufigen Zeitpunkt.
/// Das ist kein Behelf, sondern Absicht: Ein Termin ohne Zeitpunkt wäre in
/// jeder Monatsansicht, jedem ICS-Export und jeder Bereichsabfrage ein
/// Sonderfall. So steht er im Kalender – sichtbar als „in Abstimmung“ – und
/// rückt an seinen Platz, sobald entschieden ist.
async fn create_planning(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<PlanningInput>,
) -> AppResult<(StatusCode, Json<CalendarEventDto>)> {
    assert_membership(&state.pool, input.conversation_id, user.id()).await?;
    let title = input.title.trim().to_string();
    Validator::new()
        .length("title", &title, 1, EVENT_TITLE_MAX)
        .require(
            "slots",
            input.slots.len() >= 2,
            "mindestens zwei Vorschläge",
        )
        .require(
            "slots",
            input.slots.len() <= POLL_OPTIONS_MAX,
            "zu viele Vorschläge",
        )
        .finish()?;
    if let Some(description) = input.description.as_deref() {
        Validator::new()
            .length("description", description, 0, EVENT_DESCRIPTION_MAX)
            .finish()?;
    }
    if let Some(location) = input.location.as_deref() {
        Validator::new()
            .length("location", location, 0, EVENT_LOCATION_MAX)
            .finish()?;
    }

    let mut slots = input.slots;
    slots.sort_by_key(|slot| slot.starts_at);
    let erster = slots[0].starts_at;
    let erster_ende = slots[0].ends_at.unwrap_or(erster + Duration::hours(1));

    let poll = create_poll(
        &state,
        NewPoll {
            conversation_id: input.conversation_id,
            created_by: user.id(),
            kind: "date".to_string(),
            question: title.clone(),
            description: input.description.clone(),
            // Terminfindung: zu jedem Vorschlag eine eigene Antwort.
            multiple: true,
            anonymous: false,
            allow_add_options: false,
            closes_at: input.closes_at,
            options: slots
                .iter()
                .map(|slot| NewPollOption {
                    label: None,
                    starts_at: Some(slot.starts_at),
                    ends_at: slot.ends_at,
                })
                .collect(),
        },
    )
    .await?;

    let event = create_event(
        &state,
        NewEvent {
            conversation_id: Some(input.conversation_id),
            created_by: user.id(),
            title,
            description: input.description,
            location: input.location,
            starts_at: erster,
            ends_at: erster_ende,
            all_day: false,
            rrule: None,
            color: None,
            reminder_minutes: Vec::new(),
            source_poll_id: None,
            status: "planning".to_string(),
            poll_id: Some(poll.id),
            attendee_ids: Vec::new(),
            attendee_statuses: Default::default(),
            announce: Some(false),
            zustellung: None,
            client_id: None,
        },
    )
    .await?;

    // Die Abstimmung zusätzlich in die gewünschten Chats stellen – mit
    // demselben Ergebnis. Wer im Einzelchat antwortet, hat auch für die
    // Gruppe geantwortet.
    if !input.also_in.is_empty() {
        let row = require_poll(&state, poll.id).await?;
        for conversation_id in input.also_in {
            if assert_membership(&state.pool, conversation_id, user.id())
                .await
                .is_err()
            {
                // Einen Chat, in dem man selbst nicht ist, still überspringen
                // statt den ganzen Vorgang scheitern zu lassen.
                continue;
            }
            place_poll(&state, &row, conversation_id, user.id()).await?;
        }
    }

    Ok((StatusCode::CREATED, Json(event)))
}

/* ---------- Notizen ---------- */

async fn notes(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<EventNoteDto>>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let rows = sqlx::query_as::<_, EventNoteRow>(
        "select * from event_notes where event_id = $1 and deleted_at is null
          order by position asc, created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(to_note_dto(&state.pool, &event, row, user.id()).await?);
    }
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteInput {
    title: Option<String>,
    body: String,
    /// `note` oder `list`. Ohne Angabe entscheidet, ob Punkte mitkommen –
    /// siehe `kind_bestimmen`. Alte Fassungen der App, die das Feld nicht
    /// kennen, legen damit weiter das an, was sie meinen.
    kind: Option<String>,
    #[serde(default = "default_scope")]
    edit_scope: String,
    /// Wer Punkte hinzufügen darf. Ohne Angabe wie `edit_scope`.
    add_scope: Option<String>,
    /// Wer abhaken darf. Ohne Angabe: alle Eingeladenen – das ist der Sinn
    /// einer Liste, und wer es enger will, sagt es ausdrücklich.
    #[serde(default = "default_check_scope")]
    check_scope: String,
    /// Bei `listed`: wer darf. Je Recht eine eigene Liste.
    #[serde(default)]
    editor_ids: Vec<Uuid>,
    #[serde(default)]
    adder_ids: Vec<Uuid>,
    #[serde(default)]
    checker_ids: Vec<Uuid>,
    /// Punkte, die gleich mit angelegt werden.
    #[serde(default)]
    items: Vec<ItemInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemInput {
    text: String,
    /// Wie viele müssen abhaken. 0 heisst: niemand muss.
    #[serde(default)]
    required_checks: i32,
    /// Schlägt die Zahl: alle Eingeladenen, auch die von morgen.
    #[serde(default)]
    required_all: bool,
    /// Namentlich Zugewiesene. Sind welche genannt, schlagen sie beides.
    #[serde(default)]
    assignee_ids: Vec<Uuid>,
}

fn default_check_scope() -> String {
    "members".to_string()
}

fn default_scope() -> String {
    "author".to_string()
}

/// Die beiden Arten einer Notiz.
const NOTE_KINDS: &[&str] = &["note", "list"];

/// Was es wird, wenn es niemand sagt.
///
/// Wer Punkte mitschickt, meint eine Liste – auch wenn er das Feld nicht
/// kennt. Das ist dieselbe Regel, nach der die Wanderung 0012 die
/// bestehenden Notizen eingeordnet hat („Alles, was heute schon Punkte
/// trägt, war immer als Liste gemeint“), und ohne sie nimmt der Server die
/// Punkte an, speichert sie – und die App zeigt sie nie, weil sie Punkte nur
/// an einer Liste darstellt. Ein stiller Verlust, wie er hier schon einmal
/// vorkam.
fn kind_bestimmen(gesagt: Option<&str>, punkte: &[ItemInput]) -> String {
    if let Some(wert) = gesagt {
        return wert.to_string();
    }
    if punkte.iter().any(|punkt| !punkt.text.trim().is_empty()) {
        "list".to_string()
    } else {
        "note".to_string()
    }
}

async fn create_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<NoteInput>,
) -> AppResult<(StatusCode, Json<EventNoteDto>)> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let kind = kind_bestimmen(input.kind.as_deref(), &input.items);
    Validator::new()
        .one_of("editScope", &input.edit_scope, NOTE_SCOPES)
        .one_of(
            "addScope",
            input.add_scope.as_deref().unwrap_or(&input.edit_scope),
            NOTE_SCOPES,
        )
        .one_of("checkScope", &input.check_scope, CHECK_SCOPES)
        .one_of("kind", &kind, NOTE_KINDS)
        .length("body", &input.body, 0, EVENT_DESCRIPTION_MAX)
        .finish()?;

    let next: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0) + 1 from event_notes where event_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;

    // Ohne eigene Angabe gilt fuers Hinzufuegen dasselbe wie fuers Aendern –
    // das ist die Erwartung, und es erspart beim haeufigen Fall eine Frage.
    let add_scope = input
        .add_scope
        .clone()
        .unwrap_or_else(|| input.edit_scope.clone());

    let note = sqlx::query_as::<_, EventNoteRow>(
        "insert into event_notes
           (id, event_id, author_id, title, body, kind, edit_scope, add_scope, check_scope, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(user.id())
    .bind(clean(input.title))
    .bind(&input.body)
    .bind(&kind)
    .bind(&input.edit_scope)
    .bind(&add_scope)
    .bind(&input.check_scope)
    .bind(next)
    .fetch_one(&state.pool)
    .await?;

    set_note_editors(&state, &note, "edit", &input.editor_ids).await?;
    set_note_editors(&state, &note, "add", &input.adder_ids).await?;
    set_note_editors(&state, &note, "check", &input.checker_ids).await?;

    // Punkte, die gleich mitkamen. Eine Packliste legt man in einem Zug an,
    // nicht Zeile fuer Zeile ueber einzelne Anfragen.
    for (nummer, punkt) in input.items.iter().enumerate() {
        let text = punkt.text.trim();
        if text.is_empty() {
            continue;
        }
        let punkt_id = Uuid::now_v7();
        sqlx::query(
            "insert into event_note_items
               (id, note_id, text, position, required_checks, required_all, created_by)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(punkt_id)
        .bind(note.id)
        .bind(text)
        .bind(nummer as i32)
        .bind(punkt.required_checks.max(0))
        .bind(punkt.required_all)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
        set_item_assignees(&state, punkt_id, &punkt.assignee_ids).await?;
    }

    let dto = to_note_dto(&state.pool, &event, note, user.id()).await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNoteInput {
    #[serde(default, deserialize_with = "double_option")]
    title: Option<Option<String>>,
    body: Option<String>,
    // Alle drei Rechte, nicht nur das Ändern.
    //
    // Hier standen bisher nur `edit_scope` und `editor_ids`. Die Oberfläche
    // schickt aber seit jeher alle drei mit (EventNotes.tsx) – und serde wirft
    // unbekannte Felder kommentarlos weg. Die Folge war der denkbar
    // unangenehmste Fehler: Die Route antwortete 200 mit dem **alten** Wert,
    // die Oberfläche schrieb ihn zurück in ihren Zustand, und der Regler
    // sprang zurück. Kein Fehler, keine Meldung, nichts im Protokoll.
    //
    // Beim Anlegen ging es immer, weil `NoteInput` die Felder kennt. Genau das
    // machte es so schwer zu glauben.
    /// Aus einer Notiz eine Liste machen und zurueck.
    kind: Option<String>,
    edit_scope: Option<String>,
    add_scope: Option<String>,
    check_scope: Option<String>,
    editor_ids: Option<Vec<Uuid>>,
    adder_ids: Option<Vec<Uuid>>,
    checker_ids: Option<Vec<Uuid>>,
    position: Option<i32>,
}

async fn update_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateNoteInput>,
) -> AppResult<Json<EventNoteDto>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;
    if !may_edit_note(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden("Diese Notiz darfst du nicht ändern"));
    }
    // Wer sie ändern darf, bestimmt der Verfasser – sonst könnte jemand mit
    // Schreibrecht sich selbst zum alleinigen Bearbeiter machen.
    let rechte_beruehrt = input.edit_scope.is_some()
        || input.editor_ids.is_some()
        || input.add_scope.is_some()
        || input.adder_ids.is_some()
        || input.check_scope.is_some()
        || input.checker_ids.is_some();
    if rechte_beruehrt && note.author_id != Some(user.id()) {
        return Err(AppError::forbidden(
            "Wer die Notiz ändern darf, bestimmt ihr Verfasser",
        ));
    }
    if let Some(scope) = input.edit_scope.as_deref() {
        Validator::new()
            .one_of("editScope", scope, NOTE_SCOPES)
            .finish()?;
    }
    if let Some(scope) = input.add_scope.as_deref() {
        Validator::new()
            .one_of("addScope", scope, NOTE_SCOPES)
            .finish()?;
    }
    // Abhaken kennt eine Stufe mehr als die anderen beiden – deshalb eine
    // eigene Liste und nicht NOTE_SCOPES.
    if let Some(scope) = input.check_scope.as_deref() {
        Validator::new()
            .one_of("checkScope", scope, CHECK_SCOPES)
            .finish()?;
    }
    if let Some(art) = input.kind.as_deref() {
        Validator::new().one_of("kind", art, NOTE_KINDS).finish()?;
    }
    if let Some(body) = input.body.as_deref() {
        Validator::new()
            .length("body", body, 0, EVENT_DESCRIPTION_MAX)
            .finish()?;
    }

    let updated = sqlx::query_as::<_, EventNoteRow>(
        "update event_notes set
           title       = case when $3 then $4 else title end,
           body        = coalesce($5, body),
           kind        = coalesce($6, kind),
           edit_scope  = coalesce($7, edit_scope),
           add_scope   = coalesce($8, add_scope),
           check_scope = coalesce($9, check_scope),
           position    = coalesce($10, position),
           updated_at  = now()
         where id = $1 and event_id = $2 and deleted_at is null
         returning *",
    )
    .bind(note_id)
    .bind(id)
    .bind(input.title.is_some())
    .bind(input.title.flatten())
    .bind(input.body)
    .bind(input.kind)
    .bind(input.edit_scope)
    .bind(input.add_scope)
    .bind(input.check_scope)
    .bind(input.position)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Notiz nicht gefunden"))?;

    if let Some(editor_ids) = input.editor_ids {
        set_note_editors(&state, &updated, "edit", &editor_ids).await?;
    }
    if let Some(adder_ids) = input.adder_ids {
        set_note_editors(&state, &updated, "add", &adder_ids).await?;
    }
    if let Some(checker_ids) = input.checker_ids {
        set_note_editors(&state, &updated, "check", &checker_ids).await?;
    }
    let dto = to_note_dto(&state.pool, &event, updated, user.id()).await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(Json(dto))
}

async fn remove_note(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;
    // Löschen darf nur der Verfasser oder wer den Termin verwaltet.
    let darf = note.author_id == Some(user.id())
        || assert_editable(&state, &event, user.id()).await.is_ok();
    if !darf {
        return Err(AppError::forbidden("Diese Notiz darfst du nicht löschen"));
    }
    sqlx::query("update event_notes set deleted_at = now(), updated_at = now() where id = $1")
        .bind(note_id)
        .execute(&state.pool)
        .await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Die namentlich Benannten fuer EIN Recht setzen (`edit`, `add`, `check`).
async fn set_note_editors(
    state: &AppState,
    note: &EventNoteRow,
    rolle: &str,
    ids: &[Uuid],
) -> AppResult<()> {
    sqlx::query("delete from event_note_editors where note_id = $1 and role = $2")
        .bind(note.id)
        .bind(rolle)
        .execute(&state.pool)
        .await?;
    for user_id in ids {
        sqlx::query(
            "insert into event_note_editors (note_id, user_id, role) values ($1, $2, $3)
             on conflict do nothing",
        )
        .bind(note.id)
        .bind(user_id)
        .bind(rolle)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Die namentlich Zugewiesenen eines Punktes setzen.
async fn set_item_assignees(state: &AppState, item_id: Uuid, ids: &[Uuid]) -> AppResult<()> {
    sqlx::query("delete from event_note_item_assignees where item_id = $1")
        .bind(item_id)
        .execute(&state.pool)
        .await?;
    for user_id in ids {
        sqlx::query(
            "insert into event_note_item_assignees (item_id, user_id) values ($1, $2)
             on conflict do nothing",
        )
        .bind(item_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Eine Notiz samt Punkten neu laden und als DTO ausliefern.
async fn note_antwort(
    state: &AppState,
    event: &CalendarEventRow,
    note_id: Uuid,
    viewer: Uuid,
) -> AppResult<Json<EventNoteDto>> {
    let note = require_note(&state.pool, event.id, note_id).await?;
    Ok(Json(to_note_dto(&state.pool, event, note, viewer).await?))
}

/// Einen Punkt zur Liste hinzufuegen.
async fn add_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<ItemInput>,
) -> AppResult<(StatusCode, Json<EventNoteDto>)> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;

    if !crate::services::events::may_add_item(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden(
            "Zu dieser Liste darfst du nichts hinzufügen",
        ));
    }
    let text = input.text.trim();
    Validator::new().length("text", text, 1, 500).finish()?;

    let next: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0) + 1 from event_note_items where note_id = $1",
    )
    .bind(note_id)
    .fetch_one(&state.pool)
    .await?;

    let item_id = Uuid::now_v7();
    sqlx::query(
        "insert into event_note_items
           (id, note_id, text, position, required_checks, required_all, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(item_id)
    .bind(note_id)
    .bind(text)
    .bind(next)
    .bind(input.required_checks.max(0))
    .bind(input.required_all)
    .bind(user.id())
    .execute(&state.pool)
    .await?;
    set_item_assignees(&state, item_id, &input.assignee_ids).await?;

    // Ein Punkt macht daraus eine Liste. Sonst laege er in der Datenbank und
    // waere in der App nicht zu sehen – Punkte werden nur an einer Liste
    // dargestellt. Dieselbe Regel wie beim Anlegen, siehe `kind_bestimmen`.
    sqlx::query("update event_notes set kind = 'list' where id = $1 and kind <> 'list'")
        .bind(note_id)
        .execute(&state.pool)
        .await?;

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    let antwort = note_antwort(&state, &event, note_id, user.id()).await?;
    Ok((StatusCode::CREATED, antwort))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemInput {
    text: Option<String>,
    required_checks: Option<i32>,
    required_all: Option<bool>,
    position: Option<i32>,
    /// Eine leere Liste nimmt die Zuweisung zurueck – dann gilt wieder die
    /// Zahl. `null` bzw. Weglassen laesst sie unangetastet.
    assignee_ids: Option<Vec<Uuid>>,
}

/// Einen Punkt aendern. Text aendern darf, wer die NOTIZ aendern darf –
/// das ist etwas anderes als Hinzufuegen und etwas anderes als Abhaken.
async fn update_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id, item_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(input): Json<UpdateItemInput>,
) -> AppResult<Json<EventNoteDto>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;

    if !may_edit_note(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden("Diese Liste darfst du nicht ändern"));
    }
    if let Some(text) = input.text.as_deref() {
        Validator::new()
            .length("text", text.trim(), 1, 500)
            .finish()?;
    }

    sqlx::query(
        "update event_note_items set
           text            = coalesce($3, text),
           required_checks = coalesce($4, required_checks),
           required_all    = coalesce($5, required_all),
           position        = coalesce($6, position),
           updated_at      = now()
         where id = $1 and note_id = $2",
    )
    .bind(item_id)
    .bind(note_id)
    .bind(input.text.as_deref().map(str::trim))
    .bind(input.required_checks.map(|wert| wert.max(0)))
    .bind(input.required_all)
    .bind(input.position)
    .execute(&state.pool)
    .await?;

    if let Some(ids) = input.assignee_ids.as_deref() {
        set_item_assignees(&state, item_id, ids).await?;
    }

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    note_antwort(&state, &event, note_id, user.id()).await
}

async fn remove_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id, item_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<Json<EventNoteDto>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;

    if !may_edit_note(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden("Diese Liste darfst du nicht ändern"));
    }
    sqlx::query("delete from event_note_items where id = $1 and note_id = $2")
        .bind(item_id)
        .bind(note_id)
        .execute(&state.pool)
        .await?;

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    note_antwort(&state, &event, note_id, user.id()).await
}

#[derive(Debug, Deserialize)]
struct CheckInput {
    /// Ohne Angabe wird umgeschaltet.
    checked: Option<bool>,
}

/// Einen Punkt abhaken – oder den Haken wieder wegnehmen.
///
/// Jeder hakt fuer sich ab; deshalb eine Zeile je Person und nicht ein Feld
/// am Punkt. Nur so laesst sich „diesen muessen alle abhaken“ ueberhaupt
/// abbilden, und nur so sieht man, wer noch fehlt.
async fn toggle_check(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, note_id, item_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(input): Json<CheckInput>,
) -> AppResult<Json<EventNoteDto>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let note = require_note(&state.pool, id, note_id).await?;

    if !crate::services::events::may_check_item(&state.pool, &event, &note, user.id()).await? {
        return Err(AppError::forbidden("Hier darfst du nichts abhaken"));
    }

    // Gehoert der Punkt ueberhaupt zu dieser Liste? Ohne diese Pruefung liesse
    // sich mit einer geratenen Kennung ein fremder Punkt abhaken.
    let gehoert: bool = sqlx::query_scalar(
        "select exists (select 1 from event_note_items where id = $1 and note_id = $2)",
    )
    .bind(item_id)
    .bind(note_id)
    .fetch_one(&state.pool)
    .await?;
    if !gehoert {
        return Err(AppError::not_found("Punkt nicht gefunden"));
    }

    let bisher: bool = sqlx::query_scalar(
        "select exists (select 1 from event_note_checks where item_id = $1 and user_id = $2)",
    )
    .bind(item_id)
    .bind(user.id())
    .fetch_one(&state.pool)
    .await?;

    let soll = input.checked.unwrap_or(!bisher);
    if soll {
        sqlx::query(
            "insert into event_note_checks (item_id, user_id) values ($1, $2)
             on conflict do nothing",
        )
        .bind(item_id)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    } else {
        sqlx::query("delete from event_note_checks where item_id = $1 and user_id = $2")
            .bind(item_id)
            .bind(user.id())
            .execute(&state.pool)
            .await?;
    }

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    note_antwort(&state, &event, note_id, user.id()).await
}

/* ---------- Dokumente ---------- */

async fn documents(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<EventAttachmentDto>>> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let rows = sqlx::query_as::<_, EventAttachmentRow>(
        "select * from event_attachments where event_id = $1 order by created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let attachment_ids: Vec<Uuid> = rows.iter().map(|row| row.attachment_id).collect();
    let attachments =
        sqlx::query_as::<_, AttachmentRow>("select * from attachments where id = any($1)")
            .bind(&attachment_ids)
            .fetch_all(&state.pool)
            .await?;

    let items = rows
        .into_iter()
        .filter_map(|row| {
            let attachment = attachments.iter().find(|a| a.id == row.attachment_id)?;
            Some(EventAttachmentDto {
                id: row.id,
                event_id: row.event_id,
                added_by: row.added_by,
                title: row.title,
                attachment: to_attachment_dto(attachment, &state.config),
                created_at: row.created_at,
            })
        })
        .collect();
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInput {
    attachment_id: Uuid,
    title: Option<String>,
}

async fn add_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<DocumentInput>,
) -> AppResult<(StatusCode, Json<EventAttachmentDto>)> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;

    let attachment = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments where id = $1 and status = 'ready'",
    )
    .bind(input.attachment_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Datei nicht gefunden oder noch nicht fertig"))?;

    // Nur was man selbst hochgeladen hat oder wirklich sehen darf. Die Frage
    // beantwortet `services::zugriff`, und zwar mitsamt der Verlaufsgrenze;
    // die Abschrift, die hier stand, kannte sie nicht.
    if !crate::services::zugriff::anhang(&state.pool, attachment.id, user.id())
        .await?
        .grund
        .erlaubt()
    {
        return Err(AppError::forbidden(
            "Auf diese Datei hast du keinen Zugriff",
        ));
    }

    let row = sqlx::query_as::<_, EventAttachmentRow>(
        "insert into event_attachments (id, event_id, attachment_id, added_by, title)
         values ($1, $2, $3, $4, $5)
         on conflict (event_id, attachment_id)
         do update set title = coalesce(excluded.title, event_attachments.title)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(input.attachment_id)
    .bind(user.id())
    .bind(clean(input.title))
    .fetch_one(&state.pool)
    .await?;

    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok((
        StatusCode::CREATED,
        Json(EventAttachmentDto {
            id: row.id,
            event_id: row.event_id,
            added_by: row.added_by,
            title: row.title,
            attachment: to_attachment_dto(&attachment, &state.config),
            created_at: row.created_at,
        }),
    ))
}

async fn remove_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, document_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let event = require_event(&state, id).await?;
    assert_attendee(&state.pool, &event, user.id()).await?;
    let row = sqlx::query_as::<_, EventAttachmentRow>(
        "select * from event_attachments where id = $1 and event_id = $2",
    )
    .bind(document_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Dokument nicht gefunden"))?;

    let darf =
        row.added_by == Some(user.id()) || assert_editable(&state, &event, user.id()).await.is_ok();
    if !darf {
        return Err(AppError::forbidden(
            "Dieses Dokument darfst du nicht entfernen",
        ));
    }
    sqlx::query("delete from event_attachments where id = $1")
        .bind(document_id)
        .execute(&state.pool)
        .await?;
    broadcast_event(&state, &load_event_dto(&state, id).await?).await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Verknuepfung mit einer Sammlung ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkCollectionInput {
    #[serde(default, deserialize_with = "double_option")]
    collection_id: Option<Option<Uuid>>,
}

/// Haengt eine Sammlung an den Termin – oder loest die Verknuepfung.
async fn link_collection(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<LinkCollectionInput>,
) -> AppResult<Json<CalendarEventDto>> {
    let event = require_event(&state, id).await?;
    assert_editable(&state, &event, user.id()).await?;

    if let Some(Some(collection_id)) = input.collection_id {
        // Nur eine Sammlung, in die man selbst etwas legen darf – sonst
        // haengte man dem Termin einen Ordner an, den niemand fuellen kann.
        require_collection(&state.pool, collection_id, user.id(), Level::Edit).await?;
    }

    sqlx::query(
        "update calendar_events set
           collection_id = case when $2 then $3 else collection_id end,
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(input.collection_id.is_some())
    .bind(input.collection_id.flatten())
    .execute(&state.pool)
    .await?;

    let dto = load_event_dto(&state, id).await?;
    broadcast_event(&state, &dto).await?;
    Ok(Json(dto))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmInput {
    /// Welcher Vorschlag es wird. Ohne Angabe gewinnt der beste.
    option_id: Option<Uuid>,
    #[serde(default = "default_close")]
    close_poll: bool,
}

fn default_close() -> bool {
    true
}

/// Setzt den Zeitpunkt eines Termins, über den abgestimmt wurde.
///
/// Anders als „Termin aus Umfrage erstellen“ entsteht hier **kein zweiter**
/// Termin: Der bestehende rückt an seinen Platz. Sonst stünde nach der
/// Entscheidung beides im Kalender – der geplante und der bestätigte.
///
/// Die Antworten aus der Abstimmung werden zu Zu- und Absagen: Wer den Termin
/// als passend markiert hat, sagt damit zu.
async fn confirm_event(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<ConfirmInput>,
) -> AppResult<Json<CalendarEventDto>> {
    let event = require_event(&state, id).await?;
    assert_editable(&state, &event, user.id()).await?;

    let Some(poll_id) = event.poll_id else {
        return Err(AppError::bad_request(
            "Für diesen Termin läuft keine Abstimmung",
        ));
    };

    let options = sqlx::query_as::<_, crate::db::PollOptionRow>(
        "select * from poll_options where poll_id = $1 order by position asc",
    )
    .bind(poll_id)
    .fetch_all(&state.pool)
    .await?;
    let votes =
        sqlx::query_as::<_, crate::db::PollVoteRow>("select * from poll_votes where poll_id = $1")
            .bind(poll_id)
            .fetch_all(&state.pool)
            .await?;

    let option = match input.option_id {
        Some(option_id) => options.iter().find(|option| option.id == option_id),
        None => {
            // Ohne Angabe der beste Vorschlag – dieselbe Rechnung wie in der
            // Umfrage selbst, damit „bester Vorschlag“ überall dasselbe heisst.
            let dto = load_poll_dto(&state, poll_id, user.id()).await?;
            best_option(&dto.options, &dto.tally)
                .and_then(|best| options.iter().find(|option| option.id == best.id))
        }
    }
    .ok_or_else(|| AppError::bad_request("Unbekannter Terminvorschlag"))?;

    let Some(starts_at) = option.starts_at else {
        return Err(AppError::bad_request(
            "Dieser Vorschlag hat keinen Zeitpunkt",
        ));
    };
    let ends_at = option.ends_at.unwrap_or(starts_at + Duration::hours(1));

    sqlx::query(
        "update calendar_events set
           starts_at      = $2,
           ends_at        = $3,
           status         = 'confirmed',
           source_poll_id = $4,
           updated_at     = now()
         where id = $1",
    )
    .bind(id)
    .bind(starts_at)
    .bind(ends_at)
    .bind(poll_id)
    .execute(&state.pool)
    .await?;

    // Die Antworten zum gewählten Zeitpunkt werden zu Zu- und Absagen.
    //
    // Wer schon eingeladen ist, bekommt seine Antwort eingetragen. Wer es nicht
    // ist, wird nur dann aufgenommen, wenn er nicht zur Gruppe des Termins
    // gehört: Wer über einen Einzelchat abgestimmt hat, ist nicht Mitglied der
    // Gruppe und steht deshalb noch gar nicht auf der Teilnehmerliste – ein
    // blosses `update` hätte seine Zusage stillschweigend verworfen. Ein
    // Gruppenmitglied ohne Teilnehmerzeile dagegen ist ausgeladen (oder erst
    // nach dem Einladen beigetreten) und bleibt es, auch wenn es vorher
    // abgestimmt hat.
    for vote in votes.iter().filter(|vote| vote.option_id == option.id) {
        let eingetragen = sqlx::query(
            "update event_attendees set status = $3, responded_at = now()
              where event_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(vote.user_id)
        .bind(&vote.value)
        .execute(&state.pool)
        .await?
        .rows_affected();
        if eingetragen > 0 {
            continue;
        }
        let in_der_gruppe: bool = match event.conversation_id {
            Some(chat) => {
                sqlx::query_scalar(
                    "select exists (select 1 from conversation_members
                                     where conversation_id = $1 and user_id = $2)",
                )
                .bind(chat)
                .bind(vote.user_id)
                .fetch_one(&state.pool)
                .await?
            }
            None => false,
        };
        if in_der_gruppe {
            continue;
        }
        sqlx::query(
            "insert into event_attendees (event_id, user_id, status, responded_at)
             values ($1, $2, $3, now())
             on conflict (event_id, user_id)
             do update set status = excluded.status, responded_at = now()",
        )
        .bind(id)
        .bind(vote.user_id)
        .bind(&vote.value)
        .execute(&state.pool)
        .await?;
    }

    sqlx::query(
        "update polls set created_event_id = $2,
                          closed_at = case when $3 then now() else closed_at end
          where id = $1",
    )
    .bind(poll_id)
    .bind(id)
    .bind(input.close_poll)
    .execute(&state.pool)
    .await?;

    let poll_dto = load_poll_dto(&state, poll_id, user.id()).await?;
    broadcast_poll(&state, &poll_dto).await?;

    Ok(Json(melde_termin(&state, id).await?))
}
