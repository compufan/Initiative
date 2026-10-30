//! Erinnerung vor dem Termin: der Server liefert `calendar_events.reminder_minutes`
//! („Erinnerung vor dem Termin“ im Editor) selbst aus – als Push an jeden
//! Empfänger und als stille Karte im Einzelchat. Bisher standen sie nur im
//! Kalenderabo (`ical.rs`, VALARM).
//!
//! Gebaut nach dem Muster von [`super::erinnern`] (Erinnerung an ausstehende
//! Antworten): Beanspruchen in **einer** Anweisung per eindeutigem Schlüssel und
//! `on conflict do nothing`, stille Karte, Mitteilung gebündelt im Hintergrund,
//! Aufräumen beim Ausladen/Löschen/Absagen. Den Takt, den ersten Durchgang und den
//! Schalter (`ERINNERN_TAKT_S`, 0 = aus) teilt es mit jenem Dienst: [`super::erinnern::starten`]
//! ruft je Takt zuerst diesen Durchgang auf, in einer eigenen Aufgabe.
//!
//! # Die Regeln
//!
//! **Fällig**: Termin nicht gelöscht, `confirmed`, und für jede Minutenzahl `m`
//! der Liste gilt `Bezug − m Minuten ≤ jetzt < Bezug`. Bezug ist `starts_at`;
//! bei ganztägigen Terminen `starts_at − ERINNERN_GANZTAG_BEZUG_STD` (dieselbe
//! Konstante wie beim Erinnern an Antworten: Tagesbeginn des Erstellers, ohne dass
//! der Server die Zeitzone kennt). `m ≤ 0` erinnert nie – ein Fenster der Länge null.
//!
//! **Nicht rückwirkend**: Der Termin muss vor der Fälligkeit angelegt worden sein
//! (`created_at ≤ Fälligkeit`). Wer einen Termin eine halbe Stunde vorher anlegt,
//! bekommt keine „in 1 Stunde“-Erinnerung dazu. Das gilt für die Anlage, nicht
//! für Änderungen: Ein später verschobener Termin erinnert zum neuen Beginn.
//!
//! **Nicht veraltet**: höchstens `VORAB_NACHFRIST_MIN` (60) Minuten nach der
//! Fälligkeit. Nach einem Ausfall kommt keine Erinnerung zu einem Termin, der
//! schon läuft. (Bei `ERINNERN_TAKT_S=3600` ist das Fenster genau ein Takt;
//! kürzer ist besser.)
//!
//! **Wer**: der Ersteller und alle Teilnehmer mit Status `yes`, `maybe`, `pending` –
//! nicht `no`. Ausgeladene sind keine Teilnehmer mehr.
//!
//! **Push** geht an jeden Empfänger, mit Vorschau-/Push-Einstellung und
//! Stummschaltung des Chats der Karte (siehe `notify::vorab_mitteilung`).
//!
//! **Karte** nur im Einzelchat Ersteller↔Teilnehmer, in dem die zugestellte
//! Einladungskarte liegt (`event_placements`, `art = 'einzel'`, beide noch
//! Mitglied). Wer keinen hat (der Ersteller selbst, Gruppen-only, Einzelchats beim
//! Einladen abgewählt): nur Push. Der Dienst legt keinen Chat an und schreibt
//! nie in den Gruppenchat.
//!
//! # Entscheidungen
//!
//! * **Schlüssel (Termin, Person, Minuten, Beginn)**: unverändert nie doppelt,
//!   verschoben erneut. Serien: nur der erste Beginn (`starts_at`), wie dort.
//! * **Kein Nachholen** offener Zeilen: Die Erinnerung ist zeitkritisch, ein
//!   Nachholen nach Minuten wäre veraltet. Scheitert nur die Karte, geht der Push
//!   trotzdem (dann mit Link zum Termin); gezählt als `gescheitert`.
//! * **Absagen und Löschen räumen auf**: Die Karten werden als gelöscht
//!   markiert, die Zeilen entfernt ([`vorab_entfernen`]) – anders als beim
//!   Erinnern an Antworten, wo die Karte der Absage stehen bleibt. Wird ein
//!   abgesagter Termin wieder aufgenommen und liegt noch im Fenster, erinnert er
//!   dann (die Zeilen sind ja weg); danach nicht mehr.
//! * **Zeilen bleiben** nach dem Termin liegen (Kaskade mit Termin/Person);
//!   das sind wenige kleine Zeilen.
//! * **Uhr als Parameter**, wie dort: [`durchgang`] sieht nicht selbst auf die
//!   Uhr; im Betrieb ist es die der Datenbank.

use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::constants::{EINLADUNG_PARALLEL, ERINNERN_GANZTAG_BEZUG_STD, VORAB_NACHFRIST_MIN};
use crate::error::AppResult;
use crate::state::AppState;

use super::einladen::{nachrichten_loeschen, Geloescht};
use super::notify::{benachrichtige_vorab, VorabErinnert};

/// Wie viele neue Erinnerungen ein Durchgang höchstens beansprucht (wie
/// `erinnern::STAPEL`: Rückstau wird abgebaut, nicht gestaut).
const STAPEL: i64 = 200;

/* ---------- Texte ---------------------------------------------------------- */

/// „1 Stunde“, „2 Stunden“, „10 Minuten“, „1 Tag“, „2 Tagen“ – im Dativ für
/// „beginnt in …“. Krumme Werte (90) bleiben in Minuten.
pub fn vorlauf_text(minuten: i32) -> String {
    if minuten > 0 && minuten % 1440 == 0 {
        let tage = minuten / 1440;
        return if tage == 1 {
            "1 Tag".to_string()
        } else {
            format!("{tage} Tagen")
        };
    }
    if minuten > 0 && minuten % 60 == 0 {
        let stunden = minuten / 60;
        return if stunden == 1 {
            "1 Stunde".to_string()
        } else {
            format!("{stunden} Stunden")
        };
    }
    if minuten == 1 {
        "1 Minute".to_string()
    } else {
        format!("{minuten} Minuten")
    }
}

/// Der Text der Karte – als Rückfall für ältere App-Stände und die Vorschau; die
/// Karte selbst formuliert die Oberfläche aus `metadata.erinnerung.minuten`.
/// Keine Uhrzeit darin – der Server kennt keine Zeitzone.
pub fn vorab_text(titel: &str, minuten: i32) -> String {
    format!(
        "Erinnerung: „{titel}“ beginnt in {}.",
        vorlauf_text(minuten)
    )
}

/* ---------- Der Durchgang -------------------------------------------------- */

/// Was ein Durchgang getan hat.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Bilanz {
    /// Neu beanspruchte Erinnerungen (je Person und Minutenzahl).
    pub beansprucht: usize,
    /// Davon als Karte im Einzelchat angelegt.
    pub karten: usize,
    /// Gesendet ohne Karte, weil es keinen Einzelchat gibt (nur Push).
    pub ohne_karte: usize,
    /// Beansprucht, aber inzwischen nicht mehr gültig: wieder zurückgenommen.
    pub zurueckgenommen: usize,
    /// Die Karte konnte nicht angelegt werden (der Push ging trotzdem), oder die
    /// Prüfung scheiterte (dann ging nichts).
    pub gescheitert: usize,
}

impl Bilanz {
    pub fn geschah_etwas(&self) -> bool {
        *self != Bilanz::default()
    }
}

/// Eine beanspruchte Erinnerung, die noch zuzustellen ist.
#[derive(Debug, Clone, sqlx::FromRow)]
struct Anspruch {
    /// Die Kennung der Zeile – und der Schlüssel der Karte.
    id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    minuten: i32,
    beginn: DateTime<Utc>,
    /// Der Einzelchat der Einladungskarte; leer: nur Push.
    conversation_id: Option<Uuid>,
    title: String,
    created_by: Option<Uuid>,
}

/// Was aus einem Anspruch wurde.
enum Ausgang {
    Gesendet {
        chat: Option<Uuid>,
        nachricht: Option<Uuid>,
        /// Es gab einen Chat, aber die Karte kam nicht an.
        karte_gescheitert: bool,
    },
    Zurueckgenommen,
    Gescheitert,
}

/// Ein Durchgang: Fälliges beanspruchen, Karten anlegen, Mitteilungen senden.
///
/// Jede Zeile für sich; Fehler werden protokolliert (mit Kennungen, nie mit
/// Titel oder Namen) und nicht nach oben gereicht – der Dienst versucht es im
/// nächsten Takt wieder, solange das Fenster offen ist.
pub async fn durchgang(state: &AppState, jetzt: DateTime<Utc>) -> Bilanz {
    let mut bilanz = Bilanz::default();
    let ansprueche = match beanspruchen(&state.pool, jetzt).await {
        Ok(liste) => liste,
        Err(fehler) => {
            tracing::warn!(%fehler, "Fällige Erinnerungen vor dem Termin nicht beanspruchbar");
            return bilanz;
        }
    };
    bilanz.beansprucht = ansprueche.len();
    if ansprueche.is_empty() {
        return bilanz;
    }

    let ergebnisse: Vec<(Anspruch, Ausgang)> = stream::iter(ansprueche)
        .map(|anspruch| async move {
            let ausgang = zustellen(state, &anspruch).await;
            (anspruch, ausgang)
        })
        .buffer_unordered(EINLADUNG_PARALLEL)
        .collect()
        .await;

    let mut erinnert: Vec<VorabErinnert> = Vec::new();
    for (anspruch, ausgang) in ergebnisse {
        match ausgang {
            Ausgang::Gesendet {
                chat,
                nachricht,
                karte_gescheitert,
            } => {
                if nachricht.is_some() {
                    bilanz.karten += 1;
                } else if karte_gescheitert {
                    bilanz.gescheitert += 1;
                } else {
                    bilanz.ohne_karte += 1;
                }
                erinnert.push(VorabErinnert {
                    termin_id: anspruch.event_id,
                    titel: anspruch.title,
                    minuten: anspruch.minuten,
                    person: anspruch.user_id,
                    chat,
                    nachricht,
                });
            }
            Ausgang::Zurueckgenommen => bilanz.zurueckgenommen += 1,
            Ausgang::Gescheitert => bilanz.gescheitert += 1,
        }
    }
    benachrichtige_vorab(state, &erinnert).await;
    bilanz
}

/// Trägt die Fälligen ein – in **einer** Anweisung.
///
/// Was `on conflict` verliert, gehört einer anderen Instanz. Schon beanspruchte
/// Schlüssel sind vor dem `limit` ausgeschlossen, sonst verdrängten die Zeilen
/// der letzten Stunde (sie bleiben im Fenster) die neuen aus dem Stapel.
///
/// `jsonb_array_elements` über `reminder_minutes`: Der Server schreibt dort nur
/// ganze Zahlen (`Vec<i32>`); Nicht-Zahlen und Nicht-Listen werden übergangen.
async fn beanspruchen(pool: &PgPool, jetzt: DateTime<Utc>) -> AppResult<Vec<Anspruch>> {
    Ok(sqlx::query_as::<_, Anspruch>(
        "with termine as (
           select e.id as event_id, e.title, e.created_by, e.created_at,
                  e.starts_at as beginn,
                  e.starts_at - case when e.all_day then make_interval(hours => $4::int)
                                     else interval '0' end as bezug,
                  (v #>> '{}')::int as minuten
             from calendar_events e
            cross join lateral jsonb_array_elements(
                    case when jsonb_typeof(e.reminder_minutes) = 'array'
                         then e.reminder_minutes else '[]'::jsonb end
                  ) as v
            where e.deleted_at is null and e.status = 'confirmed'
              and e.created_by is not null
              and jsonb_typeof(v) = 'number'
         ),
         faellig as (
           select t.*, t.bezug - make_interval(mins => t.minuten) as faellig_am
             from termine t
            where t.minuten > 0
         ),
         kandidaten as (
           select distinct f.event_id, r.user_id, f.minuten, f.beginn, f.title,
                  f.created_by, f.faellig_am
             from faellig f
             join lateral (
               select f.created_by as user_id
               union
               select a.user_id from event_attendees a
                where a.event_id = f.event_id and a.status in ('yes', 'maybe', 'pending')
             ) r on true
            where f.faellig_am <= $1::timestamptz
              and $1::timestamptz < f.bezug
              and f.created_at <= f.faellig_am
              and $1::timestamptz <= f.faellig_am + make_interval(mins => $3::int)
              and not exists (
                select 1 from event_vorab_erinnerungen x
                 where x.event_id = f.event_id and x.user_id = r.user_id
                   and x.minuten = f.minuten and x.beginn = f.beginn
              )
         ),
         auswahl as (
           select k.*, c.conversation_id
             from kandidaten k
             left join lateral (
               select p.conversation_id
                 from event_placements p
                where p.event_id = k.event_id and p.user_id = k.user_id
                  and p.art = 'einzel' and p.message_id is not null
                  and exists (select 1 from conversation_members m
                               where m.conversation_id = p.conversation_id
                                 and m.user_id = k.user_id)
                  and exists (select 1 from conversation_members m
                               where m.conversation_id = p.conversation_id
                                 and m.user_id = k.created_by)
             ) c on true
            order by k.faellig_am, k.user_id, k.event_id
            limit $2::bigint
         ),
         beansprucht as (
           insert into event_vorab_erinnerungen
                  (id, event_id, user_id, minuten, beginn, gesendet_am)
           select gen_random_uuid(), event_id, user_id, minuten, beginn, $1::timestamptz
             from auswahl
           on conflict (event_id, user_id, minuten, beginn) do nothing
           returning id, event_id, user_id, minuten, beginn
         )
         select b.id, b.event_id, b.user_id, b.minuten, b.beginn,
                a.conversation_id, a.title, a.created_by
           from beansprucht b
           join auswahl a
             on a.event_id = b.event_id and a.user_id = b.user_id
            and a.minuten = b.minuten and a.beginn = b.beginn
          order by b.user_id, b.minuten",
    )
    .bind(jetzt)
    .bind(STAPEL)
    .bind(VORAB_NACHFRIST_MIN)
    .bind(ERINNERN_GANZTAG_BEZUG_STD)
    .fetch_all(pool)
    .await?)
}

/// Nimmt eine Beanspruchung zurück – nur solange noch keine Karte dran hängt.
async fn zuruecknehmen(pool: &PgPool, zeile: Uuid) {
    if let Err(fehler) =
        sqlx::query("delete from event_vorab_erinnerungen where id = $1 and message_id is null")
            .bind(zeile)
            .execute(pool)
            .await
    {
        tracing::warn!(%fehler, zeile = %zeile, "Beanspruchung nicht zurückgenommen");
    }
}

/// Gilt die Erinnerung noch? `None`: nein. `Some(chat_ok)`: ja, und ob beide
/// noch im Einzelchat sind. Zwischen Auswahl und Senden kann der Termin gelöscht,
/// abgesagt oder verschoben, die Person ausgeladen oder abgesagt haben.
async fn gilt_noch(pool: &PgPool, anspruch: &Anspruch) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar(
        "select $3::uuid is not null
                and exists (select 1 from conversation_members m
                             where m.conversation_id = $3 and m.user_id = $2)
                and exists (select 1 from conversation_members m
                             where m.conversation_id = $3 and m.user_id = e.created_by)
           from calendar_events e
          where e.id = $1 and e.deleted_at is null and e.status = 'confirmed'
            and e.starts_at = $4::timestamptz
            and (e.created_by = $2
                 or exists (select 1 from event_attendees a
                             where a.event_id = e.id and a.user_id = $2
                               and a.status in ('yes', 'maybe', 'pending')))",
    )
    .bind(anspruch.event_id)
    .bind(anspruch.user_id)
    .bind(anspruch.conversation_id)
    .bind(anspruch.beginn)
    .fetch_optional(pool)
    .await
}

/// Stellt eine Erinnerung zu: prüfen, Karte anlegen (falls Einzelchat), eintragen.
///
/// Eine Karte, deren Zeile bei der Eintragung nicht mehr da ist (ausgeladen,
/// abgesagt, gelöscht), wird wieder zurückgenommen – sie hinge an nichts und
/// bliebe für immer stehen – und es geht auch kein Push.
async fn zustellen(state: &AppState, anspruch: &Anspruch) -> Ausgang {
    let chat_ok = match gilt_noch(&state.pool, anspruch).await {
        Ok(Some(chat_ok)) => chat_ok,
        Ok(None) => {
            zuruecknehmen(&state.pool, anspruch.id).await;
            return Ausgang::Zurueckgenommen;
        }
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung vor dem Termin nicht prüfbar"
            );
            return Ausgang::Gescheitert;
        }
    };
    let (Some(chat), Some(ersteller), true) =
        (anspruch.conversation_id, anspruch.created_by, chat_ok)
    else {
        return Ausgang::Gesendet {
            chat: None,
            nachricht: None,
            karte_gescheitert: false,
        };
    };

    let angelegt = match super::messages::create_message(
        state,
        super::messages::NewMessage::vorab_erinnerung(
            chat,
            ersteller,
            anspruch.event_id,
            anspruch.id,
            anspruch.minuten,
            &anspruch.title,
        ),
    )
    .await
    {
        Ok(nachricht) => nachricht,
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung vor dem Termin: Karte nicht angelegt"
            );
            return Ausgang::Gesendet {
                chat: None,
                nachricht: None,
                karte_gescheitert: true,
            };
        }
    };

    let eingetragen = sqlx::query_scalar::<_, Uuid>(
        "update event_vorab_erinnerungen set message_id = $2
          where id = $1 and message_id is null
      returning id",
    )
    .bind(anspruch.id)
    .bind(angelegt.id)
    .fetch_optional(&state.pool)
    .await;
    match eingetragen {
        Ok(Some(_)) => Ausgang::Gesendet {
            chat: Some(chat),
            nachricht: Some(angelegt.id),
            karte_gescheitert: false,
        },
        Ok(None) => {
            super::erinnern::verwaist_loeschen(state, angelegt.id).await;
            Ausgang::Zurueckgenommen
        }
        Err(fehler) => {
            tracing::warn!(
                %fehler, termin = %anspruch.event_id, person = %anspruch.user_id,
                "Erinnerung vor dem Termin nicht eingetragen"
            );
            Ausgang::Gesendet {
                chat: Some(chat),
                nachricht: Some(angelegt.id),
                karte_gescheitert: false,
            }
        }
    }
}

/* ---------- Aufräumen ------------------------------------------------------- */

/// Nimmt die Karten zurück: Nachrichten als gelöscht markieren, Zeilen entfernen.
///
/// `personen`: nur deren Zeilen (Ausladen); `None`: alle des Termins (Löschen und
/// Absagen). Läuft in der Transaktion des Aufrufers, wie
/// [`super::erinnern::erinnerungen_entfernen`]. Die Zeilen werden zuerst
/// gelöscht und gelten mit der Karte, die sie **dabei** trugen.
pub async fn vorab_entfernen(
    tx: &mut Transaction<'_, Postgres>,
    termin: Uuid,
    personen: Option<&[Uuid]>,
) -> AppResult<Vec<Geloescht>> {
    let getragen: Vec<Option<Uuid>> = sqlx::query_scalar(
        "delete from event_vorab_erinnerungen
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_vorlauf_steht_im_dativ() {
        assert_eq!(vorlauf_text(1), "1 Minute");
        assert_eq!(vorlauf_text(10), "10 Minuten");
        assert_eq!(vorlauf_text(45), "45 Minuten");
        assert_eq!(vorlauf_text(60), "1 Stunde");
        assert_eq!(vorlauf_text(120), "2 Stunden");
        assert_eq!(vorlauf_text(90), "90 Minuten");
        assert_eq!(vorlauf_text(1440), "1 Tag");
        assert_eq!(vorlauf_text(2880), "2 Tagen");
    }

    #[test]
    fn der_text_nennt_den_termin_und_keine_uhrzeit() {
        assert_eq!(
            vorab_text("Grillen", 1440),
            "Erinnerung: „Grillen“ beginnt in 1 Tag."
        );
    }

    #[test]
    fn eine_bilanz_ohne_ereignis_ist_leer() {
        assert!(!Bilanz::default().geschah_etwas());
        let bilanz = Bilanz {
            ohne_karte: 1,
            ..Bilanz::default()
        };
        assert!(bilanz.geschah_etwas());
    }
}
