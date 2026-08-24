//! Everything a request handler needs. Feature modules receive this state, so
//! they never reach for globals and stay testable in isolation.

use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;
use crate::error::AppResult;
use crate::push::PushService;
use crate::realtime::bus::RealtimeBus;
use crate::realtime::hub::Hub;
use crate::storage::{create_storage, Storage};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub storage: Arc<dyn Storage>,
    pub hub: Arc<Hub>,
    pub bus: Arc<RealtimeBus>,
    pub push: Arc<PushService>,
}

impl AppState {
    pub async fn new(config: Config) -> AppResult<Self> {
        let config = Arc::new(config);
        let pool = PgPoolOptions::new()
            .max_connections(config.database_pool_max)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect(&config.database_url)
            .await?;

        Self::from_pool(pool, config).await
    }

    pub async fn from_pool(pool: PgPool, config: Arc<Config>) -> AppResult<Self> {
        let storage = create_storage(&config)?;
        let bus = Arc::new(RealtimeBus::new(config.realtime_bus, pool.clone()));
        let hub = Arc::new(Hub::new(bus.clone()));
        bus.attach_hub(hub.clone());

        Ok(Self {
            pool,
            push: Arc::new(PushService::new(config.clone())),
            config,
            storage,
            hub,
            bus,
        })
    }

    /// Starts the LISTEN/NOTIFY task that fans events out across instances.
    pub fn spawn_realtime_listener(&self) {
        let bus = self.bus.clone();
        let url = self.config.database_url.clone();
        tokio::spawn(async move { bus.listen(url).await });
    }
}
