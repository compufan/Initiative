//! Zugestellt und gelesen: Stände je Mitglied, Lesebestätigungen je Nachricht.
//!
//! # Zwei Stände
//!
//! `last_read_message_id` (gelesen) gab es schon; `delivered_message_id`
//! (zugestellt, Migration 0040) sagt, bis wohin ein Gerät des Mitglieds den
//! Verlauf EMPFANGEN hat – auch wenn der Chat nie geöffnet wurde. Gelesen
//! schliesst zugestellt ein: Wer etwas gelesen hat, hat es auch bekommen.
//! Deshalb ist der wirksame Zustellstand immer das Grössere von beiden.
//!
//! # Lesebestätigungen ausgeschaltet
//!
//! `settings.privacy.readReceipts = false` gilt gegenseitig und – wie in den
//! Einstellungen beschrieben – nur in Einzelchats: Wer sie ausschaltet, zeigt
//! anderen nicht, dass er gelesen hat, und sieht es auch bei anderen nicht.
//! Zustellung bleibt sichtbar (WhatsApp hält es genauso). In Gruppen bleiben
//! sie an; dort weiss niemand, auf wessen Schalter er sich verlassen sollte.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppResult;
use crate::realtime::Event;
use crate::state::AppState;

/// SQL-Ausdruck: Hat die Person `u` Lesebestätigungen ausgeschaltet?
///
/// Nur ein ausdrückliches `false` schaltet aus – fehlt die Angabe (ältere
/// Konten), gilt die Vorgabe „an“.
pub const LESEBESTAETIGUNG_AUS_SQL: &str =
    "(u.settings -> 'privacy' -> 'readReceipts') = 'false'::jsonb";

/// Ob Lesebestätigungen zwischen diesen beiden in diesem Chat gelten.
pub fn lesebestaetigung_gilt(ist_gruppe: bool, betrachter_aus: bool, mitglied_aus: bool) -> bool {
    ist_gruppe || !(betrachter_aus || mitglied_aus)
}

/// Ein Stand eines Mitglieds, wie ihn ein Betrachter sehen darf.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stand {
    pub user_id: Uuid,
    pub gelesen: Option<Uuid>,
    pub zugestellt: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct StandZeile {
    user_id: Uuid,
    gelesen: Option<Uuid>,
    zugestellt: Option<Uuid>,
    gelesen_am: Option<DateTime<Utc>>,
    zugestellt_am: Option<DateTime<Utc>>,
    aus: bool,
}

/// Die Stände aller Mitglieder eines Chats, wie `betrachter` sie sehen darf.
///
/// Ein Stand, der auf eine Nachricht vor der eigenen Grenze zeigt, wird
/// verschwiegen – aus der Kennung fiele sonst der Zeitpunkt einer Nachricht
/// heraus, die man nie sehen darf (dieselbe Regel wie beim Lesezeichen in der
/// Chatliste).
pub async fn staende(
    pool: &PgPool,
    conversation_id: Uuid,
    betrachter: Uuid,
) -> AppResult<Vec<Stand>> {
    let ist_gruppe = ist_gruppe(pool, conversation_id).await?;
    let grenze: Option<Option<DateTime<Utc>>> = sqlx::query_scalar(
        "select sieht_ab from conversation_members where conversation_id = $1 and user_id = $2",
    )
    .bind(conversation_id)
    .bind(betrachter)
    .fetch_optional(pool)
    .await?;
    let Some(grenze) = grenze else {
        return Ok(Vec::new());
    };
    let zeilen = sqlx::query_as::<_, StandZeile>(&format!(
        "select cm.user_id,
                cm.last_read_message_id as gelesen,
                cm.delivered_message_id as zugestellt,
                g.created_at as gelesen_am,
                z.created_at as zugestellt_am,
                coalesce({LESEBESTAETIGUNG_AUS_SQL}, false) as aus
           from conversation_members cm
           join users u on u.id = cm.user_id
           left join messages g on g.id = cm.last_read_message_id and g.conversation_id = cm.conversation_id
           left join messages z on z.id = cm.delivered_message_id and z.conversation_id = cm.conversation_id
          where cm.conversation_id = $1"
    ))
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    let betrachter_aus = zeilen
        .iter()
        .find(|zeile| zeile.user_id == betrachter)
        .is_some_and(|zeile| zeile.aus);
    let sichtbar =
        |am: Option<DateTime<Utc>>| am.is_some_and(|am| grenze.is_none_or(|ab| am >= ab));
    Ok(zeilen
        .into_iter()
        .map(|zeile| {
            let gelesen = zeile.gelesen.filter(|_| sichtbar(zeile.gelesen_am));
            let zugestellt = zeile.zugestellt.filter(|_| sichtbar(zeile.zugestellt_am));
            // Gelesen schliesst zugestellt ein – auch wenn das Lesen nicht
            // gezeigt werden darf.
            let zugestellt = groesser(zugestellt, gelesen);
            let zeigen = zeile.user_id == betrachter
                || lesebestaetigung_gilt(ist_gruppe, betrachter_aus, zeile.aus);
            Stand {
                user_id: zeile.user_id,
                gelesen: if zeigen { gelesen } else { None },
                zugestellt,
            }
        })
        .collect())
}

fn groesser(a: Option<Uuid>, b: Option<Uuid>) -> Option<Uuid> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

async fn ist_gruppe(pool: &PgPool, conversation_id: Uuid) -> AppResult<bool> {
    Ok(
        sqlx::query_scalar::<_, String>("select type from conversations where id = $1")
            .bind(conversation_id)
            .fetch_optional(pool)
            .await?
            .is_some_and(|art| art == "group"),
    )
}

/**
 * Meldet, bis wohin dieses Gerät einen Chat empfangen hat.
 *
 * Rückt nur vor, nie zurück, und nur auf eine Nachricht, die in diesem Chat
 * liegt und die die Person sehen darf. Gibt `true` zurück, wenn der Stand
 * vorrückte – nur dann gibt es etwas zu melden. Eine Wiederholung (das Gerät
 * meldet nach einem Neustart noch einmal) ändert nichts.
 */
pub async fn zustellung_melden(
    state: &AppState,
    conversation_id: Uuid,
    user_id: Uuid,
    message_id: Uuid,
) -> AppResult<bool> {
    if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, message_id, user_id).await? {
        return Ok(false);
    }
    let vorgerueckt = sqlx::query(
        "update conversation_members set delivered_message_id = $3
          where conversation_id = $1 and user_id = $2
            and (delivered_message_id is null or delivered_message_id < $3)
            -- Was schon gelesen ist, ist auch zugestellt: kein Vorrücken nötig,
            -- aber auch kein Schaden. Der Stand bleibt trotzdem ehrlich.
            and exists (select 1 from messages m
                         where m.id = $3 and m.conversation_id = $1)",
    )
    .bind(conversation_id)
    .bind(user_id)
    .bind(message_id)
    .execute(&state.pool)
    .await?
    .rows_affected()
        > 0;
    if vorgerueckt {
        // Nur an die, die diese Nachricht sehen dürfen – wie beim Lesen.
        let empfaenger =
            crate::services::verlauf::empfaenger_fuer_nachricht(&state.pool, message_id).await?;
        state
            .hub
            .publish(
                empfaenger,
                Event::new(
                    "delivery.updated",
                    serde_json::json!({
                        "conversationId": conversation_id,
                        "userId": user_id,
                        "deliveredMessageId": message_id,
                    }),
                ),
            )
            .await;
    }
    Ok(vorgerueckt)
}

/// Ein Eintrag der Nachrichteninfo: wer, und wann (falls bekannt).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bestaetigung {
    pub user_id: Uuid,
    /// `None`: der Stand stammt von vor der Zeiterfassung (Migration 0040).
    pub am: Option<DateTime<Utc>>,
}

/// „Gelesen von / Zugestellt an“ für eine Nachricht.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nachrichteninfo {
    pub gelesen: Vec<Bestaetigung>,
    /// Zugestellt, aber (sichtbar) nicht gelesen.
    pub zugestellt: Vec<Bestaetigung>,
    /// Noch auf keinem Gerät angekommen.
    pub ausstehend: Vec<Uuid>,
}

#[derive(sqlx::FromRow)]
struct InfoZeile {
    user_id: Uuid,
    gelesen: Option<Uuid>,
    zugestellt: Option<Uuid>,
    aus: bool,
}

/**
 * Wer hat diese Nachricht bekommen und gelesen – und wann.
 *
 * Gefragt werden nur die, die sie sehen dürfen (ein Neuzugang nach der
 * Nachricht kommt nicht vor). Die Zeit ist die früheste Zeile des
 * Verlaufs, deren Stand die Nachricht erreicht (siehe Migration 0040); für
 * „zugestellt“ zählt auch ein Lesen, denn gelesen heisst bekommen.
 */
pub async fn nachrichteninfo(
    pool: &PgPool,
    message_id: Uuid,
    conversation_id: Uuid,
    absender: Uuid,
) -> AppResult<Nachrichteninfo> {
    let ist_gruppe = ist_gruppe(pool, conversation_id).await?;
    let betrachter_aus: bool = sqlx::query_scalar(&format!(
        "select coalesce({LESEBESTAETIGUNG_AUS_SQL}, false) from users u where u.id = $1"
    ))
    .bind(absender)
    .fetch_optional(pool)
    .await?
    .unwrap_or(false);

    let zeilen = sqlx::query_as::<_, InfoZeile>(&format!(
        "select cm.user_id,
                cm.last_read_message_id as gelesen,
                cm.delivered_message_id as zugestellt,
                coalesce({LESEBESTAETIGUNG_AUS_SQL}, false) as aus
           from messages m
           join conversation_members cm on cm.conversation_id = m.conversation_id
           join users u on u.id = cm.user_id
          where m.id = $1
            and cm.user_id <> $2
            and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
          order by cm.joined_at, cm.user_id"
    ))
    .bind(message_id)
    .bind(absender)
    .fetch_all(pool)
    .await?;

    // Die Zeitpunkte aller auf einmal: je Person und Art die früheste Zeile,
    // deren Stand die Nachricht erreicht.
    let zeiten: Vec<(Uuid, String, DateTime<Utc>)> = sqlx::query_as(
        "select user_id, art, min(am)
           from lesestand_verlauf
          where conversation_id = $1 and bis >= $2
          group by user_id, art",
    )
    .bind(conversation_id)
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    let mut gelesen_am: HashMap<Uuid, DateTime<Utc>> = HashMap::new();
    let mut zugestellt_am: HashMap<Uuid, DateTime<Utc>> = HashMap::new();
    for (person, art, am) in zeiten {
        if art == "gelesen" {
            gelesen_am.insert(person, am);
        }
        // Gelesen heisst zugestellt: das Frühere von beiden.
        zugestellt_am
            .entry(person)
            .and_modify(|bisher| *bisher = (*bisher).min(am))
            .or_insert(am);
    }

    let mut info = Nachrichteninfo {
        gelesen: Vec::new(),
        zugestellt: Vec::new(),
        ausstehend: Vec::new(),
    };
    for zeile in zeilen {
        let hat_gelesen = zeile.gelesen.is_some_and(|stand| stand >= message_id);
        let hat_bekommen = hat_gelesen || zeile.zugestellt.is_some_and(|stand| stand >= message_id);
        let zeigen = lesebestaetigung_gilt(ist_gruppe, betrachter_aus, zeile.aus);
        if hat_gelesen && zeigen {
            info.gelesen.push(Bestaetigung {
                user_id: zeile.user_id,
                am: gelesen_am.get(&zeile.user_id).copied(),
            });
        } else if hat_bekommen {
            info.zugestellt.push(Bestaetigung {
                user_id: zeile.user_id,
                am: zugestellt_am.get(&zeile.user_id).copied(),
            });
        } else {
            info.ausstehend.push(zeile.user_id);
        }
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_gruppen_gelten_lesebestaetigungen_immer() {
        assert!(lesebestaetigung_gilt(true, true, true));
        assert!(lesebestaetigung_gilt(true, false, true));
    }

    #[test]
    fn im_einzelchat_gegenseitig() {
        assert!(lesebestaetigung_gilt(false, false, false));
        assert!(
            !lesebestaetigung_gilt(false, true, false),
            "eigene aus: sehe keine"
        );
        assert!(
            !lesebestaetigung_gilt(false, false, true),
            "andere aus: zeigt keine"
        );
    }

    #[test]
    fn gelesen_schliesst_zugestellt_ein() {
        let a = Uuid::from_u128(5);
        let b = Uuid::from_u128(9);
        assert_eq!(groesser(Some(a), Some(b)), Some(b));
        assert_eq!(groesser(None, Some(a)), Some(a));
        assert_eq!(groesser(Some(a), None), Some(a));
        assert_eq!(groesser(None, None), None);
    }
}
