use std::net::SocketAddr;

use initiative_api::config::Config;
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
        println!("\nDen Public Key zusätzlich als VITE_VAPID_PUBLIC_KEY in der PWA setzen.");
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
    let state = AppState::new(config).await?;

    if run_migrations {
        MIGRATOR.run(&state.pool).await?;
        tracing::info!("migrations up to date");
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

    axum::serve(listener, router)
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
