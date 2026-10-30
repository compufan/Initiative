//! Conversation membership, permissions and the viewer-specific chat list.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{ConversationMemberRow, ConversationRow, MessageRow};
use crate::dto::{ConversationDto, ConversationMemberDto, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

pub async fn require_conversation(pool: &PgPool, id: Uuid) -> AppResult<ConversationRow> {
    sqlx::query_as::<_, ConversationRow>("select * from conversations where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Chat nicht gefunden"))
}

pub async fn get_membership(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<ConversationMemberRow>> {
    Ok(sqlx::query_as::<_, ConversationMemberRow>(
        "select * from conversation_members where conversation_id = $1 and user_id = $2",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn assert_membership(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<ConversationMemberRow> {
    get_membership(pool, conversation_id, user_id)
        .await?
        .ok_or_else(|| AppError::forbidden("Du bist kein Mitglied dieses Chats"))
}

pub async fn assert_can_moderate(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<ConversationMemberRow> {
    let membership = assert_membership(pool, conversation_id, user_id).await?;
    if membership.role == "member" {
        return Err(AppError::forbidden("Nur Admins dürfen das ändern"));
    }
    Ok(membership)
}

pub async fn member_ids(pool: &PgPool, conversation_id: Uuid) -> AppResult<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> =
        sqlx::query_as("select user_id from conversation_members where conversation_id = $1")
            .bind(conversation_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// „Bis hierhin gelesen" verbuchen und melden.
///
/// # Warum das nicht zweimal dastehen darf
///
/// Es gibt zwei Wege hierher – das Client-Ereignis über den Socket und
/// `POST /conversations/{id}/read`. Beide schrieben dieselbe Spalte und
/// schickten dasselbe Ereignis, jeder mit seiner eigenen Kopie. Wer nur einen
/// von beiden absichert, lässt den anderen offen; genau das war der Fund.
///
/// # Zwei Löcher, eine Stelle
///
/// Die gemeldete Kennung wurde ungeprüft übernommen. Ein Neuzugang konnte
/// damit eine beliebige Kennung in den Rundruf setzen, auch eine von vor
/// seinem Beitritt.
///
/// Und der Empfängerkreis war die ganze Mitgliederliste. Ein Altmitglied, das
/// den Chat öffnet, meldet meist die Nachricht, auf der es stehengeblieben
/// ist; liegt sie vor der Grenze eines Neuzugangs, bekam der ihre Kennung
/// zugestellt. Aus einer v7-Kennung fällt ausserdem die Millisekunde heraus,
/// in der sie geschrieben wurde – das Ereignis verriet also nicht nur, DASS da
/// etwas ist, sondern auch wann.
pub async fn melde_gelesen(
    state: &AppState,
    conversation_id: Uuid,
    user_id: Uuid,
    message_id: Uuid,
) -> AppResult<()> {
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, message_id, user_id).await? {
        return Err(AppError::forbidden("Diese Nachricht kennst du nicht"));
    }

    sqlx::query(
        "update conversation_members set last_read_message_id = $3
          where conversation_id = $1 and user_id = $2
            and (last_read_message_id is null or last_read_message_id < $3)
            -- Gemeldet werden darf nur, was auch in diesem Gespräch liegt.
            and exists (select 1 from messages m
                         where m.id = $3 and m.conversation_id = $1)",
    )
    .bind(conversation_id)
    .bind(user_id)
    .bind(message_id)
    .execute(&state.pool)
    .await?;

    let empfaenger =
        crate::services::verlauf::empfaenger_fuer_nachricht(&state.pool, message_id).await?;
    state
        .hub
        .publish(
            empfaenger,
            Event::read_updated(conversation_id, user_id, message_id),
        )
        .await;
    Ok(())
}

pub async fn touch_conversation(pool: &PgPool, conversation_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "update conversations set last_message_at = now(), updated_at = now() where id = $1",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Default, Clone)]
pub struct ListOptions {
    pub ids: Option<Vec<Uuid>>,
    pub include_archived: bool,
}

#[derive(sqlx::FromRow)]
struct ConversationListRow {
    id: Uuid,
    r#type: String,
    title: Option<String>,
    avatar_attachment_id: Option<Uuid>,
    created_by: Option<Uuid>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    archived: bool,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Assembles the chat list in a fixed number of queries, regardless of size.
pub async fn load_conversation_dtos(
    state: &AppState,
    viewer_id: Uuid,
    options: ListOptions,
) -> AppResult<Vec<ConversationDto>> {
    let rows = sqlx::query_as::<_, ConversationListRow>(
        "select c.id, c.type, c.title, c.avatar_attachment_id, c.created_by, c.created_at,
                c.updated_at, cm.archived, cm.muted_until
         from conversations c
         join conversation_members cm on cm.conversation_id = c.id and cm.user_id = $1
         where ($2::uuid[] is null or c.id = any($2))
           and ($3 or cm.archived = false)
         order by coalesce(c.last_message_at, c.created_at) desc
         limit 300",
    )
    .bind(viewer_id)
    .bind(options.ids.as_deref())
    .bind(options.include_archived)
    .fetch_all(&state.pool)
    .await?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let conversation_ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();

    let member_rows = sqlx::query_as::<_, ConversationMemberRow>(
        // `user_id` als zweiter Schlüssel: Wer in derselben Transaktion
        // beitritt (Gründung, mehrere hinzugefügt), hat dasselbe `joined_at`,
        // und ohne festen Gleichstand hinge die Reihenfolge vom Plan ab – der
        // Rundruf (`load_conversation_fuer_mitglieder`) fragt anders und muss
        // trotzdem dieselbe Liste liefern.
        "select * from conversation_members where conversation_id = any($1)
          order by joined_at asc, user_id asc",
    )
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;

    // Auch die Vorschauzeile hört an der eigenen Grenze auf: Sonst stünde in
    // der Chatliste der Text einer Nachricht, die sich nicht öffnen lässt.
    // Bei einem frisch beigetretenen Chat bleibt die Zeile leer, bis das Erste
    // ankommt – das ist die richtige Auskunft.
    //
    // Je Chat **eine** Indexsuche rückwärts (`lateral … limit 1`). Hier stand
    // `distinct on (conversation_id) … order by conversation_id, id desc`:
    // Postgres las dafür JEDE Nachricht aller dreihundert Chats und sortierte
    // sie, um je Chat die erste zu behalten. Gemessen bei 600 000 Nachrichten:
    // 1,5 s und 57 MB Plattensortierung je Aufruf der Chatliste; so 2 ms.
    let last_message_rows = sqlx::query_as::<_, MessageRow>(
        "select m.*
           from conversation_members cm
           cross join lateral (
             select * from messages m
              where m.conversation_id = cm.conversation_id
                and m.deleted_at is null
                and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
              order by m.id desc
              limit 1
           ) m
          where cm.conversation_id = any($1) and cm.user_id = $2",
    )
    .bind(&conversation_ids)
    .bind(viewer_id)
    .fetch_all(&state.pool)
    .await?;

    let unread_rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "select cm.conversation_id, count(m.id)::bigint
         from conversation_members cm
         join messages m
           on m.conversation_id = cm.conversation_id
          and m.deleted_at is null
          and (m.sender_id is null or m.sender_id <> cm.user_id)
          -- `coalesce` mit der kleinsten Kennung statt `is null or …`: Nur so
          -- wird die Bedingung zur Indexgrenze auf (conversation_id, id), und
          -- gezählt wird ab dem Lesezeichen statt über den ganzen Verlauf.
          -- Gemessen bei 600 000 Nachrichten: 890 ms vorher, 7 ms so.
          and m.id > coalesce(cm.last_read_message_id,
                              '00000000-0000-0000-0000-000000000000'::uuid)
          -- Ungelesenes zählt nur, was man auch lesen darf. Sonst stünde an
          -- einem frisch beigetretenen Chat eine Zahl, die sich durch Lesen
          -- nicht abtragen lässt.
          and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
         where cm.user_id = $1 and cm.conversation_id = any($2)
         group by cm.conversation_id",
    )
    .bind(viewer_id)
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;

    /*
     * Liegt hinter meiner Grenze überhaupt etwas?
     *
     * Aus `sieht_ab` allein folgt das nicht: Auch wer ein Gespräch gründet,
     * bekommt eine Grenze gesetzt – die Regel lautet überall „du siehst ab
     * jetzt", und der Gründungszeitpunkt ist für ihn das Anfang. Wer die Frage
     * am gesetzten Feld statt am Inhalt beantwortet, bietet dem Gründer an,
     * einen Verlauf zu beantragen, den es nicht gibt.
     *
     * Eine Abfrage für alle Gespräche, wie bei den Ungelesenen: Ein `exists`
     * je Gespräch wäre bei dreihundert Gesprächen dreihundert Rundreisen.
     *
     * Der Index `messages_conversation_created_idx` (Migration 0029) macht
     * das `exists` zur Indexsuche. Ohne ihn las es im häufigsten Fall – der
     * Gründer, vor dessen Grenze nichts liegt – den ganzen Verlauf jedes
     * Gesprächs, um festzustellen, dass da nichts ist (900 ms bei 600 000
     * Nachrichten, so 3 ms).
     */
    let verdeckte_rows: Vec<(Uuid,)> = sqlx::query_as(
        "select cm.conversation_id
           from conversation_members cm
          where cm.user_id = $1
            and cm.conversation_id = any($2)
            and cm.sieht_ab is not null
            and exists (
              select 1 from messages m
               where m.conversation_id = cm.conversation_id
                 and m.deleted_at is null
                 and m.created_at < cm.sieht_ab
            )",
    )
    .bind(viewer_id)
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;
    let verdeckt: std::collections::HashSet<Uuid> =
        verdeckte_rows.into_iter().map(|(id,)| id).collect();

    /*
     * Auch das Lesezeichen der anderen hört an meiner Grenze auf.
     *
     * `lastReadMessageId` stand für JEDES Mitglied ungefiltert in der
     * Chatliste. Ein Altmitglied bleibt meist auf der Nachricht stehen, bei
     * der es aufgehört hat; liegt sie vor meinem Beitritt, hielt ich damit die
     * Kennung einer Nachricht in der Hand, die ich nie sehen darf – und aus
     * einer v7-Kennung fällt die Millisekunde heraus, in der sie geschrieben
     * wurde. Wer es nicht sehen darf, sieht kein Lesezeichen; das eigene
     * bleibt immer stehen, denn was man gelesen hat, darf man auch sehen.
     */
    let gelesen_ids: Vec<Uuid> = member_rows
        .iter()
        .filter_map(|row| row.last_read_message_id)
        .collect();
    let sichtbar_gelesen: std::collections::HashSet<Uuid> = if gelesen_ids.is_empty() {
        std::collections::HashSet::new()
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "select m.id from messages m
               join conversation_members cm on cm.conversation_id = m.conversation_id
              where m.id = any($1)
                and cm.user_id = $2
                and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)",
        )
        .bind(&gelesen_ids)
        .bind(viewer_id)
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect()
    };

    let user_ids: Vec<Uuid> = member_rows.iter().map(|row| row.user_id).collect();
    let users = super::users::load_users_by_ids(&state.pool, &user_ids, &state.config).await?;
    let last_messages =
        super::messages::hydrate_messages(state, last_message_rows, viewer_id).await?;

    let mut members_by_conversation: HashMap<Uuid, Vec<ConversationMemberDto>> = HashMap::new();
    for row in member_rows {
        members_by_conversation
            .entry(row.conversation_id)
            .or_default()
            .push(ConversationMemberDto {
                user_id: row.user_id,
                role: row.role.clone(),
                joined_at: row.joined_at,
                nickname: row.nickname.clone(),
                last_read_message_id: row
                    .last_read_message_id
                    .filter(|id| sichtbar_gelesen.contains(id)),
                sieht_ab: row.sieht_ab,
                user: users
                    .get(&row.user_id)
                    .cloned()
                    .unwrap_or_else(|| unknown_user(row.user_id)),
            });
    }

    let mut last_by_conversation: HashMap<Uuid, crate::dto::MessageDto> = HashMap::new();
    for message in last_messages {
        last_by_conversation.insert(message.conversation_id, message);
    }
    let unread_by_conversation: HashMap<Uuid, i64> = unread_rows.into_iter().collect();

    Ok(rows
        .into_iter()
        .map(|row| ConversationDto {
            avatar_url: row
                .avatar_attachment_id
                .map(|id| state.config.media_url(&id)),
            members: members_by_conversation.remove(&row.id).unwrap_or_default(),
            last_message: last_by_conversation.remove(&row.id),
            unread_count: unread_by_conversation.get(&row.id).copied().unwrap_or(0),
            verdeckter_verlauf: verdeckt.contains(&row.id),
            id: row.id,
            r#type: row.r#type,
            title: row.title,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
            muted_until: row.muted_until,
            archived: row.archived,
        })
        .collect())
}

fn unknown_user(user_id: Uuid) -> UserDto {
    UserDto {
        id: user_id,
        username: "unbekannt".to_string(),
        display_name: "Unbekannt".to_string(),
        avatar_url: None,
        bio: None,
        accent: "#78716c".to_string(),
        last_seen_at: None,
        created_at: chrono::DateTime::UNIX_EPOCH,
    }
}

pub async fn load_conversation_dto(
    state: &AppState,
    viewer_id: Uuid,
    conversation_id: Uuid,
) -> AppResult<ConversationDto> {
    load_conversation_dtos(
        state,
        viewer_id,
        ListOptions {
            ids: Some(vec![conversation_id]),
            include_archived: true,
        },
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::not_found("Chat nicht gefunden"))
}

/// Conversation payloads are viewer specific, so every member gets their own copy.
///
/// # Einmal laden, je Person nur das Eigene
///
/// Hier stand eine Schleife über `load_conversation_dto` – je Mitglied die
/// ganze Chatliste für einen Chat, rund neun Abfragen. Bei 200 Mitgliedern
/// kostete ein Umbenennen so 1800 Abfragen. Jetzt lädt
/// [`load_conversation_fuer_mitglieder`] Gespräch, Mitglieder und Profile
/// einmal und ergänzt das Betrachterabhängige in Mengenabfragen.
pub async fn broadcast_conversation(
    state: &AppState,
    conversation_id: Uuid,
    targets: Option<Vec<Uuid>>,
) -> AppResult<()> {
    let targets = match targets {
        Some(ids) => ids,
        None => member_ids(&state.pool, conversation_id).await?,
    };
    // Wie bisher: Wer (nicht mehr) Mitglied ist oder wofür das Laden
    // scheitert, bekommt nichts – ein Fehler hier soll die Änderung, die
    // schon geschrieben ist, nicht als gescheitert melden.
    let fassungen = match load_conversation_fuer_mitglieder(state, conversation_id, &targets).await
    {
        Ok(fassungen) => fassungen,
        Err(fehler) => {
            tracing::warn!(%fehler, %conversation_id, "Chat-Rundruf: Laden gescheitert");
            return Ok(());
        }
    };
    for user_id in targets {
        if let Some(conversation) = fassungen.get(&user_id) {
            state
                .hub
                .publish(vec![user_id], Event::conversation_updated(conversation))
                .await;
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct GespraechKopf {
    id: Uuid,
    r#type: String,
    title: Option<String>,
    avatar_attachment_id: Option<Uuid>,
    created_by: Option<Uuid>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/**
 * Ein Gespräch, wie es jeder dieser Betrachter sieht – Person → Fassung.
 *
 * Das Ergebnis je Person ist dasselbe wie `load_conversation_dto(person, …)`
 * (der Test `rundruf_gleichwertig` in `tests/pruefpunkte.rs` vergleicht es
 * Feld für Feld). Wer nicht Mitglied ist, fehlt im Ergebnis.
 *
 * # Was für alle gleich ist und was nicht
 *
 * Gleich: Kopf des Gesprächs, Mitgliederliste, Profile. Je Person:
 * Archiviert/Stumm (aus der Mitgliederzeile), Ungelesene, verdeckter
 * Verlauf, letzte Nachricht (sie hängt an der eigenen Grenze), welche
 * Lesezeichen der anderen man sehen darf. Jedes davon ist **eine** Abfrage
 * für alle Betrachter zusammen.
 *
 * Die letzte Nachricht wird je verschiedener Nachricht EINMAL aufbereitet,
 * wenn das Ergebnis nicht vom Betrachter abhängt – kein Zitat und keine
 * Erweiterung (Umfrage, Termin, Spiel, Sticker; siehe
 * `expanders::betrachterabhaengig`). Sonst je Person, wie bisher: Eine
 * Umfrage trägt die eigenen Stimmen, ein Termin ist nicht für jeden sichtbar,
 * ein Zitat hört an der eigenen Grenze auf.
 */
pub async fn load_conversation_fuer_mitglieder(
    state: &AppState,
    conversation_id: Uuid,
    betrachter: &[Uuid],
) -> AppResult<HashMap<Uuid, ConversationDto>> {
    use std::collections::HashSet;

    let mut ergebnis = HashMap::new();
    if betrachter.is_empty() {
        return Ok(ergebnis);
    }
    let Some(kopf) = sqlx::query_as::<_, GespraechKopf>(
        "select id, type, title, avatar_attachment_id, created_by, created_at, updated_at
           from conversations where id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&state.pool)
    .await?
    else {
        return Ok(ergebnis);
    };

    let member_rows = sqlx::query_as::<_, ConversationMemberRow>(
        "select * from conversation_members where conversation_id = $1
          order by joined_at asc, user_id asc",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;
    let mitglied: HashMap<Uuid, &ConversationMemberRow> =
        member_rows.iter().map(|row| (row.user_id, row)).collect();
    let mut leser: Vec<Uuid> = betrachter
        .iter()
        .copied()
        .filter(|id| mitglied.contains_key(id))
        .collect();
    leser.sort();
    leser.dedup();
    if leser.is_empty() {
        return Ok(ergebnis);
    }

    // Je Betrachter die letzte Nachricht innerhalb seiner Grenze – dieselbe
    // Indexsuche wie in der Chatliste, nur für alle auf einmal.
    let letzte: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select cm.user_id, m.id
           from conversation_members cm
           cross join lateral (
             select m.id from messages m
              where m.conversation_id = cm.conversation_id
                and m.deleted_at is null
                and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
              order by m.id desc
              limit 1
           ) m
          where cm.conversation_id = $1 and cm.user_id = any($2)",
    )
    .bind(conversation_id)
    .bind(&leser)
    .fetch_all(&state.pool)
    .await?;

    let ungelesen: HashMap<Uuid, i64> = sqlx::query_as::<_, (Uuid, i64)>(
        "select cm.user_id, count(m.id)::bigint
         from conversation_members cm
         join messages m
           on m.conversation_id = cm.conversation_id
          and m.deleted_at is null
          and (m.sender_id is null or m.sender_id <> cm.user_id)
          and m.id > coalesce(cm.last_read_message_id,
                              '00000000-0000-0000-0000-000000000000'::uuid)
          and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
         where cm.conversation_id = $1 and cm.user_id = any($2)
         group by cm.user_id",
    )
    .bind(conversation_id)
    .bind(&leser)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();

    let verdeckt: HashSet<Uuid> = sqlx::query_scalar::<_, Uuid>(
        "select cm.user_id
           from conversation_members cm
          where cm.conversation_id = $1
            and cm.user_id = any($2)
            and cm.sieht_ab is not null
            and exists (
              select 1 from messages m
               where m.conversation_id = cm.conversation_id
                 and m.deleted_at is null
                 and m.created_at < cm.sieht_ab
            )",
    )
    .bind(conversation_id)
    .bind(&leser)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();

    // Die Lesezeichen aller: Zeitpunkt und Gespräch einmal holen, die Grenze
    // jedes Betrachters dann ohne weitere Abfrage anlegen – dieselbe Regel
    // wie in der Chatliste (Nachricht in diesem Gespräch, ab der Grenze).
    let gelesen_ids: Vec<Uuid> = member_rows
        .iter()
        .filter_map(|row| row.last_read_message_id)
        .collect();
    let gelesen_zeit: HashMap<Uuid, chrono::DateTime<chrono::Utc>> = if gelesen_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (Uuid, chrono::DateTime<chrono::Utc>)>(
            "select id, created_at from messages where id = any($1) and conversation_id = $2",
        )
        .bind(&gelesen_ids)
        .bind(conversation_id)
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect()
    };

    let user_ids: Vec<Uuid> = member_rows.iter().map(|row| row.user_id).collect();
    let users = super::users::load_users_by_ids(&state.pool, &user_ids, &state.config).await?;

    // Die letzten Nachrichten aufbereiten: einmal je Nachricht, wo das für
    // alle dasselbe ergibt; sonst je Betrachter.
    let mut nachricht_ids: Vec<Uuid> = letzte.iter().map(|(_, id)| *id).collect();
    nachricht_ids.sort();
    nachricht_ids.dedup();
    let zeilen: HashMap<Uuid, MessageRow> = if nachricht_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, MessageRow>("select * from messages where id = any($1)")
            .bind(&nachricht_ids)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .map(|row| (row.id, row))
            .collect()
    };
    let letzte_von: HashMap<Uuid, Uuid> = letzte.into_iter().collect();
    let mut gemeinsam: Vec<MessageRow> = Vec::new();
    for zeile in zeilen.values() {
        if !super::expanders::betrachterabhaengig(zeile) {
            gemeinsam.push(zeile.clone());
        }
    }
    let mut fertig_gemeinsam: HashMap<Uuid, crate::dto::MessageDto> = HashMap::new();
    if !gemeinsam.is_empty() {
        // Der Betrachter spielt hier keine Rolle (siehe oben); irgendeiner
        // genügt.
        for nachricht in super::messages::hydrate_messages(state, gemeinsam, leser[0]).await? {
            fertig_gemeinsam.insert(nachricht.id, nachricht);
        }
    }

    for person in leser {
        let eigene = mitglied[&person];
        let grenze = eigene.sieht_ab;
        let members = member_rows
            .iter()
            .map(|row| ConversationMemberDto {
                user_id: row.user_id,
                role: row.role.clone(),
                joined_at: row.joined_at,
                nickname: row.nickname.clone(),
                last_read_message_id: row.last_read_message_id.filter(|id| {
                    gelesen_zeit
                        .get(id)
                        .is_some_and(|zeit| grenze.is_none_or(|ab| *zeit >= ab))
                }),
                sieht_ab: row.sieht_ab,
                user: users
                    .get(&row.user_id)
                    .cloned()
                    .unwrap_or_else(|| unknown_user(row.user_id)),
            })
            .collect();

        let last_message = match letzte_von.get(&person) {
            None => None,
            Some(id) => match fertig_gemeinsam.get(id) {
                Some(nachricht) => Some(nachricht.clone()),
                None => match zeilen.get(id) {
                    Some(zeile) => {
                        super::messages::hydrate_messages(state, vec![zeile.clone()], person)
                            .await?
                            .into_iter()
                            .next()
                    }
                    None => None,
                },
            },
        };

        ergebnis.insert(
            person,
            ConversationDto {
                id: kopf.id,
                r#type: kopf.r#type.clone(),
                title: kopf.title.clone(),
                avatar_url: kopf
                    .avatar_attachment_id
                    .map(|id| state.config.media_url(&id)),
                created_by: kopf.created_by,
                created_at: kopf.created_at,
                updated_at: kopf.updated_at,
                members,
                last_message,
                unread_count: ungelesen.get(&person).copied().unwrap_or(0),
                verdeckter_verlauf: verdeckt.contains(&person),
                muted_until: eigene.muted_until,
                archived: eigene.archived,
            },
        );
    }
    Ok(ergebnis)
}

/// Existing 1:1 chat between two users, if any.
///
/// Gibt es mehrere (zwei gleichzeitige Anlegevorgänge), gilt der **älteste** –
/// dieselbe Regel wie in [`einzelchats_sichern`], damit Handler und Dienst
/// denselben Chat meinen.
pub async fn find_direct_conversation(
    pool: &PgPool,
    user_a: Uuid,
    user_b: Uuid,
) -> AppResult<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "select c.id
         from conversations c
         join conversation_members a on a.conversation_id = c.id and a.user_id = $1
         join conversation_members b on b.conversation_id = c.id and b.user_id = $2
         where c.type = 'direct'
         order by c.created_at, c.id
         limit 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Die Einzelchats des Erstellers mit diesen Personen: Person → Chat.
///
/// Je Person der älteste. Ein Einzelchat, den eine Seite verlassen hat, zählt
/// nicht – er hätte nur ein Mitglied und träfe die Bedingung „beide sind
/// Mitglied“ nicht.
pub async fn vorhandene_einzelchats<'e, E>(
    executor: E,
    ersteller: Uuid,
    personen: &[Uuid],
) -> AppResult<HashMap<Uuid, Uuid>>
where
    E: sqlx::PgExecutor<'e>,
{
    if personen.is_empty() {
        return Ok(HashMap::new());
    }
    let zeilen: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select distinct on (b.user_id) b.user_id, c.id
           from conversations c
           join conversation_members a on a.conversation_id = c.id and a.user_id = $1
           join conversation_members b on b.conversation_id = c.id and b.user_id = any($2)
          where c.type = 'direct'
          order by b.user_id, c.created_at, c.id",
    )
    .bind(ersteller)
    .bind(personen)
    .fetch_all(executor)
    .await?;
    Ok(zeilen.into_iter().collect())
}

/// Was [`einzelchats_sichern`] gefunden oder angelegt hat.
#[derive(Debug, Default)]
pub struct Einzelchats {
    /// Person → ihr Einzelchat mit dem Ersteller.
    pub chat_von: HashMap<Uuid, Uuid>,
    /// Die Chats, die dabei neu angelegt wurden.
    pub neu: Vec<Uuid>,
}

/// Findet die Einzelchats zwischen dem Ersteller und diesen Personen – und legt
/// die fehlenden an.
///
/// # Warum das hier steht und nicht im Handler
///
/// Erst legte nur `POST /conversations` Einzelchats an. Eine Einladung braucht
/// sie im Dutzend, in **einer** Transaktion mit dem Termin: bricht etwas ab,
/// soll kein halber Termin und kein leerer Chat übrig bleiben. Der Handler
/// nutzt für den Direktfall jetzt denselben Dienst.
///
/// Die Prüfung, ob man mit dieser Person einen Chat anlegen darf, sitzt
/// ebenfalls nur hier: Heute gilt „Person existiert“ und nicht „mit sich
/// selbst“ – eine Sperrliste gibt es nicht. Käme eine, hängte sie sich an
/// dieser einen Stelle ein, statt an drei.
///
/// # Gleichzeitiges Anlegen
///
/// Für das Paar gibt es keinen Eindeutigkeits-Index (er wäre nicht einfach
/// auszudrücken: Mitglieder stehen in einer eigenen Tabelle). Stattdessen
/// sperrt die Transaktion jedes Paar, sortiert, damit zwei Einladungen
/// einander nicht in die Quere kommen. Wer als Zweiter sperrt, findet danach
/// den Chat des Ersten.
pub async fn einzelchats_sichern(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ersteller: Uuid,
    personen: &[Uuid],
) -> AppResult<Einzelchats> {
    let mut personen: Vec<Uuid> = personen
        .iter()
        .copied()
        .filter(|person| *person != ersteller)
        .collect();
    personen.sort();
    personen.dedup();
    if personen.is_empty() {
        return Ok(Einzelchats::default());
    }

    // Sortiert sperren: Zwei Einladungen, die dieselben Paare in anderer
    // Reihenfolge anfassen, würden einander sonst ewig warten lassen.
    sqlx::query(
        "select pg_advisory_xact_lock(
                  hashtextextended('einzelchat:' || least($1::uuid, p)::text
                                   || ':' || greatest($1::uuid, p)::text, 0))
           from (select p from unnest($2::uuid[]) as p order by p) sortiert",
    )
    .bind(ersteller)
    .bind(&personen)
    .execute(&mut **tx)
    .await?;

    let mut chat_von = vorhandene_einzelchats(&mut **tx, ersteller, &personen).await?;
    let fehlend: Vec<Uuid> = personen
        .iter()
        .copied()
        .filter(|person| !chat_von.contains_key(person))
        .collect();
    if fehlend.is_empty() {
        return Ok(Einzelchats {
            chat_von,
            neu: Vec::new(),
        });
    }

    let neue_ids: Vec<Uuid> = fehlend.iter().map(|_| Uuid::now_v7()).collect();
    sqlx::query(
        "insert into conversations (id, type, created_by)
         select id, 'direct', $2 from unnest($1::uuid[]) as id",
    )
    .bind(&neue_ids)
    .bind(ersteller)
    .execute(&mut **tx)
    .await?;

    // Beide Seiten mit `sieht_ab`: Die Regel lautet überall „du siehst ab
    // jetzt“, und für die Gründenden ist das die Geburt des Gesprächs – wie im
    // Handler, der bisher allein Chats anlegte.
    sqlx::query(
        "insert into conversation_members (conversation_id, user_id, role, sieht_ab)
         select t.chat, $3, 'owner', now() from unnest($1::uuid[]) as t(chat)
         union all
         select t.chat, t.person, 'member', now()
           from unnest($1::uuid[], $2::uuid[]) as t(chat, person)",
    )
    .bind(&neue_ids)
    .bind(&fehlend)
    .bind(ersteller)
    .execute(&mut **tx)
    .await?;

    for (person, chat) in fehlend.iter().zip(&neue_ids) {
        chat_von.insert(*person, *chat);
    }
    Ok(Einzelchats {
        chat_von,
        neu: neue_ids,
    })
}

/// Meldet neue Einzelchats den Beteiligten – nach dem Commit.
///
/// Jeder bekommt seine eigene Fassung (Chat-Nutzlasten sind betrachterabhängig),
/// darum je Chat zwei Ladevorgänge; begrenzt parallel, damit eine Einladung an
/// zweihundert Leute den Verbindungsvorrat nicht leerzieht.
pub async fn neue_chats_melden(state: &AppState, neu: &[Uuid]) {
    use futures_util::stream::{self, StreamExt};

    stream::iter(neu.iter().copied())
        .for_each_concurrent(crate::constants::EINLADUNG_PARALLEL, |chat| async move {
            if let Err(fehler) = broadcast_conversation(state, chat, None).await {
                tracing::warn!(%fehler, %chat, "neuen Einzelchat melden gescheitert");
            }
        })
        .await;
}

/* ---------- Besitz einer Gruppe ---------- */

/// Wer in einer Gruppe den Besitz übernommen hat: (Gruppe, neuer Besitzer).
pub type Uebernahme = (Uuid, Uuid);

/**
 * Gruppen ohne Besitzer bekommen einen.
 *
 * # Warum
 *
 * Verliess der Besitzer eine Gruppe (oder löschte er sein Konto), blieb sie
 * ohne „owner“ zurück. Übergeben kann aber nur ein Besitzer, und niemand
 * kann sich selbst befördern – die Gruppe war für immer ohne jemanden, der
 * Admins ernennen oder absetzen darf.
 *
 * # Wer
 *
 * Der dienstälteste Admin, sonst das dienstälteste Mitglied. Dienstalter ist
 * `joined_at`; wer gleichzeitig beigetreten ist (Gründung), wird nach Kennung
 * entschieden, damit die Wahl nicht vom Plan der Abfrage abhängt.
 *
 * Nur Gruppen: Im Direktchat ist die Rolle bedeutungslos (dort gibt es nichts
 * zu moderieren, siehe `modules::conversations::darf_moderieren`).
 *
 * Läuft in der Transaktion des Austritts bzw. der Kontolöschung, die die
 * Gespräche vorher mit `for update` sperrt (siehe [`gespraeche_sperren`]):
 * Zwei gleichzeitige Austritte können so nicht beide „es gibt noch einen
 * Besitzer“ sehen, oder den Nachfolger wählen, der gerade selbst geht.
 */
pub async fn besitz_nachfolgen(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    chats: &[Uuid],
) -> AppResult<Vec<Uebernahme>> {
    if chats.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, (Uuid, Uuid)>(
        "update conversation_members cm set role = 'owner'
           from (
             select distinct on (m.conversation_id) m.conversation_id, m.user_id
               from conversation_members m
               join conversations c on c.id = m.conversation_id and c.type = 'group'
              where m.conversation_id = any($1)
                and not exists (
                  select 1 from conversation_members o
                   where o.conversation_id = m.conversation_id and o.role = 'owner')
              order by m.conversation_id, (m.role = 'admin') desc, m.joined_at asc, m.user_id asc
           ) nachfolge
          where cm.conversation_id = nachfolge.conversation_id
            and cm.user_id = nachfolge.user_id
          returning cm.conversation_id, cm.user_id",
    )
    .bind(chats)
    .fetch_all(&mut **tx)
    .await?)
}

/// Sperrt die Gespräche für die Dauer der Transaktion – sortiert, damit zwei
/// Vorgänge, die dieselben Gespräche anfassen, einander nicht verklemmen.
pub async fn gespraeche_sperren(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    chats: &[Uuid],
) -> AppResult<()> {
    if chats.is_empty() {
        return Ok(());
    }
    sqlx::query("select id from conversations where id = any($1) order by id for update")
        .bind(chats)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Nach dem Commit: Systemzeile „… ist jetzt Besitzer“ und neue Fassung an
/// alle Mitglieder. Scheitert etwas, steht der Besitz trotzdem – nur die
/// Meldung fehlt, und die nächste Chatliste zeigt ihn.
pub async fn uebernahmen_melden(state: &AppState, uebernahmen: &[Uebernahme]) {
    for (chat, besitzer) in uebernahmen {
        let karte = super::messages::NewMessage::system(*chat, *besitzer, "owner.changed", vec![]);
        if let Err(fehler) = super::messages::create_message(state, karte).await {
            tracing::warn!(%fehler, %chat, "Besitzwechsel: Systemzeile gescheitert");
        }
        if let Err(fehler) = broadcast_conversation(state, *chat, None).await {
            tracing::warn!(%fehler, %chat, "Besitzwechsel: Rundruf gescheitert");
        }
    }
}

/**
 * Ein Konto löschen – samt Besitzübergabe in seinen Gruppen.
 *
 * Der eine Weg für beide Löschungen (selbst und über die Verwaltung). Das
 * eigentliche Löschen sind weiter die Fremdschlüssel-Kaskaden; hier kommt nur
 * hinzu, dass Gruppen, die dabei ihren Besitzer verlieren, einen neuen
 * bekommen – in derselben Transaktion.
 */
pub async fn konto_loeschen(state: &AppState, user_id: Uuid) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    let besessen: Vec<Uuid> = sqlx::query_scalar(
        "select cm.conversation_id from conversation_members cm
           join conversations c on c.id = cm.conversation_id and c.type = 'group'
          where cm.user_id = $1 and cm.role = 'owner'",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    gespraeche_sperren(&mut tx, &besessen).await?;
    sqlx::query("delete from users where id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let uebernahmen = besitz_nachfolgen(&mut tx, &besessen).await?;
    tx.commit().await?;
    uebernahmen_melden(state, &uebernahmen).await;
    Ok(())
}
