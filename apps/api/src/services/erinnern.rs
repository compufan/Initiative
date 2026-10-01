//! Erinnern: wer auf eine Einladung nicht antwortet, wird in seinem Einzelchat
//! mit dem Ersteller daran erinnert – wenn der Ersteller es für diesen Termin
//! will.
//!
//! # Die Regeln
//!
//! **Wer erinnert wird**: eine Person, die noch `pending` ist, nicht der
//! Ersteller, und der eine Einzelkarte der Einladung **zugestellt** wurde –
//! beide noch Mitglied dieses Einzelchats. Nie der Gruppenchat. Der Dienst legt
//! keinen Einzelchat an: Wer beim Einladen „Einzelchats“ abgewählt hat, will
//! dort keine Nachricht, auch keine spätere.
//!
//! **Wann**: `fällig = max(eingeladen_am, erinnern_seit, jüngste Erinnerung) +
//! Abstand`. Gesendet wird, wenn `fällig ≤ jetzt`, die Anzahl nicht erreicht ist
//! und `jetzt ≤ Beginn − Reserve`. Wer einen Termin kurz vor dem Beginn
//! einstellt, bekommt also keine Erinnerung, ohne dass dafür ein Sonderfall im
//! Code steht – es folgt aus der Rechnung.
//!
//! **Wann nicht mehr**: bei jeder Antwort (auch „Vielleicht“), beim Ausladen,
//! Löschen, Absagen, ab dem Beginn und bei erreichter Anzahl. Die Bedingungen
//! stehen alle in der einen Abfrage von [`beanspruchen`]; kein Client entscheidet
//! etwas.
//!
//! # Warum erst beanspruchen, dann senden
//!
//! Eine Nachricht lässt sich nicht zurückholen. Zwei Instanzen des Servers
//! laufen mit zwei Uhren und demselben Takt, und beide sähen dieselbe Person
//! als fällig. Darum trägt **eine** Anweisung die Fälligen in
//! `event_erinnerungen` ein; der Schlüssel (Termin, Person, Nummer) lässt jede
//! Nummer genau einmal vergeben, und wer das Nachsehen hat, überspringt die
//! Zeile. Erst danach wird gesendet – mit einem festen Schlüssel an der Nachricht,
//! so bleibt auch ein zweiter Anlauf nach einem Absturz ohne zweite Karte.
//!
//! Eine Sperre über das Senden hinweg ginge nicht: [`create_message`] nimmt den
//! Verbindungsvorrat, ist nicht transaktionsfähig und löst Rundruf und
//! Mitteilung aus. Ein Absturz zwischen Senden und Festschreiben liesse die
//! Nachricht draussen und die Zeile frei – doppelt beim nächsten Mal.
//!
//! # Warum `jetzt` ein Parameter ist
//!
//! Wie bei der Auslagerung (`gewicht`): Eine Funktion, die selbst auf die Uhr
//! sieht, lässt sich nicht prüfen. Im Betrieb liefert [`starten`] die Uhr der
//! **Datenbank**, damit alle Instanzen mit derselben rechnen.

use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::constants::{
    EINLADUNG_PARALLEL, ERINNERN_ANZAHL_MAX, ERINNERN_NACH_STD_MAX, ERINNERN_NACH_STD_MIN,
    ERINNERN_RESERVE_STD,
};
use crate::db::CalendarEventRow;
use crate::dto::{ErinnernDto, ErinnernStandDto, ErinnerterDto};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::einladen::{nachrichten_loeschen, Geloescht};
use super::notify::{benachrichtige_erinnerungen, Erinnert};

/// Wie viele neue Erinnerungen ein Durchgang höchstens beansprucht.
///
/// Rückstau wird abgebaut, nicht gestaut: Nach einem langen Ausfall kommen die
/// ältesten Fälligkeiten zuerst, der Rest im nächsten Takt.
const STAPEL: i64 = 100;

/// Wie viele offene Zeilen ein Durchgang höchstens nachholt.
const NACHHOLEN_STAPEL: i64 = 100;

/// Wie oft eine offene Zeile nachgeholt wird, bevor sie liegen bleibt.
///
/// Danach zählt sie weiter als Versuch: Lieber eine Erinnerung zu wenig als eine
/// zu viel.
const NACHHOLEN_VERSUCHE: i16 = 3;

/// Wie alt eine offene Zeile mindestens sein muss, bevor sie nachgeholt wird.
///
/// So lange darf eine andere Instanz an ihr arbeiten, ohne dass ihr jemand
/// dazwischenfährt.
const NACHHOLEN_ALTER_MIN: i32 = 2;

/// Nach einem Tag ist eine Erinnerung keine mehr: Sie bleibt liegen.
const NACHHOLEN_GRENZE_STD: i32 = 24;

/// Vorgabe für den Takt in Sekunden (`ERINNERN_TAKT_S`).
pub const TAKT_VORGABE_S: u64 = 300;
/// Kürzester Takt, wenn der Dienst läuft.
const TAKT_MIN_S: u64 = 30;
/// Längster Takt: Die Fristen sind Stunden, aber eine Stunde Verzug ist genug.
const TAKT_MAX_S: u64 = 3600;

/// Der Dienst wartet beim Start, bis Migrationen und die ersten Anfragen durch
/// sind – ein Dienst, der gleich Nachrichten schreibt, macht den Start langsam.
const ERSTER_DURCHGANG: Duration = Duration::from_secs(30);

/* ---------- Die Einstellung ------------------------------------------------ */

/// Die Einstellung eines Termins, wie der Server sie rechnet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Erinnern {
    /// Stunden bis zur ersten Erinnerung und zwischen allen weiteren.
    pub nach_std: i32,
    /// Wie oft höchstens je Person; `None`: „bis zum Termin“ (höchstens zehn).
    pub anzahl: Option<i32>,
}

impl Erinnern {
    /// Die Einstellung, die in der Zeile eines Termins steht; `None`: aus.
    pub fn aus_zeile(termin: &CalendarEventRow) -> Option<Self> {
        termin.erinnern_nach_std.map(|nach_std| Self {
            nach_std,
            anzahl: termin.erinnern_anzahl.map(i32::from),
        })
    }
}

/// Muss beim Speichern die Uhr neu starten (`erinnern_seit = jetzt`)?
///
/// Ja bei jedem tatsächlichen Unterschied, beim Einschalten und bei der
/// Wiederaufnahme nach einer Absage – sonst löste das Einschalten bei Leuten, die
/// schon lange offen sind, sofort eine Welle aus, und eine Absage mit
/// Wiederaufnahme brächte alles auf einmal zurück. Wird nur der Titel geändert
/// und die Einstellung unverändert mitgeschickt, bleibt die Uhr stehen.
///
/// Die **Zählung** wird nie zurückgesetzt, auch nicht hier: Eine Obergrenze, die
/// sich durch Umschalten erneuern liesse, wäre keine.
pub fn uhr_neu_starten(
    alt: Option<Erinnern>,
    neu: Option<Erinnern>,
    wieder_aufgenommen: bool,
) -> bool {
    match (alt, neu) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(alt), Some(neu)) => alt != neu || wieder_aufgenommen,
    }
}

/// Prüft die Grenzen – dieselben, die die Oberfläche vorab zeigt.
///
/// Nicht in der Datenbank: Die Zahlen gehören in den Code (eine Quelle,
/// gespiegelt im gemeinsamen Paket, getestet). Wer sie später ändert, soll dafür
/// nicht migrieren müssen.
pub fn pruefen(nach_std: i32, anzahl: Option<i32>) -> AppResult<()> {
    if nach_std < ERINNERN_NACH_STD_MIN {
        return Err(AppError::bad_request(format!(
            "Die Erinnerung braucht mindestens {ERINNERN_NACH_STD_MIN} Stunden Abstand."
        )));
    }
    if nach_std > ERINNERN_NACH_STD_MAX {
        return Err(AppError::bad_request(format!(
            "Höchstens {} Tage ({ERINNERN_NACH_STD_MAX} Stunden) Abstand.",
            ERINNERN_NACH_STD_MAX / 24
        )));
    }
    if let Some(anzahl) = anzahl {
        if anzahl < 1 {
            return Err(AppError::bad_request("Mindestens eine Erinnerung."));
        }
        if anzahl > ERINNERN_ANZAHL_MAX {
            return Err(AppError::bad_request(format!(
                "Höchstens {ERINNERN_ANZAHL_MAX} Erinnerungen."
            )));
        }
    }
    Ok(())
}

/// Wie oft eine Person höchstens erinnert wird: „bis zum Termin“ heisst zehn.
///
/// Gedeckelt, weil ein Abstand von einem Tag bei einem Termin in neunzig Tagen
/// sonst neunzig Nachrichten hiesse.
pub fn hoechstens(anzahl: Option<i32>) -> i32 {
    anzahl
        .unwrap_or(ERINNERN_ANZAHL_MAX)
        .min(ERINNERN_ANZAHL_MAX)
}

/// Die Einstellung eines Termins, falls eingeschaltet.
pub fn einstellung_von(termin: &CalendarEventRow) -> Option<ErinnernDto> {
    termin.erinnern_nach_std.map(|nach_stunden| ErinnernDto {
        nach_stunden,
        anzahl: termin.erinnern_anzahl.map(i32::from),
    })
}

/// Der Text der Erinnerung – als Rückfall für ältere App-Stände, für die
/// Vorschau und die Mitteilung.
///
/// Die Karte selbst formuliert die Oberfläche je Betrachter und Zustand: Ein
/// gespeicherter „Du hast noch nicht geantwortet“ würde nach der Antwort lügen.
/// Keine Uhrzeit darin – der Server kennt keine Zeitzone.
pub fn erinnerungstext(titel: &str) -> String {
    format!("Erinnerung: Du hast noch nicht auf „{titel}“ geantwortet.")
}

/* ---------- Takt und Uhr --------------------------------------------------- */

/// Der Takt aus der Einstellung: `None` heisst ausgeschaltet. Das zweite ist,
/// ob der Wert geklemmt werden musste (dann sagt der Dienst es im Protokoll).
///
/// Geklemmt statt abgelehnt, weil ein Tippfehler im Takt den Start nicht
/// verhindern soll: Weder zu oft (Last) noch zu selten (die Fristen sind
/// Stunden) ist ein Grund, den Server nicht hochzufahren.
pub fn takt(sekunden: u64) -> Option<(Duration, bool)> {
    if sekunden == 0 {
        return None;
    }
    let geklemmt = sekunden.clamp(TAKT_MIN_S, TAKT_MAX_S);
    Some((Duration::from_secs(geklemmt), geklemmt != sekunden))
}

/// Die Uhr der Datenbank.
///
/// Im Betrieb rechnen alle Instanzen damit und nicht mit der eigenen Uhr –
/// Abweichungen zwischen Maschinen sind damit ausgeschlossen. Fällt die Abfrage
/// aus, gilt die Uhr dieses Rechners: Die Alternative wäre, den Durchgang
/// ausfallen zu lassen, und die nächste Abfrage scheitert dann ohnehin.
pub async fn datenbankzeit(pool: &PgPool) -> DateTime<Utc> {
    sqlx::query_scalar::<_, DateTime<Utc>>("select now()")
        .fetch_one(pool)
        .await
        .unwrap_or_else(|fehler| {
            tracing::warn!(%fehler, "Datenbankzeit nicht lesbar – es gilt die Uhr dieses Rechners");
            Utc::now()
        })
}

/* ---------- Der Durchgang -------------------------------------------------- */

/// Was ein Durchgang getan hat.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Bilanz {
    /// Neu beanspruchte Erinnerungen.
    pub beansprucht: usize,
    /// Davon (und von den nachgeholten) als Nachricht angelegt.
    pub zugestellt: usize,
    /// Offene Zeilen früherer Durchgänge, die jetzt zugestellt sind.
    pub nachgeholt: usize,
    /// Beansprucht, aber inzwischen nicht mehr gültig: wieder zurückgenommen.
    pub zurueckgenommen: usize,
    /// Zustellen schlug fehl; die Zeile bleibt offen.
    pub gescheitert: usize,
}

impl Bilanz {
    fn geschah_etwas(&self) -> bool {
        *self != Bilanz::default()
    }
}

/// Eine beanspruchte Erinnerung, die noch zuzustellen ist.
#[derive(Debug, Clone, sqlx::FromRow)]
struct Anspruch {
    /// Die Kennung der Zeile – und der Schlüssel der Nachricht.
    id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    nummer: i16,
    conversation_id: Uuid,
    title: String,
    created_by: Option<Uuid>,
}

/// Was aus einem Anspruch wurde.
enum Ausgang {
    Zugestellt(Uuid),
    Zurueckgenommen,
    Gescheitert,
}

/// Ein Durchgang: Offenes nachholen, Fälliges beanspruchen, zustellen, melden.
///
/// Jede Zeile für sich: Eine, die nicht zustellbar ist, hält die anderen nicht
/// auf. Fehler werden protokolliert (mit Kennungen, nie mit Titel oder Namen)
/// und nicht nach oben gereicht – der Dienst soll beim nächsten Takt wieder
/// versuchen, nicht sterben.
pub async fn durchgang(state: &AppState, jetzt: DateTime<Utc>) -> Bilanz {
    let mut bilanz = Bilanz::default();
    let mut ansprueche: Vec<(Anspruch, bool)> = Vec::new();

    match nachholen(&state.pool, jetzt).await {
        Ok(liste) => ansprueche.extend(liste.into_iter().map(|anspruch| (anspruch, true))),
        Err(fehler) => tracing::warn!(%fehler, "Offene Erinnerungen nicht lesbar"),
    }
    match beanspruchen(&state.pool, jetzt).await {
        Ok(liste) => {
            bilanz.beansprucht = liste.len();
            ansprueche.extend(liste.into_iter().map(|anspruch| (anspruch, false)));
        }
        Err(fehler) => {
            tracing::warn!(%fehler, "Fällige Erinnerungen nicht beanspruchbar");
        }
    }
    if ansprueche.is_empty() {
        return bilanz;
    }

    let ergebnisse: Vec<(Anspruch, bool, Ausgang)> = stream::iter(ansprueche)
        .map(|(anspruch, nachgeholt)| async move {
            let ausgang = zustellen(state, &anspruch).await;
            (anspruch, nachgeholt, ausgang)
        })
        .buffer_unordered(EINLADUNG_PARALLEL)
        .collect()
        .await;

    let mut erinnert: Vec<Erinnert> = Vec::new();
    let mut termine: Vec<Uuid> = Vec::new();
    for (anspruch, nachgeholt, ausgang) in ergebnisse {
        match ausgang {
            Ausgang::Zugestellt(nachricht) => {
                bilanz.zugestellt += 1;
                if nachgeholt {
                    bilanz.nachgeholt += 1;
                }
                if !termine.contains(&anspruch.event_id) {
                    termine.push(anspruch.event_id);
                }
                erinnert.push(Erinnert {
                    termin_id: anspruch.event_id,
                    titel: anspruch.title,
                    person: anspruch.user_id,
                    chat: anspruch.conversation_id,
                    nachricht,
                });
            }
            Ausgang::Zurueckgenommen => bilanz.zurueckgenommen += 1,
            Ausgang::Gescheitert => bilanz.gescheitert += 1,
        }
    }

    // Eine Mitteilung je Erinnerung, gebündelt und im Hintergrund.
    benachrichtige_erinnerungen(state, &erinnert).await;

    // Der Ersteller sieht in der Detailansicht, wie oft schon erinnert wurde:
    // Der Rundruf je Termin (einmal, nicht je Person) hält die Anzeige aktuell.
    for termin in termine {
        if let Err(fehler) = super::calendar::melde_termin(state, termin).await {
            tracing::warn!(%fehler, termin = %termin, "Termin nach Erinnerung nicht gemeldet");
        }
    }
    bilanz
}

/// Trägt die Fälligen ein – in **einer** Anweisung.
///
/// Was `on conflict` verliert, gehört einer anderen Instanz. Zwei Durchgänge,
/// die gleichzeitig dieselbe Auswahl sehen, versuchen beide, (Termin, Person, 1)
/// einzutragen: Die zweite Einfügung wartet auf die erste und überspringt die
/// Zeile, sobald diese festgeschrieben ist. Rollt die erste zurück, bekommt die
/// zweite sie.
///
/// Die Bedingungen, in der Reihenfolge der Regeln:
///
/// * **an**: `erinnern_nach_std` gesetzt; Termin nicht gelöscht, `confirmed`
///   (nicht in Abstimmung, nicht abgesagt), Ersteller vorhanden.
/// * **wer**: Status `pending`, nicht der Ersteller, **zugestellte** Einzelkarte,
///   beide noch im Einzelchat.
/// * **wann**: Fälligkeit erreicht, Anzahl nicht erreicht, und nicht in den
///   letzten Stunden vor dem Beginn. Ganztägige beginnen zwölf Stunden vor
///   `starts_at`: Der Editor legt sie auf 12:00 Ortszeit, und zwölf Stunden
///   früher ist der Tagesbeginn des Erstellers, ohne dass der Server die
///   Zeitzone kennt.
/// * **eine je Person**: Wer mehrere fällige Termine hat, bekommt sie in
///   aufeinanderfolgenden Durchgängen, nicht fünf auf einmal.
///
/// Nie nachgeholt „je versäumtem Abstand“: Die Beanspruchung setzt die Uhr auf
/// `jetzt`, nach einem Ausfall von fünf Tagen kommt **eine** Erinnerung.
async fn beanspruchen(pool: &PgPool, jetzt: DateTime<Utc>) -> AppResult<Vec<Anspruch>> {
    Ok(sqlx::query_as::<_, Anspruch>(
        "with kandidaten as (
           select e.id as event_id, a.user_id, p.conversation_id,
                  r.hoechste + 1 as nummer,
                  greatest(a.eingeladen_am, e.erinnern_seit, r.zuletzt)
                    + make_interval(hours => e.erinnern_nach_std) as faellig_am
             from calendar_events e
             join event_attendees a
               on a.event_id = e.id and a.status = 'pending' and a.user_id <> e.created_by
             join event_placements p
               on p.event_id = e.id and p.user_id = a.user_id
              and p.art = 'einzel' and p.message_id is not null
             join conversation_members mp
               on mp.conversation_id = p.conversation_id and mp.user_id = a.user_id
             join conversation_members me
               on me.conversation_id = p.conversation_id and me.user_id = e.created_by
             left join lateral (
               select count(*)::int as anzahl,
                      coalesce(max(x.nummer), 0)::int as hoechste,
                      max(x.beansprucht_am) as zuletzt
                 from event_erinnerungen x
                where x.event_id = a.event_id and x.user_id = a.user_id
             ) r on true
            where e.erinnern_nach_std is not null
              and e.deleted_at is null
              and e.status = 'confirmed'
              and e.created_by is not null
              and r.anzahl < least(coalesce(e.erinnern_anzahl, $2::int), $2::int)
              and $1::timestamptz <= e.starts_at
                    - case when e.all_day then interval '12 hours' else interval '0' end
                    - make_interval(hours => $3::int)
         ),
         je_person as (
           select distinct on (user_id) *
             from kandidaten
            where faellig_am <= $1::timestamptz
            order by user_id, faellig_am, event_id
         ),
         auswahl as (
           select * from je_person order by faellig_am, user_id limit $4::bigint
         ),
         beansprucht as (
           insert into event_erinnerungen
                  (id, event_id, user_id, nummer, conversation_id, beansprucht_am)
           select gen_random_uuid(), event_id, user_id, nummer, conversation_id,
                  $1::timestamptz
             from auswahl
           on conflict (event_id, user_id, nummer) do nothing
           returning id, event_id, user_id, nummer, conversation_id
         )
         select b.id, b.event_id, b.user_id, b.nummer, b.conversation_id,
                e.title, e.created_by
           from beansprucht b
           join calendar_events e on e.id = b.event_id
          order by b.user_id",
    )
    .bind(jetzt)
    .bind(ERINNERN_ANZAHL_MAX)
    .bind(ERINNERN_RESERVE_STD)
    .bind(STAPEL)
    .fetch_all(pool)
    .await?)
}

/// Holt offene Zeilen früherer Durchgänge zum Zustellen heran.
///
/// Offen heisst: beansprucht, aber die Nachricht fehlt – ein Absturz oder ein
/// Fehler beim Anlegen. Auch das Nachholen beansprucht atomar (`skip locked`
/// und Hochzählen in einer Anweisung): Zwei Instanzen holen nicht dieselbe
/// Zeile gleichzeitig nach. Zwei Minuten Mindestalter halten es von Zeilen fern,
/// die eine andere Instanz gerade zustellt. Höchstens dreimal, höchstens einen
/// Tag lang: Danach bleibt die Zeile liegen, damit ein dauerhafter Fehler keine
/// Dauerschleife wird.
async fn nachholen(pool: &PgPool, jetzt: DateTime<Utc>) -> AppResult<Vec<Anspruch>> {
    Ok(sqlx::query_as::<_, Anspruch>(
        "with offen as (
           select id from event_erinnerungen
            where message_id is null
              and versuche < $3::smallint
              and beansprucht_am <= $1::timestamptz - make_interval(mins => $4::int)
              and beansprucht_am >  $1::timestamptz - make_interval(hours => $5::int)
            order by beansprucht_am
            limit $2::bigint
              for update skip locked
         ),
         gezaehlt as (
           update event_erinnerungen z set versuche = z.versuche + 1
            where z.id in (select id from offen)
        returning z.id, z.event_id, z.user_id, z.nummer, z.conversation_id
         )
         select g.id, g.event_id, g.user_id, g.nummer, g.conversation_id,
                e.title, e.created_by
           from gezaehlt g
           join calendar_events e on e.id = g.event_id
          order by g.id",
    )
    .bind(jetzt)
    .bind(NACHHOLEN_STAPEL)
    .bind(NACHHOLEN_VERSUCHE)
    .bind(NACHHOLEN_ALTER_MIN)
    .bind(NACHHOLEN_GRENZE_STD)
    .fetch_all(pool)
    .await?)
}

/// Nimmt eine Beanspruchung zurück – nur solange noch keine Nachricht dran hängt.
async fn zuruecknehmen(pool: &PgPool, zeile: Uuid) {
    if let Err(fehler) =
        sqlx::query("delete from event_erinnerungen where id = $1 and message_id is null")
            .bind(zeile)
            .execute(pool)
            .await
    {
        tracing::warn!(%fehler, zeile = %zeile, "Beanspruchung nicht zurückgenommen");
    }
}

/// Gilt die Erinnerung noch? Zwischen Auswahl und Senden kann jemand geantwortet
/// haben, der Termin gelöscht oder abgesagt, das Erinnern ausgeschaltet oder
/// einer der beiden den Chat verlassen haben.
async fn gilt_noch(pool: &PgPool, anspruch: &Anspruch) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (
           select 1
             from event_attendees a
             join calendar_events e on e.id = a.event_id
            where a.event_id = $1 and a.user_id = $2 and a.status = 'pending'
              and e.deleted_at is null and e.status = 'confirmed'
              and e.erinnern_nach_std is not null
              and exists (select 1 from conversation_members m
                           where m.conversation_id = $3 and m.user_id = a.user_id)
              and exists (select 1 from conversation_members m
                           where m.conversation_id = $3 and m.user_id = e.created_by)
         )",
    )
    .bind(anspruch.event_id)
    .bind(anspruch.user_id)
    .bind(anspruch.conversation_id)
    .fetch_one(pool)
    .await
}

/// Stellt eine Erinnerung zu: prüfen, Nachricht anlegen, eintragen.
///
/// Scheitert das Anlegen, bleibt die Zeile offen – der Aufrufer zählt es, ein
/// späterer Durchgang holt sie nach. Eine Nachricht, deren Zeile bei der
/// Eintragung nicht mehr da ist (die Person wurde in der Zwischenzeit
/// ausgeladen), wird wieder zurückgenommen: Sie hinge an nichts und bliebe für
/// immer stehen.
async fn zustellen(state: &AppState, anspruch: &Anspruch) -> Ausgang {
    let Some(ersteller) = anspruch.created_by else {
        zuruecknehmen(&state.pool, anspruch.id).await;
        return Ausgang::Zurueckgenommen;
    };
    match gilt_noch(&state.pool, anspruch).await {
        Ok(true) => {}
        Ok(false) => {
            zuruecknehmen(&state.pool, anspruch.id).await;
            return Ausgang::Zurueckgenommen;
        }
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung nicht prüfbar"
            );
            return Ausgang::Gescheitert;
        }
    }

    let angelegt = match super::messages::create_message(
        state,
        super::messages::NewMessage::erinnerung(
            anspruch.conversation_id,
            ersteller,
            anspruch.event_id,
            anspruch.id,
            anspruch.nummer,
            &anspruch.title,
        ),
    )
    .await
    {
        Ok(nachricht) => nachricht,
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung konnte nicht zugestellt werden"
            );
            return Ausgang::Gescheitert;
        }
    };

    let eingetragen = sqlx::query_scalar::<_, Uuid>(
        "update event_erinnerungen set message_id = $2
          where id = $1 and message_id is null
      returning id",
    )
    .bind(anspruch.id)
    .bind(angelegt.id)
    .fetch_optional(&state.pool)
    .await;
    match eingetragen {
        Ok(Some(_)) => Ausgang::Zugestellt(angelegt.id),
        Ok(None) => {
            // Entweder war eine andere Instanz schneller (dieselbe Nachricht,
            // der Schlüssel ist fest), oder die Zeile ist weg.
            let vorhanden: Result<Option<Option<Uuid>>, _> =
                sqlx::query_scalar("select message_id from event_erinnerungen where id = $1")
                    .bind(anspruch.id)
                    .fetch_optional(&state.pool)
                    .await;
            match vorhanden {
                Ok(Some(Some(nachricht))) if nachricht == angelegt.id => {
                    Ausgang::Zugestellt(angelegt.id)
                }
                Ok(Some(_)) => Ausgang::Gescheitert,
                Ok(None) => {
                    verwaist_loeschen(state, angelegt.id).await;
                    Ausgang::Zurueckgenommen
                }
                Err(fehler) => {
                    tracing::warn!(
                        %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                        "Erinnerung nicht eingetragen"
                    );
                    Ausgang::Gescheitert
                }
            }
        }
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung nicht eingetragen"
            );
            Ausgang::Gescheitert
        }
    }
}

/// Nimmt eine Nachricht zurück, deren Zeile verschwunden ist.
async fn verwaist_loeschen(state: &AppState, nachricht: Uuid) {
    let ergebnis = async {
        let mut tx = state.pool.begin().await?;
        let geloescht = nachrichten_loeschen(&mut tx, &[nachricht]).await?;
        tx.commit().await?;
        Ok::<_, AppError>(geloescht)
    }
    .await;
    match ergebnis {
        Ok(geloescht) => super::einladen::karten_melden(state, geloescht).await,
        Err(fehler) => tracing::warn!(%fehler, "Verwaiste Erinnerung nicht zurückgenommen"),
    }
}

/* ---------- Der Dienst ------------------------------------------------------ */

/// Startet den Dienst. `None`: ausgeschaltet (`ERINNERN_TAKT_S=0`).
///
/// Jede Instanz darf laufen – wer eine Erinnerung beansprucht, entscheidet die
/// Datenbank. Jeder Durchgang läuft in einer **eigenen Aufgabe**: Eine Panik darin
/// beendet nur ihn, die Schleife läuft weiter. Ein Dienst, der bei einem
/// einzigen Fehler stirbt, fiele erst auf, wenn niemand mehr erinnert wird.
///
/// Kein Abbruchsignal (wie bei den anderen Diensten): Beim Herunterfahren stirbt
/// die Aufgabe mit der Laufzeit. Das ist sicher, weil Beanspruchen und Senden
/// wiederholbar sind.
pub fn starten(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    let Some((takt, geklemmt)) = takt(state.config.erinnern_takt_s) else {
        tracing::info!("Erinnerungsdienst ausgeschaltet (ERINNERN_TAKT_S=0)");
        return None;
    };
    if geklemmt {
        tracing::warn!(
            gewuenscht = state.config.erinnern_takt_s,
            takt_s = takt.as_secs(),
            "ERINNERN_TAKT_S liegt ausserhalb von {TAKT_MIN_S} bis {TAKT_MAX_S} Sekunden – geklemmt"
        );
    }
    tracing::info!(takt_s = takt.as_secs(), "Erinnerungsdienst läuft");

    Some(tokio::spawn(async move {
        tokio::time::sleep(ERSTER_DURCHGANG).await;
        loop {
            let fuer_durchgang = state.clone();
            let aufgabe = tokio::spawn(async move {
                let jetzt = datenbankzeit(&fuer_durchgang.pool).await;
                durchgang(&fuer_durchgang, jetzt).await
            });
            match aufgabe.await {
                Ok(bilanz) if bilanz.geschah_etwas() => {
                    tracing::info!(
                        beansprucht = bilanz.beansprucht,
                        zugestellt = bilanz.zugestellt,
                        nachgeholt = bilanz.nachgeholt,
                        zurueckgenommen = bilanz.zurueckgenommen,
                        gescheitert = bilanz.gescheitert,
                        "Erinnerungen"
                    );
                }
                Ok(_) => {}
                Err(fehler) => {
                    tracing::error!(%fehler, "Ein Durchgang des Erinnerungsdienstes ist abgebrochen");
                }
            }
            tokio::time::sleep(takt).await;
        }
    }))
}

/* ---------- Aufräumen ------------------------------------------------------- */

/// Nimmt die Erinnerungskarten zurück: Nachrichten als gelöscht markieren, Zeilen
/// entfernen.
///
/// `personen`: nur deren Zeilen (Ausladen); `None`: alle des Termins (Löschen).
/// Läuft in der Transaktion des Aufrufers, VOR dem Löschen der Teilnehmerzeile –
/// danach sind die Zeilen per Kaskade schon weg und mit ihnen die Kennung der
/// Nachricht. Die Zeilen werden zuerst gelöscht und gelten mit der Nachricht, die
/// sie **dabei** trugen: Trägt eine Zeile gerade erst durch eine laufende
/// Zustellung ihre Nachricht, wartet das Löschen auf deren Eintragung.
pub async fn erinnerungen_entfernen(
    tx: &mut Transaction<'_, Postgres>,
    termin: Uuid,
    personen: Option<&[Uuid]>,
) -> AppResult<Vec<Geloescht>> {
    let getragen: Vec<Option<Uuid>> = sqlx::query_scalar(
        "delete from event_erinnerungen
          where event_id = $1 and ($2::uuid[] is null or user_id = any($2))
      returning message_id",
    )
    .bind(termin)
    .bind(personen)
    .fetch_all(&mut **tx)
    .await?;
    let mut nachrichten: Vec<Uuid> = getragen.into_iter().flatten().collect();
    nachrichten.sort();
    nachrichten.dedup();
    nachrichten_loeschen(tx, &nachrichten).await
}

/* ---------- Der Stand für den Ersteller ------------------------------------ */

/// Wie weit das Erinnern eines Termins ist – nur für den Ersteller.
///
/// Zeigt die noch Ausstehenden mit der Zahl der angekommenen Erinnerungen, und
/// getrennt davon, wen der Dienst **nicht** erreichen kann (keine zugestellte
/// Einzelkarte, oder einer der beiden hat den Einzelchat verlassen). Sonst
/// wüsste der Ersteller nicht, warum bei manchem nichts ankommt.
pub async fn stand(pool: &PgPool, termin: &CalendarEventRow) -> AppResult<ErinnernStandDto> {
    let (Some(_), Some(ersteller)) = (termin.erinnern_nach_std, termin.created_by) else {
        return Ok(ErinnernStandDto::default());
    };
    let zeilen: Vec<(Uuid, bool, i64, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select a.user_id,
                (p.message_id is not null and mp.user_id is not null and me.user_id is not null),
                (select count(*) from event_erinnerungen x
                  where x.event_id = a.event_id and x.user_id = a.user_id
                    and x.message_id is not null),
                (select max(x.beansprucht_am) from event_erinnerungen x
                  where x.event_id = a.event_id and x.user_id = a.user_id
                    and x.message_id is not null)
           from event_attendees a
           left join event_placements p
             on p.event_id = a.event_id and p.user_id = a.user_id and p.art = 'einzel'
           left join conversation_members mp
             on mp.conversation_id = p.conversation_id and mp.user_id = a.user_id
           left join conversation_members me
             on me.conversation_id = p.conversation_id and me.user_id = $2
          where a.event_id = $1 and a.status = 'pending' and a.user_id <> $2
          order by a.eingeladen_am, a.user_id",
    )
    .bind(termin.id)
    .bind(ersteller)
    .fetch_all(pool)
    .await?;

    let mut personen = Vec::new();
    let mut ohne_einzelchat = Vec::new();
    for (person, erreichbar, gesendet, zuletzt) in zeilen {
        if erreichbar {
            personen.push(ErinnerterDto {
                user_id: person,
                gesendet,
                zuletzt_am: zuletzt,
            });
        } else {
            ohne_einzelchat.push(person);
        }
    }
    Ok(ErinnernStandDto {
        aktiv: true,
        hoechstens: hoechstens(termin.erinnern_anzahl.map(i32::from)),
        personen,
        ohne_einzelchat,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(ergebnis: AppResult<()>) -> String {
        match ergebnis {
            Err(AppError::Api { message, .. }) => message,
            anderes => panic!("erwartet war ein Fehler, nicht {anderes:?}"),
        }
    }

    #[test]
    fn die_grenzen_des_abstands() {
        assert_eq!(
            text(pruefen(11, Some(3))),
            "Die Erinnerung braucht mindestens 12 Stunden Abstand."
        );
        assert!(pruefen(12, Some(3)).is_ok());
        assert!(pruefen(720, Some(3)).is_ok());
        assert_eq!(
            text(pruefen(721, Some(3))),
            "Höchstens 30 Tage (720 Stunden) Abstand."
        );
        assert!(pruefen(0, None).is_err());
        assert!(pruefen(-5, None).is_err());
    }

    #[test]
    fn die_grenzen_der_anzahl() {
        assert_eq!(text(pruefen(24, Some(0))), "Mindestens eine Erinnerung.");
        assert!(pruefen(24, Some(1)).is_ok());
        assert!(pruefen(24, Some(10)).is_ok());
        assert_eq!(text(pruefen(24, Some(11))), "Höchstens 10 Erinnerungen.");
        assert_eq!(text(pruefen(24, Some(-1))), "Mindestens eine Erinnerung.");
        // „Bis zum Termin“ ist gültig – und wird gedeckelt.
        assert!(pruefen(24, None).is_ok());
    }

    fn e(nach_std: i32, anzahl: Option<i32>) -> Option<Erinnern> {
        Some(Erinnern { nach_std, anzahl })
    }

    #[test]
    fn die_uhr_startet_bei_jedem_unterschied_und_beim_einschalten_neu() {
        // Einschalten.
        assert!(uhr_neu_starten(None, e(48, Some(3)), false));
        // Abstand oder Anzahl geändert – auch auf „bis zum Termin“.
        assert!(uhr_neu_starten(e(48, Some(3)), e(24, Some(3)), false));
        assert!(uhr_neu_starten(e(48, Some(3)), e(48, Some(5)), false));
        assert!(uhr_neu_starten(e(48, Some(3)), e(48, None), false));
        // Wiederaufnahme nach einer Absage.
        assert!(uhr_neu_starten(e(48, Some(3)), e(48, Some(3)), true));
    }

    #[test]
    fn die_uhr_bleibt_stehen_wenn_nichts_anders_ist_und_beim_ausschalten() {
        assert!(!uhr_neu_starten(e(48, Some(3)), e(48, Some(3)), false));
        assert!(!uhr_neu_starten(None, None, false));
        // Aus: Es gibt keine Uhr, die man starten könnte – auch nicht bei Wiederaufnahme.
        assert!(!uhr_neu_starten(e(48, Some(3)), None, false));
        assert!(!uhr_neu_starten(None, None, true));
    }

    #[test]
    fn bis_zum_termin_heisst_hoechstens_zehn() {
        assert_eq!(hoechstens(None), 10);
        assert_eq!(hoechstens(Some(3)), 3);
        assert_eq!(hoechstens(Some(10)), 10);
        // Was die Prüfung nie durchlässt, deckelt die Rechnung trotzdem.
        assert_eq!(hoechstens(Some(99)), 10);
    }

    #[test]
    fn der_takt_ist_ausschaltbar_und_geklemmt() {
        assert_eq!(takt(0), None);
        assert_eq!(takt(300), Some((Duration::from_secs(300), false)));
        assert_eq!(takt(5), Some((Duration::from_secs(30), true)));
        assert_eq!(takt(30), Some((Duration::from_secs(30), false)));
        assert_eq!(takt(3600), Some((Duration::from_secs(3600), false)));
        assert_eq!(takt(99_999), Some((Duration::from_secs(3600), true)));
    }

    #[test]
    fn der_text_nennt_den_termin_und_keine_uhrzeit() {
        assert_eq!(
            erinnerungstext("Grillen"),
            "Erinnerung: Du hast noch nicht auf „Grillen“ geantwortet."
        );
    }

    #[test]
    fn eine_bilanz_ohne_ereignis_ist_leer() {
        assert!(!Bilanz::default().geschah_etwas());
        let bilanz = Bilanz {
            gescheitert: 1,
            ..Bilanz::default()
        };
        assert!(bilanz.geschah_etwas());
    }
}
