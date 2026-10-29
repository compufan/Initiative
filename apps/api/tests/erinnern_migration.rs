//! Migration 0024: Erinnern.
//!
//! Sie fügt dem Termin die Einstellung hinzu und legt die Tabelle an, die
//! festhält, was erinnert wurde. Was sie NICHT tun darf: Bestand verändern.
//! Alte Termine tragen danach keine Einstellung und bleiben stumm – ein Regen
//! von Nachrichten nach dem Einspielen wäre das Schlimmste, was hier passieren
//! könnte.
//!
//! Der Test baut den Stand VOR der Migration auf (alle Migrationen bis 0023, in
//! einem eigenen Schema wie `einladen_migration.rs`), legt Altbestand an und
//! führt 0024 aus – zweimal, denn sie muss wiederholbar sein.

use initiative_api::MIGRATOR;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;

    let admin = PgPool::connect(&url).await.ok()?;
    sqlx::query("drop schema if exists erinnertest cascade")
        .execute(&admin)
        .await
        .ok()?;
    sqlx::query("create schema erinnertest")
        .execute(&admin)
        .await
        .ok()?;
    admin.close().await;

    let optionen: PgConnectOptions = url.parse().ok()?;
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(optionen.options([("search_path", "erinnertest")]))
        .await
        .ok()
}

async fn nutzer(pool: &PgPool, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         values ($1, $2, $2, 'x', $3)",
    )
    .bind(id)
    .bind(name)
    .bind(Uuid::now_v7().to_string())
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn chat(pool: &PgPool, mitglieder: &[Uuid]) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, created_by) values ($1, 'direct', $2)")
        .bind(id)
        .bind(mitglieder[0])
        .execute(pool)
        .await
        .unwrap();
    for person in mitglieder {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id, role)
             values ($1, $2, 'member')",
        )
        .bind(id)
        .bind(person)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn termin(pool: &PgPool, ersteller: Uuid, titel: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into calendar_events (id, created_by, title, starts_at, ends_at)
         values ($1, $2, $3, now() + interval '5 days', now() + interval '5 days 1 hour')",
    )
    .bind(id)
    .bind(ersteller)
    .bind(titel)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn teilnehmer(pool: &PgPool, termin: Uuid, person: Uuid, status: &str) {
    sqlx::query("insert into event_attendees (event_id, user_id, status) values ($1, $2, $3)")
        .bind(termin)
        .bind(person)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
}

async fn zaehle(pool: &PgPool, anfrage: &str) -> i64 {
    sqlx::query_scalar(anfrage).fetch_one(pool).await.unwrap()
}

/// Ob die Anweisung an der Prüfbedingung scheitert.
async fn lehnt_ab(pool: &PgPool, anweisung: &str) -> bool {
    match sqlx::query(anweisung).execute(pool).await {
        Ok(_) => false,
        Err(sqlx::Error::Database(fehler)) => fehler.is_check_violation(),
        Err(anderer) => panic!("{anweisung}: {anderer}"),
    }
}

#[tokio::test]
async fn die_migration_laesst_den_bestand_stumm_ist_wiederholbar_und_haelt_ihre_regeln() {
    let Some(pool) = pool().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – Migrationstest übersprungen");
        return;
    };

    // ---- Der Stand vor 0024 ---------------------------------------------
    for migration in MIGRATOR.iter().filter(|migration| migration.version < 24) {
        sqlx::raw_sql(&migration.sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|fehler| panic!("Migration {}: {fehler}", migration.version));
    }

    let anna = nutzer(&pool, "anna").await;
    let bodo = nutzer(&pool, "bodo").await;
    let cleo = nutzer(&pool, "cleo").await;
    let ab = chat(&pool, &[anna, bodo]).await;

    // Altbestand: ein Termin mit Teilnehmern, einer ohne.
    let mit = termin(&pool, anna, "Mit Teilnehmern").await;
    teilnehmer(&pool, mit, anna, "yes").await;
    teilnehmer(&pool, mit, bodo, "pending").await;
    let ohne = termin(&pool, anna, "Ohne Teilnehmer").await;

    // ---- 0024, zweimal ----------------------------------------------------
    let erinnern = MIGRATOR
        .iter()
        .find(|migration| migration.version == 24)
        .expect("Migration 0024 fehlt");
    sqlx::raw_sql(&erinnern.sql)
        .execute(&pool)
        .await
        .expect("erster Lauf");

    // Nichts wurde zurückgefüllt: Bestandstermine tragen keine Einstellung.
    assert_eq!(
        zaehle(
            &pool,
            "select count(*) from calendar_events
              where erinnern_nach_std is not null or erinnern_anzahl is not null
                 or erinnern_seit is not null"
        )
        .await,
        0,
        "alte Termine bleiben stumm"
    );
    assert_eq!(
        zaehle(&pool, "select count(*) from event_erinnerungen").await,
        0
    );
    assert_eq!(
        zaehle(&pool, "select count(*) from calendar_events").await,
        2
    );

    // Der zweite Lauf ändert nichts.
    sqlx::raw_sql(&erinnern.sql)
        .execute(&pool)
        .await
        .expect("zweiter Lauf");
    assert_eq!(
        zaehle(&pool, "select count(*) from calendar_events").await,
        2
    );
    assert_eq!(
        zaehle(&pool, "select count(*) from event_attendees").await,
        2
    );

    // ---- Die Prüfbedingung: kein halber Zustand ---------------------------
    // Eine Anzahl ohne Abstand.
    assert!(
        lehnt_ab(
            &pool,
            &format!("update calendar_events set erinnern_anzahl = 3 where id = '{mit}'")
        )
        .await,
        "Anzahl ohne Abstand"
    );
    // Ein Abstand ohne Beginn der Uhr.
    assert!(
        lehnt_ab(
            &pool,
            &format!("update calendar_events set erinnern_nach_std = 24 where id = '{mit}'")
        )
        .await,
        "Abstand ohne Uhr"
    );
    // Eine Uhr ohne Abstand.
    assert!(
        lehnt_ab(
            &pool,
            &format!("update calendar_events set erinnern_seit = now() where id = '{mit}'")
        )
        .await,
        "Uhr ohne Abstand"
    );
    // Null und negative Zahlen bedeuten nichts.
    assert!(
        lehnt_ab(
            &pool,
            &format!(
                "update calendar_events set erinnern_nach_std = 0, erinnern_seit = now()
                  where id = '{mit}'"
            )
        )
        .await
    );
    assert!(
        lehnt_ab(
            &pool,
            &format!(
                "update calendar_events set erinnern_nach_std = 24, erinnern_anzahl = 0,
                        erinnern_seit = now() where id = '{mit}'"
            )
        )
        .await
    );
    // Ganz oder gar nicht: Das geht, mit und ohne Anzahl.
    sqlx::query(&format!(
        "update calendar_events set erinnern_nach_std = 24, erinnern_anzahl = 3,
                erinnern_seit = now() where id = '{mit}'"
    ))
    .execute(&pool)
    .await
    .expect("alles gesetzt");
    sqlx::query(&format!(
        "update calendar_events set erinnern_anzahl = null where id = '{mit}'"
    ))
    .execute(&pool)
    .await
    .expect("bis zum Termin");
    sqlx::query(&format!(
        "update calendar_events set erinnern_nach_std = null, erinnern_anzahl = null,
                erinnern_seit = null where id = '{mit}'"
    ))
    .execute(&pool)
    .await
    .expect("aus");

    // ---- Die Tabelle ------------------------------------------------------
    let nachricht = Uuid::now_v7();
    sqlx::query(
        "insert into messages (id, conversation_id, sender_id, type) values ($1, $2, $3, 'event')",
    )
    .bind(nachricht)
    .bind(ab)
    .bind(anna)
    .execute(&pool)
    .await
    .unwrap();
    let zeile = |nummer: i16, person: Uuid, termin: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "insert into event_erinnerungen
                   (id, event_id, user_id, nummer, conversation_id, beansprucht_am)
                 values ($1, $2, $3, $4, $5, now())",
            )
            .bind(Uuid::now_v7())
            .bind(termin)
            .bind(person)
            .bind(nummer)
            .bind(ab)
            .execute(&pool)
            .await
        }
    };
    zeile(1, bodo, mit).await.expect("erste Zeile");
    // Jede Nummer geht genau einmal an – das ist das Beanspruchen.
    let doppelt = zeile(1, bodo, mit).await;
    assert!(
        matches!(&doppelt, Err(sqlx::Error::Database(f)) if f.is_unique_violation()),
        "dieselbe Nummer zweimal: {doppelt:?}"
    );
    zeile(2, bodo, mit).await.expect("zweite Nummer");
    // Nummer null gibt es nicht, und wer nicht eingeladen ist, hat keine Zeile.
    assert!(zeile(0, bodo, mit).await.is_err());
    assert!(
        zeile(1, cleo, mit).await.is_err(),
        "ohne Teilnehmerzeile keine Erinnerung"
    );
    assert!(zeile(1, bodo, ohne).await.is_err());

    // Die Nachricht ist eine Verknüpfung, die die Zeile nicht festhält: Wird sie
    // hart gelöscht, bleibt die Zeile als offene stehen.
    sqlx::query("update event_erinnerungen set message_id = $1 where event_id = $2 and nummer = 1")
        .bind(nachricht)
        .bind(mit)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("delete from messages where id = $1")
        .bind(nachricht)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        zaehle(
            &pool,
            "select count(*) from event_erinnerungen where message_id is null"
        )
        .await,
        2,
        "beide Zeilen stehen noch, jetzt offen"
    );

    // Wer ausgeladen wird, verliert seine Zeilen – eine neue Einladung beginnt
    // bei null.
    sqlx::query("delete from event_attendees where event_id = $1 and user_id = $2")
        .bind(mit)
        .bind(bodo)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        zaehle(&pool, "select count(*) from event_erinnerungen").await,
        0,
        "die Kaskade räumt auf"
    );
    // Ebenso beim Löschen des Termins und des Chats.
    teilnehmer(&pool, mit, bodo, "pending").await;
    zeile(1, bodo, mit).await.expect("neu eingeladen: Nummer 1");
    sqlx::query("delete from conversations where id = $1")
        .bind(ab)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        zaehle(&pool, "select count(*) from event_erinnerungen").await,
        0,
        "ohne Chat keine Zeile"
    );

    sqlx::query("drop schema if exists erinnertest cascade")
        .execute(&pool)
        .await
        .ok();
}
