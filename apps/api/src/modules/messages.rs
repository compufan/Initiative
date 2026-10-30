//! Nachrichten, Reaktionen und Volltextsuche.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{MESSAGE_BODY_MAX, MESSAGE_PAGE_SIZE, MESSAGE_PAGE_SIZE_MAX, MESSAGE_TYPES};
use crate::db::{MessageRow, ReactionRow};
use crate::dto::{ListResult, MessageDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::assert_membership;
use crate::services::messages::{
    create_message, hydrate_messages, load_message, publish_message_update, require_message,
    to_reaction_dtos, NewMessage,
};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/{id}/messages",
            get(list_messages).post(send_message),
        )
        .route("/messages/{id}", get(by_id).patch(edit).delete(remove))
        .route(
            "/messages/{id}/reactions",
            put(add_reaction).delete(remove_reaction),
        )
        .route("/search/messages", get(search))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    before: Option<Uuid>,
    after: Option<Uuid>,
}

async fn list_messages(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    let mitgliedschaft = assert_membership(&state.pool, id, user.id()).await?;
    let limit = query
        .limit
        .unwrap_or(MESSAGE_PAGE_SIZE)
        .clamp(1, MESSAGE_PAGE_SIZE_MAX);

    /*
     * Die Grenze des eigenen Beitritts – als SQL-Baustein, nicht als Filter in
     * Rust.
     *
     * In Rust nachträglich auszusieben wäre falsch: Das Blättern zählt Zeilen,
     * und eine Seite, aus der hinterher die Hälfte verschwindet, sieht für den
     * Client wie das Ende des Verlaufs aus. Die Bedingung gehört also in die
     * WHERE-Klausel, wo sie auch die Seitengrösse bestimmt.
     *
     * `sieht_ab is null` heisst „von Anfang an" – so stehen alle
     * Mitgliedschaften da, die es vor dieser Regel schon gab, und so sieht es
     * aus, wenn der Verlauf nachträglich freigegeben wurde.
     */
    const AB_BEITRITT: &str = "and exists (
                  select 1 from conversation_members cm
                   where cm.conversation_id = m.conversation_id
                     and cm.user_id = $4
                     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
                )";

    // `after` walks forward (catching up), everything else walks backwards.
    let rows = if let Some(after) = query.after {
        sqlx::query_as::<_, MessageRow>(
            // `not exists` statt `left join ... is null`: Es geht nur um die
            // Frage, OB eine Zeile da ist, und Postgres kann den Test an der
            // Sperre abbrechen, statt zu verknuepfen.
            &format!(
                "select * from messages m
                  where m.conversation_id = $1 and m.id > $2
                    and not exists (
                      select 1 from message_hidden h
                       where h.message_id = m.id and h.user_id = $4
                    )
                    {AB_BEITRITT}
                  order by m.id asc limit $3"
            ),
        )
        .bind(id)
        .bind(after)
        .bind(limit)
        .bind(user.id())
        .fetch_all(&state.pool)
        .await?
    } else if let Some(rows) = match mitgliedschaft.sieht_ab {
        Some(grenze) => duenne_seite(&state, id, grenze, query.before, limit, user.id()).await?,
        None => None,
    } {
        rows
    } else {
        let mut rows = sqlx::query_as::<_, MessageRow>(&format!(
            "select * from messages m
                  where m.conversation_id = $1 and ($2::uuid is null or m.id < $2)
                    and not exists (
                      select 1 from message_hidden h
                       where h.message_id = m.id and h.user_id = $4
                    )
                    {AB_BEITRITT}
                  order by m.id desc limit $3"
        ))
        .bind(id)
        .bind(query.before)
        .bind(limit)
        .bind(user.id())
        .fetch_all(&state.pool)
        .await?;
        rows.reverse();
        rows
    };

    let complete_page = rows.len() as i64 == limit;
    let next_cursor = if query.after.is_none() && complete_page {
        rows.first().map(|row| row.id.to_string())
    } else {
        None
    };

    let items = hydrate_messages(&state, rows, user.id()).await?;
    Ok(Json(ListResult::paged(items, next_cursor)))
}

/**
 * Wie viele Nachrichten liegen hinter der Grenze? Höchstens `$3` gezählt.
 *
 * Läuft als Indexbereich über `(conversation_id, created_at)` (Migration
 * 0029) und hört nach `$3` Zeilen auf – egal, wie lang der Verlauf davor ist.
 * Öffentlich, damit der Test den Plan dieser Abfrage prüfen kann.
 */
pub const HINTER_DER_GRENZE_SQL: &str = "select count(*) from (
       select 1 from messages
        where conversation_id = $1 and created_at >= $2
        order by created_at asc
        limit $3
     ) hinter";

/// Die Seite, wenn hinter der Grenze höchstens eine Seite liegt: alle diese
/// Nachrichten über denselben Indexbereich, gefiltert und sortiert wie sonst.
pub const DUENNE_SEITE_SQL: &str = "select * from (
       select * from messages m
        where m.conversation_id = $1 and m.created_at >= $2
        order by m.created_at asc
        limit $3
     ) m
     where ($4::uuid is null or m.id < $4)
       and not exists (
         select 1 from message_hidden h
          where h.message_id = m.id and h.user_id = $5
       )
     order by m.id desc
     limit $6";

/**
 * Die Seite rückwärts für jemanden mit Verlaufsgrenze – wenn sie dünn ist.
 *
 * # Warum das nötig ist
 *
 * Die allgemeine Abfrage läuft rückwärts über `(conversation_id, id)` und
 * filtert dabei `created_at >= sieht_ab`, bis die Seite voll ist. Liegt hinter
 * der Grenze weniger als eine Seite – genau der Fall eines Neuzugangs in
 * einer alten Gruppe –, wird sie nie voll: Postgres las den GANZEN Verlauf
 * vor der Grenze, Zeile für Zeile, um festzustellen, dass da nichts mehr
 * kommt. Bei jedem Öffnen des Chats.
 *
 * # Wie
 *
 * Erst zählen, wie viel hinter der Grenze liegt, über den Zeitindex und
 * gedeckelt bei einer Seite plus eins ([`HINTER_DER_GRENZE_SQL`]). Passt es
 * in eine Seite, ist die Antwort genau diese Menge, gefiltert und nach
 * Kennung sortiert ([`DUENNE_SEITE_SQL`]) – beide Abfragen lesen höchstens
 * `limit + 1` Zeilen. Sonst `None`, und die allgemeine Abfrage übernimmt:
 * Dort füllt sich die Seite, bevor die Grenze erreicht ist.
 *
 * Das Ergebnis ist dasselbe wie das der allgemeinen Abfrage, nicht nur
 * ähnlich: Was sie liefern könnte, liegt hinter der Grenze, und das ist hier
 * vollständig in der Hand.
 *
 * Offen bleibt die letzte Seite eines LANGEN Verlaufs hinter der Grenze
 * (beim Zurückblättern bis an den Anfang): Dort sucht die allgemeine Abfrage
 * nach der letzten Teilseite weiter. Das geschieht einmal am Ende des
 * Blätterns, nicht bei jedem Öffnen.
 */
async fn duenne_seite(
    state: &AppState,
    conversation_id: Uuid,
    grenze: chrono::DateTime<chrono::Utc>,
    before: Option<Uuid>,
    limit: i64,
    viewer: Uuid,
) -> AppResult<Option<Vec<MessageRow>>> {
    let hinter: i64 = sqlx::query_scalar(HINTER_DER_GRENZE_SQL)
        .bind(conversation_id)
        .bind(grenze)
        .bind(limit + 1)
        .fetch_one(&state.pool)
        .await?;
    if hinter > limit {
        return Ok(None);
    }
    let mut rows = sqlx::query_as::<_, MessageRow>(DUENNE_SEITE_SQL)
        .bind(conversation_id)
        .bind(grenze)
        .bind(limit + 1)
        .bind(before)
        .bind(viewer)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
    rows.reverse();
    Ok(Some(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendInput {
    #[serde(default = "default_message_type")]
    r#type: String,
    body: Option<String>,
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
    reply_to_id: Option<Uuid>,
    client_id: Option<String>,
    metadata: Option<Value>,
}

fn default_message_type() -> String {
    "text".to_string()
}

async fn send_message(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<SendInput>,
) -> AppResult<(StatusCode, Json<MessageDto>)> {
    assert_membership(&state.pool, id, user.id()).await?;

    let metadata = match input.metadata {
        None | Some(Value::Null) => json!({}),
        Some(metadata) => metadata,
    };
    client_metadaten_pruefen(&input.r#type, &metadata)?;
    if let Some(client_id) = input.client_id.as_deref() {
        // Der Doppelpunkt gehört den Schlüsseln, die der Server selbst
        // vergibt (`karte:…`, `erinnerung:…`, `vorab:…`). Ein Client, der so
        // einen vorwegnähme, bekäme beim Zustellen der echten Karte seine
        // eigene Nachricht als „schon gesendet“ zurück.
        Validator::new()
            .length(
                "clientId",
                client_id,
                1,
                crate::constants::MESSAGE_CLIENT_ID_MAX,
            )
            .require(
                "clientId",
                !client_id.contains(':'),
                "ungültiger Wiederholungsschlüssel",
            )
            .finish()?;
    }
    if let Some(sticker_id) = metadata.get("stickerId").and_then(Value::as_str) {
        let sticker_id = Uuid::parse_str(sticker_id)
            .map_err(|_| AppError::bad_request("Sticker nicht verfügbar"))?;
        sticker_pruefen(&state, sticker_id, id, user.id()).await?;
    }
    let has_entity = ["stickerId", "pollId", "eventId", "gameSessionId"]
        .iter()
        .any(|key| metadata.get(*key).is_some());
    let body = input
        .body
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Validator::new()
        .one_of("type", &input.r#type, MESSAGE_TYPES)
        .require(
            "type",
            input.r#type != "system",
            "Systemnachrichten können nicht gesendet werden",
        )
        .require(
            "body",
            body.is_some() || !input.attachment_ids.is_empty() || has_entity,
            "Nachricht braucht Text, Anhang oder Bezug",
        )
        .require(
            "body",
            body.as_ref()
                .map(|value| value.chars().count())
                .unwrap_or(0)
                <= MESSAGE_BODY_MAX,
            "Nachricht ist zu lang",
        )
        .require(
            "attachmentIds",
            input.attachment_ids.len() <= crate::constants::ATTACHMENTS_PER_MESSAGE,
            "zu viele Anhänge",
        )
        .finish()?;

    let message = create_message(
        &state,
        NewMessage {
            conversation_id: id,
            sender_id: Some(user.id()),
            r#type: input.r#type,
            body,
            attachment_ids: input.attachment_ids,
            reply_to_id: input.reply_to_id,
            client_id: input.client_id,
            metadata,
            silent: false,
        },
    )
    .await?;

    Ok((StatusCode::CREATED, Json(message)))
}

/// Welche Zusatzangaben ein Client einer Nachricht mitgeben darf.
///
/// Eine Positivliste statt einzelner Verbote. Vorher war jeder Schlüssel
/// erlaubt, außer den ausdrücklich gesperrten – und damit auch die, die der
/// Server selbst setzt: `system` (eine gefälschte „X wurde entfernt“-Zeile im
/// Namen eines anderen), `erinnerung` und was künftig dazukommt. Die
/// Oberfläche schickt `stickerId` (Sticker-Auswahl); `forwardedFrom` und
/// `module` stehen im gemeinsamen Schema als Angaben des Clients.
const CLIENT_METADATEN: &[&str] = &["stickerId", "forwardedFrom", "module"];

fn client_metadaten_pruefen(typ: &str, metadata: &Value) -> AppResult<()> {
    let Some(felder) = metadata.as_object() else {
        return Err(AppError::bad_request(
            "Zusatzangaben müssen ein Objekt sein",
        ));
    };
    if metadata.to_string().len() > crate::constants::MESSAGE_METADATA_MAX {
        return Err(AppError::bad_request("Zusatzangaben sind zu groß"));
    }
    // Termin-Karten legt nur die Termin-Funktion an. Über diesen Weg ließe
    // sich die Kennung eines fremden Termins in einen Chat legen, und die
    // Karte lieferte dann Titel, Ort und Teilnehmerliste – sie gehört ohnehin
    // zu einer Einladung (`event_placements`), und eine Karte ohne sie wäre
    // eine, die niemand nachführt.
    if typ == "event" || felder.contains_key("eventId") || felder.contains_key("erinnerung") {
        return Err(AppError::bad_request(
            "Termin-Karten legt nur die Termin-Funktion an.",
        ));
    }
    // Dasselbe für Umfragen und Partien. Ihre Expander laden, was die Kennung
    // nennt, ohne zu fragen, in welchem Chat es zu Hause ist – eine Karte mit
    // fremder `pollId` zeigte Frage, Stimmen und (offen) Namen jedem in diesem
    // Chat, an `assert_poll_access` vorbei; eine fremde `gameSessionId` zeigte
    // Partie und Mitspieler, auch eine Übung ohne Chat. Beide Karten legt der
    // Server selbst an (`create_poll`, `place_poll`, `create_session`).
    if felder.contains_key("pollId") || felder.contains_key("gameSessionId") {
        return Err(AppError::bad_request(
            "Umfrage- und Spielkarten legt nur die jeweilige Funktion an.",
        ));
    }
    if let Some(fremd) = felder
        .keys()
        .find(|schluessel| !CLIENT_METADATEN.contains(&schluessel.as_str()))
    {
        return Err(AppError::bad_request(format!(
            "Unbekannte Zusatzangabe „{fremd}“"
        )));
    }
    let ist_kennung = |wert: Option<&Value>| {
        wert.and_then(Value::as_str)
            .is_some_and(|text| Uuid::parse_str(text).is_ok())
    };
    if felder.contains_key("stickerId") && !ist_kennung(felder.get("stickerId")) {
        return Err(AppError::bad_request("Sticker nicht verfügbar"));
    }
    if let Some(bezug) = felder.get("forwardedFrom") {
        let passt = bezug.as_object().is_some_and(|bezug| {
            bezug.len() == 2
                && ist_kennung(bezug.get("conversationId"))
                && ist_kennung(bezug.get("messageId"))
        });
        if !passt {
            return Err(AppError::bad_request("Ungültiger Weiterleitungsbezug"));
        }
    }
    if felder.get("module").is_some_and(|modul| !modul.is_object()) {
        return Err(AppError::bad_request("`module` muss ein Objekt sein"));
    }
    Ok(())
}

/// Darf diese Person diesen Sticker in diesen Chat legen?
///
/// Der Expander bettet jeden Sticker ein, dessen Kennung in der Nachricht
/// steht, und die Medien-Prüfung gibt seine Datei dann jedem im Chat frei
/// (`sticker_gespraech` in `services::zugriff`). Eine Kennung aus einem
/// PRIVATEN Paket – etwa aus einem Chat, den man verlassen hat – machte so
/// fremde Bilder sichtbar. Erlaubt ist, was man ohnehin sehen darf:
/// öffentliche Pakete, eigene, installierte, und was in diesem Chat schon
/// einmal gesendet wurde und für mich sichtbar ist (Antwort mit demselben
/// Sticker).
async fn sticker_pruefen(
    state: &AppState,
    sticker_id: Uuid,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    let erlaubt: bool = sqlx::query_scalar(
        "select exists (
           select 1 from stickers s
             join sticker_packs p on p.id = s.pack_id
            where s.id = $1
              and (
                p.is_public
                or p.owner_id = $2
                or exists (select 1 from sticker_pack_installs i
                            where i.pack_id = p.id and i.user_id = $2)
                or exists (
                  select 1 from messages m
                    join conversation_members cm
                      on cm.conversation_id = m.conversation_id and cm.user_id = $2
                   where m.conversation_id = $3
                     and m.deleted_at is null
                     and m.metadata ->> 'stickerId' = s.id::text
                     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
                )
              )
         )",
    )
    .bind(sticker_id)
    .bind(user_id)
    .bind(conversation_id)
    .fetch_one(&state.pool)
    .await?;
    if !erlaubt {
        return Err(AppError::bad_request("Sticker nicht verfügbar"));
    }
    Ok(())
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<MessageDto>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    // Auch hier die Grenze: Diese Route ist der kürzeste Weg an der Liste
    // vorbei – eine Kennung aus einem Zitat oder einem Ereignis genügt, und
    // der Verlauf vor dem eigenen Beitritt stünde offen.
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, id, user.id()).await? {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    load_message(&state, id, user.id())
        .await?
        .map(Json)
        .ok_or_else(|| AppError::not_found("Nachricht nicht gefunden"))
}

#[derive(Debug, Deserialize)]
struct EditInput {
    body: String,
}

async fn edit(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<EditInput>,
) -> AppResult<Json<MessageDto>> {
    let row = require_message(&state.pool, id).await?;
    if row.sender_id != Some(user.id()) {
        return Err(AppError::forbidden(
            "Nur eigene Nachrichten können bearbeitet werden",
        ));
    }
    if row.deleted_at.is_some() {
        return Err(AppError::bad_request(
            "Gelöschte Nachrichten können nicht bearbeitet werden",
        ));
    }
    if row.r#type != "text" {
        return Err(AppError::bad_request(
            "Nur Textnachrichten können bearbeitet werden",
        ));
    }
    let body = input.body.trim().to_string();
    Validator::new()
        .length("body", &body, 1, MESSAGE_BODY_MAX)
        .finish()?;

    let updated = sqlx::query_as::<_, MessageRow>(
        "update messages set body = $2, edited_at = now() where id = $1 returning *",
    )
    .bind(id)
    .bind(&body)
    .fetch_one(&state.pool)
    .await?;

    let message = hydrate_messages(&state, vec![updated], user.id())
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("Nachricht konnte nicht geladen werden"))?;
    publish_message_update(&state, &message).await?;
    Ok(Json(message))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteQuery {
    /// `me` nimmt sie nur aus meinem Verlauf, `all` bei allen.
    ///
    /// Vorgabe ist `all`, weil das die bisherige Bedeutung war – ein alter
    /// Client, der den Parameter nicht kennt, verhaelt sich damit weiter so
    /// wie zuvor und loescht nicht versehentlich nur bei sich.
    #[serde(default)]
    scope: Option<String>,
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<DeleteQuery>,
) -> AppResult<StatusCode> {
    let row = require_message(&state.pool, id).await?;
    let membership = assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    // „Nur für mich“: eine Zeile für mich, sonst aendert sich nichts. Das darf
    // jeder mit jeder Nachricht tun, die er sehen kann – es betrifft ja nur
    // seinen eigenen Verlauf.
    if query.scope.as_deref() == Some("me") {
        sqlx::query(
            "insert into message_hidden (message_id, user_id) values ($1, $2)
             on conflict do nothing",
        )
        .bind(id)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
        // Nur an mich – und nur an meine anderen Geraete. Fuer die uebrigen
        // Mitglieder ist nichts geschehen.
        state
            .hub
            .publish(
                vec![user.id()],
                Event::message_deleted(row.conversation_id, id),
            )
            .await;
        return Ok(StatusCode::NO_CONTENT);
    }

    // Fremde Nachrichten bei allen zu loeschen ist Moderation, und Moderation
    // gibt es nur in einer Gruppe.
    //
    // Vorher hing das allein an der Rolle - und wer einen Zweierchat anlegt,
    // bekommt darin die Rolle "owner". Damit konnte man im Direktchat die
    // Nachrichten des Gegenuebers ueberall loeschen. In einem Gespraech unter
    // zwei Leuten gibt es aber keinen Aufseher; wer zufaellig auf "Neuer Chat"
    // getippt hat, ist keiner. Der Test hat genau das gefunden.
    let ist_gruppe =
        sqlx::query_scalar::<_, String>("select type from conversations where id = $1")
            .bind(row.conversation_id)
            .fetch_optional(&state.pool)
            .await?
            .is_some_and(|art| art == "group");

    let darf_moderieren = ist_gruppe && membership.role != "member";
    if row.sender_id != Some(user.id()) && !darf_moderieren {
        return Err(AppError::forbidden(
            "Für alle löschen kann man nur eigene Nachrichten",
        ));
    }

    // Der Empfängerkreis wird VOR dem Löschen bestimmt: Er hängt am
    // Erstellungszeitpunkt der Nachricht, und die Meldung geht nur an die, für
    // die es überhaupt etwas zu löschen gab. Wer sie nie sehen durfte, erfährt
    // sonst über die Kennung, dass es sie gab.
    let members = crate::services::verlauf::empfaenger_fuer_nachricht(&state.pool, id).await?;

    // Eine Transaktion: Scheiterte vorher der zweite oder dritte Schritt,
    // stand eine gelöschte Nachricht mit ihren Anhängen da (die weiter
    // auslieferbar waren) oder eine Termin-Platzierung, deren Karte fort ist.
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "update messages set deleted_at = now(), body = null, metadata = '{}'::jsonb where id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("delete from attachments where message_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // War es die Karte eines Termins, steht sie dort nicht mehr: Die Zeile in
    // `event_placements` mitzunehmen hält Editor, „Erneut zustellen“ und die
    // Erinnerungen ehrlich – sonst gälte die Karte weiter als vorhanden und
    // ließe sich nicht wieder zustellen.
    sqlx::query("delete from event_placements where message_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    state
        .hub
        .publish(members, Event::message_deleted(row.conversation_id, id))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct ReactionInput {
    emoji: String,
}

async fn publish_reactions(
    state: &AppState,
    message_id: Uuid,
    conversation_id: Uuid,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, ReactionRow>("select * from reactions where message_id = $1")
        .bind(message_id)
        .fetch_all(&state.pool)
        .await?;
    let reactions = to_reaction_dtos(&rows);
    // Nur an die, die diese Nachricht auch sehen dürfen. Sonst meldet das
    // Ereignis einem Neuzugang die Kennung einer Nachricht von vor seinem
    // Beitritt – samt der Liste derer, die darauf reagiert haben.
    let members =
        crate::services::verlauf::empfaenger_fuer_nachricht(&state.pool, message_id).await?;
    state
        .hub
        .publish(
            members,
            Event::message_reactions(conversation_id, message_id, &reactions),
        )
        .await;
    Ok(Json(json!({ "reactions": reactions })))
}

async fn add_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<ReactionInput>,
) -> AppResult<Json<Value>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    // Die Grenze des eigenen Beitritts gilt auch hier: Die Antwort trägt alle
    // Reaktionen samt Personen, und eine Reaktion wäre sonst der Beweis, dass
    // es eine Nachricht von vor dem Beitritt mit dieser Kennung gibt.
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, id, user.id()).await? {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    let emoji = input.emoji.trim().to_string();
    Validator::new().length("emoji", &emoji, 1, 16).finish()?;

    sqlx::query(
        "insert into reactions (message_id, user_id, emoji) values ($1, $2, $3)
         on conflict (message_id, user_id, emoji) do nothing",
    )
    .bind(id)
    .bind(user.id())
    .bind(&emoji)
    .execute(&state.pool)
    .await?;

    publish_reactions(&state, id, row.conversation_id).await
}

async fn remove_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(input): Query<ReactionInput>,
) -> AppResult<Json<Value>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, id, user.id()).await? {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }

    sqlx::query("delete from reactions where message_id = $1 and user_id = $2 and emoji = $3")
        .bind(id)
        .bind(user.id())
        .bind(input.emoji.trim())
        .execute(&state.pool)
        .await?;

    publish_reactions(&state, id, row.conversation_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: String,
    conversation_id: Option<Uuid>,
    limit: Option<i64>,
}

async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    let needle = query.q.trim();
    if needle.chars().count() < 2 {
        return Ok(Json(ListResult::new(Vec::new())));
    }

    let rows = sqlx::query_as::<_, MessageRow>(
        "select m.*
         from messages m
         join conversation_members cm
           on cm.conversation_id = m.conversation_id and cm.user_id = $1
         where m.deleted_at is null
           -- Die Grenze kostet hier nichts: `cm` steht schon im Verbund. Ohne
           -- sie waere die Suche der bequemste Weg in den Altverlauf – ein
           -- Wort eingeben statt seitenweise blaettern.
           and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
           and to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', $2)
           and ($3::uuid is null or m.conversation_id = $3)
         order by m.id desc
         limit $4",
    )
    .bind(user.id())
    .bind(needle)
    .bind(query.conversation_id)
    .bind(query.limit.unwrap_or(30).clamp(1, 50))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(
        hydrate_messages(&state, rows, user.id()).await?,
    )))
}
