//! Configuration, read once from the environment at startup.

use std::time::Duration;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageDriver {
    Local,
    R2,
    S3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationMode {
    Open,
    Invite,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeBus {
    Memory,
    Postgres,
}

#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub path_style: bool,
    pub public_base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VapidConfig {
    pub public_key: String,
    pub private_key: String,
    pub subject: String,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub log_level: String,

    pub database_url: String,
    pub database_pool_max: u32,

    pub jwt_secret: String,
    pub access_token_ttl: Duration,
    pub refresh_token_ttl: Duration,

    pub public_app_url: String,
    pub public_api_url: String,
    pub cors_origins: Vec<String>,

    pub registration_mode: RegistrationMode,
    pub invite_codes: Vec<String>,

    pub storage_driver: StorageDriver,
    pub local_storage_dir: String,
    pub s3: Option<S3Config>,
    pub signed_url_ttl: Duration,

    pub vapid: Option<VapidConfig>,
    pub realtime_bus: RealtimeBus,
    pub run_migrations: bool,
}

fn var(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

fn var_or(key: &str, fallback: &str) -> String {
    var(key).unwrap_or_else(|| fallback.to_string())
}

fn flag(key: &str, fallback: bool) -> bool {
    match var(key) {
        Some(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => fallback,
    }
}

fn number<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    var(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn list(key: &str) -> Vec<String> {
    var(key)
        .map(|value| {
            value
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn trim_slash(value: String) -> String {
    value.trim_end_matches('/').to_string()
}

impl Config {
    /// Reads the process environment. `.env` is loaded first when present.
    pub fn from_env() -> Result<Self, AppError> {
        let environment = var_or("NODE_ENV", "development");
        let is_production = environment == "production";

        let database_url =
            var("DATABASE_URL").ok_or_else(|| AppError::config("DATABASE_URL ist erforderlich"))?;

        let jwt_secret = match var("JWT_SECRET") {
            Some(secret) if secret.len() >= 16 => secret,
            Some(_) => {
                return Err(AppError::config(
                    "JWT_SECRET muss mindestens 16 Zeichen lang sein",
                ))
            }
            None if is_production => {
                return Err(AppError::config(
                    "JWT_SECRET muss in Produktion gesetzt sein (openssl rand -base64 48)",
                ))
            }
            // Development fallback: a random secret invalidates tokens on restart.
            None => crate::auth::password::random_token(32),
        };

        let storage_driver = match var_or("STORAGE_DRIVER", "local")
            .to_ascii_lowercase()
            .as_str()
        {
            "r2" => StorageDriver::R2,
            "s3" => StorageDriver::S3,
            "local" => StorageDriver::Local,
            other => {
                return Err(AppError::config(format!(
                    "Unbekannter STORAGE_DRIVER: {other}"
                )))
            }
        };

        let s3 = if storage_driver == StorageDriver::Local {
            None
        } else {
            let bucket = var("S3_BUCKET")
                .ok_or_else(|| AppError::config("S3_BUCKET ist für R2/S3 erforderlich"))?;
            let access_key_id = var("S3_ACCESS_KEY_ID")
                .ok_or_else(|| AppError::config("S3_ACCESS_KEY_ID ist für R2/S3 erforderlich"))?;
            let secret_access_key = var("S3_SECRET_ACCESS_KEY").ok_or_else(|| {
                AppError::config("S3_SECRET_ACCESS_KEY ist für R2/S3 erforderlich")
            })?;
            let endpoint = var("S3_ENDPOINT");
            if storage_driver == StorageDriver::R2 && endpoint.is_none() {
                return Err(AppError::config(
                    "STORAGE_DRIVER=r2 benötigt S3_ENDPOINT (https://<account-id>.r2.cloudflarestorage.com)",
                ));
            }
            Some(S3Config {
                endpoint,
                region: var_or("S3_REGION", "auto"),
                bucket,
                access_key_id,
                secret_access_key,
                path_style: flag("S3_FORCE_PATH_STYLE", true),
                public_base_url: var("S3_PUBLIC_BASE_URL").map(trim_slash),
            })
        };

        let vapid = match (var("VAPID_PUBLIC_KEY"), var("VAPID_PRIVATE_KEY")) {
            (Some(public_key), Some(private_key)) => Some(VapidConfig {
                public_key,
                private_key,
                subject: var_or("VAPID_SUBJECT", "mailto:admin@example.com"),
            }),
            _ => None,
        };

        Ok(Self {
            environment,
            host: var_or("HOST", "0.0.0.0"),
            port: number("PORT", 8080u16),
            log_level: var_or("LOG_LEVEL", "info"),

            database_url,
            database_pool_max: number("DATABASE_POOL_MAX", 10u32),

            jwt_secret,
            access_token_ttl: Duration::from_secs(number("ACCESS_TOKEN_TTL", 900u64)),
            refresh_token_ttl: Duration::from_secs(
                number("REFRESH_TOKEN_TTL_DAYS", 60u64) * 24 * 60 * 60,
            ),

            public_app_url: trim_slash(var_or("PUBLIC_APP_URL", "http://localhost:5173")),
            public_api_url: trim_slash(var_or("PUBLIC_API_URL", "http://localhost:8080")),
            cors_origins: list("CORS_ORIGINS").into_iter().map(trim_slash).collect(),

            registration_mode: match var_or("REGISTRATION_MODE", "open").as_str() {
                "invite" => RegistrationMode::Invite,
                "closed" => RegistrationMode::Closed,
                _ => RegistrationMode::Open,
            },
            invite_codes: list("INVITE_CODES"),

            storage_driver,
            local_storage_dir: var_or("LOCAL_STORAGE_DIR", "./.data/uploads"),
            s3,
            signed_url_ttl: Duration::from_secs(number("SIGNED_URL_TTL", 3600u64)),

            vapid,
            realtime_bus: match var_or("REALTIME_BUS", "postgres").as_str() {
                "memory" => RealtimeBus::Memory,
                _ => RealtimeBus::Postgres,
            },
            run_migrations: var("RUN_MIGRATIONS").as_deref() != Some("false"),
        })
    }

    pub fn is_production(&self) -> bool {
        self.environment == "production"
    }

    pub fn push_enabled(&self) -> bool {
        self.vapid.is_some()
    }

    /// Absolute URL of an attachment, used in every DTO.
    pub fn media_url(&self, attachment_id: &uuid::Uuid) -> String {
        format!("{}/api/v1/media/{attachment_id}", self.public_api_url)
    }
}
