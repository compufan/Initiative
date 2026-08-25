//! Profile, Suche und Einstellungen.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::auth::password::verify_password_async;
use crate::db::UserRow;
use crate::drossel::regeln;
use crate::dto::{ListResult, SelfUserDto, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::users::{
    contacts_of, load_user, merge_settings, to_self_user_dto, to_user_dto,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(search))
        .route("/users/batch", get(batch))
        .route("/users/me", patch(update_me).delete(loeschen))
        .route("/users/me/export", get(export))
        .route("/users/{id}", get(by_id))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<ListResult<UserDto>>> {
    let needle = query.q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Json(ListResult::new(Vec::new())));
    }
    // Die Suche liest ueber den ganzen Bestand. Ohne Bremse holt sich ein
    // angemeldetes Konto das Verzeichnis Buchstabe fuer Buchstabe ab.
    if !state
        .drossel
        .erlaubt(&format!("suche:{}", user.id()), regeln::SUCHEN)
    {
        return Err(AppError::too_many(
            "Zu viele Suchanfragen. Warte einen Moment.",
        ));
    }
    let pattern = format!("%{needle}%");
    let rows = sqlx::query_as::<_, UserRow>(
        "select * from users
         where id <> $1 and (lower(username) like $2 or lower(display_name) like $2)
         order by case when lower(username) = $3 then 0 else 1 end, display_name asc
         limit $4",
    )
    .bind(user.id())
    .bind(&pattern)
    .bind(&needle)
    .bind(query.limit.unwrap_or(20).clamp(1, 50))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(
        rows.iter()
            .map(|row| to_user_dto(row, &state.config))
            .collect(),
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchQuery {
    /// Kennungen, durch Komma getrennt.
    ids: String,
}

/// Mehrere Personen auf einmal nachschlagen.
///
/// Vorher holte die Oberflaeche jeden Namen einzeln: Eine Ausgabenliste mit
/// acht Beteiligten waren acht Anfragen, und weil sie nacheinander durch
/// dieselbe Verbindung mussten, war die Liste spuerbar lange ohne Namen. Die
/// Antwort ist immer dieselbe Handvoll Leute – das ist eine Anfrage wert,
/// nicht acht.
///
/// Gedeckelt, damit eine geratene Adresse nicht die ganze Benutzertabelle
/// ausliest.
async fn batch(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<BatchQuery>,
) -> AppResult<Json<ListResult<UserDto>>> {
    let ids: Vec<Uuid> = query
        .ids
        .split(',')
        .filter_map(|teil| Uuid::parse_str(teil.trim()).ok())
        .take(200)
        .collect();
    if ids.is_empty() {
        return Ok(Json(ListResult::new(Vec::new())));
    }

    let rows = sqlx::query_as::<_, UserRow>("select * from users where id = any($1)")
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;

    Ok(Json(ListResult::new(
        rows.iter()
            .map(|row| to_user_dto(row, &state.config))
            .collect(),
    )))
}

/// Alles, was ueber mich gespeichert ist – als eine Datei.
///
/// Art. 15 und Art. 20 DSGVO geben jedem das Recht, seine Daten zu bekommen,
/// und zwar in einem gaengigen, maschinenlesbaren Format. Das ist kein
/// Beiwerk: Wer nicht sehen kann, was ueber ihn gespeichert ist, kann auch
/// nicht beurteilen, ob er einverstanden ist.
///
/// Bewusst NICHT enthalten: fremde Nachrichten aus gemeinsamen Chats. Die
/// gehoeren den anderen genauso, und ein Ausdruck aller Gespraeche waere ein
/// Ausdruck der Daten Dritter. Enthalten ist, was ICH geschrieben und
/// eingetragen habe.
async fn export(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let id = user.id();

    let konto = sqlx::query_as::<_, UserRow>("select * from users where id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Konto nicht gefunden"))?;

    // Je Bereich eine schlichte Liste. `json_agg` statt vieler Runden, und
    // `coalesce`, damit leere Bereiche als [] und nicht als null erscheinen.
    let sammeln = |sql: &'static str| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_scalar::<_, Value>(sql)
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap_or(Value::Array(Vec::new()))
        }
    };

    let nachrichten = sammeln(
        "select coalesce(json_agg(json_build_object(
           'id', id, 'conversationId', conversation_id, 'type', type,
           'body', body, 'createdAt', created_at
         ) order by created_at), '[]'::json)
         from messages where sender_id = $1 and deleted_at is null",
    )
    .await;

    let chats = sammeln(
        "select coalesce(json_agg(json_build_object(
           'id', c.id, 'type', c.type, 'title', c.title,
           'rolle', m.role, 'dabeiSeit', m.joined_at
         ) order by m.joined_at), '[]'::json)
         from conversation_members m join conversations c on c.id = m.conversation_id
         where m.user_id = $1",
    )
    .await;

    let ausgaben = sammeln(
        "select coalesce(json_agg(json_build_object(
           'id', id, 'titel', title, 'betragCent', amount_cents,
           'waehrung', currency, 'am', spent_at
         ) order by spent_at), '[]'::json)
         from expenses where paid_by = $1 and deleted_at is null",
    )
    .await;

    let termine = sammeln(
        "select coalesce(json_agg(json_build_object(
           'id', id, 'titel', title, 'beginn', starts_at, 'ende', ends_at
         ) order by starts_at), '[]'::json)
         from calendar_events where created_by = $1 and deleted_at is null",
    )
    .await;

    let geraete = sammeln(
        "select coalesce(json_agg(json_build_object(
           'geraet', user_agent, 'angelegt', created_at
         ) order by created_at), '[]'::json)
         from push_subscriptions where user_id = $1",
    )
    .await;

    Ok(Json(json!({
        "hinweis": "Alles, was dieser Dienst über dich gespeichert hat. Nachrichten anderer Leute aus gemeinsamen Chats sind nicht enthalten – die gehören ihnen.",
        "erstelltAm": chrono::Utc::now().to_rfc3339(),
        "konto": {
            "id": konto.id,
            "benutzername": konto.username,
            "anzeigename": konto.display_name,
            "ueberMich": konto.bio,
            "einstellungen": konto.settings,
            "angelegtAm": konto.created_at,
            "zuletztGesehen": konto.last_seen_at,
        },
        "chats": chats,
        "meineNachrichten": nachrichten,
        "meineAusgaben": ausgaben,
        "meineTermine": termine,
        "pushGeraete": geraete,
    })))
}

/// Das eigene Konto loeschen.
///
/// Art. 17 DSGVO. Bisher konnte das nur ein Verwalter fuer andere – das eigene
/// Konto loszuwerden war schlicht nicht vorgesehen, und niemand sollte darum
/// bitten muessen.
///
/// Was dabei geschieht, ist bewusst hart: `delete from users` mit den
/// Fremdschluessel-Kaskaden aus der Datenbank. Nachrichten bleiben stehen,
/// verlieren aber ihren Absender (`on delete set null`) – sonst risse man
/// fremden Leuten Loecher in ihre Gespraeche. Wer auch seine Texte entfernt
/// haben will, loescht sie vorher; darauf weist die Oberflaeche hin.
///
/// Das Passwort wird verlangt, damit ein vergessenes offenes Geraet nicht
/// genuegt, um jemandem sein Konto zu nehmen.
async fn loeschen(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<LoeschInput>,
) -> AppResult<StatusCode> {
    let konto = sqlx::query_as::<_, UserRow>("select * from users where id = $1")
        .bind(user.id())
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Konto nicht gefunden"))?;

    if !verify_password_async(input.password, konto.password_hash.clone()).await {
        return Err(AppError::unauthorized("Das Passwort stimmt nicht."));
    }

    // Der letzte Verwalter darf nicht gehen – sonst kaeme niemand mehr in die
    // Verwaltung hinein, ausser ueber die Datenbank.
    let bin_verwalter: bool = sqlx::query_scalar("select is_admin from users where id = $1")
        .bind(user.id())
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(false);
    if bin_verwalter {
        let admins: i64 = sqlx::query_scalar("select count(*) from users where is_admin")
            .fetch_one(&state.pool)
            .await?;
        if admins <= 1 {
            return Err(AppError::bad_request(
                "Das ist das letzte Konto mit Verwaltungsrechten. Mach jemand anderen zum Verwalter, bevor du gehst.",
            ));
        }
    }

    sqlx::query("delete from users where id = $1")
        .bind(user.id())
        .execute(&state.pool)
        .await?;

    tracing::info!(user = %user.id(), "Konto auf eigenen Wunsch geloescht");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct LoeschInput {
    password: String,
}

async fn by_id(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<UserDto>> {
    let row = load_user(&state.pool, id).await?;
    Ok(Json(to_user_dto(&row, &state.config)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfileInput {
    display_name: Option<String>,
    #[serde(default, deserialize_with = "crate::modules::double_option")]
    bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::modules::double_option")]
    avatar_attachment_id: Option<Option<Uuid>>,
    settings: Option<Value>,
}

async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<UpdateProfileInput>,
) -> AppResult<Json<SelfUserDto>> {
    let current = load_user(&state.pool, user.id()).await?;

    let display_name = clean(input.display_name);
    if let Some(name) = &display_name {
        Validator::new()
            .length("displayName", name, 1, crate::constants::DISPLAY_NAME_MAX)
            .finish()?;
    }
    if let Some(Some(bio)) = &input.bio {
        Validator::new()
            .length("bio", bio, 0, crate::constants::BIO_MAX)
            .finish()?;
    }

    let settings = match input.settings {
        Some(patch) => {
            let mut merged = merge_settings(&current.settings);
            if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
                for (key, value) in source {
                    if key == "notifications" || key == "modules" {
                        if let (Some(existing), Some(incoming)) = (
                            target.get_mut(key).and_then(Value::as_object_mut),
                            value.as_object(),
                        ) {
                            for (inner_key, inner_value) in incoming {
                                existing.insert(inner_key.clone(), inner_value.clone());
                            }
                            continue;
                        }
                    }
                    target.insert(key.clone(), value.clone());
                }
            }
            Some(merged)
        }
        None => None,
    };

    let updated = sqlx::query_as::<_, UserRow>(
        "update users set
           display_name = coalesce($2, display_name),
           bio = case when $3 then $4 else bio end,
           avatar_attachment_id = case when $5 then $6 else avatar_attachment_id end,
           settings = coalesce($7, settings),
           updated_at = now()
         where id = $1
         returning *",
    )
    .bind(user.id())
    .bind(&display_name)
    .bind(input.bio.is_some())
    .bind(input.bio.clone().flatten())
    .bind(input.avatar_attachment_id.is_some())
    .bind(input.avatar_attachment_id.flatten())
    .bind(&settings)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| match error {
        sqlx::Error::RowNotFound => AppError::not_found("Benutzer nicht gefunden"),
        other => AppError::from(other),
    })?;

    // Everyone sharing a chat sees the new profile instantly.
    let contacts = contacts_of(&state.pool, user.id()).await?;
    let dto = to_user_dto(&updated, &state.config);
    state.hub.publish(contacts, Event::user_updated(&dto)).await;

    Ok(Json(to_self_user_dto(&updated, &state.config)))
}
