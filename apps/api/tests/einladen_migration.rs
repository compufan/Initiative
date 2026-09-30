//! Migration 0023: Einladen.
//!
//! Sie ändert, wer einen Termin sieht: Bisher gab der Chat Zugang, jetzt nur
//! noch die Teilnehmerzeile. Damit niemand seinen Termin verliert, muss die
//! Migration die heutigen Chatmitglieder zu Teilnehmern machen – und die
//! vorhandenen Karten in die neue Tabelle eintragen, aus den Nachrichten
//! selbst, denn `calendar_events.message_id` kennt nur die erste.
//!
//! Der Test baut den Stand VOR der Migration auf (alle Migrationen bis 0022, in
//! einem eigenen Schema wie `migrationen.rs`), legt Altbestand an und führt 0023
//! aus – zweimal, denn sie muss wiederholbar sein.

use initiative_api::MIGRATOR;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;

    let admin = PgPool::connect(&url).await.ok()?;
    sqlx::query("drop schema if exists einladentest cascade")
        .execute(&admin)
        .await
        .ok()?;
    sqlx::query("create schema einladentest")
        .execute(&admin)
        .await
        .ok()?;
    admin.close().await;

    let optionen: PgConnectOptions = url.parse().ok()?;
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(optionen.options([("search_path", "einladentest")]))
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

async fn chat(pool: &PgPool, art: &str, mitglieder: &[Uuid]) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, title, created_by) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(art)
        .bind((art == "group").then_some("Runde"))
        .bind(mitglieder[0])
        .execute(pool)
        .await
        .unwrap();
    for (nummer, person) in mitglieder.iter().enumerate() {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id, role)
             values ($1, $2, $3)",
        )
        .bind(id)
        .bind(person)
        .bind(if nummer == 0 { "owner" } else { "member" })
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn termin(
    pool: &PgPool,
    chat: Option<Uuid>,
    ersteller: Uuid,
    titel: &str,
    geloescht: bool,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into calendar_events
           (id, conversation_id, created_by, title, starts_at, ends_at, created_at, deleted_at)
         values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 1 hour',
                 now() - interval '10 days',
                 case when $5 then now() else null end)",
    )
    .bind(id)
    .bind(chat)
    .bind(ersteller)
    .bind(titel)
    .bind(geloescht)
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

async fn karte(pool: &PgPool, chat: Uuid, sender: Uuid, schluessel: serde_json::Value) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into messages (id, conversation_id, sender_id, type, metadata)
         values ($1, $2, $3, 'event', $4)",
    )
    .bind(id)
    .bind(chat)
    .bind(sender)
    .bind(schluessel)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn zaehle(pool: &PgPool, anfrage: &str) -> i64 {
    sqlx::query_scalar(anfrage).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn die_migration_traegt_teilnehmer_und_karten_nach_und_ist_wiederholbar() {
    let Some(pool) = pool().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – Migrationstest übersprungen");
        return;
    };

    // ---- Der Stand vor 0023 ---------------------------------------------
    for migration in MIGRATOR.iter().filter(|migration| migration.version < 23) {
        sqlx::raw_sql(&migration.sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|fehler| panic!("Migration {}: {fehler}", migration.version));
    }

    let anna = nutzer(&pool, "anna").await;
    let bodo = nutzer(&pool, "bodo").await;
    let cleo = nutzer(&pool, "cleo").await;
    let dora = nutzer(&pool, "dora").await;
    let gruppe = chat(&pool, "group", &[anna, bodo, cleo]).await;
    let zweite = chat(&pool, "group", &[anna, bodo]).await;
    let zweier = chat(&pool, "direct", &[anna, bodo]).await;

    // E1: Chat-Termin mit Karte im Chat UND einer zweiten Karte in einer
    // anderen Gruppe (die Nachrichtenschnittstelle liess das zu). Nur Anna
    // steht als Teilnehmerin da – Bodo und Cleo hatten Zugang über den Chat.
    let e1 = termin(&pool, Some(gruppe), anna, "Grillen", false).await;
    teilnehmer(&pool, e1, anna, "yes").await;
    let karte_e1 = karte(&pool, gruppe, anna, serde_json::json!({ "eventId": e1 })).await;
    karte(&pool, zweite, anna, serde_json::json!({ "eventId": e1 })).await;

    // E2: Termin im Zweierchat. Bodo ist schon Teilnehmer und hat zugesagt –
    // das darf die Migration nicht auf „offen“ zurücksetzen.
    let e2 = termin(&pool, Some(zweier), anna, "Zu zweit", false).await;
    teilnehmer(&pool, e2, anna, "yes").await;
    teilnehmer(&pool, e2, bodo, "yes").await;
    karte(&pool, zweier, anna, serde_json::json!({ "eventId": e2 })).await;

    // E3: Chat-Termin ohne Karte.
    let e3 = termin(&pool, Some(gruppe), anna, "Ohne Karte", false).await;
    teilnehmer(&pool, e3, anna, "yes").await;

    // E4: eine Karte, deren Schlüssel keine Kennung ist – darf nicht abbrechen.
    karte(
        &pool,
        gruppe,
        anna,
        serde_json::json!({ "eventId": "keine-uuid" }),
    )
    .await;

    // E5: ein gelöschter Termin mit Karte – wird nicht angefasst.
    let e5 = termin(&pool, Some(gruppe), anna, "Gelöscht", true).await;
    teilnehmer(&pool, e5, anna, "yes").await;
    karte(&pool, gruppe, anna, serde_json::json!({ "eventId": e5 })).await;

    // Eine gelöschte Karte zu E3 zählt nicht.
    let weg = karte(&pool, gruppe, anna, serde_json::json!({ "eventId": e3 })).await;
    sqlx::query("update messages set deleted_at = now() where id = $1")
        .bind(weg)
        .execute(&pool)
        .await
        .unwrap();

    // ---- 0023, zweimal ----------------------------------------------------
    let einladen = MIGRATOR
        .iter()
        .find(|migration| migration.version == 23)
        .expect("Migration 0023 fehlt");
    sqlx::raw_sql(&einladen.sql)
        .execute(&pool)
        .await
        .expect("erster Lauf");

    let stand = |pool: &PgPool| {
        let pool = pool.clone();
        async move {
            (
                zaehle(&pool, "select count(*) from event_attendees").await,
                zaehle(&pool, "select count(*) from event_placements").await,
            )
        }
    };
    let nach_erstem = stand(&pool).await;

    // Wer nur über den Chat Zugang hatte, steht jetzt als Teilnehmer da – mit
    // „offen“, denn wer nie gefragt wurde, hat nicht zugesagt.
    let status_von = |termin: Uuid, person: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "select status from event_attendees where event_id = $1 and user_id = $2",
            )
            .bind(termin)
            .bind(person)
            .fetch_optional(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(status_von(e1, anna).await.as_deref(), Some("yes"));
    assert_eq!(status_von(e1, bodo).await.as_deref(), Some("pending"));
    assert_eq!(status_von(e1, cleo).await.as_deref(), Some("pending"));
    assert_eq!(status_von(e1, dora).await, None, "Dora war nie im Chat");
    assert_eq!(
        status_von(e2, bodo).await.as_deref(),
        Some("yes"),
        "die Zusage bleibt"
    );
    assert_eq!(status_von(e3, cleo).await.as_deref(), Some("pending"));
    assert_eq!(
        status_von(e5, bodo).await,
        None,
        "ein gelöschter Termin bleibt, wie er ist"
    );

    // `eingeladen_am` ist überall gesetzt: bei Bestand der Anlegezeitpunkt des
    // Termins (vor zehn Tagen), bei Nachgetragenen jetzt.
    assert_eq!(
        zaehle(
            &pool,
            "select count(*) from event_attendees where eingeladen_am is null"
        )
        .await,
        0
    );
    let alt: i64 = sqlx::query_scalar(
        "select count(*) from event_attendees a join calendar_events e on e.id = a.event_id
          where a.event_id = $1 and a.user_id = $2 and a.eingeladen_am = e.created_at",
    )
    .bind(e1)
    .bind(anna)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alt, 1, "Anna: der Anlegezeitpunkt des Termins");
    let neu: i64 = sqlx::query_scalar(
        "select count(*) from event_attendees
          where event_id = $1 and user_id = $2 and eingeladen_am > now() - interval '1 minute'",
    )
    .bind(e1)
    .bind(bodo)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(neu, 1, "Bodo: nachgetragen, also jetzt");

    // Die Karten stehen in der neuen Tabelle – aus den Nachrichten selbst.
    let zeilen: Vec<(Uuid, Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "select event_id, conversation_id, art, user_id from event_placements
          order by event_id, conversation_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let von = |termin: Uuid| {
        zeilen
            .iter()
            .filter(|(id, ..)| *id == termin)
            .cloned()
            .collect::<Vec<_>>()
    };
    let e1_karten = von(e1);
    assert_eq!(
        e1_karten.len(),
        2,
        "beide Karten, nicht nur die erste: {e1_karten:?}"
    );
    assert!(e1_karten
        .iter()
        .all(|(_, _, art, person)| art == "gruppe" && person.is_none()));
    let e2_karten = von(e2);
    assert_eq!(e2_karten.len(), 1);
    assert_eq!(e2_karten[0].2, "einzel", "Einzelchat mit dem Ersteller");
    assert_eq!(e2_karten[0].3, Some(bodo), "das Gegenüber");
    assert!(von(e3).is_empty(), "die gelöschte Karte zählt nicht");
    assert!(von(e5).is_empty(), "ein gelöschter Termin hat keine Karten");
    assert_eq!(
        zeilen.len(),
        3,
        "die Karte mit dem falschen Schlüssel bricht nichts ab"
    );
    // Die Nachricht der ersten Karte ist eingetragen.
    let gebucht: i64 = sqlx::query_scalar(
        "select count(*) from event_placements where message_id = $1 and event_id = $2",
    )
    .bind(karte_e1)
    .bind(e1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(gebucht, 1);

    // Der Chat reisst den Termin nicht mehr mit.
    let regel: String = sqlx::query_scalar(
        "select c.confdeltype::text
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.conrelid = 'calendar_events'::regclass and c.contype = 'f'
            and a.attname = 'conversation_id'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(regel, "n", "on delete set null");
    let vorher = zaehle(&pool, "select count(*) from calendar_events").await;
    sqlx::query("delete from conversations where id = $1")
        .bind(zweier)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        zaehle(&pool, "select count(*) from calendar_events").await,
        vorher,
        "der Termin überlebt den Chat"
    );

    // ---- Zweiter Lauf: ändert nichts --------------------------------------
    // (Der Zweierchat ist weg, also ist auch seine Karte weg – das gehört zum
    // Vergleich.)
    let vor_zweitem = stand(&pool).await;
    sqlx::raw_sql(&einladen.sql)
        .execute(&pool)
        .await
        .expect("zweiter Lauf");
    let nach_zweitem = stand(&pool).await;
    assert_eq!(
        vor_zweitem, nach_zweitem,
        "der zweite Durchlauf tut nichts (nach dem ersten: {nach_erstem:?})"
    );
    // Die Zusage aus dem Altbestand wurde dabei nicht zurückgesetzt.
    assert_eq!(status_von(e2, bodo).await.as_deref(), Some("yes"));

    sqlx::query("drop schema if exists einladentest cascade")
        .execute(&pool)
        .await
        .ok();
}
