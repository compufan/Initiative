//! Wer was von wem sieht: Privatsphäre-Einstellungen und Sperren.
//!
//! # Warum hier und nicht in der Oberfläche
//!
//! „Zuletzt online: niemand“ ist wertlos, wenn der Server den Zeitpunkt
//! trotzdem jedem schickt und nur die eigene App ihn nicht anzeigt – ein
//! Blick in die Entwicklerwerkzeuge genügte. Deshalb filtert der Server jede
//! Stelle, an der Profile, Präsenz, Tippen oder Lesezeichen hinausgehen,
//! nach dem Betrachter: Was jemand nicht sehen soll, bekommt er nicht.
//!
//! # Was „Kontakte“ heisst
//!
//! Ein Adressbuch gibt es nicht. Kontakt ist, wer mit mir mindestens einen
//! Chat teilt – dieselbe Menge, an die schon Präsenz und Profiländerungen
//! gingen (`users::contacts_of`).
//!
//! # Gegenseitig
//!
//! Lesebestätigungen und Tipp-Anzeige sind gegenseitig wie bei WhatsApp: Wer
//! sie ausschaltet, verschickt keine und bekommt auch die der anderen nicht.
//! Sonst wäre das Ausschalten ein Weg, andere zu beobachten, ohne selbst
//! beobachtbar zu sein. Lesebestätigungen gelten dabei nur im Direktchat –
//! in Gruppen bleiben sie, wie bei WhatsApp, für alle sichtbar (eine Gruppe
//! ist ein gemeinsamer Raum; „wer hat es gelesen“ ist dort Organisation, nicht
//! Überwachung). „Zuletzt online“ ist dagegen NICHT gegenseitig: Wer es
//! verbirgt, sieht das der anderen weiter. Das ist schlichter und verrät
//! nichts, was der andere nicht freigegeben hat.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::UserDto;
use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sichtbarkeit {
    Alle,
    Kontakte,
    Niemand,
}

impl Sichtbarkeit {
    fn aus(wert: Option<&Value>) -> Self {
        match wert.and_then(Value::as_str) {
            Some("niemand") => Self::Niemand,
            Some("kontakte") => Self::Kontakte,
            // Fehlt die Angabe oder ist sie kaputt, gilt die Voreinstellung –
            // dieselbe wie in `users::merge_settings`.
            _ => Self::Alle,
        }
    }

    /// Darf ein Betrachter, der (k)ein Kontakt ist, das sehen?
    pub fn erlaubt(self, kontakt: bool) -> bool {
        match self {
            Self::Alle => true,
            Self::Kontakte => kontakt,
            Self::Niemand => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Privatsphaere {
    pub zuletzt_online: Sichtbarkeit,
    pub online: Sichtbarkeit,
    pub lesebestaetigungen: bool,
    pub tippen: bool,
}

impl Default for Privatsphaere {
    fn default() -> Self {
        Self {
            zuletzt_online: Sichtbarkeit::Alle,
            online: Sichtbarkeit::Alle,
            lesebestaetigungen: true,
            tippen: true,
        }
    }
}

impl Privatsphaere {
    /// Aus `users.settings` – fehlende Schalter gelten als an.
    pub fn aus_einstellungen(settings: &Value) -> Self {
        let p = settings.get("privacy");
        let schalter = |name: &str| {
            p.and_then(|p| p.get(name))
                .and_then(Value::as_bool)
                .unwrap_or(true)
        };
        Self {
            zuletzt_online: Sichtbarkeit::aus(p.and_then(|p| p.get("lastSeen"))),
            online: Sichtbarkeit::aus(p.and_then(|p| p.get("online"))),
            lesebestaetigungen: schalter("readReceipts"),
            tippen: schalter("typing"),
        }
    }
}

/// Die Einstellungen dieser Personen. Wer fehlt (gelöscht), hat die
/// Voreinstellung.
pub async fn laden<'e, E>(executor: E, ids: &[Uuid]) -> AppResult<HashMap<Uuid, Privatsphaere>>
where
    E: sqlx::PgExecutor<'e>,
{
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let zeilen: Vec<(Uuid, Value)> =
        sqlx::query_as("select id, settings from users where id = any($1)")
            .bind(ids)
            .fetch_all(executor)
            .await?;
    Ok(zeilen
        .into_iter()
        .map(|(id, settings)| (id, Privatsphaere::aus_einstellungen(&settings)))
        .collect())
}

pub async fn von(pool: &PgPool, id: Uuid) -> AppResult<Privatsphaere> {
    Ok(laden(pool, &[id]).await?.remove(&id).unwrap_or_default())
}

/// Sperren zwischen einer Person und anderen – in beide Richtungen.
#[derive(Debug, Default, Clone)]
pub struct Sperren {
    /// Die ich gesperrt habe.
    pub von_mir: HashSet<Uuid>,
    /// Die mich gesperrt haben.
    pub mich: HashSet<Uuid>,
}

impl Sperren {
    /// Gibt es zwischen mir und dieser Person eine Sperre, egal wer sie setzte?
    pub fn irgendeine(&self, andere: &Uuid) -> bool {
        self.von_mir.contains(andere) || self.mich.contains(andere)
    }
}

pub async fn sperren_von<'e, E>(executor: E, ich: Uuid, andere: &[Uuid]) -> AppResult<Sperren>
where
    E: sqlx::PgExecutor<'e>,
{
    if andere.is_empty() {
        return Ok(Sperren::default());
    }
    let zeilen: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select blocker_id, blocked_id from user_blocks
          where (blocker_id = $1 and blocked_id = any($2))
             or (blocked_id = $1 and blocker_id = any($2))",
    )
    .bind(ich)
    .bind(andere)
    .fetch_all(executor)
    .await?;
    let mut sperren = Sperren::default();
    for (wer, wen) in zeilen {
        if wer == ich {
            sperren.von_mir.insert(wen);
        } else {
            sperren.mich.insert(wer);
        }
    }
    Ok(sperren)
}

/// Hat `wer` die Person `wen` gesperrt?
pub async fn hat_gesperrt<'e, E>(executor: E, wer: Uuid, wen: Uuid) -> AppResult<bool>
where
    E: sqlx::PgExecutor<'e>,
{
    Ok(sqlx::query_scalar(
        "select exists (select 1 from user_blocks where blocker_id = $1 and blocked_id = $2)",
    )
    .bind(wer)
    .bind(wen)
    .fetch_one(executor)
    .await?)
}

/// Welche dieser Personen teilen mit dem Betrachter mindestens einen Chat?
pub async fn kontakte_unter(
    pool: &PgPool,
    betrachter: Uuid,
    ids: &[Uuid],
) -> AppResult<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(sqlx::query_scalar::<_, Uuid>(
        "select distinct other.user_id
           from conversation_members mine
           join conversation_members other on other.conversation_id = mine.conversation_id
          where mine.user_id = $1 and other.user_id = any($2)",
    )
    .bind(betrachter)
    .bind(ids)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect())
}

/// Ein Profil so, wie es dieser Betrachter sehen darf.
///
/// Wer mich gesperrt hat, zeigt mir weder Bild noch „zuletzt online“ – und
/// auch kein „über mich“: Die Sperre soll sich anfühlen wie ein Konto ohne
/// Angaben, nicht wie eine Lücke, an der man die Sperre abliest.
pub fn maskieren(
    profil: &mut UserDto,
    einstellungen: &Privatsphaere,
    kontakt: bool,
    sperrt_mich: bool,
) {
    if sperrt_mich {
        profil.avatar_url = None;
        profil.last_seen_at = None;
        profil.bio = None;
        return;
    }
    if !einstellungen.zuletzt_online.erlaubt(kontakt) {
        profil.last_seen_at = None;
    }
}

/// Profile für einen Betrachter filtern. Das eigene bleibt, wie es ist.
///
/// `alle_kontakte`: Die Aufrufer aus einem Chat wissen schon, dass jeder in
/// der Liste Kontakt ist (er teilt ja diesen Chat), und sparen sich die
/// Abfrage.
pub async fn fuer_betrachter<'a>(
    pool: &PgPool,
    betrachter: Uuid,
    profile: impl IntoIterator<Item = &'a mut UserDto>,
    alle_kontakte: bool,
) -> AppResult<()> {
    let mut profile: Vec<&mut UserDto> = profile
        .into_iter()
        .filter(|profil| profil.id != betrachter)
        .collect();
    if profile.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = profile.iter().map(|profil| profil.id).collect();
    let einstellungen = laden(pool, &ids).await?;
    let sperren = sperren_von(pool, betrachter, &ids).await?;
    let kontakte = if alle_kontakte {
        ids.iter().copied().collect()
    } else {
        kontakte_unter(pool, betrachter, &ids).await?
    };
    for profil in profile.iter_mut() {
        let id = profil.id;
        maskieren(
            profil,
            &einstellungen.get(&id).copied().unwrap_or_default(),
            kontakte.contains(&id),
            sperren.mich.contains(&id),
        );
    }
    Ok(())
}

/// Wer bekommt „X tippt …“?
///
/// Niemand, wenn X die Tipp-Anzeige aus hat. Sonst alle, die sie selbst an
/// haben (gegenseitig) und mit X keine Sperre teilen.
pub async fn tipp_empfaenger(
    pool: &PgPool,
    tippt: Uuid,
    empfaenger: Vec<Uuid>,
) -> AppResult<Vec<Uuid>> {
    if empfaenger.is_empty() {
        return Ok(empfaenger);
    }
    let mut alle = empfaenger.clone();
    alle.push(tippt);
    let einstellungen = laden(pool, &alle).await?;
    let an = |id: &Uuid| einstellungen.get(id).copied().unwrap_or_default().tippen;
    if !an(&tippt) {
        return Ok(Vec::new());
    }
    let sperren = sperren_von(pool, tippt, &empfaenger).await?;
    Ok(empfaenger
        .into_iter()
        .filter(|id| an(id) && !sperren.irgendeine(id))
        .collect())
}

/// Präsenz an die Kontakte – jeder bekommt, was ihm zusteht.
///
/// * „Online“ verborgen: Wer es nicht sehen darf, bekommt das Kommen gar
///   nicht gemeldet, das Gehen aber schon – als Zeitpunkt „zuletzt online“,
///   falls der erlaubt ist, sonst gar nicht.
/// * „Zuletzt online“ verborgen: `lastSeenAt` ist `null`.
/// * Eine Sperre in irgendeiner Richtung: nichts.
///
/// Empfänger sind Kontakte (sie teilen einen Chat), also gilt „kontakte“ hier
/// wie „alle“.
pub async fn praesenz_melden(
    state: &crate::state::AppState,
    person: Uuid,
    online: bool,
    kontakte: Vec<Uuid>,
) -> AppResult<()> {
    let einstellungen = von(&state.pool, person).await?;
    let sperren = sperren_von(&state.pool, person, &kontakte).await?;
    let empfaenger: Vec<Uuid> = kontakte
        .into_iter()
        .filter(|id| !sperren.irgendeine(id))
        .collect();
    let zuletzt = einstellungen.zuletzt_online.erlaubt(true);
    let online_sichtbar = einstellungen.online.erlaubt(true);
    if empfaenger.is_empty() || (online && !online_sichtbar) || (!online_sichtbar && !zuletzt) {
        return Ok(());
    }
    let jetzt = chrono::Utc::now().to_rfc3339();
    let ereignis = crate::realtime::Event::new(
        "presence",
        serde_json::json!({
            "userId": person,
            // Wer „online“ verbirgt, ist für die anderen nie online – auch
            // nicht im Augenblick des Gehens.
            "online": online && online_sichtbar,
            "lastSeenAt": if zuletzt { Some(jetzt) } else { None },
        }),
    );
    state.hub.publish(empfaenger, ereignis).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profil() -> UserDto {
        UserDto {
            id: Uuid::from_u128(1),
            username: "a".into(),
            display_name: "A".into(),
            avatar_url: Some("/bild".into()),
            bio: Some("hallo".into()),
            accent: "#000".into(),
            last_seen_at: Some(chrono::Utc::now()),
            created_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn ohne_angaben_ist_alles_offen() {
        let p = Privatsphaere::aus_einstellungen(&json!({}));
        assert_eq!(p, Privatsphaere::default());
    }

    #[test]
    fn die_schalter_werden_gelesen() {
        let p = Privatsphaere::aus_einstellungen(&json!({
            "privacy": { "lastSeen": "kontakte", "online": "niemand",
                         "readReceipts": false, "typing": false }
        }));
        assert_eq!(p.zuletzt_online, Sichtbarkeit::Kontakte);
        assert_eq!(p.online, Sichtbarkeit::Niemand);
        assert!(!p.lesebestaetigungen);
        assert!(!p.tippen);
    }

    #[test]
    fn zuletzt_online_nur_fuer_kontakte() {
        let p = Privatsphaere {
            zuletzt_online: Sichtbarkeit::Kontakte,
            ..Privatsphaere::default()
        };
        let mut fremd = profil();
        maskieren(&mut fremd, &p, false, false);
        assert!(fremd.last_seen_at.is_none());
        assert!(fremd.avatar_url.is_some(), "das Bild bleibt");
        let mut kontakt = profil();
        maskieren(&mut kontakt, &p, true, false);
        assert!(kontakt.last_seen_at.is_some());
    }

    #[test]
    fn wer_mich_sperrt_zeigt_mir_nichts() {
        let mut gesperrt = profil();
        maskieren(&mut gesperrt, &Privatsphaere::default(), true, true);
        assert!(gesperrt.avatar_url.is_none());
        assert!(gesperrt.last_seen_at.is_none());
        assert!(gesperrt.bio.is_none());
        assert_eq!(gesperrt.display_name, "A", "der Name bleibt");
    }
}
