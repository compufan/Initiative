//! „Bierjunge“ und „hängt“: ein Wort im Chat startet ein Pressen-Spiel.
//!
//! Schreibt jemand „Bierjunge“ in einen Chat, merkt sich der Server den Aufruf.
//! Antwortet ein anderes Mitglied innerhalb von zehn Minuten mit „hängt“, legt
//! er die Pressen-Partie an: Ausrufer gegen den Antwortenden, im selben Chat,
//! als ganz normale Spielkarte (`services::games::create_session`). Die
//! auslösenden Nachrichten bleiben normale Nachrichten.
//!
//! # Wer darf antworten
//!
//!   * **Einzelchat und Gruppe ohne Namen**: das erste „hängt“ eines anderen
//!     Mitglieds. Damit ist der Aufruf verbraucht.
//!   * **Gruppe mit Namen** („Bierjunge Max“): nur das „hängt“ des Genannten.
//!     Erkannt werden Benutzername, voller Anzeigename, einzelne Wörter des
//!     Anzeigenamens und der Spitzname im Chat, mit oder ohne `@`, ohne auf
//!     Groß-/Kleinschreibung zu achten. Passt dasselbe Wort auf mehrere
//!     Mitglieder (zwei „Max“), gilt der Aufruf als namenlos – lieber zu
//!     großzügig als eine Person auszuschließen, die gemeint war. Der volle Name
//!     oder der Benutzername gewinnt immer gegen ein bloßes Namenswort.
//!   * **„Generalbierjunge“**: jedes andere Mitglied, je Mitglied einmal. Der
//!     Aufruf bleibt bis zum Ablauf offen.
//!
//! # Was nicht zählt
//!
//! Der Ausrufer selbst, Nichtmitglieder, ein Aufruf älter als zehn Minuten
//! (gerechnet von der Zeit seiner Nachricht bis zur Zeit des „hängt“), ein
//! gelöschter Aufruf und eine zweite Antwort derselben Person auf denselben
//! Aufruf.
//!
//! # Gleichzeitige „hängt“
//!
//! Bei einem normalen Aufruf darf nur ein „hängt“ ein Spiel starten. Das
//! entscheidet ein einziges `update … where verbraucht_am is null`: Wer es
//! gewinnt, legt die Partie an, wer verliert, räumt seine Antwort wieder weg.
//! Schlägt das Anlegen fehl, wird der Aufruf wieder freigegeben.
//!
//! Die Verarbeitung ist ein Zusatz zum Senden: Ein Fehler hier wird nur
//! protokolliert und verhindert nie, dass die Nachricht ankommt.

use std::future::Future;
use std::pin::Pin;

use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::dto::MessageDto;
use crate::error::AppResult;
use crate::state::AppState;

/// So lange gilt ein Aufruf (ab der Zeit seiner Nachricht).
pub const FRIST_MINUTEN: i64 = 10;
/// Aufgeräumt wird, was älter ist als das – die Frist ist dann längst um.
const AUFBEWAHREN_STUNDEN: i64 = 24;

/// Welche Art Aufruf eine Nachricht enthält.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Art {
    Normal,
    General,
}

impl Art {
    fn als_text(self) -> &'static str {
        match self {
            Art::Normal => "normal",
            Art::General => "general",
        }
    }
}

/// Ein Mitglied des Chats, wie es für die Namenssuche gebraucht wird.
#[derive(Debug, Clone, FromRow)]
pub struct Mitglied {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub nickname: Option<String>,
}

/* ---------- reine Erkennung ---------- */

/// Zerlegt Text in kleingeschriebene Wörter; alles, was kein Buchstabe oder
/// keine Ziffer ist, trennt (also auch `@`, Satzzeichen und Unterstriche).
pub fn woerter(text: &str) -> Vec<String> {
    text.split(|zeichen: char| !zeichen.is_alphanumeric())
        .filter(|wort| !wort.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Enthält der Text einen Aufruf? „Generalbierjunge“ geht „Bierjunge“ vor.
/// Es zählen nur ganze Wörter: „Bierjungenstreich“ ist keiner.
pub fn ruf_art(woerter: &[String]) -> Option<Art> {
    if woerter.iter().any(|w| w == "generalbierjunge") {
        Some(Art::General)
    } else if woerter.iter().any(|w| w == "bierjunge") {
        Some(Art::Normal)
    } else {
        None
    }
}

/// Enthält der Text ein „hängt“ (auch ohne Umlaut geschrieben)?
pub fn ist_haengt(woerter: &[String]) -> bool {
    woerter.iter().any(|w| w == "hängt" || w == "haengt")
}

/// Wen der Text meint, wenn er ein anderes Mitglied beim Namen nennt.
pub fn finde_ziel(
    text_woerter: &[String],
    ausrufer: Uuid,
    mitglieder: &[Mitglied],
) -> Option<Uuid> {
    // (Güte, Stelle) je Mitglied; größere Güte und frühere Stelle sind besser.
    let mut beste: Vec<(Uuid, u8, usize)> = Vec::new();
    for mitglied in mitglieder.iter().filter(|m| m.user_id != ausrufer) {
        let mut schluessel: Vec<(Vec<String>, u8)> = Vec::new();
        for ganzer_name in [
            Some(&mitglied.username),
            Some(&mitglied.display_name),
            mitglied.nickname.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            let teile = woerter(ganzer_name);
            if teile.concat().chars().count() >= 3 {
                schluessel.push((teile.clone(), 2));
            }
            // Einzelne Namenswörter nur beim Anzeige- und Spitznamen: Der
            // Benutzername ist meist ein Wort und steht schon oben.
            if ganzer_name != &mitglied.username {
                for teil in teile {
                    if teil.chars().count() >= 3 {
                        schluessel.push((vec![teil], 1));
                    }
                }
            }
        }
        let mut bestes: Option<(u8, usize)> = None;
        for (folge, guete) in &schluessel {
            if folge.is_empty() || folge.len() > text_woerter.len() {
                continue;
            }
            if let Some(stelle) = text_woerter
                .windows(folge.len())
                .position(|fenster| fenster == folge.as_slice())
            {
                let besser = match bestes {
                    None => true,
                    Some((g, s)) => *guete > g || (*guete == g && stelle < s),
                };
                if besser {
                    bestes = Some((*guete, stelle));
                }
            }
        }
        if let Some((guete, stelle)) = bestes {
            beste.push((mitglied.user_id, guete, stelle));
        }
    }
    let (_, top_guete, top_stelle) = beste
        .iter()
        .copied()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)))?;
    let gleichauf: Vec<&(Uuid, u8, usize)> = beste
        .iter()
        .filter(|(_, g, s)| *g == top_guete && *s == top_stelle)
        .collect();
    if gleichauf.len() == 1 {
        Some(gleichauf[0].0)
    } else {
        None
    }
}

/* ---------- Verarbeitung ---------- */

/// Wird von `create_message` nach dem Anlegen einer Nachricht aufgerufen.
/// Fehler werden nur protokolliert.
///
/// WARUM der Rückgabewert verpackt ist: Das Anlegen der Partie schreibt eine
/// Nachricht (die Spielkarte), und jede Nachricht ruft diese Funktion – ein
/// Kreis, den Rust bei `async fn` nur mit Umweg über `Box::pin` zulässt. Die
/// Karte ist keine Textnachricht und löst nichts aus; der Kreis dreht sich nie.
pub fn nach_nachricht<'a>(
    state: &'a AppState,
    nachricht: &'a MessageDto,
) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        if let Err(fehler) = verarbeiten(state, nachricht).await {
            tracing::warn!(?fehler, message_id = %nachricht.id, "Bierjunge-Auslöser fehlgeschlagen");
        }
    })
}

async fn verarbeiten(state: &AppState, nachricht: &MessageDto) -> AppResult<()> {
    if nachricht.r#type != "text" || nachricht.deleted_at.is_some() {
        return Ok(());
    }
    let (Some(sender), Some(text)) = (nachricht.sender_id, nachricht.body.as_deref()) else {
        return Ok(());
    };
    let text_woerter = woerter(text);
    let haengt = ist_haengt(&text_woerter);
    let art = ruf_art(&text_woerter);
    if !haengt && art.is_none() {
        return Ok(());
    }
    let mitglieder = mitglieder_von(&state.pool, nachricht.conversation_id).await?;
    // Nichtmitglieder lösen nie etwas aus (der Weg über die Oberfläche prüft
    // das schon; dieser Dienst verlässt sich nicht darauf).
    if !mitglieder.iter().any(|m| m.user_id == sender) {
        return Ok(());
    }
    if haengt {
        antworten(state, nachricht, sender).await?;
    }
    if let Some(art) = art {
        aufruf_anlegen(state, nachricht, sender, art, &text_woerter, &mitglieder).await?;
    }
    Ok(())
}

async fn mitglieder_von(pool: &PgPool, chat: Uuid) -> AppResult<Vec<Mitglied>> {
    Ok(sqlx::query_as::<_, Mitglied>(
        "select cm.user_id, u.username, u.display_name, cm.nickname
           from conversation_members cm
           join users u on u.id = cm.user_id
          where cm.conversation_id = $1
          order by cm.user_id",
    )
    .bind(chat)
    .fetch_all(pool)
    .await?)
}

async fn aufruf_anlegen(
    state: &AppState,
    nachricht: &MessageDto,
    ausrufer: Uuid,
    art: Art,
    text_woerter: &[String],
    mitglieder: &[Mitglied],
) -> AppResult<()> {
    // Aufräumen nebenbei: Aufrufe, deren Frist längst um ist, brauchen wir nicht mehr.
    sqlx::query(
        "delete from bierjunge_aufrufe where erstellt_am < now() - make_interval(hours => $1)",
    )
    .bind(AUFBEWAHREN_STUNDEN as i32)
    .execute(&state.pool)
    .await?;

    // Namen gelten nur im Gruppenchat und nur beim normalen Aufruf.
    let ziel = if art == Art::Normal && mitglieder.len() > 2 {
        finde_ziel(text_woerter, ausrufer, mitglieder)
    } else {
        None
    };
    sqlx::query(
        "insert into bierjunge_aufrufe
           (conversation_id, ausrufer_id, message_id, art, ziel_id, erstellt_am)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (message_id) do nothing",
    )
    .bind(nachricht.conversation_id)
    .bind(ausrufer)
    .bind(nachricht.id)
    .bind(art.als_text())
    .bind(ziel)
    .bind(nachricht.created_at)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[derive(Debug, FromRow)]
struct Kandidat {
    id: Uuid,
    ausrufer_id: Uuid,
    art: String,
}

async fn antworten(state: &AppState, nachricht: &MessageDto, antwortender: Uuid) -> AppResult<()> {
    // Alles, was dieses „hängt“ beantworten dürfte, ältester Aufruf zuerst.
    // Die Frist rechnet von der Zeit des Aufrufs bis zur Zeit dieser Nachricht.
    let kandidaten = sqlx::query_as::<_, Kandidat>(
        "select a.id, a.ausrufer_id, a.art
           from bierjunge_aufrufe a
           join messages m on m.id = a.message_id and m.deleted_at is null
           join conversation_members cm
             on cm.conversation_id = a.conversation_id and cm.user_id = a.ausrufer_id
          where a.conversation_id = $1
            and a.ausrufer_id <> $2
            and a.erstellt_am <= $3
            and a.erstellt_am >= $3 - make_interval(mins => $4)
            and (a.art = 'general'
                 or (a.verbraucht_am is null and (a.ziel_id is null or a.ziel_id = $2)))
            and not exists (select 1 from bierjunge_antworten r
                             where r.aufruf_id = a.id and r.user_id = $2)
          order by a.erstellt_am, a.id",
    )
    .bind(nachricht.conversation_id)
    .bind(antwortender)
    .bind(nachricht.created_at)
    .bind(FRIST_MINUTEN as i32)
    .fetch_all(&state.pool)
    .await?;

    for kandidat in kandidaten {
        // 1. Die Antwort buchen. Der Schlüssel (Aufruf, Person) lässt jede
        //    Person nur einmal antworten – auch bei zwei „hängt“ gleichzeitig.
        let gebucht = sqlx::query(
            "insert into bierjunge_antworten (aufruf_id, user_id, nachricht_id)
             values ($1, $2, $3)
             on conflict (aufruf_id, user_id) do nothing",
        )
        .bind(kandidat.id)
        .bind(antwortender)
        .bind(nachricht.id)
        .execute(&state.pool)
        .await?
        .rows_affected();
        if gebucht == 0 {
            continue;
        }
        // 2. Ein normaler Aufruf verbraucht sich: genau ein „hängt“ gewinnt.
        if kandidat.art == "normal" {
            let beansprucht = sqlx::query(
                "update bierjunge_aufrufe set verbraucht_am = now()
                  where id = $1 and verbraucht_am is null",
            )
            .bind(kandidat.id)
            .execute(&state.pool)
            .await?
            .rows_affected();
            if beansprucht == 0 {
                zuruecknehmen(&state.pool, kandidat.id, antwortender, false).await?;
                continue;
            }
        }
        // 3. Die Partie anlegen: Ausrufer gegen Antwortenden.
        match super::games::create_session(
            state,
            nachricht.conversation_id,
            "pressen",
            kandidat.ausrufer_id,
            &[antwortender],
        )
        .await
        {
            Ok(spiel) => {
                sqlx::query(
                    "update bierjunge_antworten set spiel_id = $3
                      where aufruf_id = $1 and user_id = $2",
                )
                .bind(kandidat.id)
                .bind(antwortender)
                .bind(spiel.id)
                .execute(&state.pool)
                .await?;
                // Ein „hängt“ startet höchstens ein Spiel.
                return Ok(());
            }
            Err(fehler) => {
                tracing::warn!(?fehler, "Pressen-Partie aus „hängt“ nicht angelegt");
                zuruecknehmen(
                    &state.pool,
                    kandidat.id,
                    antwortender,
                    kandidat.art == "normal",
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// Macht eine Antwort rückgängig (verlorenes Rennen, gescheitertes Anlegen).
async fn zuruecknehmen(
    pool: &PgPool,
    aufruf: Uuid,
    person: Uuid,
    aufruf_freigeben: bool,
) -> AppResult<()> {
    sqlx::query("delete from bierjunge_antworten where aufruf_id = $1 and user_id = $2")
        .bind(aufruf)
        .bind(person)
        .execute(pool)
        .await?;
    if aufruf_freigeben {
        sqlx::query("update bierjunge_aufrufe set verbraucht_am = null where id = $1")
            .bind(aufruf)
            .execute(pool)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mitglied(n: u128, benutzer: &str, anzeige: &str, spitz: Option<&str>) -> Mitglied {
        Mitglied {
            user_id: Uuid::from_u128(n),
            username: benutzer.into(),
            display_name: anzeige.into(),
            nickname: spitz.map(str::to_string),
        }
    }

    #[test]
    fn aufrufe_und_haengt_nur_als_ganze_woerter_und_ohne_grossschreibung() {
        assert_eq!(ruf_art(&woerter("Bierjunge!")), Some(Art::Normal));
        assert_eq!(ruf_art(&woerter("ey BIERJUNGE @max")), Some(Art::Normal));
        assert_eq!(ruf_art(&woerter("Generalbierjunge")), Some(Art::General));
        assert_eq!(
            ruf_art(&woerter("generalBierjunge und Bierjunge")),
            Some(Art::General)
        );
        assert_eq!(ruf_art(&woerter("Bierjungenstreich")), None);
        assert_eq!(ruf_art(&woerter("Bier Junge")), None);
        assert!(ist_haengt(&woerter("Hängt.")));
        assert!(ist_haengt(&woerter("ok, HÄNGT!")));
        assert!(ist_haengt(&woerter("haengt")));
        assert!(!ist_haengt(&woerter("aufgehängt")));
        assert!(!ist_haengt(&woerter("hängte")));
    }

    #[test]
    fn namen_werden_tolerant_erkannt() {
        let ich = Uuid::from_u128(1);
        let leute = [
            mitglied(1, "tim", "Tim Kasper", None),
            mitglied(2, "maxl", "Max Muster", None),
            mitglied(3, "lena_k", "Lena", Some("Lenchen")),
        ];
        let ziel = |text: &str| finde_ziel(&woerter(text), ich, &leute);
        assert_eq!(ziel("Bierjunge Max"), Some(Uuid::from_u128(2)));
        assert_eq!(ziel("bierjunge @MAXL"), Some(Uuid::from_u128(2)));
        assert_eq!(ziel("Bierjunge Max Muster"), Some(Uuid::from_u128(2)));
        assert_eq!(ziel("Bierjunge lenchen"), Some(Uuid::from_u128(3)));
        assert_eq!(ziel("Bierjunge Lena!"), Some(Uuid::from_u128(3)));
        assert_eq!(ziel("Bierjunge"), None);
        assert_eq!(ziel("Bierjunge Maximilian"), None, "ganze Wörter");
        // Der Ausrufer selbst ist nie das Ziel.
        assert_eq!(ziel("Bierjunge Tim"), None);
    }

    #[test]
    fn derselbe_vorname_zweimal_heisst_namenlos_aber_der_volle_name_gewinnt() {
        let ich = Uuid::from_u128(1);
        let leute = [
            mitglied(1, "tim", "Tim", None),
            mitglied(2, "maxa", "Max Anders", None),
            mitglied(3, "maxb", "Max Besser", None),
        ];
        assert_eq!(finde_ziel(&woerter("Bierjunge Max"), ich, &leute), None);
        assert_eq!(
            finde_ziel(&woerter("Bierjunge Max Besser"), ich, &leute),
            Some(Uuid::from_u128(3))
        );
        assert_eq!(
            finde_ziel(&woerter("Bierjunge @maxa"), ich, &leute),
            Some(Uuid::from_u128(2))
        );
    }
}
