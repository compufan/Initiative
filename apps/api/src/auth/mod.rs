pub mod erneuerungskeks;
pub mod fernsehticket;
pub mod jwt;
pub mod medienkeks;
pub mod password;

use axum::extract::{FromRef, FromRequestParts, OptionalFromRequestParts};
use axum::http::request::Parts;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

/// Extractor for routes that require a signed-in user.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser(pub Uuid);

impl AuthUser {
    pub fn id(&self) -> Uuid {
        self.0
    }
}

fn token_from(parts: &Parts) -> Option<String> {
    if let Some(header) = parts.headers.get(axum::http::header::AUTHORIZATION) {
        let value = header.to_str().ok()?;
        if let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
        {
            return Some(token.trim().to_string());
        }
    }
    // Websocket upgrades and downloads cannot set headers, so a query parameter
    // is accepted as well.
    parts.uri.query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key == "access_token" || key == "token" {
                urlencoding::decode(value)
                    .ok()
                    .map(|decoded| decoded.into_owned())
            } else {
                None
            }
        })
    })
}

impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);
        let token = token_from(parts).ok_or_else(|| AppError::unauthorized("Nicht angemeldet"))?;
        let claims = jwt::decode(&token, &app_state.config.jwt_secret)
            .ok_or_else(|| AppError::unauthorized("Sitzung abgelaufen"))?;
        if claims.typ != "access" {
            return Err(AppError::unauthorized("Ungültiges Token"));
        }
        let id =
            Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("Ungültiges Token"))?;
        if claims
            .sid
            .as_deref()
            .and_then(|sid| Uuid::parse_str(sid).ok())
            .is_some_and(|sid| sitzungen::widerrufen(&sid))
        {
            return Err(AppError::unauthorized("Sitzung beendet"));
        }
        Ok(AuthUser(id))
    }
}

/// Die angemeldete Person samt ihrer Sitzung (für die Geräteliste).
#[derive(Debug, Clone, Copy)]
pub struct AktuelleSitzung {
    pub user: Uuid,
    /// `None` bei Tokens von vor der Geräteliste.
    pub sitzung: Option<Uuid>,
}

impl<S> FromRequestParts<S> for AktuelleSitzung
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let AuthUser(user) =
            <AuthUser as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        let app_state = AppState::from_ref(state);
        let sitzung = token_from(parts)
            .and_then(|token| jwt::decode(&token, &app_state.config.jwt_secret))
            .and_then(|claims| claims.sid)
            .and_then(|sid| Uuid::parse_str(&sid).ok());
        Ok(AktuelleSitzung { user, sitzung })
    }
}

/// Widerrufene Sitzungen und ihre offenen Leitungen – im Speicher dieses
/// Prozesses.
///
/// # Warum im Speicher
///
/// Ein Zugriffstoken ist selbsttragend: Der Server prüft es ohne Datenbank.
/// Meldet man ein Gerät ab, gilt sein Zugriffstoken sonst noch bis zum Ablauf
/// (eine Viertelstunde). Hier merkt sich der Prozess, welche Sitzungen er
/// beendet hat, und lehnt ihre Tokens sofort ab – und schliesst ihre
/// Echtzeit-Leitung. Ohne Datenbankabfrage je Anfrage.
///
/// Bei mehreren Maschinen gilt das sofort nur auf der, die das Abmelden
/// bearbeitet hat; die anderen merken es spätestens beim nächsten Erneuern
/// (das scheitert) bzw. bei der Sitzungsprüfung der Leitung (`ws::sitzung_lebt`,
/// jede Minute).
pub mod sitzungen {
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex};
    use std::time::{Duration, Instant};

    use tokio::sync::Notify;
    use uuid::Uuid;

    /// Länger als jedes Zugriffstoken lebt – danach ist der Eintrag unnötig.
    const MERKEN: Duration = Duration::from_secs(2 * 3600);

    static WIDERRUFEN: LazyLock<Mutex<HashMap<Uuid, Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    /// Sitzung → ihre offenen Leitungen (Kennung, Zeichen zum Schliessen).
    type Leitungen = HashMap<Uuid, Vec<(Uuid, Arc<Notify>)>>;
    static LEITUNGEN: LazyLock<Mutex<Leitungen>> = LazyLock::new(|| Mutex::new(HashMap::new()));

    pub fn widerrufen(sitzung: &Uuid) -> bool {
        WIDERRUFEN
            .lock()
            .map(|liste| liste.get(sitzung).is_some_and(|bis| *bis > Instant::now()))
            .unwrap_or(false)
    }

    /// Eine Sitzung ist beendet: Tokens ablehnen, Leitungen schliessen.
    pub fn beenden(sitzung: Uuid) {
        if let Ok(mut liste) = WIDERRUFEN.lock() {
            let jetzt = Instant::now();
            liste.retain(|_, bis| *bis > jetzt);
            liste.insert(sitzung, jetzt + MERKEN);
        }
        if let Ok(mut leitungen) = LEITUNGEN.lock() {
            for (_, zeichen) in leitungen.remove(&sitzung).unwrap_or_default() {
                zeichen.notify_one();
            }
        }
    }

    /// Eine Leitung dieser Sitzung meldet sich an; das Zeichen kommt, wenn
    /// die Sitzung beendet wird.
    pub fn leitung_anmelden(sitzung: Uuid, leitung: Uuid) -> Arc<Notify> {
        let zeichen = Arc::new(Notify::new());
        if let Ok(mut leitungen) = LEITUNGEN.lock() {
            leitungen
                .entry(sitzung)
                .or_default()
                .push((leitung, zeichen.clone()));
        }
        zeichen
    }

    pub fn leitung_abmelden(sitzung: Uuid, leitung: Uuid) {
        if let Ok(mut leitungen) = LEITUNGEN.lock() {
            if let Some(liste) = leitungen.get_mut(&sitzung) {
                liste.retain(|(id, _)| *id != leitung);
                if liste.is_empty() {
                    leitungen.remove(&sitzung);
                }
            }
        }
    }
}

impl<S> OptionalFromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Option<Self>, Self::Rejection> {
        Ok(
            <AuthUser as FromRequestParts<S>>::from_request_parts(parts, state)
                .await
                .ok(),
        )
    }
}

/// Extractor for routes only admins may reach.
///
/// Bewusst serverseitig: Der Admin-Status hängt an `users.is_admin` in der
/// Datenbank, nicht an einem Schalter im Browser. Ein manipuliertes Frontend
/// kann sich damit keine Rechte verschaffen.
#[derive(Debug, Clone, Copy)]
pub struct AdminUser(pub Uuid);

impl AdminUser {
    pub fn id(&self) -> Uuid {
        self.0
    }
}

impl<S> FromRequestParts<S> for AdminUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);
        let AuthUser(id) =
            <AuthUser as FromRequestParts<S>>::from_request_parts(parts, state).await?;

        let is_admin: Option<bool> = sqlx::query_scalar("select is_admin from users where id = $1")
            .bind(id)
            .fetch_optional(&app_state.pool)
            .await?;

        match is_admin {
            Some(true) => Ok(AdminUser(id)),
            _ => Err(AppError::forbidden("Adminrechte erforderlich")),
        }
    }
}
