pub mod jwt;
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
        Ok(AuthUser(id))
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
