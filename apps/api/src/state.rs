//! Everything a request handler needs. Feature modules receive this state, so
//! they never reach for globals and stay testable in isolation.

use std::sync::{Arc, RwLock};

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
    /// Was beim Hochfahren schiefging – etwa eine nicht erreichbare Datenbank
    /// oder eine gescheiterte Migration.
    ///
    /// Der Server läuft in so einem Fall bewusst weiter, statt sich zu
    /// beenden. Ein Dienst, der sich bei einem Problem einfach auflöst,
    /// hinterlässt nichts als hängende Anfragen: Die Fly-Vermittlung nimmt
    /// die Verbindung an, wartet auf eine Maschine, die immer wieder
    /// abstürzt, und schickt nicht einmal einen Fehler. Genau das hat hier
    /// einen ganzen Ausfall unsichtbar gemacht. Wer stattdessen antwortet und
    /// sagt, was fehlt, ist in einer Minute repariert statt in einer Stunde.
    startup_problem: Arc<RwLock<Option<String>>>,
}

impl AppState {
    pub async fn new(config: Config) -> AppResult<Self> {
        let config = Arc::new(config);
        // `connect_lazy` statt `connect`: Der Aufbau der Verbindung darf den
        // Start nicht verhindern. Ist die Datenbank gerade weg, soll der
        // Server trotzdem hochkommen und über /healthz sagen, was fehlt.
        let pool = PgPoolOptions::new()
            .max_connections(config.database_pool_max)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_lazy(&config.database_url)?;

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
            startup_problem: Arc::new(RwLock::new(None)),
        })
    }

    /// Hält fest, was beim Hochfahren schiefging. `/healthz` nennt es dann.
    pub fn set_startup_problem(&self, text: impl Into<String>) {
        if let Ok(mut slot) = self.startup_problem.write() {
            *slot = Some(text.into());
        }
    }

    pub fn startup_problem(&self) -> Option<String> {
        self.startup_problem
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// Starts the LISTEN/NOTIFY task that fans events out across instances.
    pub fn spawn_realtime_listener(&self) {
        let bus = self.bus.clone();
        let url = self.config.realtime_database_url.clone();
        tokio::spawn(async move { bus.listen(url).await });
    }
}
