//! Den Verlauf vor dem eigenen Beitritt beantragen – und freigeben.
//!
//! # Die Regel
//!
//! Wer neu dazukommt, sieht ab seinem Beitritt. Alles davor gehört denen, die
//! damals dabei waren; es gibt es auf Antrag, und **alle** anderen Mitglieder
//! müssen zustimmen. Ein einziges Nein genügt, und der Antrag ist erledigt –
//! wer nicht will, dass ein Neuer mitliest, soll das nicht begründen müssen
//! und auch nicht überstimmt werden können.
//!
//! # Was hier abgeleitet bleibt
//!
//! Wer zustimmen muss, wird beim **Auszählen** bestimmt und nicht beim Stellen
//! festgeschrieben. Tritt jemand während eines offenen Antrags bei, muss auch
//! er zustimmen; tritt jemand aus, zählt seine Stimme nicht mehr. Eine beim
//! Stellen eingefrorene Liste hätte die bekannte Schwäche: Sie geht mit der
//! Wirklichkeit auseinander, und zwar in die öffnende Richtung.
//!
//! # Was hier verbucht wird – und warum das kein Widerspruch ist
//!
//! Die Freigabe selbst ist ein `update` auf **eine** Spalte einer
//! Mitgliedschaft (`sieht_ab`). Verliehen wird der Behälter, nicht sein
//! Inhalt: Ob im Gespräch zehn oder zehntausend Nachrichten liegen, kostet
//! dasselbe. Genau daran scheiterte der Gedanke einer Tabelle mit einer Zeile
//! je Nachricht.

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Wie lange ein abgelehnter Antrag nachwirkt, bevor erneut gefragt werden
/// darf. Ein Tag: lang genug, dass Nachfassen Absicht verlangt, kurz genug,
/// dass ein Sinneswandel in der Gruppe nicht wochenlang wirkungslos bleibt.
const SPERRE_NACH_ABLEHNUNG: chrono::TimeDelta = chrono::TimeDelta::hours(24);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Antrag {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub antragsteller: Uuid,
    pub status: String,
    /// Wer noch nicht abgestimmt hat – aus der HEUTIGEN Mitgliederliste.
    pub offen_bei: Vec<Uuid>,
    pub zugestimmt: Vec<Uuid>,
    pub abgelehnt: Vec<Uuid>,
}

#[derive(Debug, sqlx::FromRow)]
struct AntragZeile {
    id: Uuid,
    conversation_id: Uuid,
    antragsteller: Uuid,
    status: String,
}

/// Die Stimmen eines Antrags, aufgeteilt nach der heutigen Mitgliederliste.
async fn stimmen(pool: &PgPool, zeile: &AntragZeile) -> AppResult<Antrag> {
    let mitglieder: Vec<Uuid> = sqlx::query_scalar(
        "select user_id from conversation_members
          where conversation_id = $1 and user_id <> $2",
    )
    .bind(zeile.conversation_id)
    .bind(zeile.antragsteller)
    .fetch_all(pool)
    .await?;

    let abgegeben: Vec<(Uuid, bool)> =
        sqlx::query_as("select user_id, zustimmung from verlaufsstimmen where antrag_id = $1")
            .bind(zeile.id)
            .fetch_all(pool)
            .await?;

    let mut zugestimmt = Vec::new();
    let mut abgelehnt = Vec::new();
    let mut offen_bei = Vec::new();
    for person in mitglieder {
        match abgegeben.iter().find(|(id, _)| *id == person) {
            Some((_, true)) => zugestimmt.push(person),
            Some((_, false)) => abgelehnt.push(person),
            None => offen_bei.push(person),
        }
    }

    Ok(Antrag {
        id: zeile.id,
        conversation_id: zeile.conversation_id,
        antragsteller: zeile.antragsteller,
        status: zeile.status.clone(),
        offen_bei,
        zugestimmt,
        abgelehnt,
    })
}

/// Einen Antrag stellen. Wer schon alles sieht, braucht keinen.
pub async fn stellen(pool: &PgPool, conversation_id: Uuid, user_id: Uuid) -> AppResult<Antrag> {
    let grenze: Option<Option<chrono::DateTime<chrono::Utc>>> = sqlx::query_scalar(
        "select sieht_ab from conversation_members where conversation_id = $1 and user_id = $2",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    let Some(grenze) = grenze else {
        return Err(AppError::forbidden("Du bist nicht in diesem Chat"));
    };
    let Some(grenze) = grenze else {
        return Err(AppError::conflict("Du siehst den Verlauf bereits"));
    };

    /*
     * Eine gesetzte Grenze heisst nicht, dass dahinter etwas liegt.
     *
     * Auch wer ein Gespräch gründet, bekommt eine – die Regel lautet überall
     * „du siehst ab jetzt". Ohne diese Prüfung könnte er einen Antrag stellen,
     * über den alle anderen abstimmen, um ihm ein leeres Nichts freizugeben.
     */
    let verdeckt: bool = sqlx::query_scalar(
        "select exists (
           select 1 from messages
            where conversation_id = $1 and deleted_at is null and created_at < $2
         )",
    )
    .bind(conversation_id)
    .bind(grenze)
    .fetch_one(pool)
    .await?;
    if !verdeckt {
        return Err(AppError::conflict("Vor deinem Beitritt liegt hier nichts"));
    }

    // Alleine im Gespräch gibt es niemanden zu fragen – dann wäre ein Antrag
    // eine Abstimmung ohne Wähler, die nie zustande käme.
    let andere: i64 = sqlx::query_scalar(
        "select count(*) from conversation_members
          where conversation_id = $1 and user_id <> $2",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if andere == 0 {
        return Err(AppError::conflict("In diesem Chat ist sonst niemand"));
    }

    // Ein Nein muss halten.
    //
    // Solange es den Knopf nur in der Schnittstelle gab, war das Nachfassen
    // Handarbeit; mit einem Knopf in der App ist es ein Fingertipp, und jeder
    // neue Antrag legt allen anderen wieder ein Band über den Chat. Wer
    // abgelehnt wurde, wartet deshalb, bevor er erneut fragt. Zurückgezogene
    // Anträge zählen hier nicht – die hat man sich selbst versagt.
    let abgelehnt_am: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "select max(entschieden_at) from verlaufsantraege
          where conversation_id = $1 and antragsteller = $2 and status = 'abgelehnt'",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if let Some(am) = abgelehnt_am {
        let vergangen = chrono::Utc::now() - am;
        if vergangen < SPERRE_NACH_ABLEHNUNG {
            let stunden = (SPERRE_NACH_ABLEHNUNG - vergangen).num_hours() + 1;
            return Err(AppError::conflict(format!(
                "Dein Antrag wurde abgelehnt. Du kannst in {stunden} Stunden erneut fragen."
            )));
        }
    }

    let zeile = sqlx::query_as::<_, AntragZeile>(
        "insert into verlaufsantraege (id, conversation_id, antragsteller)
         values ($1, $2, $3)
         on conflict (conversation_id, antragsteller) where status = 'offen'
         do update set created_at = verlaufsantraege.created_at
         returning id, conversation_id, antragsteller, status",
    )
    .bind(Uuid::now_v7())
    .bind(conversation_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    stimmen(pool, &zeile).await
}

/// Abstimmen – und bei Bedarf gleich entscheiden.
///
/// Gibt den Antrag in seinem neuen Zustand zurück. Wurde er angenommen, ist
/// `sieht_ab` in derselben Transaktion schon gefallen: Ein Antrag, der als
/// angenommen gilt, aber noch nichts freigegeben hat, wäre ein Zustand, in dem
/// niemand weiss, woran er ist.
pub async fn abstimmen(
    pool: &PgPool,
    antrag_id: Uuid,
    user_id: Uuid,
    zustimmung: bool,
) -> AppResult<Antrag> {
    let mut tx = pool.begin().await?;

    let zeile = sqlx::query_as::<_, AntragZeile>(
        "select id, conversation_id, antragsteller, status
           from verlaufsantraege where id = $1 for update",
    )
    .bind(antrag_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Antrag nicht gefunden"))?;

    if zeile.status != "offen" {
        return Err(AppError::conflict("Über diesen Antrag ist schon entschieden"));
    }
    if zeile.antragsteller == user_id {
        return Err(AppError::forbidden("Über den eigenen Antrag stimmt man nicht ab"));
    }
    let dabei: bool = sqlx::query_scalar(
        "select exists (select 1 from conversation_members
                         where conversation_id = $1 and user_id = $2)",
    )
    .bind(zeile.conversation_id)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !dabei {
        return Err(AppError::forbidden("Du bist nicht in diesem Chat"));
    }

    sqlx::query(
        "insert into verlaufsstimmen (antrag_id, user_id, zustimmung) values ($1, $2, $3)
         on conflict (antrag_id, user_id) do update set zustimmung = excluded.zustimmung",
    )
    .bind(antrag_id)
    .bind(user_id)
    .bind(zustimmung)
    .execute(&mut *tx)
    .await?;

    // Ein Nein entscheidet sofort. Sonst: Zählen, ob alle dafür sind.
    let (neuer_status, freigeben) = if !zustimmung {
        ("abgelehnt", false)
    } else {
        let fehlend: i64 = sqlx::query_scalar(
            "select count(*) from conversation_members m
              where m.conversation_id = $1
                and m.user_id <> $2
                and not exists (
                  select 1 from verlaufsstimmen s
                   where s.antrag_id = $3 and s.user_id = m.user_id and s.zustimmung
                )",
        )
        .bind(zeile.conversation_id)
        .bind(zeile.antragsteller)
        .bind(antrag_id)
        .fetch_one(&mut *tx)
        .await?;
        if fehlend == 0 {
            ("angenommen", true)
        } else {
            ("offen", false)
        }
    };

    if neuer_status != "offen" {
        sqlx::query(
            "update verlaufsantraege set status = $2, entschieden_at = now() where id = $1",
        )
        .bind(antrag_id)
        .bind(neuer_status)
        .execute(&mut *tx)
        .await?;
    }

    if freigeben {
        // Der ganze Verlauf mit einem Federstrich – eine Zeile, unabhängig
        // davon, wie viel darin liegt.
        sqlx::query(
            "update conversation_members set sieht_ab = null
              where conversation_id = $1 and user_id = $2",
        )
        .bind(zeile.conversation_id)
        .bind(zeile.antragsteller)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let zeile = AntragZeile {
        status: neuer_status.to_string(),
        ..zeile
    };
    stimmen(pool, &zeile).await
}

/// Den eigenen Antrag zurückziehen.
pub async fn zurueckziehen(pool: &PgPool, antrag_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let betroffen = sqlx::query(
        "update verlaufsantraege set status = 'zurueckgezogen', entschieden_at = now()
          where id = $1 and antragsteller = $2 and status = 'offen'",
    )
    .bind(antrag_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    if betroffen.rows_affected() == 0 {
        return Err(AppError::not_found("Antrag nicht gefunden"));
    }
    Ok(())
}

/// Die offenen Anträge eines Gesprächs – für alle, die darin sind.
pub async fn offene(pool: &PgPool, conversation_id: Uuid) -> AppResult<Vec<Antrag>> {
    let zeilen = sqlx::query_as::<_, AntragZeile>(
        "select id, conversation_id, antragsteller, status
           from verlaufsantraege
          where conversation_id = $1 and status = 'offen'
          order by created_at",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    let mut antraege = Vec::with_capacity(zeilen.len());
    for zeile in &zeilen {
        antraege.push(stimmen(pool, zeile).await?);
    }
    Ok(antraege)
}

/**
 * Darf diese Person diese eine Nachricht sehen?
 *
 * Für die Wege, die nicht über die Liste gehen – eine Nachricht über ihre
 * Kennung, ein Zitat, eine Reaktion. Die Liste selbst filtert in SQL, weil
 * dort das Blättern an der Zeilenzahl hängt; hier genügt die Einzelfrage.
 *
 * Enthält die Mitgliedschaft gleich mit: Wer gar nicht im Gespräch ist, sieht
 * ohnehin nichts, und zwei getrennte Prüfungen wären zwei Gelegenheiten, eine
 * davon zu vergessen.
 */
pub async fn darf_nachricht_sehen(
    pool: &PgPool,
    message_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    let erlaubt: bool = sqlx::query_scalar(
        "select exists (
           select 1 from messages m
             join conversation_members cm on cm.conversation_id = m.conversation_id
            where m.id = $1
              and cm.user_id = $2
              and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
         )",
    )
    .bind(message_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(erlaubt)
}

/// Wer von den Mitgliedern darf diese Nachricht sehen?
///
/// Für Ereignisse, die an ein Gespräch gehen und eine Nachricht betreffen –
/// eine Reaktion etwa. Ohne diese Einschränkung bekäme ein Neuzugang die
/// Kennung einer Nachricht gemeldet, die er nie sehen darf.
pub async fn empfaenger_fuer_nachricht(pool: &PgPool, message_id: Uuid) -> AppResult<Vec<Uuid>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select cm.user_id
           from messages m
           join conversation_members cm on cm.conversation_id = m.conversation_id
          where m.id = $1
            and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(ids)
}
