//! Chats, Mitglieder und Lesestatus.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::dto::{ConversationDto, ListResult};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::attachments::require_eigener_anhang;
use crate::services::conversations::{
    assert_can_moderate, assert_membership, besitz_nachfolgen, broadcast_conversation,
    einzelchats_sichern, gespraeche_sperren, get_membership, load_conversation_dto,
    load_conversation_dtos, member_ids, require_conversation, uebernahmen_eintragen,
    uebernahmen_melden, ListOptions, HINTERGRUENDE,
};
use crate::services::messages::{ausliefern, nachricht_anlegen, NewMessage};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/conversations", get(list).post(create))
        .route("/conversations/{id}", get(by_id).patch(update))
        .route("/conversations/{id}/members", post(add_members))
        .route(
            "/conversations/{id}/members/{user_id}",
            patch(update_member).delete(remove_member),
        )
        .route("/conversations/{id}/read", post(mark_read))
        // Der Verlauf vor dem eigenen Beitritt: beantragen, abstimmen, ansehen.
        .route(
            "/conversations/{id}/verlauf",
            get(verlauf_offene).post(verlauf_stellen),
        )
        .route(
            "/conversations/{id}/verlauf/{antrag_id}",
            post(verlauf_abstimmen).delete(verlauf_zurueckziehen),
        )
        // Für mich: leeren, Direktchat löschen, Reihenfolge der Angehefteten.
        .route("/conversations/{id}/leeren", post(leeren))
        .route("/conversations/{id}/ausblenden", post(ausblenden))
        .route(
            "/conversations/angeheftet",
            axum::routing::put(angeheftet_ordnen),
        )
        // Eigene Ordner der Chatliste.
        .route("/chat-ordner", get(ordner_liste).post(ordner_anlegen))
        .route(
            "/chat-ordner/{ordner_id}",
            patch(ordner_aendern).delete(ordner_loeschen),
        )
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    archived: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<ConversationDto>>> {
    let archived = query.archived.as_deref() == Some("true");
    let items = load_conversation_dtos(
        &state,
        user.id(),
        ListOptions {
            ids: None,
            include_archived: archived,
        },
    )
    .await?;
    let items = if archived {
        items.into_iter().filter(|item| item.archived).collect()
    } else {
        items
    };
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    #[serde(default = "default_type")]
    r#type: String,
    title: Option<String>,
    member_ids: Vec<Uuid>,
    avatar_attachment_id: Option<Uuid>,
}

fn default_type() -> String {
    "direct".to_string()
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<ConversationDto>)> {
    Validator::new()
        .one_of("type", &input.r#type, crate::constants::CONVERSATION_TYPES)
        .require(
            "memberIds",
            !input.member_ids.is_empty(),
            "mindestens ein Mitglied",
        )
        .require(
            "memberIds",
            input.r#type != "direct" || input.member_ids.len() == 1,
            "Direktchats brauchen genau ein Gegenüber",
        )
        // Der Titel steht in der Chatliste und jeder Mitteilung aller
        // Mitglieder; `CONVERSATION_TITLE_MAX` gab es, geprüft wurde er nie.
        .length(
            "title",
            input.title.as_deref().map(str::trim).unwrap_or_default(),
            0,
            crate::constants::CONVERSATION_TITLE_MAX,
        )
        .finish()?;

    let mut members = input.member_ids.clone();
    members.push(user.id());
    members.sort();
    members.dedup();

    let known: Vec<(Uuid,)> = sqlx::query_as("select id from users where id = any($1)")
        .bind(&members)
        .fetch_all(&state.pool)
        .await?;
    if known.len() != members.len() {
        return Err(AppError::bad_request("Unbekannte Mitglieder"));
    }

    if input.r#type == "direct" {
        let counterpart = input.member_ids[0];
        if counterpart == user.id() {
            return Err(AppError::bad_request(
                "Chat mit sich selbst ist nicht möglich",
            ));
        }
        // Finden oder anlegen: derselbe Dienst wie bei Einladungen, die
        // Einzelchats im Dutzend brauchen. Dort sitzt auch die Sperre gegen
        // zwei gleichzeitig angelegte Chats desselben Paares.
        let mut tx = state.pool.begin().await?;
        let gesichert = einzelchats_sichern(&mut tx, user.id(), &[counterpart]).await?;
        tx.commit().await?;
        let chat = *gesichert
            .chat_von
            .get(&counterpart)
            .ok_or_else(|| AppError::internal("Einzelchat konnte nicht angelegt werden"))?;
        if gesichert.neu.is_empty() {
            // Wer den Chat „für sich gelöscht“ hatte und neu anschreibt, will
            // ihn wieder in der Liste sehen.
            sqlx::query(
                "update conversation_members set ausgeblendet = false
                  where conversation_id = $1 and user_id = $2 and ausgeblendet",
            )
            .bind(chat)
            .bind(user.id())
            .execute(&state.pool)
            .await?;
            let dto = load_conversation_dto(&state, user.id(), chat).await?;
            return Ok((StatusCode::OK, Json(dto)));
        }
        broadcast_conversation(&state, chat, Some(members)).await?;
        let dto = load_conversation_dto(&state, user.id(), chat).await?;
        return Ok((StatusCode::CREATED, Json(dto)));
    }

    let conversation_id = Uuid::now_v7();
    let title = if input.r#type == "group" {
        Some(
            input
                .title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Neue Gruppe".to_string()),
        )
    } else {
        None
    };

    // Dasselbe wie beim Profilbild: Ein Gruppenbild muss die eigene Datei
    // sein. Sonst reichte eine geratene Anhangskennung, um eine fremde Datei
    // allen Mitgliedern einer Gruppe zu zeigen.
    if let Some(anhang) = input.avatar_attachment_id {
        require_eigener_anhang(&state.pool, anhang, user.id()).await?;
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "insert into conversations (id, type, title, avatar_attachment_id, created_by)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(conversation_id)
    .bind(&input.r#type)
    .bind(&title)
    .bind(input.avatar_attachment_id)
    .bind(user.id())
    .execute(&mut *tx)
    .await?;

    for member_id in &members {
        sqlx::query(
            // `sieht_ab` auch bei der Gründung: Die Regel lautet „du siehst ab
            // deinem Beitritt", und für die Gründenden ist das die Geburt des
            // Gesprächs – es gibt nichts davor. Eine Ausnahme hier wäre eine
            // zweite Regel ohne Not.
            "insert into conversation_members (conversation_id, user_id, role, sieht_ab)
             values ($1, $2, $3, now())",
        )
        .bind(conversation_id)
        .bind(member_id)
        .bind(if *member_id == user.id() {
            "owner"
        } else {
            "member"
        })
        .execute(&mut *tx)
        .await?;
    }
    // Die Systemzeile gehört zur Gründung: Vorher kam sie nach dem Commit, und
    // ein Abbruch dazwischen liess eine Gruppe ohne „… hat die Gruppe
    // erstellt“ zurück (und ohne `last_message_at`, also unten in der Liste).
    let gruendung = if input.r#type == "group" {
        Some(
            nachricht_anlegen(
                &mut tx,
                NewMessage::system(
                    conversation_id,
                    user.id(),
                    "conversation.created",
                    Vec::new(),
                ),
            )
            .await?,
        )
    } else {
        None
    };
    tx.commit().await?;

    if let Some(gruendung) = gruendung {
        ausliefern(&state, gruendung).await?;
    }

    broadcast_conversation(&state, conversation_id, Some(members)).await?;
    let dto = load_conversation_dto(&state, user.id(), conversation_id).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ConversationDto>> {
    assert_membership(&state.pool, id, user.id()).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    #[serde(default, deserialize_with = "super::double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    avatar_attachment_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "super::double_option")]
    description: Option<Option<String>>,
    /// Gruppenschalter – nur die genannten ändern sich.
    settings: Option<EinstellungenInput>,
    #[serde(default, deserialize_with = "super::double_option")]
    muted_until: Option<Option<chrono::DateTime<chrono::Utc>>>,
    archived: Option<bool>,
    pinned: Option<bool>,
    marked_unread: Option<bool>,
    notify_level: Option<String>,
    notify_preview: Option<bool>,
    #[serde(default, deserialize_with = "super::double_option")]
    hintergrund: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EinstellungenInput {
    nur_admins_senden: Option<bool>,
    nur_admins_info: Option<bool>,
    langsamer_modus: Option<u32>,
}

/// Höchstens so viele angeheftete Chats – wie bei WhatsApp. Mehr wäre keine
/// Hervorhebung mehr, sondern eine zweite Liste.
pub const ANGEHEFTET_MAX: i64 = 5;

/// Die Stufen des langsamen Modus in Sekunden (0 = aus). Eine feste Auswahl
/// wie bei Telegram: frei wählbare Werte bräuchten eine Obergrenze und
/// brächten nichts, was diese Stufen nicht schon können.
pub const LANGSAM_STUFEN: &[u32] = &[0, 10, 30, 60, 300, 900, 3600];

/// Länge der Gruppenbeschreibung – dieselbe Grenze wie in Migration 0037.
pub const BESCHREIBUNG_MAX: usize = 512;

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateInput>,
) -> AppResult<Json<ConversationDto>> {
    let membership = assert_membership(&state.pool, id, user.id()).await?;
    let chat = require_conversation(&state.pool, id).await?;
    let einstellungen_vorher = crate::dto::GruppenEinstellungen::aus(&chat.settings);

    let info_aendern = input.title.is_some()
        || input.avatar_attachment_id.is_some()
        || input.description.is_some();
    if info_aendern || input.settings.is_some() {
        // Ein Direktchat hat keinen Titel, kein Bild und keine Schalter: Die
        // Oberfläche zeigt dort Namen und Bild des Gegenübers. Wer ihn
        // angelegt hat, ist „owner“ – und konnte ihn bisher für beide
        // umbenennen.
        if chat.r#type != "group" {
            return Err(AppError::forbidden(
                "Einen Direktchat kann man nicht umbenennen",
            ));
        }
    }
    if info_aendern {
        // Wer die Gruppeninfo ändern darf, bestimmt der Schalter „Nur Admins
        // dürfen Gruppeninfo ändern“ – an ist er wie bisher.
        if membership.role == "member" && einstellungen_vorher.nur_admins_info {
            return Err(AppError::forbidden("Nur Admins dürfen den Chat ändern"));
        }
        if let Some(Some(title)) = &input.title {
            Validator::new()
                .length(
                    "title",
                    title.trim(),
                    1,
                    crate::constants::CONVERSATION_TITLE_MAX,
                )
                .finish()?;
        }
        if let Some(Some(beschreibung)) = &input.description {
            Validator::new()
                .length("description", beschreibung.trim(), 0, BESCHREIBUNG_MAX)
                .finish()?;
        }
        if let Some(Some(anhang)) = input.avatar_attachment_id {
            require_eigener_anhang(&state.pool, anhang, user.id()).await?;
        }
    }
    if let Some(schalter) = &input.settings {
        // Die Schalter selbst sind Moderation – auch wenn Mitglieder die Info
        // ändern dürfen, dürfen sie nicht sich selbst das Schreiben erlauben.
        if membership.role == "member" {
            return Err(AppError::forbidden(
                "Nur Admins dürfen die Gruppeneinstellungen ändern",
            ));
        }
        if let Some(sekunden) = schalter.langsamer_modus {
            if !LANGSAM_STUFEN.contains(&sekunden) {
                return Err(AppError::bad_request(
                    "Unbekannte Stufe für den langsamen Modus",
                ));
            }
        }
    }
    if let Some(stufe) = &input.notify_level {
        Validator::new()
            .one_of("notifyLevel", stufe, &["alle", "erwaehnungen", "aus"])
            .finish()?;
    }
    if let Some(Some(hintergrund)) = &input.hintergrund {
        if !HINTERGRUENDE.contains(&hintergrund.as_str()) {
            return Err(AppError::bad_request("Unbekannter Hintergrund"));
        }
    }

    // Alles in einer Transaktion samt Systemzeilen: Eine Anfrage, die Titel
    // UND Stummschalten trägt, gilt ganz oder gar nicht – und eine Änderung
    // ohne ihre Zeile im Verlauf gibt es nicht.
    let mut tx = state.pool.begin().await?;
    let mut zeilen = Vec::new();
    let mut alle_melden = false;
    if info_aendern {
        let titel = input
            .title
            .clone()
            .map(|t| t.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()));
        let beschreibung = input
            .description
            .clone()
            .map(|t| t.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()));
        sqlx::query(
            "update conversations set
               title = case when $2 then coalesce($3, title) else title end,
               avatar_attachment_id = case when $4 then $5 else avatar_attachment_id end,
               description = case when $6 then $7 else description end,
               updated_at = now()
             where id = $1",
        )
        .bind(id)
        .bind(titel.is_some())
        .bind(titel.clone().flatten())
        .bind(input.avatar_attachment_id.is_some())
        .bind(input.avatar_attachment_id.flatten())
        .bind(beschreibung.is_some())
        .bind(beschreibung.clone().flatten())
        .execute(&mut *tx)
        .await?;
        if let Some(Some(neu)) = &titel {
            if chat.title.as_deref() != Some(neu.as_str()) {
                zeilen.push(systemzeile(
                    id,
                    user.id(),
                    "conversation.renamed",
                    Some(neu.clone()),
                ));
            }
        }
        if let Some(bild) = input.avatar_attachment_id {
            if bild != chat.avatar_attachment_id {
                let art = if bild.is_some() {
                    "conversation.avatar"
                } else {
                    "conversation.avatar.removed"
                };
                zeilen.push(systemzeile(id, user.id(), art, None));
            }
        }
        if let Some(neu) = &beschreibung {
            if neu.as_deref() != chat.description.as_deref() {
                zeilen.push(systemzeile(id, user.id(), "conversation.description", None));
            }
        }
        alle_melden = true;
    }
    if let Some(schalter) = &input.settings {
        let neu = crate::dto::GruppenEinstellungen {
            nur_admins_senden: schalter
                .nur_admins_senden
                .unwrap_or(einstellungen_vorher.nur_admins_senden),
            nur_admins_info: schalter
                .nur_admins_info
                .unwrap_or(einstellungen_vorher.nur_admins_info),
            langsamer_modus: schalter
                .langsamer_modus
                .unwrap_or(einstellungen_vorher.langsamer_modus),
        };
        if neu != einstellungen_vorher {
            sqlx::query("update conversations set settings = $2, updated_at = now() where id = $1")
                .bind(id)
                .bind(serde_json::to_value(&neu).unwrap_or_default())
                .execute(&mut *tx)
                .await?;
            let text = einstellungen_text(&einstellungen_vorher, &neu);
            zeilen.push(systemzeile(
                id,
                user.id(),
                "conversation.settings",
                Some(text),
            ));
            alle_melden = true;
        }
    }

    if input.muted_until.is_some()
        || input.archived.is_some()
        || input.marked_unread.is_some()
        || input.notify_level.is_some()
        || input.notify_preview.is_some()
        || input.hintergrund.is_some()
    {
        // `muted_until` in der Vergangenheit hiesse „nicht stumm“ – das ist
        // `null`. Nach oben begrenzt: „Immer“ schickt die Oberfläche als fernes
        // Datum, und mehr als das Jahr 9999 kann niemand meinen.
        let stumm = input.muted_until.map(|bis| {
            bis.filter(|bis| *bis > chrono::Utc::now()).map(|bis| {
                bis.min(
                    chrono::DateTime::parse_from_rfc3339("9999-12-31T00:00:00Z")
                        .map(|d| d.with_timezone(&chrono::Utc))
                        .unwrap_or(bis),
                )
            })
        });
        sqlx::query(
            "update conversation_members set
               muted_until = case when $3 then $4 else muted_until end,
               archived = coalesce($5, archived),
               -- Archivieren nimmt die Nadel heraus: Ein angehefteter Chat im
               -- Archiv stünde nirgends oben.
               pinned_at = case when $5 then null else pinned_at end,
               marked_unread = coalesce($6, marked_unread),
               notify_level = coalesce($7, notify_level),
               notify_preview = coalesce($8, notify_preview),
               settings = case when $9 then
                            case when $10::text is null then settings - 'hintergrund'
                                 else jsonb_set(settings, '{hintergrund}', to_jsonb($10::text)) end
                          else settings end
             where conversation_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(user.id())
        .bind(stumm.is_some())
        .bind(stumm.flatten())
        .bind(input.archived)
        .bind(input.marked_unread)
        .bind(&input.notify_level)
        .bind(input.notify_preview)
        .bind(input.hintergrund.is_some())
        .bind(input.hintergrund.clone().flatten())
        .execute(&mut *tx)
        .await?;
    }
    if let Some(anheften) = input.pinned {
        anheften_setzen(&mut tx, id, user.id(), anheften).await?;
    }

    let mut angelegt = Vec::with_capacity(zeilen.len());
    for zeile in zeilen {
        angelegt.push(nachricht_anlegen(&mut tx, zeile).await?);
    }
    tx.commit().await?;

    crate::services::messages::alle_ausliefern(&state, angelegt).await;
    if alle_melden {
        broadcast_conversation(&state, id, None).await?;
    } else {
        // Nur Persönliches geändert: Die anderen sehen davon nichts, also
        // bekommen auch nur meine Geräte die neue Fassung.
        broadcast_conversation(&state, id, Some(vec![user.id()])).await?;
    }
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

/// Anheften oder lösen, mit der Grenze von [`ANGEHEFTET_MAX`].
///
/// Unter einer Sperre je Person: Zwei gleichzeitige „anheften“ aus zwei Tabs
/// sähen sonst beide vier und landeten bei sechs.
async fn anheften_setzen(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    person: Uuid,
    anheften: bool,
) -> AppResult<()> {
    if !anheften {
        sqlx::query(
            "update conversation_members set pinned_at = null
              where conversation_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(person)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('anheften:' || $1::text, 0))")
        .bind(person)
        .execute(&mut **tx)
        .await?;
    let schon: i64 = sqlx::query_scalar(
        "select count(*) from conversation_members
          where user_id = $1 and pinned_at is not null and conversation_id <> $2",
    )
    .bind(person)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if schon >= ANGEHEFTET_MAX {
        return Err(AppError::conflict(format!(
            "Du kannst höchstens {ANGEHEFTET_MAX} Chats anheften."
        )));
    }
    sqlx::query(
        "update conversation_members
            set pinned_at = coalesce(pinned_at, clock_timestamp()), archived = false
          where conversation_id = $1 and user_id = $2",
    )
    .bind(id)
    .bind(person)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Eine Systemzeile; `text` landet im Rumpf, wo die Oberfläche ihn in den
/// Satz einsetzt (neuer Titel, geänderte Schalter).
fn systemzeile(id: Uuid, wer: Uuid, art: &str, text: Option<String>) -> NewMessage {
    let mut zeile = NewMessage::system(id, wer, art, Vec::new());
    zeile.body = text;
    zeile
}

/// Was sich an den Schaltern geändert hat – als kurzer deutscher Satzteil
/// für die Systemzeile.
pub fn einstellungen_text(
    vorher: &crate::dto::GruppenEinstellungen,
    neu: &crate::dto::GruppenEinstellungen,
) -> String {
    let mut teile = Vec::new();
    if vorher.nur_admins_senden != neu.nur_admins_senden {
        teile.push(if neu.nur_admins_senden {
            "nur Admins dürfen schreiben".to_string()
        } else {
            "alle dürfen schreiben".to_string()
        });
    }
    if vorher.nur_admins_info != neu.nur_admins_info {
        teile.push(if neu.nur_admins_info {
            "nur Admins dürfen die Gruppeninfo ändern".to_string()
        } else {
            "alle dürfen die Gruppeninfo ändern".to_string()
        });
    }
    if vorher.langsamer_modus != neu.langsamer_modus {
        teile.push(match neu.langsamer_modus {
            0 => "langsamer Modus aus".to_string(),
            s if s % 3600 == 0 => format!("langsamer Modus: {} h", s / 3600),
            s if s % 60 == 0 => format!("langsamer Modus: {} min", s / 60),
            s => format!("langsamer Modus: {s} s"),
        });
    }
    teile.join(", ")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMembersInput {
    member_ids: Vec<Uuid>,
}

async fn add_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<AddMembersInput>,
) -> AppResult<Json<ConversationDto>> {
    assert_can_moderate(&state.pool, id, user.id()).await?;
    let conversation = require_conversation(&state.pool, id).await?;
    if conversation.r#type == "direct" {
        return Err(AppError::bad_request("Direktchats haben feste Mitglieder"));
    }

    let mut ids = input.member_ids.clone();
    ids.sort();
    ids.dedup();
    let known: Vec<(Uuid,)> = sqlx::query_as("select id from users where id = any($1)")
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;
    if known.len() != ids.len() {
        return Err(AppError::bad_request("Unbekannte Mitglieder"));
    }
    // Wer mich gesperrt hat, kann ich nicht in eine Gruppe holen – sonst wäre
    // die Sperre mit einem Klick umgangen. Die Meldung nennt niemanden: Sie
    // soll nicht verraten, wer gesperrt hat.
    let sperren = crate::services::privatsphaere::sperren_von(&state.pool, user.id(), &ids).await?;
    if !sperren.mich.is_empty() {
        return Err(AppError::forbidden(
            "Mindestens eine Person kann nicht hinzugefügt werden.",
        ));
    }

    // Mitglieder und Systemzeile zusammen: Vorher stand jede Zeile für sich,
    // und ein Abbruch mittendrin liess die Hälfte der Gewählten drin – ohne
    // Systemzeile, also ohne dass die Gruppe davon erfuhr.
    let mut tx = state.pool.begin().await?;
    for member_id in &ids {
        sqlx::query(
            /*
             * Wer jetzt dazukommt, sieht ab jetzt.
             *
             * `joined_at` stand schon immer in dieser Tabelle und wurde nie
             * ausgewertet – wer eine Gruppe nach zwei Jahren betrat, las zwei
             * Jahre mit. Den bisherigen Verlauf gibt es auf Antrag, dem alle
             * zustimmen müssen (siehe `services::verlauf`).
             *
             * `do nothing` bei Konflikt heisst hier: Eine bestehende
             * Mitgliedschaft behält ihre Grenze. Wer austritt und neu
             * beitritt, bekommt dagegen eine frische – die Zeile wird beim
             * Austritt gelöscht.
             */
            "insert into conversation_members (conversation_id, user_id, sieht_ab)
             values ($1, $2, now()) on conflict (conversation_id, user_id) do nothing",
        )
        .bind(id)
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    }
    let zeile = nachricht_anlegen(
        &mut tx,
        NewMessage::system(id, user.id(), "members.added", ids),
    )
    .await?;
    tx.commit().await?;

    ausliefern(&state, zeile).await?;
    broadcast_conversation(&state, id, None).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMemberInput {
    role: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    nickname: Option<Option<String>>,
}

async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateMemberInput>,
) -> AppResult<Json<ConversationDto>> {
    let ich = assert_membership(&state.pool, id, user.id()).await?;
    let fremd = target_id != user.id();
    if input.role.is_some() || fremd {
        darf_moderieren(&state, id, &ich).await?;
    }
    if let Some(role) = &input.role {
        Validator::new()
            .one_of("role", role, crate::constants::MEMBER_ROLES)
            .finish()?;
    }
    // Der Spitzname steht bei jeder Nachricht dieser Person im Chat – so lang
    // wie ein Anzeigename, nicht länger.
    if let Some(Some(nickname)) = &input.nickname {
        Validator::new()
            .length("nickname", nickname, 0, crate::constants::DISPLAY_NAME_MAX)
            .finish()?;
    }

    let ziel = get_membership(&state.pool, id, target_id)
        .await?
        .ok_or_else(|| AppError::not_found("Mitglied nicht gefunden"))?;
    if fremd {
        nur_unter_mir(&ich, &ziel)?;
    }

    // Die Rangordnung: Ernennen geht bis zum eigenen Rang, „owner“ nur als
    // Übergabe durch den Besitzer. Vorher konnte ein Admin sich selbst zum
    // Besitzer machen und den bisherigen danach herabstufen oder entfernen.
    let mut uebergabe = false;
    if let Some(role) = input.role.as_deref() {
        // Das schliesst auch den Besitzer ein: Er kann sich nicht selbst zum
        // Admin herabstufen und die Gruppe ohne Besitzer zurücklassen.
        // Abgeben geht nur als Übergabe (mit Nachfolger) oder durch Austritt,
        // nach dem `besitz_nachfolgen` einen bestimmt.
        if !fremd {
            return Err(AppError::forbidden(
                "Die eigene Rolle kann man nicht selbst ändern",
            ));
        }
        if role == "owner" {
            if ich.role != "owner" {
                return Err(AppError::forbidden(
                    "Den Chat übergeben kann nur, wer ihn besitzt",
                ));
            }
            uebergabe = true;
        } else if rang(role) > rang(&ich.role) {
            return Err(AppError::forbidden(
                "Ernennen geht nur bis zum eigenen Rang",
            ));
        }
    }

    // Eine Übergabe sind zwei Zeilen: Der Neue wird Besitzer, der Bisherige
    // Admin. Zusammen oder gar nicht – sonst gäbe es kurz zwei Besitzer oder
    // keinen.
    // Die Systemzeile zur Rolle: befördert, herabgestuft oder übergeben.
    let rollen_zeile = match input.role.as_deref() {
        Some(_) if uebergabe => Some(NewMessage::system(
            id,
            user.id(),
            "owner.transferred",
            vec![target_id],
        )),
        Some(neu) if rang(neu) > rang(&ziel.role) => Some(NewMessage::system(
            id,
            user.id(),
            "member.promoted",
            vec![target_id],
        )),
        Some(neu) if rang(neu) < rang(&ziel.role) => Some(NewMessage::system(
            id,
            user.id(),
            "member.demoted",
            vec![target_id],
        )),
        _ => None,
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "update conversation_members set
           role = coalesce($3, role),
           nickname = case when $4 then $5 else nickname end
         where conversation_id = $1 and user_id = $2",
    )
    .bind(id)
    .bind(target_id)
    .bind(&input.role)
    .bind(input.nickname.is_some())
    .bind(input.nickname.flatten())
    .execute(&mut *tx)
    .await?;
    if uebergabe {
        sqlx::query(
            "update conversation_members set role = 'admin'
              where conversation_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(user.id())
        .execute(&mut *tx)
        .await?;
    }
    let zeile = match rollen_zeile {
        Some(zeile) => Some(nachricht_anlegen(&mut tx, zeile).await?),
        None => None,
    };
    tx.commit().await?;

    if let Some(zeile) = zeile {
        ausliefern(&state, zeile).await?;
    }
    broadcast_conversation(&state, id, None).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let ich = assert_membership(&state.pool, id, user.id()).await?;
    // Gehen darf jeder. Andere entfernen ist Moderation – nur in Gruppen und
    // nur bei Mitgliedern unter dem eigenen Rang.
    if target_id != user.id() {
        darf_moderieren(&state, id, &ich).await?;
        let ziel = get_membership(&state.pool, id, target_id)
            .await?
            .ok_or_else(|| AppError::not_found("Mitglied nicht gefunden"))?;
        nur_unter_mir(&ich, &ziel)?;
    }

    let before = member_ids(&state.pool, id).await?;
    // Austritt und Besitzübergabe in einer Transaktion, unter der Sperre des
    // Gesprächs: Geht der Besitzer, übernimmt der dienstälteste Admin (sonst
    // das dienstälteste Mitglied) – siehe `besitz_nachfolgen`.
    let mut tx = state.pool.begin().await?;
    gespraeche_sperren(&mut tx, &[id]).await?;
    sqlx::query("delete from conversation_members where conversation_id = $1 and user_id = $2")
        .bind(id)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
    let uebernahmen = besitz_nachfolgen(&mut tx, &[id]).await?;
    let kind = if target_id == user.id() {
        "member.left"
    } else {
        "member.removed"
    };
    // Die Systemzeile in derselben Transaktion: Ein Austritt ohne Zeile im
    // Verlauf (Abbruch nach dem Commit) liess die Übrigen rätseln, wohin
    // jemand verschwunden ist.
    let zeile = nachricht_anlegen(
        &mut tx,
        NewMessage::system(id, user.id(), kind, vec![target_id]),
    )
    .await?;
    let karten = uebernahmen_eintragen(&mut tx, &uebernahmen).await?;
    tx.commit().await?;

    ausliefern(&state, zeile).await?;

    state
        .hub
        .publish(vec![target_id], Event::conversation_removed(id))
        .await;
    let remaining: Vec<Uuid> = before
        .into_iter()
        .filter(|member| *member != target_id)
        .collect();
    if uebernahmen.is_empty() {
        broadcast_conversation(&state, id, Some(remaining)).await?;
    } else {
        // Systemzeile „… ist jetzt Besitzer“ und neue Fassung an alle.
        uebernahmen_melden(&state, &uebernahmen, karten).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Rangordnung ---------- */

/// Owner über Admin über Mitglied. Unbekanntes zählt wie ein Mitglied – ein
/// Datenfehler darf keine Rechte geben.
fn rang(rolle: &str) -> u8 {
    match rolle {
        "owner" => 3,
        "admin" => 2,
        _ => 1,
    }
}

async fn ist_gruppe(state: &AppState, id: Uuid) -> AppResult<bool> {
    Ok(require_conversation(&state.pool, id).await?.r#type == "group")
}

/// Moderieren gibt es nur in Gruppen und nur ab Admin.
///
/// Im Direktchat ist, wer ihn angelegt hat, „owner“ – zufällig, weil er als
/// Erster getippt hat. Damit konnte er das Gegenüber entfernen und ihm einen
/// Spitznamen geben. In einem Gespräch unter zweien gibt es keinen Aufseher
/// (dieselbe Regel wie beim Löschen für alle in `modules::messages`).
async fn darf_moderieren(
    state: &AppState,
    id: Uuid,
    ich: &crate::db::ConversationMemberRow,
) -> AppResult<()> {
    if !ist_gruppe(state, id).await? {
        return Err(AppError::forbidden(
            "Im Direktchat gibt es nichts zu moderieren",
        ));
    }
    if ich.role == "member" {
        return Err(AppError::forbidden("Nur Admins dürfen das ändern"));
    }
    Ok(())
}

/// Niemand ändert oder entfernt einen Gleich- oder Höherrangigen – sich
/// selbst ausgenommen, und das prüfen die Aufrufer vorher.
fn nur_unter_mir(
    ich: &crate::db::ConversationMemberRow,
    ziel: &crate::db::ConversationMemberRow,
) -> AppResult<()> {
    if rang(&ziel.role) >= rang(&ich.role) {
        return Err(AppError::forbidden(
            "Gleich- oder höherrangige Mitglieder kann man nicht ändern",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkReadInput {
    message_id: Uuid,
}

async fn mark_read(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<MarkReadInput>,
) -> AppResult<Json<serde_json::Value>> {
    assert_membership(&state.pool, id, user.id()).await?;
    crate::services::conversations::melde_gelesen(&state, id, user.id(), input.message_id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/* ---------- Verlauf vor dem eigenen Beitritt ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StimmeInput {
    zustimmung: bool,
}

/// Offene Anträge dieses Gesprächs – jedes Mitglied muss sie sehen, sonst
/// kann es nicht abstimmen.
async fn verlauf_offene(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<crate::services::verlauf::Antrag>>> {
    assert_membership(&state.pool, id, user.id()).await?;
    Ok(Json(ListResult::new(
        crate::services::verlauf::offene(&state.pool, id).await?,
    )))
}

/// „Ich möchte auch sehen, was vor meinem Beitritt war."
async fn verlauf_stellen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<crate::services::verlauf::Antrag>)> {
    assert_membership(&state.pool, id, user.id()).await?;
    let antrag = crate::services::verlauf::stellen(&state.pool, id, user.id()).await?;
    // Alle anderen müssen davon erfahren – ein Antrag, den niemand sieht,
    // wird nie entschieden.
    let empfaenger = member_ids(&state.pool, id).await?;
    state
        .hub
        .publish(empfaenger, Event::verlauf_antrag(id))
        .await;
    Ok((StatusCode::CREATED, Json(antrag)))
}

async fn verlauf_abstimmen(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, antrag_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<StimmeInput>,
) -> AppResult<Json<crate::services::verlauf::Antrag>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let antrag =
        crate::services::verlauf::abstimmen(&state.pool, antrag_id, user.id(), input.zustimmung)
            .await?;
    let empfaenger = member_ids(&state.pool, id).await?;
    state
        .hub
        .publish(empfaenger, Event::verlauf_antrag(id))
        .await;
    Ok(Json(antrag))
}

async fn verlauf_zurueckziehen(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, antrag_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    assert_membership(&state.pool, id, user.id()).await?;
    crate::services::verlauf::zurueckziehen(&state.pool, antrag_id, user.id()).await?;
    let empfaenger = member_ids(&state.pool, id).await?;
    state
        .hub
        .publish(empfaenger, Event::verlauf_antrag(id))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Für mich: leeren, löschen, anheften ---------- */

/// „Chat leeren (für mich)“ – die anderen behalten alles.
async fn leeren(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ConversationDto>> {
    let mut tx = state.pool.begin().await?;
    crate::services::conversations::leeren(&mut tx, id, user.id(), false).await?;
    tx.commit().await?;
    broadcast_conversation(&state, id, Some(vec![user.id()])).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

/// „Direktchat löschen (für mich)“: geleert und aus der Liste, bis wieder
/// etwas kommt. Eine Gruppe verlässt man stattdessen – sie zu „löschen“ und
/// trotzdem Mitglied zu bleiben, hiesse weiter Nachrichten zu bekommen, die
/// man nirgends sieht.
async fn ausblenden(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    assert_membership(&state.pool, id, user.id()).await?;
    if ist_gruppe(&state, id).await? {
        return Err(AppError::bad_request(
            "Eine Gruppe löscht man, indem man sie verlässt.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    crate::services::conversations::leeren(&mut tx, id, user.id(), true).await?;
    tx.commit().await?;
    // Meine Geräte nehmen ihn aus der Liste; das Gegenüber erfährt nichts.
    state
        .hub
        .publish(vec![user.id()], Event::conversation_removed(id))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrdnenInput {
    /// Die angehefteten Chats von oben nach unten.
    ids: Vec<Uuid>,
}

/// Die Reihenfolge der angehefteten Chats. Die Reihenfolge IST `pinned_at`:
/// Der oberste bekommt den jüngsten Zeitpunkt. Was nicht angeheftet ist,
/// bleibt unberührt – Umordnen heftet nichts an.
async fn angeheftet_ordnen(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<OrdnenInput>,
) -> AppResult<StatusCode> {
    if input.ids.len() as i64 > ANGEHEFTET_MAX {
        return Err(AppError::bad_request("Zu viele Chats"));
    }
    sqlx::query(
        "update conversation_members cm
            set pinned_at = now() - make_interval(secs => (t.rang - 1) / 1000.0)
           from unnest($2::uuid[]) with ordinality as t(id, rang)
          where cm.conversation_id = t.id and cm.user_id = $1 and cm.pinned_at is not null",
    )
    .bind(user.id())
    .bind(&input.ids)
    .execute(&state.pool)
    .await?;
    for id in &input.ids {
        broadcast_conversation(&state, *id, Some(vec![user.id()])).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Eigene Ordner ---------- */

/// Höchstens so viele Ordner je Person – Telegram erlaubt zehn, mehr passt
/// auch nicht in eine Zeile Filter.
const ORDNER_MAX: i64 = 10;
const ORDNER_NAME_MAX: usize = 40;

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct OrdnerDto {
    id: Uuid,
    name: String,
    position: i32,
    chats: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrdnerInput {
    name: Option<String>,
    chats: Option<Vec<Uuid>>,
    position: Option<i32>,
}

/// Nur eigene Chats gehören in einen Ordner – sonst stünde dort eine fremde
/// Kennung, die beim Anzeigen ohnehin herausfiele.
async fn eigene_chats(state: &AppState, person: Uuid, chats: &[Uuid]) -> AppResult<Vec<Uuid>> {
    let mut eigene: Vec<Uuid> = sqlx::query_scalar(
        "select conversation_id from conversation_members
          where user_id = $1 and conversation_id = any($2)",
    )
    .bind(person)
    .bind(chats)
    .fetch_all(&state.pool)
    .await?;
    // Reihenfolge der Eingabe behalten.
    eigene.sort_by_key(|id| chats.iter().position(|c| c == id));
    Ok(eigene)
}

fn ordner_name(name: &str) -> AppResult<String> {
    let name = name.trim().to_string();
    Validator::new()
        .length("name", &name, 1, ORDNER_NAME_MAX)
        .finish()?;
    Ok(name)
}

async fn ordner_liste(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<OrdnerDto>>> {
    let ordner = sqlx::query_as::<_, OrdnerDto>(
        "select id, name, position, chats from chat_ordner
          where user_id = $1 order by position, created_at",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(ordner)))
}

async fn ordner_anlegen(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<OrdnerInput>,
) -> AppResult<(StatusCode, Json<OrdnerDto>)> {
    let name = ordner_name(input.name.as_deref().unwrap_or_default())?;
    let chats = eigene_chats(&state, user.id(), &input.chats.unwrap_or_default()).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('ordner:' || $1::text, 0))")
        .bind(user.id())
        .execute(&mut *tx)
        .await?;
    let anzahl: i64 = sqlx::query_scalar("select count(*) from chat_ordner where user_id = $1")
        .bind(user.id())
        .fetch_one(&mut *tx)
        .await?;
    if anzahl >= ORDNER_MAX {
        return Err(AppError::conflict(format!(
            "Höchstens {ORDNER_MAX} Ordner."
        )));
    }
    let ordner = sqlx::query_as::<_, OrdnerDto>(
        "insert into chat_ordner (id, user_id, name, position, chats)
         values ($1, $2, $3, $4, $5)
         returning id, name, position, chats",
    )
    .bind(Uuid::now_v7())
    .bind(user.id())
    .bind(&name)
    .bind(input.position.unwrap_or(anzahl as i32))
    .bind(&chats)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(ordner)))
}

async fn ordner_aendern(
    State(state): State<AppState>,
    user: AuthUser,
    Path(ordner_id): Path<Uuid>,
    Json(input): Json<OrdnerInput>,
) -> AppResult<Json<OrdnerDto>> {
    let name = match input.name.as_deref() {
        Some(name) => Some(ordner_name(name)?),
        None => None,
    };
    let chats = match input.chats {
        Some(chats) => Some(eigene_chats(&state, user.id(), &chats).await?),
        None => None,
    };
    let ordner = sqlx::query_as::<_, OrdnerDto>(
        "update chat_ordner set
           name = coalesce($3, name),
           chats = coalesce($4, chats),
           position = coalesce($5, position)
         where id = $1 and user_id = $2
         returning id, name, position, chats",
    )
    .bind(ordner_id)
    .bind(user.id())
    .bind(&name)
    .bind(&chats)
    .bind(input.position)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Ordner nicht gefunden"))?;
    Ok(Json(ordner))
}

async fn ordner_loeschen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(ordner_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("delete from chat_ordner where id = $1 and user_id = $2")
        .bind(ordner_id)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
