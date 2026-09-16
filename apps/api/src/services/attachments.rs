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
        prioritaet: row.prioritaet.clone(),
        ablage: row.ablage.clone(),
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
 * Die Regel selbst steht in [`crate::services::zugriff`] – dort zusammen mit
 * dem GRUND, aus dem sie greift, und mit der Gegenrichtung („wer sieht das
 * hier?"). Hier bleibt nur der Name, unter dem die Medienroute fragt: Sie will
 * ja bloss ja oder nein wissen.
 */
pub async fn darf_anhang_sehen(
    pool: &PgPool,
    attachment_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    Ok(
        crate::services::zugriff::anhang(pool, attachment_id, user_id)
            .await?
            .grund
            .erlaubt(),
    )
}

/**
 * Darf diese Person an dieser Datei etwas ÄNDERN?
 *
 * Sehen und ändern sind zwei Fragen. Wer ein Foto in einem Chat sieht, darf es
 * ansehen, weitergeben, auf den Fernseher werfen – aber nicht bestimmen, wo es
 * gespeichert wird. Sonst stellte ein Gruppenmitglied die Urlaubsbilder eines
 * anderen auf „niedrig", und sie wanderten auf den langsamen Speicher.
 *
 * Zwei Wege führen zu einem Ja:
 *
 * **Selbst hochgeladen.** Dann gehört die Datei einem, überall.
 *
 * **Änderungsrecht auf einem Sammlungseintrag, der sie enthält.** Das ist der
 * Weg, den der Anwender meint, wenn er sagt, man solle „in einer Sammlung"
 * Prioritäten vergeben können: Wer den Ordner pflegen darf, darf auch
 * entscheiden, was davon schnell erreichbar bleiben muss.
 *
 * Eine weitergegebene Kopie zählt wie ihr Original (`coalesce(quelle_id, id)`),
 * denn es sind dieselben Bytes: Was man an der Kopie einstellt, gilt für beide,
 * also muss man beides dürfen.
 *
 * Die Stufe selbst kommt aus [`crate::services::permissions::item_level`] und
 * wird hier NICHT noch einmal in SQL formuliert. Es gab schon einmal drei
 * Fassungen dieser Regel in dieser Codebasis, und sie waren unterschiedlich
 * falsch.
 */
pub async fn darf_anhang_verwalten(
    pool: &PgPool,
    attachment_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    let wurzel: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "select coalesce(quelle_id, id), uploader_id from attachments where id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    let Some((wurzel, _)) = wurzel else {
        return Ok(false);
    };

    let ist_eigen: Option<(Uuid,)> =
        sqlx::query_as("select id from attachments where id = $1 and uploader_id = $2")
            .bind(wurzel)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if ist_eigen.is_some() {
        return Ok(true);
    }

    /*
     * Die Obergrenze ist keine Sparmassnahme, sondern eine Schranke: Eine
     * Datei kann in beliebig vielen Sammlungen liegen, und jede Stufe kostet
     * zwei Abfragen. Wer in den ersten fünfzig Einträgen kein Änderungsrecht
     * hat, hat auch im einundfünfzigsten keines, das anders zustande käme.
     */
    let eintraege: Vec<(Uuid,)> = sqlx::query_as(
        "select id from collection_items
          where attachment_id = $1 and deleted_at is null
          order by created_at asc
          limit 50",
    )
    .bind(wurzel)
    .fetch_all(pool)
    .await?;
    for (item_id,) in eintraege {
        let stufe = crate::services::permissions::item_level(pool, item_id, user_id).await?;
        if stufe.allows(crate::services::permissions::Level::Edit) {
            return Ok(true);
        }
    }
    Ok(false)
}
