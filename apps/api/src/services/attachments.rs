use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{json_to_f32_vec, AttachmentRow};
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};

pub fn to_attachment_dto(row: &AttachmentRow, config: &Config) -> AttachmentDto {
    AttachmentDto {
        id: row.id,
        kind: row.kind.clone(),
        mime: row.mime.clone(),
        size: row.size,
        file_name: row.file_name.clone(),
        width: row.width,
        height: row.height,
        duration_ms: row.duration_ms,
        waveform: row.waveform.as_ref().map(json_to_f32_vec),
        preview_data_url: row.preview_data_url.clone(),
        url: config.media_url(&row.id),
        status: row.status.clone(),
        created_at: row.created_at,
    }
}

pub async fn load_by_message_ids(
    pool: &PgPool,
    message_ids: &[Uuid],
    config: &Config,
) -> AppResult<HashMap<Uuid, Vec<AttachmentDto>>> {
    let mut grouped: HashMap<Uuid, Vec<AttachmentDto>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments where message_id = any($1) order by created_at asc",
    )
    .bind(message_ids)
    .fetch_all(pool)
    .await?;

    for row in rows {
        if let Some(message_id) = row.message_id {
            grouped
                .entry(message_id)
                .or_default()
                .push(to_attachment_dto(&row, config));
        }
    }
    Ok(grouped)
}

pub async fn load_attachment(pool: &PgPool, id: Uuid) -> AppResult<AttachmentRow> {
    sqlx::query_as::<_, AttachmentRow>("select * from attachments where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Datei nicht gefunden"))
}

/// Ein Bild, das man als *eigenes* ausgibt, muss auch das eigene sein.
///
/// # Warum das nötig ist
///
/// Die Anhangskennung ist in dieser API bewusst der Schlüssel zur Datei
/// (`media.rs`: „capability URL"). Wer sie kennt, darf lesen. Genau deshalb
/// darf sie nicht zugleich ein Mittel sein, Rechte zu VERGEBEN.
///
/// Ohne diese Prüfung liess sich eine fremde Anhangskennung als eigenes
/// Profilbild oder als Bild einer Gruppe eintragen. Aus „wer die Kennung
/// kennt, sieht die Datei" wäre damit „jeder in dieser Gruppe sieht die
/// Datei" geworden – die Weitergabe eines fremden Bildes an einen ganzen
/// Kreis, mit einem PATCH und einer geratenen Kennung.
///
/// Für ein Profil- oder Gruppenbild ist die strenge Regel auch die richtige:
/// Der Client lädt es unmittelbar davor selbst hoch. Es gibt keinen
/// rechtmässigen Weg, hier auf eine fremde Datei zu zeigen. `collections.rs`
/// kennt für das Ablegen in einer Sammlung eine mildere Fassung
/// (`assert_may_use_attachment`) – dort ist das Weiterreichen ja der Zweck.
pub async fn require_eigener_anhang(
    pool: &PgPool,
    attachment_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    let anhang = load_attachment(pool, attachment_id).await?;
    if anhang.uploader_id == Some(user_id) {
        return Ok(());
    }
    // Bewusst „nicht gefunden" statt „verboten": Ob es eine Datei mit dieser
    // Kennung gibt, geht den Fragenden nichts an.
    Err(AppError::not_found("Datei nicht gefunden"))
}

/**
 * Darf diese Person diesen Anhang sehen?
 *
 * Die eine Frage, an der die Medienrouten hängen. Sie ist bewusst *eine*
 * Abfrage: Die Routen werden bei jedem Bild im Verlauf angefragt, und drei
 * Rundreisen zur Datenbank je Vorschaubild wären an der heissesten Stelle der
 * App genau der falsche Preis.
 *
 * # Die Regeln – und warum sie so lauten
 *
 * * **Eigenes** (`uploader_id`): immer. Auch bevor es irgendwo hängt.
 * * **An einer Nachricht**: wer JETZT im Gespräch ist. Bewusst die heutige
 *   Mitgliedschaft und kein `left_at`: Wer eine Gruppe verlässt, verliert den
 *   Zugriff auch auf das, was er dort einmal gesehen hat. Umgekehrt sieht ein
 *   neu Hinzugekommener den alten Verlauf – dieselbe Regel, die schon für die
 *   Nachrichten selbst gilt.
 * * **Profilbild**: jede angemeldete Person. Es ist das Bild, das man führt,
 *   damit andere einen erkennen; eine engere Regel hiesse, dass man in einer
 *   Suchliste vor lauter grauen Kreisen sässe.
 * * **Bild einer Gruppe**: wer in ihr ist.
 * * **Sticker**: wie jedes andere Medium – kein Freibrief. Aus einem
 *   öffentlichen Paket, aus einem eigenen, oder in einer Nachricht in einem
 *   Gespräch, in dem man ist. Die Verbindung Nachricht→Sticker steht nur im
 *   JSON (`metadata->>'stickerId'`), deshalb der Umweg über `stickers.id`.
 * * **In einer Sammlung**: was die Sammlung erlaubt – einschliesslich eines
 *   Rechts an genau dieser einen Datei.
 * * **Dokument an einem Termin**: wer den Termin sehen darf (Ersteller, Chat
 *   des Termins, oder eingeladen) – dieselbe Bedingung wie `assert_visible`
 *   im Kalender.
 */
pub async fn darf_anhang_sehen(
    pool: &PgPool,
    attachment_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    let erlaubt: bool = sqlx::query_scalar(
        r#"
select
  -- eigenes
  exists (select 1 from attachments a where a.id = $1 and a.uploader_id = $2)
  -- an einer Nachricht in einem Gespraech, in dem ich JETZT bin
  or exists (
    select 1 from attachments a
      join messages m on m.id = a.message_id
      join conversation_members cm on cm.conversation_id = m.conversation_id
     where a.id = $1 and cm.user_id = $2
  )
  -- Profilbild: fuer jede angemeldete Person
  or exists (select 1 from users u where u.avatar_attachment_id = $1)
  -- Bild einer Gruppe, in der ich bin
  or exists (
    select 1 from conversations c
      join conversation_members cm on cm.conversation_id = c.id
     where c.avatar_attachment_id = $1 and cm.user_id = $2
  )
  -- Sticker: oeffentliches Paket, eigenes Paket, oder in einer Nachricht
  -- eines Gespraechs, in dem ich bin
  or exists (
    select 1 from stickers s
      join sticker_packs p on p.id = s.pack_id
     where s.attachment_id = $1
       and (
         p.is_public
         or p.owner_id = $2
         or exists (
           select 1 from messages m
             join conversation_members cm on cm.conversation_id = m.conversation_id
            where cm.user_id = $2
              and m.metadata ->> 'stickerId' = s.id::text
         )
       )
  )
  -- in einer Sammlung, die ich sehen darf (geerbt ueber den Baum)
  or exists (
    with recursive wurzeln as (
      select c.id
        from collections c
       where c.deleted_at is null
         and (
           c.created_by = $2
           or exists (
             select 1 from collection_grants g
              where g.collection_id = c.id and g.user_id = $2
           )
           or exists (
             select 1 from collection_grants g
               join conversation_members m
                 on m.conversation_id = g.conversation_id and m.user_id = $2
              where g.collection_id = c.id and g.conversation_id is not null
           )
           or (
             c.member_level <> 'none'
             and exists (
               select 1 from conversation_members m
                where m.conversation_id = c.conversation_id and m.user_id = $2
             )
           )
         )
    ),
    baum as (
      select id from wurzeln
      union
      select c.id from collections c join baum b on c.parent_id = b.id
       where c.deleted_at is null
    )
    select 1 from collection_items i
     where i.attachment_id = $1
       and i.deleted_at is null
       and i.collection_id in (select id from baum)
  )
  -- oder ein Recht an genau dieser einen Datei
  or exists (
    select 1 from collection_items i
      join collection_grants g on g.item_id = i.id
     where i.attachment_id = $1
       and i.deleted_at is null
       and (
         g.user_id = $2
         or (
           g.conversation_id is not null
           and exists (
             select 1 from conversation_members m
              where m.conversation_id = g.conversation_id and m.user_id = $2
           )
         )
       )
  )
  -- Dokument an einem Termin, den ich sehen darf
  or exists (
    select 1 from event_attachments ea
      join calendar_events e on e.id = ea.event_id
     where ea.attachment_id = $1
       and (
         e.created_by = $2
         or exists (
           select 1 from conversation_members cm
            where cm.conversation_id = e.conversation_id and cm.user_id = $2
         )
         or exists (
           select 1 from event_attendees t
            where t.event_id = e.id and t.user_id = $2
         )
       )
  )
"#,
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(erlaubt)
}
