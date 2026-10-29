//! Termine, Zu-/Absagen und der ICS-Feed.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::constants::EVENT_CLIENT_ID_MAX;
use crate::db::{json_to_i32_vec, CalendarEventRow, EventAttendeeRow, MessageRow};
use crate::dto::{CalendarEventDto, EventAttendeeDto, ZustellungDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::recurrence::expand_occurrences;
use crate::state::AppState;

use super::einladen::{self, Reservierung, Wunsch};
use super::erinnern::{self, Erinnern};
use super::expanders::{metadata_id, Expansion, MessageExpander};
use super::notify::Aenderung;

pub fn to_event_dto(row: &CalendarEventRow, attendees: &[EventAttendeeRow]) -> CalendarEventDto {
    CalendarEventDto {
        id: row.id,
        conversation_id: row.conversation_id,
        created_by: row.created_by,
        title: row.title.clone(),
        description: row.description.clone(),
        location: row.location.clone(),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        all_day: row.all_day,
        rrule: row.rrule.clone(),
        color: row.color.clone(),
        source_poll_id: row.source_poll_id,
        status: row.status.clone(),
        poll_id: row.poll_id,
        collection_id: row.collection_id,
        attendees: attendees
            .iter()
            .map(|attendee| EventAttendeeDto {
                user_id: attendee.user_id,
                status: attendee.status.clone(),
                responded_at: attendee.responded_at,
            })
            .collect(),
        reminder_minutes: json_to_i32_vec(&row.reminder_minutes),
        stand: row.stand,
        erinnern: erinnern::einstellung_von(row),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub async fn require_event(state: &AppState, event_id: Uuid) -> AppResult<CalendarEventRow> {
    sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = $1 and deleted_at is null",
    )
    .bind(event_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))
}

pub async fn load_event_dtos(
    state: &AppState,
    event_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, CalendarEventDto>> {
    if event_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, CalendarEventRow>(
        "select * from calendar_events where id = any($1) and deleted_at is null",
    )
    .bind(event_ids)
    .fetch_all(&state.pool)
    .await?;
    let attendees = sqlx::query_as::<_, EventAttendeeRow>(
        "select * from event_attendees where event_id = any($1)",
    )
    .bind(event_ids)
    .fetch_all(&state.pool)
    .await?;

    let mut by_event: HashMap<Uuid, Vec<EventAttendeeRow>> = HashMap::new();
    for attendee in attendees {
        by_event
            .entry(attendee.event_id)
            .or_default()
            .push(attendee);
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let attendees = by_event.remove(&row.id).unwrap_or_default();
            (row.id, to_event_dto(&row, &attendees))
        })
        .collect())
}

pub async fn load_event_dto(state: &AppState, event_id: Uuid) -> AppResult<CalendarEventDto> {
    load_event_dtos(state, &[event_id])
        .await?
        .remove(&event_id)
        .ok_or_else(|| AppError::not_found("Termin nicht gefunden"))
}

/// Every event a user can see in a window: their own and the ones they were
/// invited to. Recurring events stay a single row and are returned when *any*
/// occurrence falls into the window.
///
/// Sichtbar ist, was die Teilnehmerzeile (oder der Ersteller) hergibt – ein
/// Chat, in dem der Termin als Karte steht, verleiht keinen Zugang. Der Filter
/// `conversation_id` fragt, in welchen Chats ein Termin eine Karte hat, und
/// begrenzt nur die Auswahl; er macht nichts sichtbar.
pub async fn load_events_for_user(
    state: &AppState,
    user_id: Uuid,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    conversation_id: Option<Uuid>,
) -> AppResult<Vec<CalendarEventDto>> {
    let from = from.unwrap_or_else(|| Utc::now() - Duration::days(30));
    let to = to.unwrap_or_else(|| Utc::now() + Duration::days(180));

    let rows = sqlx::query_as::<_, CalendarEventRow>(
        "select distinct e.*
         from calendar_events e
         left join event_attendees ea on ea.event_id = e.id and ea.user_id = $1
         where e.deleted_at is null
           and (e.created_by = $1 or ea.user_id is not null)
           and ($4::uuid is null
                or e.conversation_id = $4
                or exists (select 1 from event_placements p
                            where p.event_id = e.id and p.conversation_id = $4))
           and (e.rrule is not null or (e.starts_at <= $3 and e.ends_at >= $2))
         order by e.starts_at asc
         limit 1000",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;

    let in_window: Vec<CalendarEventRow> = rows
        .into_iter()
        .filter(|row| {
            row.rrule.is_none()
                || !expand_occurrences(row.starts_at, row.ends_at, row.rrule.as_deref(), from, to)
                    .is_empty()
        })
        .collect();
    if in_window.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<Uuid> = in_window.iter().map(|row| row.id).collect();
    let attendees = sqlx::query_as::<_, EventAttendeeRow>(
        "select * from event_attendees where event_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;
    let mut by_event: HashMap<Uuid, Vec<EventAttendeeRow>> = HashMap::new();
    for attendee in attendees {
        by_event
            .entry(attendee.event_id)
            .or_default()
            .push(attendee);
    }

    Ok(in_window
        .into_iter()
        .map(|row| {
            let attendees = by_event.remove(&row.id).unwrap_or_default();
            to_event_dto(&row, &attendees)
        })
        .collect())
}

pub struct NewEvent {
    pub conversation_id: Option<Uuid>,
    pub created_by: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub color: Option<String>,
    pub reminder_minutes: Vec<i32>,
    pub source_poll_id: Option<Uuid>,
    /// `confirmed`, oder `planning`, solange der Zeitpunkt abgestimmt wird.
    pub status: String,
    pub poll_id: Option<Uuid>,
    pub attendee_ids: Vec<Uuid>,
    /// Pre-set RSVP answers, e.g. taken over from a date poll.
    pub attendee_statuses: HashMap<Uuid, String>,
    pub announce: Option<bool>,
    /// Die ausdrückliche Zustellung (siehe `einladen`). Fehlt sie, gilt der
    /// alte Weg Wort für Wort: `conversation_id` bestimmt den Chat, alle
    /// seine Mitglieder werden eingeladen, eine Karte kommt dorthin. So bleiben
    /// ältere App-Stände, „Termin aus Umfrage“ und die Terminfindung, wie sie
    /// waren.
    pub zustellung: Option<Wunsch>,
    /// Wiederholungsschutz: derselbe Schlüssel, derselbe Termin.
    pub client_id: Option<String>,
    /// Ob und wie an ausstehende Antworten erinnert wird. Alle Aufrufer ausser
    /// dem Editor (Umfrage, Terminfindung, Demo-Daten, ältere App-Stände) lassen
    /// es leer: Dann verhält sich alles wie vorher.
    pub erinnern: Option<Erinnern>,
}

/// Was `anlegen` ergeben hat.
pub struct Angelegt {
    pub termin: CalendarEventDto,
    /// Nur beim ausdrücklichen Weg.
    pub zustellung: Option<ZustellungDto>,
    /// Der Termin gab es schon (gleicher Wiederholungsschutz-Schlüssel).
    pub wiederholt: bool,
}

/// Shared by the calendar module and by "Termin aus Umfrage erstellen".
pub async fn create_event(state: &AppState, input: NewEvent) -> AppResult<CalendarEventDto> {
    Ok(anlegen(state, input).await?.termin)
}

/// Legt einen Termin an – in zwei Phasen, siehe `einladen`.
///
/// Phase 1 ist eine Transaktion (Termin, Teilnehmer, fehlende Einzelchats,
/// reservierte Karten), Phase 2 legt die Nachrichten an. Wer denselben
/// Schlüssel noch einmal schickt (Funkloch, Doppeltipp), bekommt den schon
/// angelegten Termin zurück, **ohne** dass etwas ein zweites Mal geschieht.
pub async fn anlegen(state: &AppState, input: NewEvent) -> AppResult<Angelegt> {
    let ersteller = input.created_by;
    let explizit = input.zustellung.is_some();
    if let Some(einstellung) = input.erinnern {
        erinnern::pruefen(einstellung.nach_std, einstellung.anzahl)?;
    }

    if let Some(client_id) = input.client_id.as_deref() {
        if let Some(vorhanden) = vorhandener_termin(&state.pool, ersteller, client_id).await? {
            return wiederholung(state, vorhanden, explizit).await;
        }
    }

    // Wer eingeladen ist. Ausdrücklich: genau die Liste, der Chat fügt nichts
    // hinzu. Alt: die Liste plus alle Mitglieder des Chats.
    let mut personen = input.attendee_ids.clone();
    if !explizit {
        if let Some(chat) = input.conversation_id {
            personen.extend(super::conversations::member_ids(&state.pool, chat).await?);
        }
    }
    let personen = einladen::personen_bereinigen(Some(ersteller), &personen);
    if explizit {
        einladen::anzahl_pruefen(personen.len())?;
    }
    // Die Prüfungen vor der Transaktion teilen sich eine Verbindung, die vor
    // dem Beginn der Transaktion wieder frei wird.
    let mut lesen = state.pool.acquire().await?;
    einladen::personen_pruefen(&mut lesen, &personen).await?;

    // Der Plan: wohin die Karten gehen.
    let plan = match &input.zustellung {
        Some(wunsch) => {
            let gruppen = einladen::ohne_doppelte(&wunsch.gruppen);
            let mitglieder = einladen::gruppen_pruefen(&mut lesen, ersteller, &gruppen).await?;
            einladen::planen(
                ersteller,
                &personen,
                &Wunsch {
                    gruppen,
                    ..wunsch.clone()
                },
                &mitglieder,
            )
        }
        None => einladen::Plan::default(),
    };
    einladen::einzelchats_bremsen(state, &mut lesen, ersteller, &plan.einzel).await?;
    drop(lesen);

    // Der alte Weg stellt höchstens eine Karte in den Chat des Termins – und
    // trägt sie ebenfalls ein, damit Löschen, Synchronität und Erinnern für
    // Bestand und Neues dieselbe Quelle haben.
    let alte_karte = match (explizit, input.conversation_id) {
        (false, Some(chat)) if input.announce.unwrap_or(true) => {
            Some(einladen::alte_karte(&state.pool, chat, ersteller).await?)
        }
        _ => None,
    };

    let event_id = Uuid::now_v7();
    let conversation_id = if explizit {
        plan.gruppen.first().copied()
    } else {
        input.conversation_id
    };

    let (ids, stati): (Vec<Uuid>, Vec<String>) = std::iter::once((ersteller, "yes".to_string()))
        .chain(personen.iter().map(|person| {
            (
                *person,
                input
                    .attendee_statuses
                    .get(person)
                    .cloned()
                    .unwrap_or_else(|| "pending".to_string()),
            )
        }))
        .unzip();

    // Phase 1.
    let mut tx = state.pool.begin().await?;
    let einzel =
        super::conversations::einzelchats_sichern(&mut tx, ersteller, &plan.einzel).await?;

    let eingefuegt = sqlx::query(
        "insert into calendar_events
           (id, conversation_id, created_by, title, description, location, starts_at, ends_at,
            all_day, rrule, color, reminder_minutes, source_poll_id, status, poll_id, client_id,
            erinnern_nach_std, erinnern_anzahl, erinnern_seit)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, case when $17::int is null then null else now() end)",
    )
    .bind(event_id)
    .bind(conversation_id)
    .bind(ersteller)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.location)
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(input.all_day)
    .bind(&input.rrule)
    .bind(&input.color)
    .bind(serde_json::json!(input.reminder_minutes))
    .bind(input.source_poll_id)
    .bind(&input.status)
    .bind(input.poll_id)
    .bind(&input.client_id)
    .bind(input.erinnern.map(|einstellung| einstellung.nach_std))
    .bind(
        input
            .erinnern
            .and_then(|einstellung| einstellung.anzahl)
            .map(|anzahl| anzahl as i16),
    )
    .execute(&mut *tx)
    .await;
    match eingefuegt {
        Ok(_) => {}
        // Zwei gleichzeitige Anfragen mit demselben Schlüssel: Die zweite
        // scheitert am Eindeutigkeits-Index und liefert den Termin der ersten.
        Err(sqlx::Error::Database(fehler))
            if fehler.is_unique_violation() && input.client_id.is_some() =>
        {
            tx.rollback().await?;
            let client_id = input.client_id.as_deref().unwrap_or_default();
            let vorhanden = vorhandener_termin(&state.pool, ersteller, client_id)
                .await?
                .ok_or_else(|| AppError::conflict("Der Termin wurde gerade angelegt"))?;
            return wiederholung(state, vorhanden, explizit).await;
        }
        Err(fehler) => return Err(fehler.into()),
    }

    // Die Teilnehmer in einem Zug, nicht einer je Person: Bei hundert
    // Eingeladenen wären das hundert Runden, und ein Abbruch mittendrin
    // hinterliess einen halben Termin.
    sqlx::query(
        "insert into event_attendees (event_id, user_id, status, responded_at, eingeladen_am)
         select $1, t.user_id, t.status,
                case when t.status = 'pending' then null else now() end, now()
           from unnest($2::uuid[], $3::text[]) as t(user_id, status)
         on conflict (event_id, user_id) do update
           set status = excluded.status, responded_at = excluded.responded_at",
    )
    .bind(event_id)
    .bind(&ids)
    .bind(&stati)
    .execute(&mut *tx)
    .await?;

    let mut karten: Vec<Reservierung> = Vec::new();
    if explizit {
        karten.extend(plan.gruppen.iter().map(|chat| Reservierung::gruppe(*chat)));
        karten.extend(plan.einzel.iter().filter_map(|person| {
            einzel
                .chat_von
                .get(person)
                .map(|chat| Reservierung::einzel(*chat, *person))
        }));
    } else {
        karten.extend(alte_karte);
    }
    einladen::reservieren(&mut tx, event_id, ersteller, &karten).await?;
    tx.commit().await?;

    // Phase 2: erst die neuen Chats melden, damit sie in der Liste stehen, wenn
    // die Karte eintrifft.
    super::conversations::neue_chats_melden(state, &einzel.neu).await;
    let zugestellt = einladen::offene_karten_zustellen(state, event_id, ersteller, explizit)
        .await
        .unwrap_or_else(|fehler| {
            tracing::warn!(%fehler, termin = %event_id, "Karten konnten nicht zugestellt werden");
            einladen::Zugestellt::default()
        });
    if let Some(erste) = zugestellt.karten.first().and_then(|karte| karte.message_id) {
        sqlx::query("update calendar_events set message_id = $1 where id = $2")
            .bind(erste)
            .bind(event_id)
            .execute(&state.pool)
            .await?;
    }

    let dto = melde_termin(state, event_id).await?;

    if !explizit {
        return Ok(Angelegt {
            termin: dto,
            zustellung: None,
            wiederholt: false,
        });
    }
    let benachrichtigt = super::notify::benachrichtige_einladung(
        state,
        &dto,
        ersteller,
        &personen,
        &zugestellt.karten,
    )
    .await;
    let einzel_jetzt = zugestellt
        .karten
        .iter()
        .filter(|karte| karte.art == "einzel")
        .count();
    let zustellung = einladen::zustellung_dto(
        &state.pool,
        event_id,
        &plan.ausgelassen,
        einzel.neu.len(),
        benachrichtigt,
        Some(einzel_jetzt),
    )
    .await?;
    Ok(Angelegt {
        termin: dto,
        zustellung: Some(zustellung),
        wiederholt: false,
    })
}

/// Der Termin zu einem Wiederholungsschutz-Schlüssel, falls es ihn gibt.
async fn vorhandener_termin(
    pool: &sqlx::PgPool,
    ersteller: Uuid,
    client_id: &str,
) -> AppResult<Option<Uuid>> {
    if client_id.chars().count() > EVENT_CLIENT_ID_MAX {
        return Err(AppError::bad_request("Der Schlüssel ist zu lang"));
    }
    let zeile: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select id, deleted_at from calendar_events where created_by = $1 and client_id = $2",
    )
    .bind(ersteller)
    .bind(client_id)
    .fetch_optional(pool)
    .await?;
    match zeile {
        None => Ok(None),
        Some((id, None)) => Ok(Some(id)),
        // Der Schlüssel bleibt vergeben, auch wenn der Termin inzwischen
        // gelöscht wurde: Eine Wiederholung soll ihn nicht wieder auferstehen
        // lassen.
        Some((_, Some(_))) => Err(AppError::conflict("Dieser Termin wurde bereits gelöscht")),
    }
}

async fn wiederholung(state: &AppState, event_id: Uuid, explizit: bool) -> AppResult<Angelegt> {
    // Die erste Anfrage stellt womöglich noch zu: Wer jetzt „ausstehend“ liest,
    // hält die Karten für verloren und stößt ein zweites Zustellen an, das
    // neben dem ersten läuft. Also kurz auf deren Ende warten.
    if explizit {
        einladen::auf_laufende_zustellung_warten(&state.pool, event_id).await?;
    }
    let termin = load_event_dto(state, event_id).await?;
    let zustellung = if explizit {
        Some(einladen::zustellung_dto(&state.pool, event_id, &[], 0, 0, None).await?)
    } else {
        None
    };
    Ok(Angelegt {
        termin,
        zustellung,
        wiederholt: true,
    })
}

/// Meldet allen Teilnehmern, dass sich ein Termin geändert hat – und zählt
/// seinen Stand hoch.
///
/// Der Stand steigt **vor** dem Laden: Jede Fassung mit Stand *k* enthält alle
/// Schreibvorgänge, die vor dem Hochzählen auf *k* committet waren; eine
/// spätere Änderung hat ein höheres *k*. Zwei fast gleichzeitige Zusagen
/// können ihre Rundrufe vertauscht ausliefern – der Client erkennt an der
/// Zahl, welche die neuere ist, und lässt die ältere fallen.
///
/// Empfänger sind die Teilnehmer (und der Ersteller). Ein Chat, in dem eine
/// Karte steht, ist keiner.
pub async fn melde_termin(state: &AppState, event_id: Uuid) -> AppResult<CalendarEventDto> {
    let erhoeht: Option<i64> = sqlx::query_scalar(
        "update calendar_events set stand = stand + 1
          where id = $1 and deleted_at is null
          returning stand",
    )
    .bind(event_id)
    .fetch_optional(&state.pool)
    .await?;
    if erhoeht.is_none() {
        return Err(AppError::not_found("Termin nicht gefunden"));
    }
    let dto = load_event_dto(state, event_id).await?;
    state
        .hub
        .publish(empfaenger_des_termins(&dto), Event::event_updated(&dto))
        .await;
    Ok(dto)
}

/// Kurzform für die Stellen, die nur melden wollen (Notizen, Unterlagen, …).
///
/// Die übergebene Fassung ist nur der Anlass: Gemeldet wird eine frisch
/// geladene mit hochgezähltem Stand.
pub async fn broadcast_event(state: &AppState, event: &CalendarEventDto) -> AppResult<()> {
    melde_termin(state, event.id).await.map(|_| ())
}

/// Wer einen Termin sieht: die Teilnehmer und der Ersteller.
pub fn empfaenger_des_termins(event: &CalendarEventDto) -> Vec<Uuid> {
    event
        .attendees
        .iter()
        .map(|teilnehmer| teilnehmer.user_id)
        .chain(event.created_by)
        .collect()
}

/// Embeds the referenced event into every `event` message – für den, der sie
/// sehen darf.
///
/// Der Betrachter wird geprüft: Wer nicht eingeladen ist, bekommt weder Titel
/// und Teilnehmerliste noch (in `hydrate_messages`) die Kennung der Karte.
/// Bisher ging die Fassung an jeden, der eine Karte mit dieser Kennung sah –
/// auch an den, der sie selbst in einen Chat gelegt hatte.
pub struct EventExpander;

#[async_trait]
impl MessageExpander for EventExpander {
    fn key(&self) -> &'static str {
        "calendar"
    }

    async fn expand(
        &self,
        state: &AppState,
        viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        // Nur Karten: Eine Nachricht anderer Art, die eine `eventId` in den
        // Metadaten trägt, ist keine Karte und bekommt keinen Termin.
        let karten: Vec<&MessageRow> = messages
            .iter()
            .filter(|message| message.r#type == "event")
            .collect();
        let mut ids: Vec<Uuid> = karten
            .iter()
            .filter_map(|message| metadata_id(message, "eventId"))
            .collect();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let events = load_event_dtos(state, &ids).await?;
        let mut result = HashMap::new();
        for message in karten {
            let Some(event_id) = metadata_id(message, "eventId") else {
                continue;
            };
            let Some(event) = events.get(&event_id) else {
                continue;
            };
            let darf = event.created_by == Some(viewer_id)
                || event
                    .attendees
                    .iter()
                    .any(|teilnehmer| teilnehmer.user_id == viewer_id);
            if darf {
                result.insert(
                    message.id,
                    Expansion {
                        event: Some(event.clone()),
                        ..Default::default()
                    },
                );
            }
        }
        Ok(result)
    }
}

/// Was sich an Zeit und Ort geändert hat, falls etwas Wesentliches.
///
/// Der Titel zählt nicht: Ein korrigierter Tippfehler ist keine Nachricht wert.
pub fn wesentlich_geaendert(
    alt: &CalendarEventRow,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    all_day: bool,
    rrule: Option<&str>,
    location: Option<&str>,
) -> Option<Aenderung> {
    fn leer_ist_keins(text: Option<&str>) -> Option<&str> {
        text.map(str::trim).filter(|wert| !wert.is_empty())
    }
    let zeit = alt.starts_at != starts_at
        || alt.ends_at != ends_at
        || alt.all_day != all_day
        || leer_ist_keins(alt.rrule.as_deref()) != leer_ist_keins(rrule);
    let ort = leer_ist_keins(alt.location.as_deref()) != leer_ist_keins(location);
    match (zeit, ort) {
        (true, true) => Some(Aenderung::ZeitUndOrt),
        (true, false) => Some(Aenderung::Zeit),
        (false, true) => Some(Aenderung::Ort),
        (false, false) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn termin() -> CalendarEventRow {
        let beginn = DateTime::UNIX_EPOCH + Duration::days(20_000);
        CalendarEventRow {
            id: Uuid::nil(),
            conversation_id: None,
            created_by: None,
            message_id: None,
            title: "Grillen".to_string(),
            description: None,
            location: Some("Wiese".to_string()),
            starts_at: beginn,
            ends_at: beginn + Duration::hours(2),
            all_day: false,
            rrule: None,
            color: None,
            reminder_minutes: serde_json::json!([]),
            source_poll_id: None,
            status: "confirmed".to_string(),
            poll_id: None,
            collection_id: None,
            stand: 0,
            client_id: None,
            erinnern_nach_std: None,
            erinnern_anzahl: None,
            erinnern_seit: None,
            created_at: beginn,
            updated_at: beginn,
            deleted_at: None,
        }
    }

    fn pruefe(alt: &CalendarEventRow, ort: Option<&str>, verschoben: bool) -> Option<Aenderung> {
        let verschiebung = if verschoben {
            Duration::hours(3)
        } else {
            Duration::zero()
        };
        wesentlich_geaendert(
            alt,
            alt.starts_at + verschiebung,
            alt.ends_at + verschiebung,
            alt.all_day,
            alt.rrule.as_deref(),
            ort,
        )
    }

    #[test]
    fn nichts_geaendert_ist_nichts_wert() {
        assert_eq!(pruefe(&termin(), Some("Wiese"), false), None);
    }

    #[test]
    fn eine_neue_zeit_ist_eine_zeitaenderung() {
        assert_eq!(
            pruefe(&termin(), Some("Wiese"), true),
            Some(Aenderung::Zeit)
        );
    }

    #[test]
    fn ein_neuer_ort_ist_eine_ortsaenderung() {
        assert_eq!(pruefe(&termin(), Some("Wald"), false), Some(Aenderung::Ort));
        assert_eq!(pruefe(&termin(), None, false), Some(Aenderung::Ort));
    }

    #[test]
    fn beides_zusammen_hat_einen_eigenen_text() {
        let aenderung = pruefe(&termin(), Some("Wald"), true);
        assert_eq!(aenderung, Some(Aenderung::ZeitUndOrt));
        assert_eq!(aenderung.unwrap().text(), "Zeit und Ort geändert");
    }

    #[test]
    fn leerer_und_fehlender_ort_sind_dasselbe_und_leerraum_zaehlt_nicht() {
        let mut ohne_ort = termin();
        ohne_ort.location = None;
        assert_eq!(pruefe(&ohne_ort, Some("  "), false), None);
        assert_eq!(pruefe(&termin(), Some(" Wiese "), false), None);
    }

    #[test]
    fn die_wiederholungsregel_und_ganztaegig_zaehlen_zur_zeit() {
        let alt = termin();
        let mit_regel = wesentlich_geaendert(
            &alt,
            alt.starts_at,
            alt.ends_at,
            false,
            Some("FREQ=WEEKLY;COUNT=3"),
            Some("Wiese"),
        );
        assert_eq!(mit_regel, Some(Aenderung::Zeit));
        let ganztaegig =
            wesentlich_geaendert(&alt, alt.starts_at, alt.ends_at, true, None, Some("Wiese"));
        assert_eq!(ganztaegig, Some(Aenderung::Zeit));
    }
}
