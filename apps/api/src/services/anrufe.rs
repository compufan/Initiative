//! 1:1-Anrufe: Signalisierung, Zustand, Systemzeile, ICE-Zugangsdaten.
//!
//! # Was der Server tut – und was nicht
//!
//! Ton und Bild gehen per WebRTC von Gerät zu Gerät (oder über einen
//! TURN-Server, wenn kein direkter Weg geht). Der Server sieht davon nichts.
//! Er vermittelt nur die Signalisierung über die vorhandene Echtzeit-Leitung –
//! und zwar ausschliesslich zwischen den beiden Mitgliedern eines Direktchats,
//! die einander schreiben dürfen (Sperren in beide Richtungen,
//! `services::conversations::senden_erlaubt`).
//!
//! # Zustand
//!
//! ```text
//! klingelt ──antwort──▶ verbunden ──ende──▶ beendet   („Anruf, 3:12“)
//!    │
//!    ├──ende (Anrufer) / 45 s ohne Antwort──▶ verpasst  („Verpasster Anruf“)
//!    ├──abgelehnt / ende (Angerufener)──────▶ abgelehnt („Verpasster Anruf“)
//! (Gegenüber telefoniert schon) ─────────────▶ besetzt   („Verpasster Anruf“)
//! ```
//!
//! Jeder Übergang ist EIN bedingtes Update (`where status = …`). Die
//! Systemzeile entsteht in derselben Transaktion, mit festem Schlüssel
//! (`anruf:{id}`) – damit landet sie genau einmal im Chat, auch wenn Auflegen,
//! Zeitlimit und Aufräumdienst gleichzeitig zuschlagen oder mehrere Instanzen
//! laufen. Gemeldet (Echtzeit, Push) wird erst nach dem Commit.
//!
//! # Gruppenanrufe
//!
//! Gibt es bewusst nicht: Ab drei Personen müsste jedes Gerät jedem anderen
//! seinen Strom schicken (Vollvermaschung) – das trägt kein Telefon. Dafür
//! braucht es einen Medienserver (SFU), siehe `docs/FEATURES.md`.

use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dto::PushPayload;
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::messages::{ausliefern, nachricht_anlegen, NewMessage};
use crate::state::AppState;

/// So lange klingelt es, bevor der Anruf als verpasst gilt.
pub const KLINGELN: Duration = Duration::from_secs(45);
/// Ein „verbundener“ Anruf, von dem so lange nichts kam, ist liegengeblieben
/// (beide Geräte abgestürzt) und zählt nicht mehr als „besetzt“.
pub const VERBUNDEN_HOECHSTENS: Duration = Duration::from_secs(6 * 3600);
/// Höchstgrösse einer Sitzungsbeschreibung (SDP). Echte sind 2–10 KB.
const SDP_MAX: usize = 64 * 1024;
/// Höchstgrösse eines ICE-Kandidaten samt Feldern.
const ICE_MAX: usize = 2 * 1024;
/// So lange gelten ausgestellte TURN-Zugangsdaten.
pub const TURN_GUELTIG: Duration = Duration::from_secs(4 * 3600);

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnrufZeile {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub anrufer_id: Option<Uuid>,
    pub angerufener_id: Option<Uuid>,
    pub video: bool,
    pub status: String,
    pub begonnen_at: DateTime<Utc>,
    pub angenommen_at: Option<DateTime<Utc>>,
    pub beendet_at: Option<DateTime<Utc>>,
    pub nachricht_id: Option<Uuid>,
    pub angebot_sdp: Option<String>,
    pub antwort_sdp: Option<String>,
}

impl AnrufZeile {
    fn ist_beteiligt(&self, person: Uuid) -> bool {
        self.anrufer_id == Some(person) || self.angerufener_id == Some(person)
    }

    fn gegenueber(&self, person: Uuid) -> Option<Uuid> {
        if self.anrufer_id == Some(person) {
            self.angerufener_id
        } else if self.angerufener_id == Some(person) {
            self.anrufer_id
        } else {
            None
        }
    }

    fn beide(&self) -> Vec<Uuid> {
        self.anrufer_id
            .into_iter()
            .chain(self.angerufener_id)
            .collect()
    }
}

fn uuid_feld(payload: &Value, key: &str) -> Option<Uuid> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|wert| Uuid::parse_str(wert).ok())
}

/// Ein Anruf, wenn diese Person an ihm beteiligt ist.
pub async fn fuer(state: &AppState, anruf_id: Uuid, person: Uuid) -> AppResult<AnrufZeile> {
    let zeile = sqlx::query_as::<_, AnrufZeile>("select * from anrufe where id = $1")
        .bind(anruf_id)
        .fetch_optional(&state.pool)
        .await?;
    match zeile {
        Some(zeile) if zeile.ist_beteiligt(person) => Ok(zeile),
        // Ob es den Anruf gibt, geht Unbeteiligte nichts an.
        _ => Err(AppError::not_found("Anruf nicht gefunden")),
    }
}

/// Eine Absage nur an die Leitung, die gefragt hat.
fn fehler_melden(
    state: &AppState,
    person: Uuid,
    verbindung: Uuid,
    anruf: Option<Uuid>,
    grund: &str,
    text: &str,
) {
    state.hub.send_to(
        person,
        verbindung,
        &Event::new(
            "anruf.fehler",
            json!({ "anrufId": anruf, "grund": grund, "text": text }),
        ),
    );
}

/// Ein Signal von einem Gerät (`anruf.*` über die Echtzeit-Leitung).
///
/// Fehler gehen nicht als Fehler an den Socket (der soll daran nicht
/// zerbrechen), sondern als `anruf.fehler` an die fragende Leitung.
pub async fn ereignis(
    state: &AppState,
    ich: Uuid,
    verbindung: Uuid,
    typ: &str,
    payload: &Value,
) -> AppResult<()> {
    match typ {
        "anruf.angebot" => angebot(state, ich, verbindung, payload).await,
        "anruf.antwort" => antwort(state, ich, verbindung, payload).await,
        "anruf.ice" => ice(state, ich, payload).await,
        "anruf.ende" | "anruf.abgelehnt" => {
            let Some(anruf_id) = uuid_feld(payload, "anrufId") else {
                return Ok(());
            };
            auflegen(state, ich, anruf_id, typ == "anruf.abgelehnt").await
        }
        _ => Ok(()),
    }
}

async fn angebot(state: &AppState, ich: Uuid, verbindung: Uuid, payload: &Value) -> AppResult<()> {
    let (Some(anruf_id), Some(chat)) = (
        uuid_feld(payload, "anrufId"),
        uuid_feld(payload, "conversationId"),
    ) else {
        return Ok(());
    };
    let video = payload
        .get("video")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(sdp) = payload.get("sdp").and_then(Value::as_str) else {
        return Ok(());
    };
    if sdp.len() > SDP_MAX {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "ungueltig",
            "Angebot zu gross",
        );
        return Ok(());
    }
    if !state
        .drossel
        .erlaubt(&format!("anruf:{ich}"), crate::drossel::regeln::ANRUF)
    {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "gedrosselt",
            "Zu viele Anrufe – bitte später noch einmal",
        );
        return Ok(());
    }

    let gespraech =
        match crate::services::conversations::require_conversation(&state.pool, chat).await {
            Ok(g) => g,
            Err(_) => {
                fehler_melden(
                    state,
                    ich,
                    verbindung,
                    Some(anruf_id),
                    "nicht_erlaubt",
                    "Chat nicht gefunden",
                );
                return Ok(());
            }
        };
    if gespraech.r#type != "direct" {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "nur_direkt",
            "Anrufe gibt es nur im Direktchat",
        );
        return Ok(());
    }
    // Mitglied, keine Sperre in irgendeiner Richtung – dieselbe Regel wie
    // fürs Schreiben.
    if let Err(fehler) =
        crate::services::conversations::senden_erlaubt(&state.pool, chat, ich, None).await
    {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "gesperrt",
            &fehler.to_string(),
        );
        return Ok(());
    }
    let gegenueber: Option<Uuid> = sqlx::query_scalar(
        "select user_id from conversation_members
          where conversation_id = $1 and user_id <> $2 limit 1",
    )
    .bind(chat)
    .bind(ich)
    .fetch_optional(&state.pool)
    .await?;
    let Some(gegenueber) = gegenueber else {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "nicht_erlaubt",
            "Niemand zum Anrufen da",
        );
        return Ok(());
    };

    // Was liegengeblieben ist, zählt nicht als „besetzt“.
    abraeumen(state).await;

    let mut tx = state.pool.begin().await?;
    let besetzt: bool = sqlx::query_scalar(
        "select exists (
           select 1 from anrufe
            where status in ('klingelt', 'verbunden') and id <> $1
              and (anrufer_id = $2 or angerufener_id = $2)
              and begonnen_at > now() - make_interval(secs => $3))",
    )
    .bind(anruf_id)
    .bind(gegenueber)
    .bind(VERBUNDEN_HOECHSTENS.as_secs_f64())
    .fetch_one(&mut *tx)
    .await?;
    let status = if besetzt { "besetzt" } else { "klingelt" };
    let neu = sqlx::query_as::<_, AnrufZeile>(
        "insert into anrufe (id, conversation_id, anrufer_id, angerufener_id, video, status,
                             angebot_sdp, beendet_at)
         values ($1, $2, $3, $4, $5, $6, $7, case when $6 = 'besetzt' then now() end)
         on conflict (id) do nothing
         returning *",
    )
    .bind(anruf_id)
    .bind(chat)
    .bind(ich)
    .bind(gegenueber)
    .bind(video)
    .bind(status)
    .bind(sdp)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(neu) = neu else {
        // Dieselbe Kennung noch einmal (Neuversuch) – schon verbucht.
        return Ok(());
    };
    if besetzt {
        let angelegt = systemzeile_anlegen(&mut tx, &neu).await?;
        tx.commit().await?;
        state
            .hub
            .publish(
                vec![ich],
                Event::new("anruf.besetzt", json!({ "anrufId": anruf_id })),
            )
            .await;
        if let Err(fehler) = ausliefern(state, angelegt).await {
            tracing::warn!(%fehler, "Anruf: Systemzeile festgeschrieben, Meldung gescheitert");
        }
        return Ok(());
    }
    tx.commit().await?;

    state
        .hub
        .publish(
            vec![gegenueber],
            Event::new(
                "anruf.angebot",
                json!({
                    "anrufId": anruf_id,
                    "conversationId": chat,
                    "von": ich,
                    "video": video,
                    "begonnenAt": neu.begonnen_at,
                }),
            ),
        )
        .await;
    klingel_push(state, &neu).await;

    // Das Zeitlimit. Läuft diese Instanz nicht mehr, wenn es abläuft, übernimmt
    // der Aufräumdienst (`abraeumen`) – das Update ist bedingt, also zählt nur
    // der erste.
    let dienst = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(KLINGELN).await;
        if let Err(fehler) =
            abschliessen(&dienst, anruf_id, &["klingelt"], "verpasst", "zeitlimit").await
        {
            tracing::warn!(%fehler, "Anruf: Zeitlimit konnte nicht verbucht werden");
        }
    });
    Ok(())
}

async fn antwort(state: &AppState, ich: Uuid, verbindung: Uuid, payload: &Value) -> AppResult<()> {
    let Some(anruf_id) = uuid_feld(payload, "anrufId") else {
        return Ok(());
    };
    let Some(sdp) = payload.get("sdp").and_then(Value::as_str) else {
        return Ok(());
    };
    if sdp.len() > SDP_MAX {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "ungueltig",
            "Antwort zu gross",
        );
        return Ok(());
    }
    /*
     * Wer zuerst annimmt, gewinnt – EIN bedingtes Update. Nimmt ein zweites
     * Gerät derselben Person gleichzeitig an, trifft es keine Zeile mehr und
     * bekommt `anruf.angenommen` wie alle anderen Geräte auch.
     */
    let zeile = sqlx::query_as::<_, AnrufZeile>(
        "update anrufe set status = 'verbunden', angenommen_at = now(), antwort_sdp = $3
          where id = $1 and angerufener_id = $2 and status = 'klingelt'
          returning *",
    )
    .bind(anruf_id)
    .bind(ich)
    .bind(sdp)
    .fetch_optional(&state.pool)
    .await?;
    let Some(zeile) = zeile else {
        fehler_melden(
            state,
            ich,
            verbindung,
            Some(anruf_id),
            "vorbei",
            "Der Anruf ist schon vorbei",
        );
        return Ok(());
    };
    if let Some(anrufer) = zeile.anrufer_id {
        state
            .hub
            .publish(
                vec![anrufer],
                Event::new("anruf.antwort", json!({ "anrufId": anruf_id })),
            )
            .await;
    }
    // Alle Geräte des Angerufenen hören auf zu klingeln – ausser dem, das
    // angenommen hat (es erkennt sich an seiner Leitung).
    state
        .hub
        .publish(
            vec![ich],
            Event::new(
                "anruf.angenommen",
                json!({ "anrufId": anruf_id, "verbindung": verbindung }),
            ),
        )
        .await;
    ende_push(state, &zeile, "angenommen").await;
    Ok(())
}

async fn ice(state: &AppState, ich: Uuid, payload: &Value) -> AppResult<()> {
    let Some(anruf_id) = uuid_feld(payload, "anrufId") else {
        return Ok(());
    };
    let Some(kandidat) = payload.get("candidate") else {
        return Ok(());
    };
    if kandidat.to_string().len() > ICE_MAX {
        return Ok(());
    }
    let zeile = match fuer(state, anruf_id, ich).await {
        Ok(zeile) => zeile,
        Err(_) => return Ok(()),
    };
    if !matches!(zeile.status.as_str(), "klingelt" | "verbunden") {
        return Ok(());
    }
    let Some(ziel) = zeile.gegenueber(ich) else {
        return Ok(());
    };
    state
        .hub
        .publish(
            vec![ziel],
            Event::new(
                "anruf.ice",
                json!({ "anrufId": anruf_id, "candidate": kandidat }),
            ),
        )
        .await;
    Ok(())
}

/// Auflegen oder ablehnen – je nach Zustand und Rolle.
pub async fn auflegen(
    state: &AppState,
    ich: Uuid,
    anruf_id: Uuid,
    ablehnen: bool,
) -> AppResult<()> {
    let zeile = match fuer(state, anruf_id, ich).await {
        Ok(zeile) => zeile,
        Err(_) => return Ok(()),
    };
    let anrufer = zeile.anrufer_id == Some(ich);
    match (zeile.status.as_str(), anrufer, ablehnen) {
        ("klingelt", true, _) => {
            abschliessen(state, anruf_id, &["klingelt"], "verpasst", "abgebrochen").await?;
        }
        ("klingelt", false, _) => {
            abschliessen(state, anruf_id, &["klingelt"], "abgelehnt", "abgelehnt").await?;
        }
        ("verbunden", _, _) => {
            abschliessen(state, anruf_id, &["verbunden"], "beendet", "aufgelegt").await?;
        }
        _ => {}
    }
    Ok(())
}

/// „3:12“ bzw. „1:02:03“.
pub fn dauer_text(sekunden: i64) -> String {
    let s = sekunden.max(0);
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// Der Text der Systemzeile – aus Sicht des Angerufenen; die Oberfläche
/// sagt dem Anrufer „Anruf nicht angenommen“ (`SystemBubble`).
pub fn zeilentext(zeile: &AnrufZeile) -> String {
    let art = if zeile.video { "Videoanruf" } else { "Anruf" };
    match (zeile.status.as_str(), zeile.angenommen_at, zeile.beendet_at) {
        ("beendet", Some(von), Some(bis)) => {
            format!("{art}, {}", dauer_text((bis - von).num_seconds()))
        }
        _ => {
            if zeile.video {
                "Verpasster Videoanruf".to_string()
            } else {
                "Verpasster Anruf".to_string()
            }
        }
    }
}

async fn systemzeile_anlegen(
    tx: &mut sqlx::PgConnection,
    zeile: &AnrufZeile,
) -> AppResult<crate::services::messages::Angelegt> {
    let Some(anrufer) = zeile.anrufer_id else {
        return Err(AppError::internal("Anruf ohne Anrufer"));
    };
    let mut nachricht = NewMessage::system(
        zeile.conversation_id,
        anrufer,
        "anruf",
        zeile.angerufener_id.into_iter().collect(),
    );
    nachricht.body = Some(zeilentext(zeile));
    // Der feste Schlüssel macht die Zeile zur einzigen: Ein zweiter Versuch
    // bekommt die erste zurück (siehe `nachricht_anlegen`).
    nachricht.client_id = Some(format!("anruf:{}", zeile.id));
    let dauer = match (zeile.angenommen_at, zeile.beendet_at) {
        (Some(von), Some(bis)) => Some((bis - von).num_seconds().max(0)),
        _ => None,
    };
    if let Some(objekt) = nachricht.metadata.as_object_mut() {
        objekt.insert(
            "anruf".to_string(),
            json!({
                "id": zeile.id,
                "status": zeile.status,
                "video": zeile.video,
                "dauerS": dauer,
            }),
        );
    }
    let angelegt = nachricht_anlegen(&mut *tx, nachricht).await?;
    sqlx::query("update anrufe set nachricht_id = $2 where id = $1")
        .bind(zeile.id)
        .bind(angelegt.id())
        .execute(&mut *tx)
        .await?;
    Ok(angelegt)
}

/**
 * Einen Anruf in einen Endzustand bringen – genau einmal.
 *
 * Das Update ist bedingt (`status = any($von)`); wer zu spät kommt (Auflegen
 * gleichzeitig mit dem Zeitlimit), trifft keine Zeile und tut nichts. Die
 * Systemzeile steht in derselben Transaktion. Gibt zurück, ob dieser Aufruf
 * es war.
 */
pub async fn abschliessen(
    state: &AppState,
    anruf_id: Uuid,
    von: &[&str],
    nach: &str,
    grund: &str,
) -> AppResult<bool> {
    let mut tx = state.pool.begin().await?;
    let zeile = sqlx::query_as::<_, AnrufZeile>(
        "update anrufe set status = $3, beendet_at = now()
          where id = $1 and status = any($2)
          returning *",
    )
    .bind(anruf_id)
    .bind(von)
    .bind(nach)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(zeile) = zeile else {
        return Ok(false);
    };
    let angelegt = systemzeile_anlegen(&mut tx, &zeile).await?;
    tx.commit().await?;

    let beide = zeile.beide();
    state
        .hub
        .publish(
            beide,
            Event::new(
                "anruf.ende",
                json!({ "anrufId": anruf_id, "grund": grund, "status": zeile.status }),
            ),
        )
        .await;
    if nach == "abgelehnt" {
        if let Some(anrufer) = zeile.anrufer_id {
            state
                .hub
                .publish(
                    vec![anrufer],
                    Event::new("anruf.abgelehnt", json!({ "anrufId": anruf_id })),
                )
                .await;
        }
    }
    if von.contains(&"klingelt") {
        ende_push(state, &zeile, nach).await;
    }
    if let Err(fehler) = ausliefern(state, angelegt).await {
        tracing::warn!(%fehler, "Anruf: Systemzeile festgeschrieben, Meldung gescheitert");
    }
    Ok(true)
}

/**
 * Liegengebliebenes abschliessen: Klingeln über das Zeitlimit hinaus (die
 * Instanz mit dem Zeitgeber ist weg) und „verbunden“ über Stunden (beide
 * Geräte abgestürzt). Sicher bei mehreren Instanzen – jeder Abschluss ist
 * bedingt.
 */
pub async fn abraeumen(state: &AppState) {
    let faellig: Vec<(Uuid, String)> = match sqlx::query_as(
        "select id, status from anrufe
          where (status = 'klingelt' and begonnen_at < now() - make_interval(secs => $1))
             or (status = 'verbunden' and begonnen_at < now() - make_interval(secs => $2))
          limit 100",
    )
    .bind(KLINGELN.as_secs_f64() + 5.0)
    .bind(VERBUNDEN_HOECHSTENS.as_secs_f64())
    .fetch_all(&state.pool)
    .await
    {
        Ok(liste) => liste,
        Err(fehler) => {
            tracing::warn!(%fehler, "Anrufe aufräumen gescheitert");
            return;
        }
    };
    for (id, status) in faellig {
        let ergebnis = if status == "klingelt" {
            abschliessen(state, id, &["klingelt"], "verpasst", "zeitlimit").await
        } else {
            abschliessen(state, id, &["verbunden"], "beendet", "getrennt").await
        };
        if let Err(fehler) = ergebnis {
            tracing::warn!(%fehler, anruf = %id, "Anruf konnte nicht abgeschlossen werden");
        }
    }
}

/// Den Aufräumdienst starten (alle 15 Sekunden).
pub fn starten(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut takt = tokio::time::interval(Duration::from_secs(15));
        takt.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            takt.tick().await;
            abraeumen(&state).await;
        }
    })
}

async fn push_erlaubt(state: &AppState, person: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "select (settings->'notifications'->>'push') is distinct from 'false'
           from users where id = $1",
    )
    .bind(person)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .unwrap_or(false)
}

async fn name_von(state: &AppState, person: Option<Uuid>) -> String {
    let Some(person) = person else {
        return "Jemand".to_string();
    };
    sqlx::query_scalar::<_, String>("select display_name from users where id = $1")
        .bind(person)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "Jemand".to_string())
}

/// „Anruf von …“ an ALLE Geräte des Angerufenen – auch bei geschlossener App.
/// Eigener `tag`, damit Ende und Annehmen genau diese Mitteilung ersetzen.
async fn klingel_push(state: &AppState, zeile: &AnrufZeile) {
    let Some(ziel) = zeile.angerufener_id else {
        return;
    };
    if !state.push.enabled() || !push_erlaubt(state, ziel).await {
        return;
    }
    let name = name_von(state, zeile.anrufer_id).await;
    let payload = PushPayload {
        title: format!("Anruf von {name}"),
        body: if zeile.video {
            "Videoanruf – tippen zum Annehmen".to_string()
        } else {
            "Sprachanruf – tippen zum Annehmen".to_string()
        },
        tag: Some(format!("anruf:{}", zeile.id)),
        url: format!("/chats/{}?anruf={}", zeile.conversation_id, zeile.id),
        conversation_id: Some(zeile.conversation_id),
        message_id: None,
        kind: "anruf".to_string(),
    };
    state
        .push
        .im_hintergrund(state.pool.clone(), vec![(vec![ziel], payload)]);
}

/// Die Klingel-Mitteilung ersetzen: „Verpasster Anruf“ oder, angenommen,
/// eine leise, die der Dienst-Arbeiter gleich wieder schliesst.
async fn ende_push(state: &AppState, zeile: &AnrufZeile, ausgang: &str) {
    let Some(ziel) = zeile.angerufener_id else {
        return;
    };
    if !state.push.enabled() || !push_erlaubt(state, ziel).await {
        return;
    }
    let name = name_von(state, zeile.anrufer_id).await;
    let (titel, text) = match ausgang {
        "angenommen" => (
            "Anruf angenommen".to_string(),
            format!("Gespräch mit {name}"),
        ),
        "abgelehnt" => ("Anruf abgelehnt".to_string(), name),
        _ => (format!("Verpasster Anruf von {name}"), zeilentext(zeile)),
    };
    let payload = PushPayload {
        title: titel,
        body: text,
        tag: Some(format!("anruf:{}", zeile.id)),
        url: format!("/chats/{}", zeile.conversation_id),
        conversation_id: Some(zeile.conversation_id),
        message_id: None,
        kind: if ausgang == "verpasst" {
            "anruf-verpasst".to_string()
        } else {
            "anruf-ende".to_string()
        },
    };
    state
        .push
        .im_hintergrund(state.pool.clone(), vec![(vec![ziel], payload)]);
}

/* ---------- ICE-Server und TURN-Zugangsdaten ------------------------------ */

/// SHA-1 (FIPS 180-1) – nur für HMAC-SHA1 der TURN-Zugangsdaten, die coturn
/// so verlangt. Keine eigene Abhängigkeit für 40 Zeilen.
pub fn sha1(daten: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut nachricht = daten.to_vec();
    let bits = (daten.len() as u64).wrapping_mul(8);
    nachricht.push(0x80);
    while nachricht.len() % 64 != 56 {
        nachricht.push(0);
    }
    nachricht.extend_from_slice(&bits.to_be_bytes());
    for block in nachricht.chunks(64) {
        let mut w = [0u32; 80];
        for (i, wort) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([wort[0], wort[1], wort[2], wort[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wert) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let neu = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wert);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = neu;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut ergebnis = [0u8; 20];
    for (i, wert) in h.iter().enumerate() {
        ergebnis[i * 4..i * 4 + 4].copy_from_slice(&wert.to_be_bytes());
    }
    ergebnis
}

/// HMAC-SHA1 (RFC 2104).
pub fn hmac_sha1(schluessel: &[u8], daten: &[u8]) -> [u8; 20] {
    let mut block = [0u8; 64];
    if schluessel.len() > 64 {
        block[..20].copy_from_slice(&sha1(schluessel));
    } else {
        block[..schluessel.len()].copy_from_slice(schluessel);
    }
    let mut innen = Vec::with_capacity(64 + daten.len());
    innen.extend(block.iter().map(|b| b ^ 0x36));
    innen.extend_from_slice(daten);
    let innen = sha1(&innen);
    let mut aussen = Vec::with_capacity(84);
    aussen.extend(block.iter().map(|b| b ^ 0x5c));
    aussen.extend_from_slice(&innen);
    sha1(&aussen)
}

/**
 * Zeitlich begrenzte TURN-Zugangsdaten nach coturns `use-auth-secret`
 * („TURN REST API“): Benutzername `Ablauf:Kennung`, Passwort
 * `base64(HMAC-SHA1(Geheimnis, Benutzername))`. coturn rechnet dasselbe nach
 * und weist ab, sobald der Ablauf vorbei ist – das Geheimnis selbst kennt nur
 * der Server.
 */
pub fn turn_zugang(geheimnis: &str, person: Uuid, ablauf_unix: i64) -> (String, String) {
    let benutzer = format!("{ablauf_unix}:{person}");
    let mac = hmac_sha1(geheimnis.as_bytes(), benutzer.as_bytes());
    let passwort = base64::engine::general_purpose::STANDARD.encode(mac);
    (benutzer, passwort)
}

/// Die ICE-Server für diese Person, wie `RTCPeerConnection` sie erwartet.
pub fn ice_server(config: &crate::config::Config, person: Uuid) -> Value {
    let mut server = Vec::new();
    if !config.stun_urls.is_empty() {
        server.push(json!({ "urls": config.stun_urls }));
    }
    let ablauf = Utc::now().timestamp() + TURN_GUELTIG.as_secs() as i64;
    if let (false, Some(geheimnis)) = (config.turn_urls.is_empty(), config.turn_secret.as_deref()) {
        let (benutzer, passwort) = turn_zugang(geheimnis, person, ablauf);
        server.push(json!({
            "urls": config.turn_urls,
            "username": benutzer,
            "credential": passwort,
        }));
    }
    json!({
        "iceServers": server,
        "gueltigBis": DateTime::<Utc>::from_timestamp(ablauf, 0),
        "klingelnS": KLINGELN.as_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha1_nach_den_pruefwerten() {
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn hmac_sha1_nach_rfc_2202() {
        assert_eq!(
            hex(&hmac_sha1(&[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        assert_eq!(
            hex(&hmac_sha1(b"Jefe", b"what do ya want for nothing?")),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
        // Schlüssel länger als ein Block.
        assert_eq!(
            hex(&hmac_sha1(
                &[0xaa; 80],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "aa4ae5e15272d00e95705637ce8a3b55ed402112"
        );
    }

    #[test]
    fn dauer_wird_lesbar() {
        assert_eq!(dauer_text(0), "0:00");
        assert_eq!(dauer_text(192), "3:12");
        assert_eq!(dauer_text(3723), "1:02:03");
    }
}
