//! Wer darf was – für Sammlungen, Dateien und alles, was daran hängt.
//!
//! Drei Stufen, aufsteigend: ansehen, ändern, besitzen. Sie werden vererbt:
//! eine Datei erbt von ihrer Sammlung, eine Sammlung von ihrem Elternordner.
//! Die höchste gefundene Stufe gewinnt – ein ausdrückliches Recht kann ein
//! geerbtes also erweitern, aber nie beschneiden.
//!
//! Bewusst allgemein gehalten: Ausgaben und Ereignisse brauchen dieselbe
//! Frage beantwortet, und zwei Rechtesysteme nebeneinander wären zwei
//! Gelegenheiten, sie unterschiedlich falsch zu beantworten.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Was jemand mit einem Eintrag tun darf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Kein Zugriff. Der Eintrag existiert für diese Person nicht.
    None,
    /// Ansehen und herunterladen.
    View,
    /// Zusätzlich hinzufügen, umbenennen, verschieben.
    Edit,
    /// Zusätzlich löschen und Rechte vergeben.
    Own,
}

impl Level {
    /// Die Reihenfolge als Zahl – so vergleicht die Datenbank die Stufen.
    pub fn rank(self) -> i32 {
        match self {
            Level::None => 0,
            Level::View => 1,
            Level::Edit => 2,
            Level::Own => 3,
        }
    }

    pub fn from_rank(rank: i32) -> Self {
        match rank {
            r if r >= 3 => Level::Own,
            2 => Level::Edit,
            1 => Level::View,
            _ => Level::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::View => "view",
            Level::Edit => "edit",
            Level::Own => "own",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Level::None),
            "view" => Some(Level::View),
            "edit" => Some(Level::Edit),
            "own" => Some(Level::Own),
            _ => None,
        }
    }

    /// Reicht diese Stufe für das Verlangte?
    pub fn allows(self, needed: Level) -> bool {
        self.rank() >= needed.rank()
    }
}

/// Die Kette von einer Sammlung bis zur Wurzel, gemeinsam für alle Abfragen.
///
/// `deleted_at is null` gilt für jedes Glied: Wer einen Elternordner löscht,
/// nimmt damit auch die Rechte an allem darunter zurück.
const KETTE: &str = "
with recursive kette as (
  select id, parent_id, conversation_id, member_level, created_by
    from collections
   where id = $1 and deleted_at is null
  union all
  select c.id, c.parent_id, c.conversation_id, c.member_level, c.created_by
    from collections c
    join kette k on c.id = k.parent_id
   where c.deleted_at is null
)";

/// Alle Quellen eines Rechts an dieser Kette, für eine Person.
const STUFEN: &str = "
stufen as (
  -- Ausdrücklich an die Person vergeben.
  select g.level
    from collection_grants g
    join kette k on g.collection_id = k.id
   where g.user_id = $2
  union all
  -- An alle in einem Chat vergeben, in dem die Person ist.
  select g.level
    from collection_grants g
    join kette k on g.collection_id = k.id
    join conversation_members m
      on m.conversation_id = g.conversation_id and m.user_id = $2
   where g.conversation_id is not null
  union all
  -- Mitglied des Chats, aus dem die Sammlung stammt.
  select k.member_level
    from kette k
    join conversation_members m
      on m.conversation_id = k.conversation_id and m.user_id = $2
   where k.member_level <> 'none'
  union all
  -- Wer sie angelegt hat, besitzt sie.
  select 'own' from kette k where k.created_by = $2
)";

const RANG: &str =
    "coalesce(max(case level when 'own' then 3 when 'edit' then 2 when 'view' then 1 else 0 end), 0)";

/// Welche Stufe hat diese Person an dieser Sammlung?
pub async fn collection_level(
    pool: &PgPool,
    collection_id: Uuid,
    user_id: Uuid,
) -> AppResult<Level> {
    let sql = format!("{KETTE}, {STUFEN} select {RANG}::int from stufen");
    let rank: i32 = sqlx::query_scalar(&sql)
        .bind(collection_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(Level::from_rank(rank))
}

/// Welche Stufe hat diese Person an dieser einzelnen Datei?
///
/// Geerbt von der Sammlung, erweiterbar durch ein Recht an der Datei selbst.
/// Wer sie hinzugefügt hat, besitzt sie – sonst könnte man das eigene
/// Hochgeladene nicht mehr entfernen, sobald einem der Ordner nicht gehört.
pub async fn item_level(pool: &PgPool, item_id: Uuid, user_id: Uuid) -> AppResult<Level> {
    let sql = format!(
        "
with ziel as (
  select id, collection_id, added_by from collection_items
   where id = $1 and deleted_at is null
),
eigen as (
  select g.level
    from collection_grants g
    join ziel z on g.item_id = z.id
   where g.user_id = $2
  union all
  select g.level
    from collection_grants g
    join ziel z on g.item_id = z.id
    join conversation_members m
      on m.conversation_id = g.conversation_id and m.user_id = $2
   where g.conversation_id is not null
  union all
  select 'own' from ziel z where z.added_by = $2
)
select {RANG}::int from eigen"
    );
    let eigener: i32 = sqlx::query_scalar(&sql)
        .bind(item_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;

    let collection_id: Option<Uuid> = sqlx::query_scalar(
        "select collection_id from collection_items where id = $1 and deleted_at is null",
    )
    .bind(item_id)
    .fetch_optional(pool)
    .await?;
    let geerbt = match collection_id {
        Some(id) => collection_level(pool, id, user_id).await?,
        None => Level::None,
    };

    Ok(Level::from_rank(eigener.max(geerbt.rank())))
}

/// Wie [`collection_level`], aber wirft, wenn es nicht reicht.
///
/// Fehlender Zugriff meldet 404, nicht 403: Wer eine Sammlung nicht sehen
/// darf, soll auch nicht erfahren, dass es sie gibt. Bei „darf sehen, aber
/// nicht ändern“ ist 403 richtig – da ist die Existenz ohnehin bekannt.
pub async fn require_collection(
    pool: &PgPool,
    collection_id: Uuid,
    user_id: Uuid,
    needed: Level,
) -> AppResult<Level> {
    let level = collection_level(pool, collection_id, user_id).await?;
    if level == Level::None {
        return Err(AppError::not_found("Sammlung nicht gefunden"));
    }
    if !level.allows(needed) {
        return Err(AppError::forbidden(match needed {
            Level::Own => "Dafür musst du die Sammlung besitzen",
            _ => "Du darfst diese Sammlung nur ansehen",
        }));
    }
    Ok(level)
}

/// Wie [`item_level`], aber wirft, wenn es nicht reicht.
pub async fn require_item(
    pool: &PgPool,
    item_id: Uuid,
    user_id: Uuid,
    needed: Level,
) -> AppResult<Level> {
    let level = item_level(pool, item_id, user_id).await?;
    if level == Level::None {
        return Err(AppError::not_found("Datei nicht gefunden"));
    }
    if !level.allows(needed) {
        return Err(AppError::forbidden("Du darfst diese Datei nur ansehen"));
    }
    Ok(level)
}

/// Die Kennungen aller Sammlungen, die diese Person mindestens ansehen darf.
///
/// Eine einzige Abfrage statt einer je Sammlung: bei ein paar hundert Ordnern
/// wären das sonst ein paar hundert Rundreisen zur Datenbank.
pub async fn visible_collection_ids(pool: &PgPool, user_id: Uuid) -> AppResult<Vec<Uuid>> {
    // Zuerst die Sammlungen mit einem unmittelbaren Recht, dann alles
    // darunter – Kinder erben von ihren Eltern.
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "
with recursive wurzeln as (
  select c.id
    from collections c
   where c.deleted_at is null
     and (
       c.created_by = $1
       or exists (
         select 1 from collection_grants g
          where g.collection_id = c.id and g.user_id = $1
       )
       or exists (
         select 1 from collection_grants g
          join conversation_members m
            on m.conversation_id = g.conversation_id and m.user_id = $1
          where g.collection_id = c.id and g.conversation_id is not null
       )
       or (
         c.member_level <> 'none'
         and exists (
           select 1 from conversation_members m
            where m.conversation_id = c.conversation_id and m.user_id = $1
         )
       )
     )
),
baum as (
  select id from wurzeln
  union
  select c.id
    from collections c
    join baum b on c.parent_id = b.id
   where c.deleted_at is null
)
select id from baum",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stufen_sind_geordnet() {
        assert!(Level::Own > Level::Edit);
        assert!(Level::Edit > Level::View);
        assert!(Level::View > Level::None);
    }

    #[test]
    fn allows_ist_aufsteigend() {
        // Wer besitzt, darf auch ansehen und ändern.
        assert!(Level::Own.allows(Level::View));
        assert!(Level::Own.allows(Level::Edit));
        assert!(Level::Own.allows(Level::Own));
        // Wer nur ansehen darf, darf nicht ändern.
        assert!(Level::View.allows(Level::View));
        assert!(!Level::View.allows(Level::Edit));
        assert!(!Level::View.allows(Level::Own));
        // Ohne Recht gar nichts.
        assert!(!Level::None.allows(Level::View));
    }

    #[test]
    fn rang_und_zurueck() {
        for level in [Level::None, Level::View, Level::Edit, Level::Own] {
            assert_eq!(Level::from_rank(level.rank()), level);
            assert_eq!(Level::parse(level.as_str()), Some(level));
        }
        // Unbekanntes fällt auf "kein Zugriff", nicht auf "darf alles".
        assert_eq!(Level::parse("administrator"), None);
        assert_eq!(Level::from_rank(-1), Level::None);
        assert_eq!(Level::from_rank(99), Level::Own);
    }
}
