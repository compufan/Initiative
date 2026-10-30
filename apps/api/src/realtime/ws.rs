//! Websocket endpoint.
//!
//! One socket per device; everything the user may see is pushed through the
//! realtime hub, so the client only polls on a cold start.

use std::time::Duration;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::jwt;
use crate::constants::{HEARTBEAT_INTERVAL_SECS, REALTIME_PATH, TYPING_TTL_MS};
use crate::realtime::hub::PresenceChange;
use crate::realtime::Event;
use crate::services::conversations::{get_membership, member_ids};
use crate::services::users::{contacts_of, touch_last_seen};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(REALTIME_PATH, get(upgrade))
}

/// Unter `/api/v1`: das Ticket für den Aufbau der Leitung.
pub fn api_router() -> Router<AppState> {
    Router::new().route("/realtime/ticket", axum::routing::post(ticket_ausstellen))
}

/// Wie lange ein Ticket gilt – Zeit genug für den Aufbau, zu kurz zum
/// Weiterreichen.
pub const TICKET_GUELTIG_S: i64 = 30;

/**
 * `POST /realtime/ticket`: ein Einmal-Ticket für die Echtzeit-Leitung.
 *
 * Ein Browser kann beim Aufbau eines WebSockets keinen `Authorization`-Kopf
 * setzen. Bisher stand deshalb das Zugriffstoken in der Adresse (`?token=`) –
 * und damit in jedem Protokoll eines Zwischenknotens, eine Viertelstunde lang
 * ein Schlüssel zum ganzen Konto. Das Ticket wird hier mit dem Token im Kopf
 * geholt, gilt 30 Sekunden und genau EINEN Aufbau ([`ticket_einloesen`]).
 *
 * Eine widerrufene Sitzung bekommt keins (`sitzung_lebt`): Sonst holte sich
 * ein Client mit einem noch nicht abgelaufenen Token einer beendeten Sitzung
 * Ticket um Ticket, und jeder Aufbau endete mit 4401.
 */
async fn ticket_ausstellen(
    State(state): State<AppState>,
    user: crate::auth::AuthUser,
) -> crate::error::AppResult<axum::Json<serde_json::Value>> {
    if !sitzung_lebt(&state.pool, user.id()).await {
        return Err(crate::error::AppError::unauthorized("Sitzung beendet"));
    }
    let ticket = crate::auth::password::random_token(32);
    // Abgelaufene gleich mit wegräumen: Die Tabelle bleibt so klein, dass sie
    // keinen weiteren Index braucht.
    let _ = sqlx::query("delete from echtzeit_tickets where gueltig_bis < now()")
        .execute(&state.pool)
        .await;
    sqlx::query(
        "insert into echtzeit_tickets (hash, user_id, gueltig_bis)
         values ($1, $2, now() + make_interval(secs => $3))",
    )
    .bind(crate::auth::password::sha256_hex(&ticket))
    .bind(user.id())
    .bind(TICKET_GUELTIG_S as f64)
    .execute(&state.pool)
    .await?;
    Ok(axum::Json(serde_json::json!({
        "ticket": ticket,
        "expiresIn": TICKET_GUELTIG_S,
    })))
}

/// Löst ein Ticket ein – höchstens einmal, und nur innerhalb seiner Frist.
/// `delete … returning` macht beides in einem Schritt: Zwei gleichzeitige
/// Aufbauten mit demselben Ticket bekommen nicht beide eine Leitung.
async fn ticket_einloesen(pool: &sqlx::PgPool, ticket: &str) -> Option<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "delete from echtzeit_tickets
          where hash = $1 and gueltig_bis > now()
          returning user_id",
    )
    .bind(crate::auth::password::sha256_hex(ticket))
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// Wie oft eine offene Leitung nachsieht, ob ihre Sitzung noch besteht.
const SITZUNG_PRUEFEN: Duration = Duration::from_secs(60);

/**
 * Wie lange eine Leitung still sein darf, bevor sie als tot gilt: zwei
 * Herzschläge.
 *
 * Der Server pingt alle `HEARTBEAT_INTERVAL_SECS`, der Browser antwortet von
 * selbst mit Pong. Bisher bemerkte der Server eine tote Leitung nur, wenn das
 * SENDEN scheiterte – bei einer halboffenen Verbindung (Handy im Funkloch,
 * NAT-Eintrag verfallen) passiert das oft nie, und die Leitung belegte
 * Speicher und galt als „online“. Kommt zwei Herzschläge lang gar nichts,
 * nicht einmal ein Pong, ist sie zu.
 */
const LESEFRIST: Duration = Duration::from_secs(2 * HEARTBEAT_INTERVAL_SECS);

/// Das nächste Paket vom Client – oder `None`, wenn die Leitung endet, kaputt
/// ist oder länger als `frist` schweigt.
async fn naechstes<S, E>(strom: &mut S, frist: Duration) -> Option<Message>
where
    S: futures_util::Stream<Item = Result<Message, E>> + Unpin,
{
    match tokio::time::timeout(frist, strom.next()).await {
        Ok(Some(Ok(message))) => Some(message),
        // Zu lange still, zu Ende oder kaputt: alles dasselbe Ende.
        _ => None,
    }
}

/**
 * Besteht für dieses Konto noch eine Sitzung?
 *
 * Das Zugriffstoken wird nur beim Aufbau der Leitung geprüft – danach lief sie
 * unbegrenzt weiter. Wer ein Token abgegriffen und damit einmal verbunden
 * hatte, las so jede neue Nachricht mit, auch nachdem das Passwort geändert,
 * die Wiederverwendung erkannt oder das Konto gelöscht war: Alle drei
 * widerrufen die Erneuerungs-Token, und an genau denen hängt diese Frage.
 *
 * Ein Fehler der Datenbank zählt als „besteht": Ein kurzer Aussetzer soll
 * nicht jede offene Leitung auf einmal trennen.
 */
pub async fn sitzung_lebt(pool: &sqlx::PgPool, user_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "select exists (
           select 1 from refresh_tokens
            where user_id = $1 and revoked_at is null and expires_at > now()
         )",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap_or(true)
}

/// 4401 heisst für den Client: Token erneuern und neu verbinden. Scheitert
/// die Erneuerung, weil die Sitzung fort ist, meldet er sich ab.
fn abgelaufen() -> Message {
    Message::Close(Some(axum::extract::ws::CloseFrame {
        code: 4401,
        reason: Utf8Bytes::from_static("unauthorized"),
    }))
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    ticket: Option<String>,
    token: Option<String>,
    access_token: Option<String>,
}

/**
 * Wer sich da verbindet.
 *
 * Neu: ein Einmal-Ticket (`?ticket=`, siehe [`ticket_ausstellen`]). Weil der
 * Client die Adresse an einer Stelle baut, die das alte Feld schreibt, nimmt
 * auch `?token=` ein Ticket an – ein Zugriffstoken ist ein JWT mit Punkten,
 * ein Ticket nie.
 *
 * Übergangsweise geht weiter das Zugriffstoken selbst (`?token=` bzw.
 * `?access_token=`), damit Clients von vor der Umstellung nicht stumm
 * bleiben. Es kann entfallen, sobald keine alten Stände mehr im Umlauf sind.
 */
async fn wer_verbindet(state: &AppState, query: TokenQuery) -> Option<Uuid> {
    let token = query.token.or(query.access_token);
    let ticket = query
        .ticket
        .or_else(|| token.clone().filter(|wert| !wert.contains('.')));
    if let Some(ticket) = ticket {
        return ticket_einloesen(&state.pool, &ticket).await;
    }
    token
        .as_deref()
        .and_then(|token| jwt::decode(token, &state.config.jwt_secret))
        .filter(|claims| claims.typ == "access")
        .and_then(|claims| Uuid::parse_str(&claims.sub).ok())
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
) -> Response {
    let user_id = wer_verbindet(&state, query).await;

    // Ein noch nicht abgelaufenes Token einer widerrufenen Sitzung verbindet
    // nicht mehr – siehe `sitzung_lebt`.
    let user_id = match user_id {
        Some(user_id) if sitzung_lebt(&state.pool, user_id).await => Some(user_id),
        _ => None,
    };

    match user_id {
        Some(user_id) => ws.on_upgrade(move |socket| handle(socket, state, user_id)),
        // Closing with 4401 tells the client to refresh its token and retry.
        None => ws.on_upgrade(|mut socket| async move {
            let _ = socket.send(abgelaufen()).await;
        }),
    }
}

async fn handle(socket: WebSocket, state: AppState, user_id: Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let (connection_id, ausgang, presence) = state.hub.register(user_id);
    let crate::realtime::hub::Ausgang {
        empfang: mut outbound,
        schliessen: ueberlauf,
    } = ausgang;

    if presence == PresenceChange::CameOnline {
        broadcast_presence(&state, user_id, true).await;
    }
    touch_last_seen(&state.pool, user_id).await;

    state.hub.send_to(
        user_id,
        connection_id,
        &Event::new(
            "hello",
            serde_json::json!({
                "userId": user_id,
                "connectionId": connection_id,
                "serverTime": chrono::Utc::now().to_rfc3339(),
            }),
        ),
    );

    // Outbound pump: hub frames plus a heartbeat that detects dead sockets,
    // plus the periodic check that the session behind the socket still exists.
    let pool = state.pool.clone();
    let mut writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pruefung = tokio::time::interval_at(
            tokio::time::Instant::now() + SITZUNG_PRUEFEN,
            SITZUNG_PRUEFEN,
        );
        pruefung.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                frame = outbound.recv() => match frame {
                    Some(frame) => {
                        if sender.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = heartbeat.tick() => {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                _ = pruefung.tick() => {
                    if !sitzung_lebt(&pool, user_id).await {
                        let _ = sender.send(abgelaufen()).await;
                        break;
                    }
                }
            }
        }
        let _ = sender.close().await;
    });

    let leser = async {
        while let Some(message) = naechstes(&mut receiver, LESEFRIST).await {
            match message {
                Message::Text(text) => {
                    if let Err(error) = handle_client_event(&state, user_id, &text).await {
                        tracing::debug!(%error, "realtime event failed");
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    // Endet der Schreiber (Sitzung widerrufen, Leitung tot), endet auch das
    // Lesen: Ein Gegenüber, das den Schluss nicht beantwortet, soll über die
    // Leitung weder tippen noch Gelesen-Marken setzen können.
    //
    // Läuft der Ausgangspuffer über (`hub::AUSGANG_PUFFER`), endet beides
    // sofort: Der Schreiber hängt dann meist selbst in einem `send`, das nie
    // fertig wird, und sähe ein Zeichen nicht. Der Abbruch unten trennt die
    // Leitung; der Client verbindet neu und holt nach.
    tokio::select! {
        _ = leser => {}
        _ = &mut writer => {}
        _ = ueberlauf.notified() => {
            tracing::debug!(%user_id, "Ausgangspuffer voll – Verbindung wird geschlossen");
        }
    }

    writer.abort();
    if state.hub.unregister(user_id, connection_id) == PresenceChange::WentOffline {
        touch_last_seen(&state.pool, user_id).await;
        broadcast_presence(&state, user_id, false).await;
    }
}

async fn broadcast_presence(state: &AppState, user_id: Uuid, online: bool) {
    match contacts_of(&state.pool, user_id).await {
        Ok(contacts) if !contacts.is_empty() => {
            state
                .hub
                .publish(contacts, Event::presence(user_id, online))
                .await;
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "presence broadcast failed"),
    }
}

async fn handle_client_event(
    state: &AppState,
    user_id: Uuid,
    raw: &str,
) -> Result<(), crate::error::AppError> {
    let Ok(envelope) = serde_json::from_str::<Value>(raw) else {
        return Ok(());
    };
    let Some(event_type) = envelope.get("type").and_then(Value::as_str) else {
        return Ok(());
    };
    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);

    match event_type {
        "ping" => {
            state.hub.deliver_local(
                &[user_id],
                &Event::new(
                    "pong",
                    serde_json::json!({ "ts": chrono::Utc::now().to_rfc3339() }),
                )
                .to_frame(),
            );
        }
        "typing" => {
            let Some(conversation_id) = uuid_field(&payload, "conversationId") else {
                return Ok(());
            };
            if get_membership(&state.pool, conversation_id, user_id)
                .await?
                .is_none()
            {
                return Ok(());
            }
            let typing = payload
                .get("typing")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let until = chrono::Utc::now()
                + chrono::Duration::milliseconds(if typing { TYPING_TTL_MS } else { 0 });
            let audience: Vec<Uuid> = member_ids(&state.pool, conversation_id)
                .await?
                .into_iter()
                .filter(|member| *member != user_id)
                .collect();
            state
                .hub
                .publish(
                    audience,
                    Event::typing(conversation_id, user_id, until.to_rfc3339()),
                )
                .await;
        }
        "read" => {
            let (Some(conversation_id), Some(message_id)) = (
                uuid_field(&payload, "conversationId"),
                uuid_field(&payload, "messageId"),
            ) else {
                return Ok(());
            };
            if get_membership(&state.pool, conversation_id, user_id)
                .await?
                .is_none()
            {
                return Ok(());
            }
            // Ein Client, der etwas Unerlaubtes meldet, bekommt hier keinen
            // Fehler zurück – der Socket soll daran nicht zerbrechen. Verbucht
            // wird es trotzdem nicht.
            let _ = crate::services::conversations::melde_gelesen(
                state,
                conversation_id,
                user_id,
                message_id,
            )
            .await;
        }
        // Unknown events are ignored so new clients can talk to old servers.
        _ => {}
    }
    Ok(())
}

fn uuid_field(payload: &Value, key: &str) -> Option<Uuid> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eine halboffene Leitung, von der nichts mehr kommt, galt ewig als offen.
    /// (Mit kurzer Frist geprüft; im Betrieb sind es zwei Herzschläge.)
    #[tokio::test]
    async fn eine_stille_leitung_endet_nach_der_frist() {
        let frist = Duration::from_millis(50);
        let mut still = futures_util::stream::pending::<Result<Message, ()>>();
        let anfang = tokio::time::Instant::now();
        assert!(naechstes(&mut still, frist).await.is_none());
        assert!(anfang.elapsed() >= frist);
        assert_eq!(LESEFRIST, Duration::from_secs(2 * HEARTBEAT_INTERVAL_SECS));
    }

    #[tokio::test]
    async fn ein_pong_haelt_sie_offen() {
        let mut lebendig = futures_util::stream::iter(vec![
            Ok::<_, ()>(Message::Pong(Vec::new().into())),
            Err(()),
        ]);
        assert!(matches!(
            naechstes(&mut lebendig, LESEFRIST).await,
            Some(Message::Pong(_))
        ));
        // Ein Fehler beendet sie.
        assert!(naechstes(&mut lebendig, LESEFRIST).await.is_none());
    }
}
