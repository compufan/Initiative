//! Push notifications for chat activity.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::constants::{message_preview, truncate};
use crate::db::EventPlacementRow;
use crate::dto::{CalendarEventDto, MessageDto, PushPayload};
use crate::state::AppState;

#[derive(sqlx::FromRow)]
struct NotificationTarget {
    id: Uuid,
    settings: serde_json::Value,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Push notification for a freshly created message.
pub async fn notify_new_message(state: &AppState, message: &MessageDto, member_ids: &[Uuid]) {
    if !state.push.enabled() {
        return;
    }
    let recipients: Vec<Uuid> = member_ids
        .iter()
        .copied()
        .filter(|id| Some(*id) != message.sender_id)
        .collect();
    if recipients.is_empty() {
        return;
    }

    let targets = match sqlx::query_as::<_, NotificationTarget>(
        "select u.id, u.settings, cm.muted_until
         from users u
         join conversation_members cm on cm.user_id = u.id and cm.conversation_id = $1
         where u.id = any($2)",
    )
    .bind(message.conversation_id)
    .bind(&recipients)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "loading notification targets failed");
            return;
        }
    };

    let now = chrono::Utc::now();
    let mut with_preview: Vec<Uuid> = Vec::new();
    let mut without_preview: Vec<Uuid> = Vec::new();

    for target in targets {
        if target.muted_until.is_some_and(|until| until > now) {
            continue;
        }
        let (push_enabled, previews) = benachrichtigungen(&target.settings);
        if !push_enabled {
            continue;
        }
        if previews {
            with_preview.push(target.id);
        } else {
            without_preview.push(target.id);
        }
    }

    if with_preview.is_empty() && without_preview.is_empty() {
        return;
    }

    let sender_name = match message.sender_id {
        Some(sender_id) => {
            sqlx::query_as::<_, (String,)>("select display_name from users where id = $1")
                .bind(sender_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten()
                .map(|(name,)| name)
                .unwrap_or_else(|| "Initiative".to_string())
        }
        None => "Initiative".to_string(),
    };

    let conversation = sqlx::query_as::<_, (Option<String>, String)>(
        "select title, type from conversations where id = $1",
    )
    .bind(message.conversation_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let title = match conversation {
        Some((Some(chat_title), kind)) if kind == "group" => {
            format!("{sender_name} · {chat_title}")
        }
        _ => sender_name,
    };

    let preview = truncate(
        &message_preview(
            &message.r#type,
            message.body.as_deref(),
            message.deleted_at.is_some(),
        ),
        140,
    );

    if !with_preview.is_empty() {
        let payload = PushPayload {
            title: title.clone(),
            body: preview,
            tag: Some(format!("conversation:{}", message.conversation_id)),
            url: format!("/chats/{}", message.conversation_id),
            conversation_id: Some(message.conversation_id),
            message_id: Some(message.id),
            kind: "message".to_string(),
        };
        state
            .push
            .send_to_users(&state.pool, &with_preview, &payload)
            .await;
    }

    if !without_preview.is_empty() {
        let payload = PushPayload {
            title: "Initiative".to_string(),
            body: "Neue Nachricht".to_string(),
            tag: Some(format!("conversation:{}", message.conversation_id)),
            url: format!("/chats/{}", message.conversation_id),
            conversation_id: Some(message.conversation_id),
            message_id: None,
            kind: "message".to_string(),
        };
        state
            .push
            .send_to_users(&state.pool, &without_preview, &payload)
            .await;
    }
}

/// Generic helper for modules (your turn, poll closed, event reminder …).
pub async fn notify_users(state: &AppState, user_ids: &[Uuid], payload: &PushPayload) {
    if !state.push.enabled() || user_ids.is_empty() {
        return;
    }
    state
        .push
        .send_to_users(&state.pool, user_ids, payload)
        .await;
}

/// Was jemand für Mitteilungen eingestellt hat: (Push an, Vorschau an).
/// Beides ist ohne Angabe an.
fn benachrichtigungen(settings: &serde_json::Value) -> (bool, bool) {
    let settings = super::users::merge_settings(settings);
    let notifications = settings.get("notifications");
    let schalter = |name: &str| {
        notifications
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
    };
    (schalter("push"), schalter("previews"))
}

/* ---------- Termine --------------------------------------------------------- */

/// Welcher Chat trägt die Einladungs-Mitteilung einer Person?
///
/// Der Einzelchat, sonst der erste Gruppenchat mit Karte – aber nie einer,
/// den die Person stummgeschaltet hat. Sind alle stumm, kommt keine:
/// Wer alles stummgeschaltet hat, will es so, und die Einladung steht trotzdem
/// in der Karte und im Kalender.
///
/// Rein, damit sich die Auswahl ohne Push-Dienst prüfen lässt.
pub fn push_ziel(einzel: Option<Uuid>, gruppen: &[Uuid], stumm: &HashSet<Uuid>) -> Option<Uuid> {
    einzel
        .into_iter()
        .chain(gruppen.iter().copied())
        .find(|chat| !stumm.contains(chat))
}

#[derive(sqlx::FromRow)]
struct PersonEinstellung {
    id: Uuid,
    settings: serde_json::Value,
    conversation_id: Option<Uuid>,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Schickt die Einladungs-Mitteilung: genau **eine** je Person, gleich in wie
/// vielen Chats ihre Karte steht.
///
/// Die Doppelung im Bestand kam daher, dass jede Karte eine eigene Nachricht
/// ist und `create_message` für jede benachrichtigt – mit Kennzeichen je Chat,
/// also zwei Mitteilungen auf dem Gerät. Darum sind Einladungskarten stumm
/// (`NewMessage::einladung`), und hier wird einmal gewählt, über welchen Chat
/// die Person angesprochen wird (`push_ziel`).
///
/// `personen`: wer eingeladen wurde (nicht der Ersteller). `karten`: die
/// Karten, die dabei zugestellt wurden, mit Nachricht. Wer keine Karte hat,
/// bekommt keine Einladungs-Mitteilung – er findet den Termin im Kalender.
///
/// Liefert, wie vielen Personen eine Mitteilung ging. Ist der Push nicht
/// eingerichtet, ist das null; gesendet wird im Hintergrund, die Anfrage wartet
/// nicht darauf.
pub async fn benachrichtige_einladung(
    state: &AppState,
    termin: &CalendarEventDto,
    absender: Uuid,
    personen: &[Uuid],
    karten: &[EventPlacementRow],
) -> usize {
    if !state.push.enabled() || personen.is_empty() || karten.is_empty() {
        return 0;
    }

    // Je Person die Kandidaten: erst der Einzelchat, dann die Gruppenchats mit
    // Karte, in der Reihenfolge, in der sie zugestellt wurden.
    let gruppen: Vec<Uuid> = karten
        .iter()
        .filter(|karte| karte.art == "gruppe")
        .map(|karte| karte.conversation_id)
        .collect();
    let mut in_gruppen: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    if !gruppen.is_empty() {
        match sqlx::query_as::<_, (Uuid, Uuid)>(
            "select conversation_id, user_id from conversation_members
              where conversation_id = any($1) and user_id = any($2)",
        )
        .bind(&gruppen)
        .bind(personen)
        .fetch_all(&state.pool)
        .await
        {
            Ok(zeilen) => {
                for (chat, person) in zeilen {
                    in_gruppen.entry(person).or_default().insert(chat);
                }
            }
            Err(fehler) => {
                tracing::warn!(%fehler, "Gruppenmitglieder für die Einladung nicht geladen");
                return 0;
            }
        }
    }
    let einzel_von: HashMap<Uuid, Uuid> = karten
        .iter()
        .filter(|karte| karte.art == "einzel")
        .filter_map(|karte| karte.user_id.map(|person| (person, karte.conversation_id)))
        .collect();
    let nachricht_in: HashMap<Uuid, Uuid> = karten
        .iter()
        .filter_map(|karte| karte.message_id.map(|id| (karte.conversation_id, id)))
        .collect();

    let alle_chats: Vec<Uuid> = karten.iter().map(|karte| karte.conversation_id).collect();
    let zeilen = match sqlx::query_as::<_, PersonEinstellung>(
        "select u.id, u.settings, cm.conversation_id, cm.muted_until
           from users u
           left join conversation_members cm
             on cm.user_id = u.id and cm.conversation_id = any($2)
          where u.id = any($1)",
    )
    .bind(personen)
    .bind(&alle_chats)
    .fetch_all(&state.pool)
    .await
    {
        Ok(zeilen) => zeilen,
        Err(fehler) => {
            tracing::warn!(%fehler, "Empfänger der Einladung nicht geladen");
            return 0;
        }
    };

    let jetzt = chrono::Utc::now();
    let mut einstellung: HashMap<Uuid, (bool, bool)> = HashMap::new();
    let mut stumm: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    for zeile in &zeilen {
        einstellung
            .entry(zeile.id)
            .or_insert_with(|| benachrichtigungen(&zeile.settings));
        if let (Some(chat), Some(bis)) = (zeile.conversation_id, zeile.muted_until) {
            if bis > jetzt {
                stumm.entry(zeile.id).or_default().insert(chat);
            }
        }
    }

    let name = anzeigename(state, absender).await;
    let leer = HashSet::new();
    let mut ziele: Vec<(Vec<Uuid>, PushPayload)> = Vec::new();
    let mut angesprochen = 0usize;
    for person in personen {
        let Some((push_an, vorschau)) = einstellung.get(person).copied() else {
            continue;
        };
        if !push_an {
            continue;
        }
        let gruppenchats: Vec<Uuid> = gruppen
            .iter()
            .copied()
            .filter(|chat| {
                in_gruppen
                    .get(person)
                    .is_some_and(|dabei| dabei.contains(chat))
            })
            .collect();
        let Some(chat) = push_ziel(
            einzel_von.get(person).copied(),
            &gruppenchats,
            stumm.get(person).unwrap_or(&leer),
        ) else {
            continue;
        };
        let (titel, text) = if vorschau {
            (
                name.clone(),
                truncate(&format!("📅 Einladung: {}", termin.title), 140),
            )
        } else {
            ("Initiative".to_string(), "Neue Einladung".to_string())
        };
        ziele.push((
            vec![*person],
            PushPayload {
                title: titel,
                body: text,
                tag: Some(format!("termin:{}", termin.id)),
                url: format!("/chats/{chat}"),
                conversation_id: Some(chat),
                message_id: nachricht_in.get(&chat).copied(),
                kind: "event".to_string(),
            },
        ));
        angesprochen += 1;
    }

    if !ziele.is_empty() {
        state.push.im_hintergrund(state.pool.clone(), ziele);
    }
    angesprochen
}

/// Was an einem Termin geschehen ist, das die Eingeladenen angeht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminAnlass {
    Geaendert(Aenderung),
    Abgesagt,
    Geloescht,
}

/// Was an Zeit und Ort geändert wurde.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aenderung {
    Zeit,
    Ort,
    ZeitUndOrt,
}

impl Aenderung {
    pub fn text(self) -> &'static str {
        match self {
            Aenderung::Zeit => "Zeit geändert",
            Aenderung::Ort => "Ort geändert",
            Aenderung::ZeitUndOrt => "Zeit und Ort geändert",
        }
    }
}

/// Mitteilung über eine Änderung, Absage oder Löschung – an die, die es angeht.
///
/// Anders als die Einladung läuft sie nicht über einen Chat: Es gibt keine
/// Karte, auf die sie zeigt, also zählt keine Stummschaltung eines Chats, nur
/// die Einstellung der Person. Der Text kennt keine Uhrzeit – der Server kennt
/// keine Zeitzone, und die Karte formatiert im Gerät.
///
/// Das gleiche `tag` ersetzt eine frühere Mitteilung zum selben Termin: Eine
/// Änderung verdrängt die Einladung, statt sich zu stapeln.
///
/// Liefert, wie vielen Personen eine Mitteilung ging.
pub async fn benachrichtige_termin(
    state: &AppState,
    termin: &CalendarEventDto,
    ausloeser: Uuid,
    anlass: TerminAnlass,
    empfaenger: &[Uuid],
) -> usize {
    if !state.push.enabled() || empfaenger.is_empty() {
        return 0;
    }
    let zeilen = match sqlx::query_as::<_, (Uuid, serde_json::Value)>(
        "select id, settings from users where id = any($1)",
    )
    .bind(empfaenger)
    .fetch_all(&state.pool)
    .await
    {
        Ok(zeilen) => zeilen,
        Err(fehler) => {
            tracing::warn!(%fehler, "Empfänger der Terminmitteilung nicht geladen");
            return 0;
        }
    };

    let name = anzeigename(state, ausloeser).await;
    let (text, url) = match anlass {
        TerminAnlass::Geaendert(aenderung) => (
            format!("📅 {} – {}", termin.title, aenderung.text()),
            format!("/kalender/termin/{}", termin.id),
        ),
        TerminAnlass::Abgesagt => (
            format!("📅 Abgesagt: {}", termin.title),
            format!("/kalender/termin/{}", termin.id),
        ),
        TerminAnlass::Geloescht => (
            format!("📅 Entfällt: {}", termin.title),
            "/kalender".to_string(),
        ),
    };
    // Ohne Vorschau steht nur, dass sich etwas getan hat – nicht was.
    let ohne_vorschau = "Terminänderung";

    let mut ziele: Vec<(Vec<Uuid>, PushPayload)> = Vec::new();
    let mut angesprochen = 0usize;
    for (person, settings) in zeilen {
        let (push_an, vorschau) = benachrichtigungen(&settings);
        if !push_an {
            continue;
        }
        let (titel, body) = if vorschau {
            (name.clone(), truncate(&text, 140))
        } else {
            ("Initiative".to_string(), ohne_vorschau.to_string())
        };
        ziele.push((
            vec![person],
            PushPayload {
                title: titel,
                body,
                tag: Some(format!("termin:{}", termin.id)),
                url: url.clone(),
                conversation_id: None,
                message_id: None,
                kind: "event".to_string(),
            },
        ));
        angesprochen += 1;
    }
    if !ziele.is_empty() {
        state.push.im_hintergrund(state.pool.clone(), ziele);
    }
    angesprochen
}

/// Eine Erinnerung, die zugestellt wurde – und an wen eine Mitteilung gehen soll.
#[derive(Debug, Clone)]
pub struct Erinnert {
    pub termin_id: Uuid,
    pub titel: String,
    pub person: Uuid,
    /// Der Einzelchat, in dem die Erinnerung steht.
    pub chat: Uuid,
    /// Die Karte der Erinnerung.
    pub nachricht: Uuid,
}

/// Was an eine erinnerte Person geht – oder nichts.
///
/// Rein, damit sich Auswahl und Wortlaut ohne Push-Dienst prüfen lassen. Es
/// gelten die Einstellungen der Person wie überall: Push aus oder der Einzelchat
/// stummgeschaltet heisst keine Mitteilung (die Karte steht trotzdem im Chat),
/// ohne Vorschau steht weder Termin noch Ersteller darin.
///
/// Titel „Initiative“ und nicht der Name des Erstellers: Die Mitteilung kommt von
/// der App, nicht von einer Person – eine automatische Mitteilung soll kein
/// Gesicht tragen. Das `tag` ist das der Einladung: Auf dem Gerät steht höchstens
/// **eine** Mitteilung je Termin, die aber erneut klingelt.
pub fn erinnerung_mitteilung(
    erinnert: &Erinnert,
    push_an: bool,
    vorschau: bool,
    stumm: bool,
) -> Option<PushPayload> {
    if !push_an || stumm {
        return None;
    }
    let text = if vorschau {
        truncate(&super::erinnern::erinnerungstext(&erinnert.titel), 140)
    } else {
        "Erinnerung an einen Termin".to_string()
    };
    Some(PushPayload {
        title: "Initiative".to_string(),
        body: text,
        tag: Some(format!("termin:{}", erinnert.termin_id)),
        url: format!("/chats/{}", erinnert.chat),
        conversation_id: Some(erinnert.chat),
        message_id: Some(erinnert.nachricht),
        kind: "event".to_string(),
    })
}

/// Schickt die Mitteilungen zu den Erinnerungen eines Durchgangs: **eine** je
/// Erinnerung, mit **einer** Abfrage für alle Personen.
///
/// Die Karte ist stumm angelegt (`NewMessage::erinnerung`), sonst käme
/// `notify_new_message` mit „📅 Termin“ und dem Kennzeichen des Chats dazu.
///
/// Liefert, wie vielen Erinnerungen eine Mitteilung folgt. Ist der Push nicht
/// eingerichtet, ist das null; gesendet wird im Hintergrund.
pub async fn benachrichtige_erinnerungen(state: &AppState, erinnert: &[Erinnert]) -> usize {
    if !state.push.enabled() || erinnert.is_empty() {
        return 0;
    }
    let personen: Vec<Uuid> = erinnert.iter().map(|eintrag| eintrag.person).collect();
    let chats: Vec<Uuid> = erinnert.iter().map(|eintrag| eintrag.chat).collect();
    let zeilen = match sqlx::query_as::<_, PersonEinstellung>(
        "select u.id, u.settings, cm.conversation_id, cm.muted_until
           from users u
           left join conversation_members cm
             on cm.user_id = u.id and cm.conversation_id = any($2)
          where u.id = any($1)",
    )
    .bind(&personen)
    .bind(&chats)
    .fetch_all(&state.pool)
    .await
    {
        Ok(zeilen) => zeilen,
        Err(fehler) => {
            tracing::warn!(%fehler, "Empfänger der Erinnerungen nicht geladen");
            return 0;
        }
    };

    let jetzt = chrono::Utc::now();
    let mut einstellung: HashMap<Uuid, (bool, bool)> = HashMap::new();
    let mut stumm: HashSet<(Uuid, Uuid)> = HashSet::new();
    for zeile in &zeilen {
        einstellung
            .entry(zeile.id)
            .or_insert_with(|| benachrichtigungen(&zeile.settings));
        if let (Some(chat), Some(bis)) = (zeile.conversation_id, zeile.muted_until) {
            if bis > jetzt {
                stumm.insert((zeile.id, chat));
            }
        }
    }

    let ziele: Vec<(Vec<Uuid>, PushPayload)> = erinnert
        .iter()
        .filter_map(|eintrag| {
            let (push_an, vorschau) = einstellung.get(&eintrag.person).copied()?;
            let ist_stumm = stumm.contains(&(eintrag.person, eintrag.chat));
            erinnerung_mitteilung(eintrag, push_an, vorschau, ist_stumm)
                .map(|payload| (vec![eintrag.person], payload))
        })
        .collect();
    let angesprochen = ziele.len();
    if !ziele.is_empty() {
        state.push.im_hintergrund(state.pool.clone(), ziele);
    }
    angesprochen
}

async fn anzeigename(state: &AppState, person: Uuid) -> String {
    sqlx::query_as::<_, (String,)>("select display_name from users where id = $1")
        .bind(person)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .map(|(name,)| name)
        .unwrap_or_else(|| "Initiative".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(nummer: u128) -> Uuid {
        Uuid::from_u128(nummer)
    }

    fn stumm(chats: &[u128]) -> HashSet<Uuid> {
        chats.iter().map(|nummer| chat(*nummer)).collect()
    }

    #[test]
    fn der_einzelchat_geht_vor_der_gruppe() {
        let ziel = push_ziel(Some(chat(1)), &[chat(2), chat(3)], &stumm(&[]));
        assert_eq!(ziel, Some(chat(1)));
    }

    #[test]
    fn ein_stummer_einzelchat_weicht_auf_die_gruppe_aus() {
        let ziel = push_ziel(Some(chat(1)), &[chat(2), chat(3)], &stumm(&[1]));
        assert_eq!(ziel, Some(chat(2)));
    }

    #[test]
    fn sind_alle_stumm_kommt_keine_mitteilung() {
        let ziel = push_ziel(Some(chat(1)), &[chat(2)], &stumm(&[1, 2]));
        assert_eq!(ziel, None);
    }

    #[test]
    fn ohne_einzelchat_zaehlt_die_erste_nicht_stumme_gruppe_in_auswahlreihenfolge() {
        let ziel = push_ziel(None, &[chat(5), chat(4), chat(6)], &stumm(&[5]));
        assert_eq!(ziel, Some(chat(4)));
    }

    #[test]
    fn ohne_jede_karte_kommt_keine_mitteilung() {
        assert_eq!(push_ziel(None, &[], &stumm(&[])), None);
    }

    #[test]
    fn die_einstellungen_gelten_ohne_angabe_als_an() {
        assert_eq!(benachrichtigungen(&serde_json::json!({})), (true, true));
        assert_eq!(
            benachrichtigungen(&serde_json::json!({
                "notifications": { "push": false, "previews": false }
            })),
            (false, false)
        );
    }

    fn erinnert() -> Erinnert {
        Erinnert {
            termin_id: chat(7),
            titel: "Grillen".to_string(),
            person: chat(2),
            chat: chat(3),
            nachricht: chat(4),
        }
    }

    #[test]
    fn die_erinnerung_zeigt_mit_vorschau_den_termin_und_nennt_nie_einen_namen() {
        let payload = erinnerung_mitteilung(&erinnert(), true, true, false).expect("Mitteilung");
        assert_eq!(payload.title, "Initiative");
        assert_eq!(
            payload.body,
            "Erinnerung: Du hast noch nicht auf „Grillen“ geantwortet."
        );
        assert_eq!(payload.kind, "event");
        assert_eq!(payload.tag, Some(format!("termin:{}", chat(7))));
        assert_eq!(payload.url, format!("/chats/{}", chat(3)));
        assert_eq!(payload.conversation_id, Some(chat(3)));
        assert_eq!(payload.message_id, Some(chat(4)));
    }

    #[test]
    fn ohne_vorschau_steht_weder_termin_noch_titel_darin() {
        let payload = erinnerung_mitteilung(&erinnert(), true, false, false).expect("Mitteilung");
        assert_eq!(payload.body, "Erinnerung an einen Termin");
        assert!(!payload.body.contains("Grillen"));
        assert_eq!(payload.title, "Initiative");
    }

    #[test]
    fn push_aus_oder_ein_stummer_chat_heisst_keine_mitteilung() {
        assert!(erinnerung_mitteilung(&erinnert(), false, true, false).is_none());
        assert!(erinnerung_mitteilung(&erinnert(), true, true, true).is_none());
    }

    #[test]
    fn ein_langer_titel_wird_gekuerzt() {
        let mut lang = erinnert();
        lang.titel = "x".repeat(300);
        let payload = erinnerung_mitteilung(&lang, true, true, false).expect("Mitteilung");
        assert_eq!(payload.body.chars().count(), 140);
        assert!(payload.body.ends_with('…'));
    }

    #[test]
    fn die_aenderungstexte() {
        assert_eq!(Aenderung::Zeit.text(), "Zeit geändert");
        assert_eq!(Aenderung::Ort.text(), "Ort geändert");
        assert_eq!(Aenderung::ZeitUndOrt.text(), "Zeit und Ort geändert");
    }
}
