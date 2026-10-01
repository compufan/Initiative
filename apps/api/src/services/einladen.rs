//! Einladen: wohin eine Einladung geht und wie sie dort ankommt.
//!
//! # Die Regeln
//!
//! **Wer den Termin sieht**: der Ersteller und jede Person mit Zeile in
//! `event_attendees`. Sonst niemand. Kein Chat, keine Rolle, kein Verlauf
//! verleiht Zugang.
//!
//! **Was eine Karte ist**: ein *Ort*, an dem der Termin angezeigt wird, nicht
//! ein Zugang. Jede Karte ist eine `event`-Nachricht mit einer Zeile in
//! `event_placements` – im Gruppenchat (`gruppe`) oder im Einzelchat zwischen
//! Ersteller und Person (`einzel`).
//!
//! **Wohin die Einladung geht** (beim Anlegen und, nur für die neu
//! Hinzugefügten, beim Ändern):
//!
//! ```text
//! Einzelkarte(n):  für jede eingeladene Person, wenn senden && einzelchats
//! Gruppenkarte:    für jeden ausdrücklich gewählten Gruppenchat G, wenn senden
//!                  && alle Mitglieder von G (ausser dem Ersteller) eingeladen sind
//! ```
//!
//! Nie in einen Gruppenchat, der nicht ausdrücklich gewählt wurde – auch nicht,
//! wenn zufällig alle seine Mitglieder eingeladen sind. Sonst postete „alle
//! einladen“ in jeden Gruppenchat, und die Oberfläche könnte nichts abwählen,
//! ohne Personen abzuwählen.
//!
//! # Zwei Phasen
//!
//! Phase 1 ist **eine Transaktion**: Termin, Teilnehmer, fehlende Einzelchats
//! und die *reservierten* Karten-Zeilen. Jeder Fehler rollt alles zurück.
//! Phase 2 legt die Nachrichten an – nach dem Commit, je Karte wiederholbar.
//! Scheitert sie teilweise, bleibt der Termin gültig, die Antwort nennt, was
//! aussteht, und `…/zustellung/nachliefern` holt es nach. `create_message` ist
//! der eine Einstieg für Nachrichten (Rundruf, Push, Hydrierung) und nicht
//! transaktionsfähig; ein Umbau beträfe jeden Nachrichtenweg.

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::constants::{EINLADUNGEN_MAX, EINLADUNG_GRUPPEN_MAX, EINLADUNG_PARALLEL};
use crate::db::{CalendarEventRow, EventPlacementRow};
use crate::drossel::regeln;
use crate::dto::{
    AusgelassenDto, GruppenKarteDto, TerminAntwort, ZustellungDto, ZustellungStandDto,
};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

use super::conversations::{einzelchats_sichern, vorhandene_einzelchats};
use super::messages::{create_message, NewMessage};

/// Wie viele fehlende Personen je ausgelassenem Gruppenchat genannt werden.
const FEHLENDE_GENANNT: usize = 5;

/// Wie lange eine wiederholte Anfrage auf eine laufende Zustellung wartet.
const ZUSTELLUNG_WARTEN: std::time::Duration = std::time::Duration::from_secs(8);

/* ---------- Der Plan -------------------------------------------------------- */

/// Was der Ersteller will.
#[derive(Debug, Clone)]
pub struct Wunsch {
    /// `false`: niemand bekommt eine Karte oder Benachrichtigung; nur Kalender.
    pub senden: bool,
    /// Karte in die Einzelchats.
    pub einzelchats: bool,
    /// Gruppenchats, in die die Karte soll – in Auswahlreihenfolge.
    pub gruppen: Vec<Uuid>,
}

/// Was daraus wird.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    /// Gruppenchats, in die die Karte gestellt wird.
    pub gruppen: Vec<Uuid>,
    /// Gewünschte Gruppenchats, in denen nicht alle eingeladen sind – mit den
    /// Fehlenden.
    pub ausgelassen: Vec<(Uuid, Vec<Uuid>)>,
    /// Personen mit Einzelkarte (ohne Ersteller).
    pub einzel: Vec<Uuid>,
}

/// Rechnet aus Wunsch und Einladungsliste, wohin die Karten gehen.
///
/// Rein: keine Datenbank, keine Uhr. Das macht die Regel prüfbar und erlaubt
/// der Oberfläche, dieselbe Rechnung schon vor dem Senden zu zeigen
/// (`zustellungPlanen` im gemeinsamen Paket, beide Seiten lesen dieselben
/// Testfälle aus `testdaten/zustellung.json`).
///
/// `mitglieder` kennt für jeden gewünschten Gruppenchat dessen Mitglieder. Ein
/// Chat ohne weitere Mitglieder als den Ersteller zählt als „alle eingeladen“.
pub fn planen(
    ersteller: Uuid,
    personen: &[Uuid],
    wunsch: &Wunsch,
    mitglieder: &HashMap<Uuid, Vec<Uuid>>,
) -> Plan {
    if !wunsch.senden {
        return Plan::default();
    }

    let mut eingeladen: HashSet<Uuid> = HashSet::new();
    let mut reihenfolge: Vec<Uuid> = Vec::new();
    for person in personen {
        if *person != ersteller && eingeladen.insert(*person) {
            reihenfolge.push(*person);
        }
    }

    let mut gesehen: HashSet<Uuid> = HashSet::new();
    let mut gruppen = Vec::new();
    let mut ausgelassen = Vec::new();
    for chat in &wunsch.gruppen {
        if !gesehen.insert(*chat) {
            continue;
        }
        let fehlend: Vec<Uuid> = mitglieder
            .get(chat)
            .map(|liste| {
                liste
                    .iter()
                    .copied()
                    .filter(|person| *person != ersteller && !eingeladen.contains(person))
                    .collect()
            })
            .unwrap_or_default();
        if fehlend.is_empty() {
            gruppen.push(*chat);
        } else {
            ausgelassen.push((*chat, fehlend));
        }
    }

    Plan {
        gruppen,
        ausgelassen,
        einzel: if wunsch.einzelchats {
            reihenfolge
        } else {
            Vec::new()
        },
    }
}

/* ---------- Prüfen ---------------------------------------------------------- */

/// Die Einladungsliste: ohne den Ersteller, ohne Doppelte, sortiert.
pub fn personen_bereinigen(ersteller: Option<Uuid>, personen: &[Uuid]) -> Vec<Uuid> {
    let mut bereinigt: Vec<Uuid> = personen
        .iter()
        .copied()
        .filter(|person| Some(*person) != ersteller)
        .collect();
    bereinigt.sort();
    bereinigt.dedup();
    bereinigt
}

/// Dieselbe Liste ohne Doppelte, in der ursprünglichen Reihenfolge.
pub fn ohne_doppelte(liste: &[Uuid]) -> Vec<Uuid> {
    let mut gesehen = HashSet::new();
    liste
        .iter()
        .copied()
        .filter(|eintrag| gesehen.insert(*eintrag))
        .collect()
}

/// Höchstens 200 Eingeladene.
///
/// Nur dort geprüft, wo die Liste ausdrücklich gilt. Der alte Weg kennt keine
/// Grenze: Dort kommen alle Mitglieder des Chats hinzu, und eine Einladung, die
/// vorher ging, soll nicht nachträglich scheitern.
pub fn anzahl_pruefen(anzahl: usize) -> AppResult<()> {
    if anzahl > EINLADUNGEN_MAX {
        return Err(AppError::bad_request(format!(
            "Zu viele Eingeladene (höchstens {EINLADUNGEN_MAX})."
        )));
    }
    Ok(())
}

/// Alle Eingeladenen haben ein Konto.
///
/// Alle Lesezugriffe dieses Moduls nehmen eine Verbindung statt des Vorrats:
/// Eine Änderung hält eine Transaktion offen, und wer darin noch eine zweite
/// Verbindung anfordert, lässt bei vielen gleichzeitigen Änderungen den Vorrat
/// leerlaufen – alle halten eine und warten auf die nächste.
pub async fn personen_pruefen(conn: &mut PgConnection, personen: &[Uuid]) -> AppResult<()> {
    if personen.is_empty() {
        return Ok(());
    }
    let bekannt: i64 = sqlx::query_scalar("select count(*) from users where id = any($1)")
        .bind(personen)
        .fetch_one(conn)
        .await?;
    if bekannt as usize != personen.len() {
        return Err(AppError::bad_request(
            "Unbekannte Personen unter den Eingeladenen.",
        ));
    }
    Ok(())
}

/// Prüft die gewünschten Gruppenchats und liefert deren Mitglieder.
///
/// Es müssen Gruppenchats sein (ein Einzelchat hat seine Karte ohnehin) und der
/// Ersteller muss darin Mitglied sein: Sonst ließe sich eine Karte in jeden
/// beliebigen Chat stellen, dessen Kennung man kennt.
pub async fn gruppen_pruefen(
    conn: &mut PgConnection,
    ersteller: Uuid,
    gruppen: &[Uuid],
) -> AppResult<HashMap<Uuid, Vec<Uuid>>> {
    gruppenanzahl_pruefen(gruppen.len())?;
    if gruppen.is_empty() {
        return Ok(HashMap::new());
    }

    let chats: Vec<(Uuid, String)> =
        sqlx::query_as("select id, type from conversations where id = any($1)")
            .bind(gruppen)
            .fetch_all(&mut *conn)
            .await?;
    let verschieden: HashSet<Uuid> = gruppen.iter().copied().collect();
    if chats.len() != verschieden.len() {
        return Err(AppError::not_found("Chat nicht gefunden"));
    }
    if chats.iter().any(|(_, art)| art != "group") {
        return Err(AppError::bad_request(
            "Nur Gruppenchats lassen sich als Ziel wählen.",
        ));
    }

    let zeilen: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select conversation_id, user_id from conversation_members
          where conversation_id = any($1)
          order by conversation_id, user_id",
    )
    .bind(gruppen)
    .fetch_all(&mut *conn)
    .await?;
    let mut mitglieder: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (chat, person) in zeilen {
        mitglieder.entry(chat).or_default().push(person);
    }
    for chat in &verschieden {
        let dabei = mitglieder
            .get(chat)
            .is_some_and(|liste| liste.contains(&ersteller));
        if !dabei {
            return Err(AppError::forbidden("Du bist kein Mitglied dieses Chats"));
        }
    }
    Ok(mitglieder)
}

/// Bremst Einladungen, die viele neue Einzelchats anlegen würden – bevor etwas
/// angelegt ist.
///
/// Gezählt wird, was wirklich neu entsteht: Wer nur in bestehende Chats
/// schreibt, verbraucht nichts.
pub async fn einzelchats_bremsen(
    state: &AppState,
    conn: &mut PgConnection,
    ersteller: Uuid,
    einzel: &[Uuid],
) -> AppResult<()> {
    if einzel.is_empty() {
        return Ok(());
    }
    let vorhanden = vorhandene_einzelchats(conn, ersteller, einzel).await?;
    let neu = einzel.len().saturating_sub(vorhanden.len());
    if neu == 0 {
        return Ok(());
    }
    if !state.drossel.erlaubt_menge(
        &format!("einzelchats:{ersteller}"),
        regeln::EINZELCHATS_NEU,
        neu as u32,
    ) {
        return Err(AppError::too_many(
            "Zu viele neue Chats in kurzer Zeit. Warte einen Moment.",
        ));
    }
    Ok(())
}

/* ---------- Die Karten ------------------------------------------------------ */

/// Die Karte des alten Weges: im Chat des Termins.
///
/// In einem Zweierchat mit dem Ersteller ist das eine Einzelkarte, sonst eine
/// Gruppenkarte. Die Unterscheidung hält Löschen und Ausladen richtig: Wer aus
/// dem Termin ausgeladen wird, verliert seine Einzelkarte.
pub async fn alte_karte(pool: &PgPool, chat: Uuid, ersteller: Uuid) -> AppResult<Reservierung> {
    let art: Option<String> = sqlx::query_scalar("select type from conversations where id = $1")
        .bind(chat)
        .fetch_optional(pool)
        .await?;
    if art.as_deref() == Some("direct") {
        let mitglieder = super::conversations::member_ids(pool, chat).await?;
        if mitglieder.len() == 2 && mitglieder.contains(&ersteller) {
            if let Some(gegenueber) = mitglieder.into_iter().find(|person| *person != ersteller) {
                return Ok(Reservierung::einzel(chat, gegenueber));
            }
        }
    }
    Ok(Reservierung::gruppe(chat))
}

/// Eine Karte, die noch angelegt werden soll.
#[derive(Debug, Clone)]
pub struct Reservierung {
    pub chat: Uuid,
    /// `gruppe` oder `einzel`.
    pub art: &'static str,
    /// Bei `einzel` das Gegenüber des Erstellers.
    pub person: Option<Uuid>,
}

impl Reservierung {
    pub fn gruppe(chat: Uuid) -> Self {
        Self {
            chat,
            art: "gruppe",
            person: None,
        }
    }

    pub fn einzel(chat: Uuid, person: Uuid) -> Self {
        Self {
            chat,
            art: "einzel",
            person: Some(person),
        }
    }
}

/// Trägt die Karten in die Tabelle ein – ohne Nachricht.
///
/// Eine Zeile vor der Nachricht: Bricht das Zustellen ab, bleibt sichtbar, was
/// noch aussteht, und ein zweiter Anlauf legt keine zweite Karte an.
pub async fn reservieren(
    tx: &mut Transaction<'_, Postgres>,
    event_id: Uuid,
    ersteller: Uuid,
    karten: &[Reservierung],
) -> AppResult<()> {
    if karten.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = karten.iter().map(|_| Uuid::now_v7()).collect();
    let chats: Vec<Uuid> = karten.iter().map(|karte| karte.chat).collect();
    let arten: Vec<String> = karten.iter().map(|karte| karte.art.to_string()).collect();
    let personen: Vec<Option<Uuid>> = karten.iter().map(|karte| karte.person).collect();
    sqlx::query(
        "insert into event_placements (id, event_id, conversation_id, art, user_id, created_by)
         select t.id, $1, t.chat, t.art, t.person, $2
           from unnest($3::uuid[], $4::uuid[], $5::text[], $6::uuid[])
                as t(id, chat, art, person)
         on conflict do nothing",
    )
    .bind(event_id)
    .bind(ersteller)
    .bind(&ids)
    .bind(&chats)
    .bind(&arten)
    .bind(&personen)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Alle Karten eines Termins, in der Reihenfolge ihrer Anlage.
pub async fn platzierungen(pool: &PgPool, event_id: Uuid) -> AppResult<Vec<EventPlacementRow>> {
    Ok(sqlx::query_as::<_, EventPlacementRow>(
        "select * from event_placements where event_id = $1 order by created_at, id",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?)
}

/// Was eine Runde Zustellen ergeben hat.
#[derive(Debug, Default)]
pub struct Zugestellt {
    /// Die Karten, die jetzt eine Nachricht haben – in Reihenfolge der Anlage.
    pub karten: Vec<EventPlacementRow>,
    /// Wie viele nicht angelegt werden konnten.
    pub fehlgeschlagen: usize,
}

/// Was aus einer offenen Karte in dieser Runde wurde.
enum Ausgang {
    Angelegt(Uuid),
    Fehlgeschlagen,
    /// Die Zeile ist inzwischen weg oder trägt schon eine Nachricht: Der Termin
    /// wurde gelöscht, die Person ausgeladen oder eine andere Runde war schneller.
    Uebersprungen,
}

/// Legt für jede noch offene Karte die Nachricht an (Phase 2).
///
/// `still`: Die Nachricht löst keine eigene Mitteilung aus – die Einladung
/// meldet sich genau einmal je Person, nicht einmal je Karte. Der alte Weg
/// (Termin an einem Chat, ohne `zustellung`) bleibt nicht stumm, damit er sich
/// so verhält wie bisher.
///
/// Höchstens [`EINLADUNG_PARALLEL`] gleichzeitig, und nie innerhalb einer
/// Datenbank-Transaktion. Teilfehler werden gezählt und protokolliert, nicht
/// geworfen: Der Termin steht, und eine fehlende Karte lässt sich nachliefern.
///
/// Zwischen dem Lesen der offenen Zeilen und dem Anlegen der Nachricht kann der
/// Termin gelöscht oder die Person ausgeladen werden – dann sind die Zeilen
/// weg, und eine Karte, die jetzt noch entstünde, hinge an nichts und bliebe für
/// immer stehen. Deshalb wird vor jeder Karte nachgesehen, und eine Nachricht,
/// deren Zeile bei der Eintragung nicht mehr (oder schon anderweitig belegt)
/// ist, wird wieder zurückgenommen.
pub async fn offene_karten_zustellen(
    state: &AppState,
    event_id: Uuid,
    ersteller: Uuid,
    still: bool,
) -> AppResult<Zugestellt> {
    let offen: Vec<EventPlacementRow> = sqlx::query_as(
        "select * from event_placements
          where event_id = $1 and message_id is null
          order by created_at, id",
    )
    .bind(event_id)
    .fetch_all(&state.pool)
    .await?;
    if offen.is_empty() {
        return Ok(Zugestellt::default());
    }

    // `buffered` und nicht `buffer_unordered`: Die Reihenfolge der Ergebnisse
    // ist die der Anlage, und die erste Karte ist die „Ursprungskarte“ des
    // Termins.
    let ergebnisse: Vec<(EventPlacementRow, Ausgang)> = stream::iter(offen)
        .map(|zeile| async move {
            let offen_noch: bool = sqlx::query_scalar(
                "select exists (select 1 from event_placements
                                 where id = $1 and message_id is null)",
            )
            .bind(zeile.id)
            .fetch_one(&state.pool)
            .await
            // Im Zweifel anlegen: Eine überzählige Karte räumt die Eintragung
            // unten weg, eine fehlende fiele niemandem auf.
            .unwrap_or(true);
            if !offen_noch {
                return (zeile, Ausgang::Uebersprungen);
            }
            let mut nachricht =
                NewMessage::einladung(zeile.conversation_id, ersteller, event_id, zeile.id);
            nachricht.silent = still;
            match create_message(state, nachricht).await {
                Ok(angelegt) => (zeile, Ausgang::Angelegt(angelegt.id)),
                Err(fehler) => {
                    tracing::warn!(
                        %fehler, termin = %event_id, chat = %zeile.conversation_id,
                        "Karte konnte nicht zugestellt werden"
                    );
                    (zeile, Ausgang::Fehlgeschlagen)
                }
            }
        })
        .buffered(EINLADUNG_PARALLEL)
        .collect()
        .await;

    let fehlgeschlagen = ergebnisse
        .iter()
        .filter(|(_, ausgang)| matches!(ausgang, Ausgang::Fehlgeschlagen))
        .count();
    let (karten_ids, nachricht_ids): (Vec<Uuid>, Vec<Uuid>) = ergebnisse
        .iter()
        .filter_map(|(zeile, ausgang)| match ausgang {
            Ausgang::Angelegt(id) => Some((zeile.id, *id)),
            _ => None,
        })
        .unzip();
    // Nur Zeilen, die noch leer sind: Wer schneller war, behält seine Karte.
    let eingetragen: HashSet<Uuid> = if karten_ids.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "update event_placements p set message_id = t.nachricht
               from unnest($1::uuid[], $2::uuid[]) as t(karte, nachricht)
              where p.id = t.karte and p.message_id is null
          returning p.id",
        )
        .bind(&karten_ids)
        .bind(&nachricht_ids)
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect()
    };

    // Nachrichten ohne Zeile zurücknehmen – sie sind verwaist.
    let verwaist: Vec<Uuid> = ergebnisse
        .iter()
        .filter_map(|(zeile, ausgang)| match ausgang {
            Ausgang::Angelegt(id) if !eingetragen.contains(&zeile.id) => Some(*id),
            _ => None,
        })
        .collect();
    if !verwaist.is_empty() {
        let mut tx = state.pool.begin().await?;
        let geloescht = nachrichten_loeschen(&mut tx, &verwaist).await?;
        tx.commit().await?;
        karten_melden(state, geloescht).await;
    }

    let karten = ergebnisse
        .into_iter()
        .filter_map(|(mut zeile, ausgang)| match ausgang {
            Ausgang::Angelegt(id) if eingetragen.contains(&zeile.id) => {
                zeile.message_id = Some(id);
                Some(zeile)
            }
            _ => None,
        })
        .collect();
    Ok(Zugestellt {
        karten,
        fehlgeschlagen,
    })
}

/// Wartet, bis eine eben begonnene Zustellung fertig ist – höchstens ein paar
/// Sekunden.
///
/// Für die Wiederholung einer Anfrage (gleicher Schlüssel): Die erste legt die
/// Nachrichten womöglich noch an, und ihr Stand „ausstehend“ wäre eine
/// Momentaufnahme, kein Fehler. Gewartet wird nur bei einem jungen Termin, und
/// nie länger als [`ZUSTELLUNG_WARTEN`]: Ist die erste Anfrage mit dem Server
/// gestorben, bleibt die Zeile offen, und die Wiederholung meldet es dann
/// ehrlich.
pub async fn auf_laufende_zustellung_warten(pool: &PgPool, event_id: Uuid) -> AppResult<()> {
    let beginn = std::time::Instant::now();
    loop {
        let laeuft: bool = sqlx::query_scalar(
            "select exists (
               select 1 from event_placements p
                 join calendar_events e on e.id = p.event_id
                where p.event_id = $1 and p.message_id is null
                  and e.created_at > now() - interval '2 minutes'
             )",
        )
        .bind(event_id)
        .fetch_one(pool)
        .await?;
        if !laeuft || beginn.elapsed() >= ZUSTELLUNG_WARTEN {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// Eine gelöschte Karte und wem das gemeldet wird.
#[derive(Debug)]
pub struct Geloescht {
    pub nachricht: Uuid,
    pub chat: Uuid,
    pub empfaenger: Vec<Uuid>,
}

/// Nimmt Karten zurück: Nachrichten als gelöscht markieren, Zeilen entfernen.
///
/// Läuft in der Transaktion des Aufrufers, damit „Person ausgeladen“ und „ihre
/// Karte ist weg“ zusammen gelten oder gar nicht. Die Empfänger werden VOR dem
/// Löschen bestimmt, wie bei jeder gelöschten Nachricht: Wer sie nie sehen
/// durfte, erfährt sonst über die Kennung, dass es sie gab.
///
/// Die Nachricht bleibt als „Diese Nachricht wurde gelöscht“ zurück, nicht als
/// Platzhalter: Der Ersteller sähe sonst in seinem Chat eine volle Karte,
/// während der Eingeladene „nicht verfügbar“ sieht – zwei Wahrheiten in einem
/// Chat.
///
/// Die Zeilen werden zuerst gelöscht und die Nachricht gilt, die sie **dabei**
/// trugen, nicht die, die der Aufrufer gelesen hat: Trägt eine Zeile gerade
/// erst durch eine laufende Zustellung ihre Nachricht, wartet das Löschen auf
/// deren Eintragung, und die Karte bliebe sonst ohne Zeile zurück.
pub async fn karten_entfernen(
    tx: &mut Transaction<'_, Postgres>,
    zeilen: &[EventPlacementRow],
) -> AppResult<Vec<Geloescht>> {
    if zeilen.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = zeilen.iter().map(|zeile| zeile.id).collect();
    let getragen: Vec<Option<Uuid>> =
        sqlx::query_scalar("delete from event_placements where id = any($1) returning message_id")
            .bind(&ids)
            .fetch_all(&mut **tx)
            .await?;
    let mut nachrichten: Vec<Uuid> = zeilen
        .iter()
        .filter_map(|zeile| zeile.message_id)
        .chain(getragen.into_iter().flatten())
        .collect();
    nachrichten.sort();
    nachrichten.dedup();
    nachrichten_loeschen(tx, &nachrichten).await
}

/// Markiert Nachrichten als gelöscht und bestimmt, wem es zu melden ist.
async fn nachrichten_loeschen(
    tx: &mut Transaction<'_, Postgres>,
    nachrichten: &[Uuid],
) -> AppResult<Vec<Geloescht>> {
    if nachrichten.is_empty() {
        return Ok(Vec::new());
    }
    let empfaenger = super::verlauf::empfaenger_fuer_nachrichten(&mut **tx, nachrichten).await?;
    sqlx::query(
        "update messages set deleted_at = now(), body = null, metadata = '{}'::jsonb
          where id = any($1) and deleted_at is null",
    )
    .bind(nachrichten)
    .execute(&mut **tx)
    .await?;

    Ok(empfaenger
        .into_iter()
        .map(|(nachricht, chat, empfaenger)| Geloescht {
            nachricht,
            chat,
            empfaenger,
        })
        .collect())
}

/// Meldet gelöschte Karten – nach dem Commit.
pub async fn karten_melden(state: &AppState, geloescht: Vec<Geloescht>) {
    for karte in geloescht {
        state
            .hub
            .publish(
                karte.empfaenger,
                Event::message_deleted(karte.chat, karte.nachricht),
            )
            .await;
    }
}

/* ---------- Was die Antwort sagt ------------------------------------------- */

/// Baut die Zustellungs-Angabe der Antwort.
///
/// Der Stand der Karten kommt aus der Tabelle, nicht aus dem, was diese
/// Anfrage selbst getan hat: Beim Ändern stehen auch die Karten früherer
/// Anfragen da, und bei einer Wiederholung hat die Anfrage gar nichts getan.
pub async fn zustellung_dto(
    pool: &PgPool,
    event_id: Uuid,
    ausgelassen: &[(Uuid, Vec<Uuid>)],
    neue_einzelchats: usize,
    benachrichtigt: usize,
    einzel_jetzt: Option<usize>,
) -> AppResult<ZustellungDto> {
    let zeilen = platzierungen(pool, event_id).await?;
    let einzel_gesamt = zeilen
        .iter()
        .filter(|zeile| zeile.art == "einzel" && zeile.message_id.is_some())
        .count();
    Ok(ZustellungDto {
        gruppen: zeilen
            .iter()
            .filter(|zeile| zeile.art == "gruppe")
            .map(|zeile| GruppenKarteDto {
                conversation_id: zeile.conversation_id,
                nachricht_id: zeile.message_id,
            })
            .collect(),
        einzelchats: einzel_jetzt.unwrap_or(einzel_gesamt) as i64,
        neue_einzelchats: neue_einzelchats as i64,
        ausgelassen: ausgelassen
            .iter()
            .map(|(chat, fehlend)| AusgelassenDto {
                conversation_id: *chat,
                fehlend: fehlend.iter().copied().take(FEHLENDE_GENANNT).collect(),
            })
            .collect(),
        ausstehend: zeilen
            .iter()
            .filter(|zeile| zeile.message_id.is_none())
            .count() as i64,
        benachrichtigt: benachrichtigt as i64,
    })
}

/// Wo ein Termin steht – für den Editor beim Bearbeiten.
pub async fn zustellung_stand(pool: &PgPool, event_id: Uuid) -> AppResult<ZustellungStandDto> {
    let zeilen = platzierungen(pool, event_id).await?;
    Ok(ZustellungStandDto {
        gruppen: zeilen
            .iter()
            .filter(|zeile| zeile.art == "gruppe")
            .map(|zeile| GruppenKarteDto {
                conversation_id: zeile.conversation_id,
                nachricht_id: zeile.message_id,
            })
            .collect(),
        einzel_nutzer_ids: zeilen
            .iter()
            .filter(|zeile| zeile.art == "einzel")
            .filter_map(|zeile| zeile.user_id)
            .collect(),
        ausstehend: zeilen
            .iter()
            .filter(|zeile| zeile.message_id.is_none())
            .count() as i64,
    })
}

/// Legt fehlende Nachrichten zu reservierten Karten an (idempotent).
///
/// Die Personen, deren erste Karte jetzt ankommt, bekommen ihre Einladungs-
/// Mitteilung; wer schon früher eine Karte hatte, wurde damals benachrichtigt
/// und nicht ein zweites Mal.
pub async fn nachliefern(
    state: &AppState,
    termin: &CalendarEventRow,
    ersteller: Uuid,
) -> AppResult<TerminAntwort> {
    let vorher = platzierungen(&state.pool, termin.id).await?;
    let schon_versorgt: HashSet<Uuid> = vorher
        .iter()
        .filter(|zeile| zeile.message_id.is_some())
        .filter_map(|zeile| zeile.user_id)
        .collect();
    let zugestellt = offene_karten_zustellen(state, termin.id, ersteller, true).await?;

    let dto = super::calendar::load_event_dto(state, termin.id).await?;
    let personen: Vec<Uuid> = dto
        .attendees
        .iter()
        .map(|teilnehmer| teilnehmer.user_id)
        .filter(|person| *person != ersteller && !schon_versorgt.contains(person))
        .collect();
    let benachrichtigt = super::notify::benachrichtige_einladung(
        state,
        &dto,
        ersteller,
        &personen,
        &zugestellt.karten,
    )
    .await;

    let einzel = zugestellt
        .karten
        .iter()
        .filter(|karte| karte.art == "einzel")
        .count();
    let zustellung =
        zustellung_dto(&state.pool, termin.id, &[], 0, benachrichtigt, Some(einzel)).await?;
    Ok(TerminAntwort {
        termin: dto,
        zustellung: Some(zustellung),
    })
}

/* ---------- Ändern ---------------------------------------------------------- */

/// Was eine Änderungsanfrage an den Einladungen will.
#[derive(Debug, Clone)]
pub struct Einladungswunsch {
    /// Sollzustand der Eingeladenen (ohne Ersteller); `None`: unverändert.
    pub personen: Option<Vec<Uuid>>,
    /// Zusätzlich auszuladen – für das Ausladen einer einzelnen Person.
    pub ausladen: Vec<Uuid>,
    /// Gilt für die **neu Hinzugefügten** dieser Anfrage (und neue Gruppen).
    pub senden: bool,
    pub einzelchats: bool,
    /// Sollzustand der Gruppenkarten; `None`: unverändert.
    ///
    /// Fehlt das Feld, bleiben die Karten, wie sie sind – wichtig für den
    /// Editor, der es erst schickt, wenn er die bestehenden Karten kennt. Sonst
    /// wählte er sie versehentlich ab.
    pub gruppen: Option<Vec<Uuid>>,
}

impl Einladungswunsch {
    /// Nichts ändern, außer was die Felder ausdrücklich sagen.
    pub fn unveraendert() -> Self {
        Self {
            personen: None,
            ausladen: Vec::new(),
            senden: true,
            einzelchats: true,
            gruppen: None,
        }
    }
}

/// Was Phase 1 einer Änderung ergeben hat.
#[derive(Debug, Default)]
pub struct Geaendert {
    pub hinzu: Vec<Uuid>,
    pub entfernt: Vec<Uuid>,
    pub neue_chats: Vec<Uuid>,
    /// Neu gewünschte Gruppenchats, in denen nicht alle eingeladen sind.
    pub ausgelassen: Vec<(Uuid, Vec<Uuid>)>,
    /// Zurückgenommene Karten – noch zu melden.
    pub geloescht: Vec<Geloescht>,
}

/// Phase 1 einer Änderung: in der Transaktion des Aufrufers.
///
/// Der Aufrufer hat die Termin-Zeile gesperrt (`for update`): Zwei gleichzeitige
/// Änderungen des Erstellers laufen hintereinander und sehen je den Stand der
/// anderen.
///
/// # Was wo ankommt
///
/// * **Hinzugefügte**: Teilnehmerzeile, Einzelkarte, eine Mitteilung – und nur
///   sie. Wer schon dabei ist, wird nicht noch einmal eingeladen.
/// * **Entfernte**: Der Zugang endet sofort, ihre **Einzelkarte wird
///   gelöscht**. Eine **Gruppenkarte bleibt**: Würde sie gelöscht, verlören
///   alle anderen Mitglieder ihre einzige Karte, weil ein Einziger abgewählt
///   wurde. Der Entfernte sieht dort nur „Termin nicht verfügbar“.
/// * **Gruppen**: Was neu in der Liste steht, bekommt eine Karte (wenn alle
///   Mitglieder eingeladen sind, sonst `ausgelassen`); was nicht mehr darin
///   steht, verliert sie. Bestehende Karten bleiben, auch wenn inzwischen
///   Mitglieder fehlen – das ist eine Sache des Erstellers, nicht des Plans.
pub async fn aendern_vorbereiten(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    termin: &CalendarEventRow,
    wunsch: &Einladungswunsch,
) -> AppResult<Geaendert> {
    let ersteller = termin.created_by.ok_or_else(|| {
        AppError::forbidden("Nur wer den Termin angelegt hat, kann Einladungen ändern")
    })?;

    let ist: Vec<Uuid> =
        sqlx::query_scalar("select user_id from event_attendees where event_id = $1")
            .bind(termin.id)
            .fetch_all(&mut **tx)
            .await?;
    let ist = personen_bereinigen(Some(ersteller), &ist);
    let auszuladen: HashSet<Uuid> = wunsch.ausladen.iter().copied().collect();
    let soll: Vec<Uuid> = match &wunsch.personen {
        Some(liste) => personen_bereinigen(Some(ersteller), liste),
        None => ist.clone(),
    }
    .into_iter()
    .filter(|person| !auszuladen.contains(person))
    .collect();
    // Die Grenze gilt nur, wenn die Liste wächst: Der alte Weg und die Migration
    // haben Termine mit mehr Eingeladenen hinterlassen, und wer dort jemanden
    // ausladen oder eine Gruppenkarte abwählen will, darf nicht an einer Zahl
    // scheitern, die er mit dieser Änderung verkleinert.
    if soll.len() > ist.len() {
        anzahl_pruefen(soll.len())?;
    }

    let ist_menge: HashSet<Uuid> = ist.iter().copied().collect();
    let soll_menge: HashSet<Uuid> = soll.iter().copied().collect();
    let hinzu: Vec<Uuid> = soll
        .iter()
        .copied()
        .filter(|person| !ist_menge.contains(person))
        .collect();
    let entfernt: Vec<Uuid> = ist
        .iter()
        .copied()
        .filter(|person| !soll_menge.contains(person))
        .collect();
    // Eine Terminfindung stellt ihre Frage nur in den Chats, in denen sie
    // steht: Wer später dazukäme, bekäme eine Karte mit Zusage-Knöpfen, könnte
    // aber nicht abstimmen. Erst wenn der Zeitpunkt feststeht, lässt sich
    // weiter einladen.
    if !hinzu.is_empty() && termin.status == "planning" {
        return Err(AppError::bad_request(
            "Solange über den Zeitpunkt abgestimmt wird, lassen sich keine weiteren Personen einladen – lege zuerst den Zeitpunkt fest.",
        ));
    }
    personen_pruefen(tx, &hinzu).await?;

    // Gruppenkarten: was neu ist, was wegfällt.
    let bestehende: Vec<EventPlacementRow> = sqlx::query_as(
        "select * from event_placements where event_id = $1 and art = 'gruppe'
          order by created_at, id",
    )
    .bind(termin.id)
    .fetch_all(&mut **tx)
    .await?;
    let (neue_gruppen, weg_karten): (Vec<Uuid>, Vec<EventPlacementRow>) = match &wunsch.gruppen {
        None => (Vec::new(), Vec::new()),
        Some(liste) => {
            let liste = ohne_doppelte(liste);
            gruppenanzahl_pruefen(liste.len())?;
            let gewuenscht: HashSet<Uuid> = liste.iter().copied().collect();
            let vorhanden: HashSet<Uuid> = bestehende
                .iter()
                .map(|karte| karte.conversation_id)
                .collect();
            (
                liste
                    .iter()
                    .copied()
                    .filter(|chat| !vorhanden.contains(chat))
                    .collect(),
                bestehende
                    .iter()
                    .filter(|karte| !gewuenscht.contains(&karte.conversation_id))
                    .cloned()
                    .collect(),
            )
        }
    };
    // Nur die NEUEN Gruppen werden geprüft: Eine schon bestehende Karte darf
    // der Ersteller auch nach seinem Austritt noch abwählen.
    let mitglieder = gruppen_pruefen(tx, ersteller, &neue_gruppen).await?;

    let einzel_plan = planen(
        ersteller,
        &hinzu,
        &Wunsch {
            senden: wunsch.senden,
            einzelchats: wunsch.einzelchats,
            gruppen: Vec::new(),
        },
        &HashMap::new(),
    );
    let gruppen_plan = planen(
        ersteller,
        &soll,
        &Wunsch {
            senden: wunsch.senden,
            einzelchats: false,
            gruppen: neue_gruppen.clone(),
        },
        &mitglieder,
    );
    einzelchats_bremsen(state, tx, ersteller, &einzel_plan.einzel).await?;

    let einzel = einzelchats_sichern(tx, ersteller, &einzel_plan.einzel).await?;

    if !hinzu.is_empty() {
        sqlx::query(
            "insert into event_attendees (event_id, user_id, status, eingeladen_am)
             select $1, p, 'pending', now() from unnest($2::uuid[]) as p
             on conflict (event_id, user_id) do nothing",
        )
        .bind(termin.id)
        .bind(&hinzu)
        .execute(&mut **tx)
        .await?;
    }
    let mut zu_loeschen = weg_karten.clone();
    if !entfernt.is_empty() {
        sqlx::query("delete from event_attendees where event_id = $1 and user_id = any($2)")
            .bind(termin.id)
            .bind(&entfernt)
            .execute(&mut **tx)
            .await?;
        let einzelkarten: Vec<EventPlacementRow> = sqlx::query_as(
            "select * from event_placements
              where event_id = $1 and art = 'einzel' and user_id = any($2)",
        )
        .bind(termin.id)
        .bind(&entfernt)
        .fetch_all(&mut **tx)
        .await?;
        zu_loeschen.extend(einzelkarten);
    }
    let geloescht = karten_entfernen(tx, &zu_loeschen).await?;

    let mut karten: Vec<Reservierung> = gruppen_plan
        .gruppen
        .iter()
        .map(|chat| Reservierung::gruppe(*chat))
        .collect();
    karten.extend(einzel_plan.einzel.iter().filter_map(|person| {
        einzel
            .chat_von
            .get(person)
            .map(|chat| Reservierung::einzel(*chat, *person))
    }));
    reservieren(tx, termin.id, ersteller, &karten).await?;

    // Der Chat des Termins ist der erste Gruppenchat mit Karte – nur dort
    // nachführen, wo sich die Gruppenkarten geändert haben.
    if !weg_karten.is_empty() || !gruppen_plan.gruppen.is_empty() {
        sqlx::query(
            "update calendar_events set conversation_id =
               (select conversation_id from event_placements
                 where event_id = $1 and art = 'gruppe' order by created_at, id limit 1)
             where id = $1",
        )
        .bind(termin.id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(Geaendert {
        hinzu,
        entfernt,
        neue_chats: einzel.neu,
        ausgelassen: gruppen_plan.ausgelassen,
        geloescht,
    })
}

/// Löscht einen Termin samt allen Karten.
///
/// Die Karten verschwinden als „gelöscht“ wie jede gelöschte Nachricht – kein
/// Sonderzustand, keine Karte mit „Termin nicht verfügbar“, die niemand mehr
/// erklären kann. Der Bestand ließ hier tote Karten stehen, bei N Karten wären
/// es N Leichen je Termin.
pub async fn termin_loeschen(
    state: &AppState,
    termin: &CalendarEventRow,
) -> AppResult<Vec<Geloescht>> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("update calendar_events set deleted_at = now() where id = $1")
        .bind(termin.id)
        .execute(&mut *tx)
        .await?;
    // Erst jetzt gelesen, nicht davor: Eine Zustellung, die in der Zwischenzeit
    // eine Karte angelegt hat, gehört sonst nicht mehr zu dem, was hier
    // eingesammelt wird, und bliebe als Karte ohne Termin stehen.
    let zeilen: Vec<EventPlacementRow> = sqlx::query_as(
        "select * from event_placements where event_id = $1 order by created_at, id",
    )
    .bind(termin.id)
    .fetch_all(&mut *tx)
    .await?;
    let geloescht = karten_entfernen(&mut tx, &zeilen).await?;
    tx.commit().await?;
    Ok(geloescht)
}

/// Mehr als zehn Gruppenchats sind keine Einladung mehr, sondern ein Rundbrief.
pub fn gruppenanzahl_pruefen(anzahl: usize) -> AppResult<()> {
    if anzahl > EINLADUNG_GRUPPEN_MAX {
        return Err(AppError::bad_request(format!(
            "Zu viele Gruppenchats (höchstens {EINLADUNG_GRUPPEN_MAX})."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(nummer: u128) -> Uuid {
        Uuid::from_u128(nummer)
    }

    const ICH: u128 = 1;

    fn wunsch(senden: bool, einzelchats: bool, gruppen: &[u128]) -> Wunsch {
        Wunsch {
            senden,
            einzelchats,
            gruppen: gruppen.iter().map(|nummer| id(*nummer)).collect(),
        }
    }

    fn gruppen(tabelle: &[(u128, &[u128])]) -> HashMap<Uuid, Vec<Uuid>> {
        tabelle
            .iter()
            .map(|(chat, leute)| (id(*chat), leute.iter().map(|nummer| id(*nummer)).collect()))
            .collect()
    }

    fn plan(personen: &[u128], wunsch: &Wunsch, mitglieder: &HashMap<Uuid, Vec<Uuid>>) -> Plan {
        let personen: Vec<Uuid> = personen.iter().map(|nummer| id(*nummer)).collect();
        planen(id(ICH), &personen, wunsch, mitglieder)
    }

    #[test]
    fn sind_alle_eingeladen_kommt_die_gruppenkarte_und_es_gibt_einzelkarten() {
        let mitglieder = gruppen(&[(100, &[1, 2, 3, 4])]);
        let ergebnis = plan(&[2, 3, 4], &wunsch(true, true, &[100]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(100)]);
        assert!(ergebnis.ausgelassen.is_empty());
        assert_eq!(ergebnis.einzel, vec![id(2), id(3), id(4)]);
    }

    #[test]
    fn fehlt_eine_person_wird_die_gruppe_ausgelassen_die_einzelkarten_bleiben() {
        let mitglieder = gruppen(&[(100, &[1, 2, 3, 4])]);
        let ergebnis = plan(&[2, 3], &wunsch(true, true, &[100]), &mitglieder);
        assert!(ergebnis.gruppen.is_empty());
        assert_eq!(ergebnis.ausgelassen, vec![(id(100), vec![id(4)])]);
        assert_eq!(ergebnis.einzel, vec![id(2), id(3)]);
    }

    #[test]
    fn eine_nicht_gewaehlte_gruppe_bekommt_nie_eine_karte() {
        // Alle Mitglieder von 100 sind eingeladen – trotzdem nichts, weil die
        // Gruppe nicht ausdrücklich gewählt wurde.
        let mitglieder = gruppen(&[(100, &[1, 2, 3])]);
        let ergebnis = plan(&[2, 3], &wunsch(true, true, &[]), &mitglieder);
        assert!(ergebnis.gruppen.is_empty());
        assert!(ergebnis.ausgelassen.is_empty());
        assert_eq!(ergebnis.einzel, vec![id(2), id(3)]);
    }

    #[test]
    fn senden_aus_heisst_nichts() {
        let mitglieder = gruppen(&[(100, &[1, 2])]);
        assert_eq!(
            plan(&[2], &wunsch(false, true, &[100]), &mitglieder),
            Plan::default()
        );
    }

    #[test]
    fn ohne_einzelchats_bleiben_nur_die_gruppen() {
        let mitglieder = gruppen(&[(100, &[1, 2, 3])]);
        let ergebnis = plan(&[2, 3], &wunsch(true, false, &[100]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(100)]);
        assert!(ergebnis.einzel.is_empty());
    }

    #[test]
    fn mehrere_gruppen_werden_einzeln_beurteilt_in_auswahlreihenfolge() {
        let mitglieder = gruppen(&[(100, &[1, 2, 3]), (200, &[1, 3, 5]), (300, &[1, 2])]);
        let ergebnis = plan(&[2, 3], &wunsch(true, true, &[300, 200, 100]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(300), id(100)]);
        assert_eq!(ergebnis.ausgelassen, vec![(id(200), vec![id(5)])]);
    }

    #[test]
    fn eine_gruppe_nur_mit_dem_ersteller_zaehlt_als_vollstaendig() {
        let mitglieder = gruppen(&[(100, &[1])]);
        let ergebnis = plan(&[], &wunsch(true, true, &[100]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(100)]);
        assert!(ergebnis.einzel.is_empty());
    }

    #[test]
    fn der_ersteller_in_der_liste_wird_ignoriert_und_doppelte_zusammengefuehrt() {
        let mitglieder = gruppen(&[(100, &[1, 2])]);
        let ergebnis = plan(&[1, 2, 2], &wunsch(true, true, &[100, 100]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(100)]);
        assert_eq!(ergebnis.einzel, vec![id(2)]);
    }

    #[test]
    fn eine_person_in_zwei_gruppen_ist_kein_problem() {
        let mitglieder = gruppen(&[(100, &[1, 2, 3]), (200, &[1, 3, 4])]);
        let ergebnis = plan(&[2, 3, 4], &wunsch(true, true, &[100, 200]), &mitglieder);
        assert_eq!(ergebnis.gruppen, vec![id(100), id(200)]);
        assert_eq!(ergebnis.einzel.len(), 3);
    }

    #[test]
    fn personen_bereinigen_sortiert_und_entdoppelt() {
        let ergebnis = personen_bereinigen(Some(id(1)), &[id(3), id(1), id(2), id(3)]);
        assert_eq!(ergebnis, vec![id(2), id(3)]);
        assert_eq!(
            personen_bereinigen(None, &[id(2), id(1)]),
            vec![id(1), id(2)]
        );
    }
}
