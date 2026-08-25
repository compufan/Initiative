//! Der Ausfall vom 25. August, nachgestellt.
//!
//! Das Fly-Protokoll sagte nur `Error: VersionMismatch(1)`, danach Code 1,
//! Neustart, wieder Code 1 – bis „machine has reached its max restart count of
//! 10“. Nach aussen sah man nichts als hängende Anfragen: Die Fly-Vermittlung
//! nimmt die Verbindung an, sucht eine Maschine und findet keine.
//!
//! Ursache war eine Prüfsumme. sqlx vergleicht jede Migrationsdatei mit dem,
//! was beim Ausführen davon vermerkt wurde. Stimmt das nicht überein, bricht es
//! ab – **bevor** irgendeine neuere Migration läuft. Eine veränderte Datei aus
//! dem August blockiert damit alles, was danach kam.
//!
//! Dieser Test stellt genau das her: eine Datenbank mit vollständig
//! ausgeführten Migrationen, deren Vermerk zu Version 1 nicht mehr zur Datei
//! passt. Ohne echte Datenbank überspringt er sich, wie der übrige
//! Integrationstest auch.

use initiative_api::migrate;
use initiative_api::MIGRATOR;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

/// Eine Verbindung in einem eigenen Schema, damit dieser Test dem E2E-Test
/// nicht in die Quere kommt. `search_path` wird beim Verbindungsaufbau gesetzt
/// und gilt damit für jede Verbindung aus dem Vorrat – nicht nur die erste.
async fn pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;

    let admin = PgPool::connect(&url).await.ok()?;
    sqlx::query("drop schema if exists migrationstest cascade")
        .execute(&admin)
        .await
        .ok()?;
    sqlx::query("create schema migrationstest")
        .execute(&admin)
        .await
        .ok()?;
    admin.close().await;

    let optionen: PgConnectOptions = url.parse().ok()?;
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(optionen.options([("search_path", "migrationstest")]))
        .await
        .ok()
}

#[tokio::test]
async fn eine_veraenderte_migration_blockiert_alles_danach() {
    let Some(pool) = pool().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – Migrationstest übersprungen");
        return;
    };
    MIGRATOR.run(&pool).await.expect("frische Datenbank");

    let letzte = MIGRATOR.iter().last().unwrap().version;

    // --- Den Ausfall herstellen -----------------------------------------
    // Version 1 bekommt eine Prüfsumme, die zu keiner Datei passt: genau das,
    // was eine nachträglich veränderte Migrationsdatei bewirkt.
    sqlx::query("update _sqlx_migrations set checksum = $1 where version = 1")
        .bind(vec![0u8; 48])
        .execute(&pool)
        .await
        .unwrap();
    // Und die letzte Migration gilt als noch nicht gelaufen – sie ist das
    // Opfer der Blockade.
    sqlx::query("delete from _sqlx_migrations where version = $1")
        .bind(letzte)
        .execute(&pool)
        .await
        .unwrap();

    // --- Ohne Reparatur: Stillstand, aber mit Ansage --------------------
    let fehler = migrate::hochfahren(&pool, &MIGRATOR, false)
        .await
        .expect_err("die veränderte Prüfsumme muss auffallen");
    assert!(
        fehler.contains("0001_init.sql"),
        "die Meldung muss die Datei nennen, nicht nur eine Nummer: {fehler}"
    );
    assert!(
        fehler.contains("migration-reparieren"),
        "die Meldung muss sagen, was zu tun ist: {fehler}"
    );

    // Der eigentliche Schaden: Die letzte Migration kam nicht durch.
    let offen: i64 = sqlx::query_scalar("select count(*) from _sqlx_migrations where version = $1")
        .bind(letzte)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(offen, 0, "eine alte Prüfsumme blockiert alles Neuere");

    // --- Mit Reparatur: angleichen, weiterlaufen ------------------------
    let bericht = migrate::hochfahren(&pool, &MIGRATOR, true)
        .await
        .expect("nach dem Angleichen muss es durchlaufen");
    assert_eq!(
        bericht.angeglichen.len(),
        1,
        "nur die eine kaputte Prüfsumme darf angefasst werden, nicht alle: {:?}",
        bericht.angeglichen
    );
    assert!(bericht.angeglichen[0].contains("Migration 1"));

    let nachgeholt: i64 =
        sqlx::query_scalar("select count(*) from _sqlx_migrations where version = $1")
            .bind(letzte)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(nachgeholt, 1, "die offene Migration muss nachgelaufen sein");

    // --- Danach ist Ruhe ------------------------------------------------
    // Wichtig, weil der Schalter versehentlich gesetzt bleiben kann: Ein
    // zweiter Durchlauf darf nichts mehr verändern.
    let zweiter = migrate::hochfahren(&pool, &MIGRATOR, true)
        .await
        .expect("zweiter Durchlauf");
    assert!(
        zweiter.angeglichen.is_empty(),
        "nichts mehr anzugleichen: {:?}",
        zweiter.angeglichen
    );
    migrate::hochfahren(&pool, &MIGRATOR, false)
        .await
        .expect("und ohne Schalter läuft es jetzt auch");

    sqlx::query("drop schema if exists migrationstest cascade")
        .execute(&pool)
        .await
        .ok();
}

/// `/healthz` bleibt erreichbar, `/readyz` sagt die Wahrheit.
///
/// Der Unterschied ist teuer erkauft. Erst hat `/healthz` bei einem
/// Startproblem 503 geantwortet – fachlich richtig, betrieblich fatal: Fly
/// fragt genau diesen Endpunkt ab, um zu entscheiden, ob eine Maschine
/// Anfragen bekommt. Die Maschine flog aus dem Verkehr, der Vermittler nahm
/// Anfragen an, fand niemanden, der sie beantwortet, und der Browser wartete
/// wieder ohne Fehlermeldung. Aus blockierten Migrationen – bei denen Chats
/// tadellos funktionieren – wurde so erneut ein Totalausfall.
///
/// Also: `/healthz` ist das Lebenszeichen und antwortet, solange der Prozess
/// steht. Die strenge Antwort steht in `/readyz` und im Rumpf.
#[tokio::test]
async fn healthz_bleibt_erreichbar_readyz_sagt_die_wahrheit() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use initiative_api::config::Config;
    use initiative_api::state::AppState;
    use tower::ServiceExt;

    let Some(url) = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
    else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");

    let frage = |pfad: &str| Request::builder().uri(pfad).body(Body::empty()).unwrap();
    let lies = |antwort: axum::response::Response| async move {
        let status = antwort.status();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        )
    };

    // --- Ohne Problem: beide gruen -------------------------------------
    let router = initiative_api::app::build(state.clone());
    let (status, koerper) = lies(router.oneshot(frage("/healthz")).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(koerper["status"], "ok");

    let router = initiative_api::app::build(state.clone());
    let (status, koerper) = lies(router.oneshot(frage("/readyz")).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(koerper["status"], "ok");

    // --- Mit Startproblem ----------------------------------------------
    state.set_startup_problem(
        "Migration 1 (0001_init.sql) wurde nach dem Ausführen verändert. \
         Aufgabe „migration-reparieren“ starten.",
    );

    // Das Lebenszeichen bleibt 200 – sonst nimmt Fly die Maschine aus dem
    // Verkehr, und aus einem Teilproblem wird wieder ein Totalausfall.
    let router = initiative_api::app::build(state.clone());
    let (status, koerper) = lies(router.oneshot(frage("/healthz")).await.unwrap()).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "Fly prueft /healthz und entscheidet danach ueber die Zustellung: {koerper}"
    );
    // Verschwiegen wird trotzdem nichts.
    assert_eq!(koerper["status"], "degraded");
    assert!(
        koerper["error"]
            .as_str()
            .unwrap_or_default()
            .contains("migration-reparieren"),
        "die Antwort muss sagen, was zu tun ist: {koerper}"
    );

    // Die strenge Antwort steht in /readyz – daran haengt der Deploy.
    let router = initiative_api::app::build(state.clone());
    let (status, koerper) = lies(router.oneshot(frage("/readyz")).await.unwrap()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(koerper["status"], "degraded");
}
