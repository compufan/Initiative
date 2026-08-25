use std::net::SocketAddr;

use initiative_api::config::Config;
use initiative_api::migrate;
use initiative_api::push::vapid;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `initiative-api --generate-vapid-keys` prints a fresh Web-Push key pair.
    if std::env::args().any(|arg| arg == "--generate-vapid-keys") {
        let keys = vapid::generate_keys();
        println!("VAPID_PUBLIC_KEY={}", keys.public_key);
        println!("VAPID_PRIVATE_KEY={}", keys.private_key);
        // Frueher stand hier, man muesse den Public Key zusaetzlich als
        // VITE_VAPID_PUBLIC_KEY in der PWA setzen. Das stimmt seit laengerem
        // nicht mehr: Die App holt ihn zur Laufzeit von
        // /api/v1/push/public-key (modules/push.rs).
        println!("\nBeides in die Umgebung der API legen – die PWA holt den öffentlichen Schlüssel von selbst.");
        return Ok(());
    }

    // `initiative-api --generate-media-key` druckt einen frischen Schlüssel für
    // die Dateiverschlüsselung. Bewusst hier und nicht „irgendwo mit openssl“:
    // Der Server hat den Zufallsgenerator schon, und so steht in der Anleitung
    // ein Befehl, der auf jedem Rechner dasselbe tut.
    if std::env::args().any(|arg| arg == "--generate-media-key") {
        use base64::Engine;
        let bytes = initiative_api::auth::password::random_bytes(32);
        println!(
            "MEDIA_KEY={}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        println!("\nDiesen Schlüssel getrennt von den Sicherungen aufbewahren.");
        println!("Ohne ihn sind alle damit abgelegten Dateien unwiederbringlich verloren.");
        return Ok(());
    }

    // `.env` im Repo-Wurzelverzeichnis, alternativ neben der Crate.
    if dotenvy::dotenv().is_err() {
        let _ = dotenvy::from_filename("apps/api/.env");
    }
    let config = Config::from_env()?;

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                format!("initiative_api={},tower_http=warn", config.log_level).into()
            }),
        )
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();

    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let run_migrations = config.run_migrations;
    let repair_migrations = config.repair_migrations;
    let state = AppState::new(config).await?;

    // Ab hier wird nichts mehr mit `?` nach oben gereicht, was den Prozess
    // beenden würde. Ein Server, der sich bei einem Problem auflöst, ist von
    // aussen nicht von einem Netzausfall zu unterscheiden: Fly nimmt die
    // Anfrage an, sucht eine Maschine, findet keine – und der Browser wartet
    // ohne Fehlermeldung. Genau das hat hier einen Ausfall unsichtbar
    // gemacht. Also: hochkommen, antworten, und sagen was fehlt.
    if run_migrations {
        if repair_migrations {
            tracing::warn!(
                "MIGRATIONS_REPAIR ist gesetzt: Prüfsummen ausgeführter Migrationen \
                 werden an die Dateien angeglichen. Nach dem Reparieren wieder entfernen."
            );
        }
        match migrate::hochfahren(&state.pool, &MIGRATOR, repair_migrations).await {
            Ok(bericht) => {
                for zeile in &bericht.angeglichen {
                    tracing::warn!("{zeile}");
                }
                tracing::info!("migrations up to date");
            }
            Err(problem) => {
                tracing::error!("{problem}");
                state.set_startup_problem(problem);
            }
        }
    }
    state.spawn_realtime_listener();

    let router = app::build(state.clone());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        %addr,
        storage = state.storage.kind(),
        bus = state.bus.kind(),
        push = state.push.enabled(),
        "Initiative API bereit"
    );

    // Mit Verbindungsinformationen: Ohne sie kennt die Ratenbremse die
    // Gegenstelle nicht und wuerde alle direkten Aufrufe in einen Topf werfen.
    // Hinter einem Reverse Proxy zaehlt ohnehin `X-Forwarded-For` – aber nur,
    // wenn TRUST_PROXY gesetzt ist.
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
