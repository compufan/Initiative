//! Besitz und Leihe – wer etwas hat, wer es sehen darf, und **warum**.
//!
//! # Der Gedanke
//!
//! Jeder Gegenstand in dieser App hat einen Besitzer: den, der ihn angelegt
//! oder hochgeladen hat. Und er kann verliehen werden – an ein Gespräch, an
//! eine Sammlung, an die Eingeladenen eines Termins. Wer ihn sehen darf, ist
//! damit keine Frage der Kenntnis einer Kennung mehr, sondern eine Frage nach
//! einer Leihe.
//!
//! # Abgeleitet, nicht verbucht – und warum
//!
//! Naheliegend wäre eine Tabelle `leihen`: eine Zeile je Ausleihe, Rücknahme
//! heisst löschen. Das wäre gut nachzuschlagen und schlecht zu pflegen.
//! Jeder Beitritt zu einer Gruppe müsste Leihen für **jeden vergangenen**
//! Anhang nachtragen, jeder Austritt sie wieder einsammeln, und jede
//! vergessene Rücknahme wäre ein stiller, offener Zugriff. Doppelt geführter
//! Zustand läuft auseinander, und dieser hier liefe in die gefährliche
//! Richtung auseinander.
//!
//! Deshalb wird die Leihe **abgeleitet**: aus der Mitgliedschaft, die es
//! ohnehin gibt, aus den Rechten an einer Sammlung, aus der Einladung zu
//! einem Termin. Damit gilt sie immer genau jetzt – und der rückwirkende
//! Entzug beim Verlassen eines Gesprächs kostet keine Zeile Pflegearbeit.
//!
//! Was einer Tabelle voraus wäre, ist die Nachvollziehbarkeit. Genau die
//! liefert dieses Modul nach: nicht nur *ob*, sondern *warum* – und über
//! [`wer_sieht_anhang`] auch die Gegenrichtung, also den ganzen Kreis.

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppResult;

/// Woher ein Recht kommt. Die Antwort auf „warum darf ich das sehen?".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "art", rename_all = "camelCase")]
pub enum Grund {
    /// Selbst hochgeladen.
    Besitz,
    /// Hängt an einer Nachricht in einem Gespräch, in dem die Person ist.
    Gespraech { gespraech: Uuid },
    /// Profilbild – das sieht jede angemeldete Person.
    Profilbild,
    /// Bild einer Gruppe, in der die Person ist.
    Gruppenbild { gespraech: Uuid },
    /// Sticker aus einem öffentlichen Paket.
    StickerOeffentlich,
    /// Sticker aus einem eigenen Paket.
    StickerEigenesPaket,
    /// Sticker, der in einem Gespräch der Person verschickt wurde.
    StickerImGespraech { gespraech: Uuid },
    /// Liegt in einer Sammlung, die die Person sehen darf.
    Sammlung { sammlung: Uuid },
    /// Ausdrückliches Recht an genau dieser einen Datei.
    Einzelrecht,
    /// Dokument an einem Termin, den die Person sehen darf.
    Termin { termin: Uuid },
    /// Kein Recht.
    Keins,
}

impl Grund {
    /// Ein Satz, den man einem Menschen zeigen kann.
    pub fn satz(&self) -> String {
        match self {
            Grund::Besitz => "selbst hochgeladen".into(),
            Grund::Gespraech { .. } => "hängt an einer Nachricht in einem gemeinsamen Chat".into(),
            Grund::Profilbild => "ist ein Profilbild – das sieht jede angemeldete Person".into(),
            Grund::Gruppenbild { .. } => "ist das Bild einer gemeinsamen Gruppe".into(),
            Grund::StickerOeffentlich => "Sticker aus einem öffentlichen Paket".into(),
            Grund::StickerEigenesPaket => "Sticker aus dem eigenen Paket".into(),
            Grund::StickerImGespraech { .. } => "Sticker, der in einem gemeinsamen Chat kam".into(),
            Grund::Sammlung { .. } => "liegt in einer Sammlung mit Zugriff".into(),
            Grund::Einzelrecht => "ausdrücklich für genau diese Datei freigegeben".into(),
            Grund::Termin { .. } => "Dokument an einem Termin mit Zugriff".into(),
            Grund::Keins => "kein Zugriff".into(),
        }
    }

    pub fn erlaubt(&self) -> bool {
        !matches!(self, Grund::Keins)
    }
}

/// Was die Abfrage über einen Anhang und eine Person sagt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Auskunft {
    pub besitzer: Option<Uuid>,
    pub grund: Grund,
}

/// Eine Zeile aus der Datenbank: der Grund als Text plus der Bezug.
#[derive(Debug, sqlx::FromRow)]
struct GrundZeile {
    art: String,
    bezug: Option<Uuid>,
}

fn zu_grund(zeile: GrundZeile) -> Grund {
    match (zeile.art.as_str(), zeile.bezug) {
        ("besitz", _) => Grund::Besitz,
        ("gespraech", Some(id)) => Grund::Gespraech { gespraech: id },
        ("profilbild", _) => Grund::Profilbild,
        ("gruppenbild", Some(id)) => Grund::Gruppenbild { gespraech: id },
        ("sticker_oeffentlich", _) => Grund::StickerOeffentlich,
        ("sticker_eigenes", _) => Grund::StickerEigenesPaket,
        ("sticker_gespraech", Some(id)) => Grund::StickerImGespraech { gespraech: id },
        ("sammlung", Some(id)) => Grund::Sammlung { sammlung: id },
        ("einzelrecht", _) => Grund::Einzelrecht,
        ("termin", Some(id)) => Grund::Termin { termin: id },
        _ => Grund::Keins,
    }
}

/**
 * Darf diese Person diesen Anhang sehen – und warum?
 *
 * Eine Abfrage, weil sie vor jedem Bild im Verlauf steht. Die Zweige stehen in
 * der Reihenfolge, in der sie am billigsten und am häufigsten zutreffen; der
 * erste, der greift, gewinnt, und sein Name kommt als Grund zurück.
 *
 * Die Regeln selbst sind Entscheidungen, keine technischen Zwänge, und sie
 * stehen absichtlich an genau dieser einen Stelle:
 *
 * * **Gespräch** meint die HEUTIGE Mitgliedschaft UND die eigene
 *   Verlaufsgrenze: Wer austritt, verliert den Zugriff auch auf das, was er
 *   dort einmal gesehen hat; wer neu dazukommt, bekommt ihn nicht rückwirkend.
 * * **Profilbild** sieht jede angemeldete Person – sonst sässe man in einer
 *   Namensliste vor lauter grauen Kreisen.
 * * **Sticker** sind Medien wie andere und bekommen keinen Freibrief.
 */
pub async fn anhang(pool: &PgPool, attachment_id: Uuid, user_id: Uuid) -> AppResult<Auskunft> {
    let zeile = sqlx::query_as::<_, GrundZeile>(
        r#"
select art, bezug from (
  select 'besitz' as art, null::uuid as bezug, 0 as rang
    from attachments a where a.id = $1 and a.uploader_id = $2
  union all
  select 'gespraech', m.conversation_id, 1
    from attachments a
    join messages m on m.id = a.message_id
    join conversation_members cm on cm.conversation_id = m.conversation_id
   where a.id = $1 and cm.user_id = $2
     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
  union all
  select 'profilbild', null::uuid, 2
    from users u where u.avatar_attachment_id = $1
  union all
  select 'gruppenbild', c.id, 3
    from conversations c
    join conversation_members cm on cm.conversation_id = c.id
   where c.avatar_attachment_id = $1 and cm.user_id = $2
  union all
  select 'sticker_oeffentlich', null::uuid, 4
    from stickers s join sticker_packs p on p.id = s.pack_id
   where s.attachment_id = $1 and p.is_public
  union all
  select 'sticker_eigenes', null::uuid, 5
    from stickers s join sticker_packs p on p.id = s.pack_id
   where s.attachment_id = $1 and p.owner_id = $2
  union all
  select 'sticker_gespraech', m.conversation_id, 6
    from stickers s
    join messages m on m.metadata ->> 'stickerId' = s.id::text
    join conversation_members cm on cm.conversation_id = m.conversation_id
   where s.attachment_id = $1 and cm.user_id = $2
     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
  union all
  select 'sammlung', i.collection_id, 7
    from collection_items i
   where i.attachment_id = $1 and i.deleted_at is null
     and i.collection_id in (select sichtbare_sammlungen($2))
  union all
  select 'einzelrecht', null::uuid, 8
    from collection_items i
    join collection_grants g on g.item_id = i.id
   where i.attachment_id = $1 and i.deleted_at is null
     and (
       g.user_id = $2
       or (g.conversation_id is not null and exists (
             select 1 from conversation_members m
              where m.conversation_id = g.conversation_id and m.user_id = $2))
     )
  union all
  select 'termin', e.id, 9
    from event_attachments ea
    join calendar_events e on e.id = ea.event_id
   where ea.attachment_id = $1
     and (
       e.created_by = $2
       or exists (select 1 from conversation_members cm
                   where cm.conversation_id = e.conversation_id and cm.user_id = $2)
       or exists (select 1 from event_attendees t
                   where t.event_id = e.id and t.user_id = $2)
     )
) as gruende
order by rang
limit 1
"#,
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let besitzer: Option<Uuid> =
        sqlx::query_scalar("select uploader_id from attachments where id = $1")
            .bind(attachment_id)
            .fetch_optional(pool)
            .await?
            .flatten();

    Ok(Auskunft {
        besitzer,
        grund: zeile.map(zu_grund).unwrap_or(Grund::Keins),
    })
}

/// Eine Person im Kreis derer, die etwas sehen dürfen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leihe {
    pub person: Uuid,
    pub grund: Grund,
    /// Derselbe Grund in einem Satz – damit die Oberfläche nichts übersetzen muss.
    pub satz: String,
}

/// Der ganze Kreis um einen Anhang.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kreis {
    pub besitzer: Option<Uuid>,
    /// Wahr, wenn der Anhang für JEDE angemeldete Person sichtbar ist
    /// (Profilbild, öffentliches Sticker-Paket). Dann ist `leihen`
    /// unvollständig – eine Liste aller Konten wäre weder nützlich noch klug.
    pub alle_angemeldeten: bool,
    pub leihen: Vec<Leihe>,
}

/**
 * Die Gegenrichtung: Wer sieht diesen Anhang?
 *
 * Das ist der Teil, der einer Leihtabelle voraus wäre – und der Grund, warum
 * das Ableiten nichts kostet: Die Antwort wird gerechnet, wenn jemand fragt,
 * statt bei jeder Mitgliedsänderung nachgetragen zu werden.
 *
 * Bewusst keine heisse Route: Diese Abfrage darf teuer sein, sie läuft nur,
 * wenn ein Mensch wissen will, wer etwas sehen kann.
 */
pub async fn wer_sieht_anhang(pool: &PgPool, attachment_id: Uuid) -> AppResult<Kreis> {
    let besitzer: Option<Uuid> =
        sqlx::query_scalar("select uploader_id from attachments where id = $1")
            .bind(attachment_id)
            .fetch_optional(pool)
            .await?
            .flatten();

    let alle_angemeldeten: bool = sqlx::query_scalar(
        "select exists (select 1 from users where avatar_attachment_id = $1)
             or exists (select 1 from stickers s join sticker_packs p on p.id = s.pack_id
                         where s.attachment_id = $1 and p.is_public)",
    )
    .bind(attachment_id)
    .fetch_one(pool)
    .await?;

    let zeilen = sqlx::query_as::<_, (Uuid, String, Option<Uuid>)>(
        r#"
select person, art, bezug from (
  select a.uploader_id as person, 'besitz' as art, null::uuid as bezug, 0 as rang
    from attachments a where a.id = $1 and a.uploader_id is not null
  union all
  select cm.user_id, 'gespraech', m.conversation_id, 1
    from attachments a
    join messages m on m.id = a.message_id
    join conversation_members cm on cm.conversation_id = m.conversation_id
   where a.id = $1
     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
  union all
  select cm.user_id, 'gruppenbild', c.id, 3
    from conversations c
    join conversation_members cm on cm.conversation_id = c.id
   where c.avatar_attachment_id = $1
  union all
  select p.owner_id, 'sticker_eigenes', null::uuid, 5
    from stickers s join sticker_packs p on p.id = s.pack_id
   where s.attachment_id = $1 and p.owner_id is not null
  union all
  select cm.user_id, 'sticker_gespraech', m.conversation_id, 6
    from stickers s
    join messages m on m.metadata ->> 'stickerId' = s.id::text
    join conversation_members cm on cm.conversation_id = m.conversation_id
   where s.attachment_id = $1
     and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
  union all
  select p, 'sammlung', i.collection_id, 7
    from collection_items i,
         lateral wer_sieht_sammlung(i.collection_id) as p
   where i.attachment_id = $1 and i.deleted_at is null
  union all
  select g.user_id, 'einzelrecht', null::uuid, 8
    from collection_items i
    join collection_grants g on g.item_id = i.id
   where i.attachment_id = $1 and i.deleted_at is null and g.user_id is not null
  union all
  select m.user_id, 'einzelrecht', null::uuid, 8
    from collection_items i
    join collection_grants g on g.item_id = i.id
    join conversation_members m on m.conversation_id = g.conversation_id
   where i.attachment_id = $1 and i.deleted_at is null and g.conversation_id is not null
  union all
  select e.created_by, 'termin', e.id, 9
    from event_attachments ea join calendar_events e on e.id = ea.event_id
   where ea.attachment_id = $1 and e.created_by is not null
  union all
  select cm.user_id, 'termin', e.id, 9
    from event_attachments ea join calendar_events e on e.id = ea.event_id
    join conversation_members cm on cm.conversation_id = e.conversation_id
   where ea.attachment_id = $1
  union all
  select t.user_id, 'termin', e.id, 9
    from event_attachments ea join calendar_events e on e.id = ea.event_id
    join event_attendees t on t.event_id = e.id
   where ea.attachment_id = $1
) as kreis
order by person, rang
"#,
    )
    .bind(attachment_id)
    .fetch_all(pool)
    .await?;

    // Je Person nur der stärkste Grund – die Reihenfolge oben sortiert ihn
    // nach vorn.
    let mut gesehen: Vec<Uuid> = Vec::new();
    let mut leihen = Vec::new();
    for (person, art, bezug) in zeilen {
        if gesehen.contains(&person) {
            continue;
        }
        gesehen.push(person);
        let grund = zu_grund(GrundZeile { art, bezug });
        leihen.push(Leihe {
            person,
            satz: grund.satz(),
            grund,
        });
    }

    Ok(Kreis {
        besitzer,
        alle_angemeldeten,
        leihen,
    })
}
