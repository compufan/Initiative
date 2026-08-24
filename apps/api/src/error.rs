//! Uniform error handling: every failure becomes `{ "error": { code, message } }`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{message}")]
    Api {
        status: StatusCode,
        code: &'static str,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error("Konfigurationsfehler: {0}")]
    Config(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<&'a serde_json::Value>,
}

impl AppError {
    fn api(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::api(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::api(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::api(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::api(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::api(StatusCode::CONFLICT, "conflict", message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::api(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", message)
    }

    pub fn unsupported_media(message: impl Into<String>) -> Self {
        Self::api(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            message,
        )
    }

    /// 422 with per-field details, mirroring the client side validation.
    pub fn validation(issues: Vec<(&str, String)>) -> Self {
        let details = json!(issues
            .iter()
            .map(|(path, message)| json!({ "path": path, "message": message }))
            .collect::<Vec<_>>());
        Self::Api {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation_failed",
            message: "Eingabe konnte nicht verarbeitet werden".to_string(),
            details: Some(details),
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, details) = match &self {
            AppError::Api {
                status,
                code,
                message,
                details,
            } => (*status, *code, message.clone(), details.clone()),
            AppError::Database(sqlx::Error::RowNotFound) => (
                StatusCode::NOT_FOUND,
                "not_found",
                "Nicht gefunden".to_string(),
                None,
            ),
            AppError::Config(message) => {
                tracing::error!(error = %message, "configuration error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Interner Serverfehler".to_string(),
                    None,
                )
            }
            other => {
                tracing::error!(error = %other, "unhandled error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Interner Serverfehler".to_string(),
                    None,
                )
            }
        };

        (
            status,
            Json(json!({
                "error": ErrorBody { code, message: &message, details: details.as_ref() }
            })),
        )
            .into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
