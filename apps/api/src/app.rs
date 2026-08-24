//! HTTP application: middleware, health checks and the module router.

use axum::extract::State;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::constants::API_PREFIX;
use crate::state::AppState;

pub fn build(state: AppState) -> Router {
    let cors = cors_layer(&state);

    Router::new()
        .route("/", get(index))
        .route("/healthz", get(health))
        .nest(API_PREFIX, crate::modules::router())
        .merge(crate::realtime::ws::router())
        .fallback(not_found)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

fn cors_layer(state: &AppState) -> CorsLayer {
    let mut origins: Vec<String> = state.config.cors_origins.clone();
    origins.push(state.config.public_app_url.clone());
    let allow_any = origins.iter().any(|origin| origin == "*");
    let development = !state.config.is_production();

    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE])
        .expose_headers([header::CONTENT_RANGE, header::CONTENT_LENGTH])
        .allow_credentials(!allow_any)
        .max_age(std::time::Duration::from_secs(3600));

    if allow_any {
        return layer
            .allow_origin(AllowOrigin::any())
            .allow_credentials(false);
    }

    layer.allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
        let Ok(origin) = origin.to_str() else {
            return false;
        };
        let normalised = origin.trim_end_matches('/');
        if origins.iter().any(|allowed| allowed == normalised) {
            return true;
        }
        // Local development hosts (Vite, phone on the same network).
        development
            && (normalised.starts_with("http://localhost")
                || normalised.starts_with("http://127.0.0.1")
                || normalised.starts_with("http://[::1]")
                || normalised.starts_with("http://192.168.")
                || normalised.starts_with("http://10."))
    }))
}

async fn index() -> Json<serde_json::Value> {
    Json(json!({
        "name": "Initiative API",
        "version": 1,
        "runtime": "rust",
        "modules": crate::modules::MODULE_KEYS,
        "docs": "https://github.com/compufan/Initiative/blob/main/docs/API.md",
    }))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // Fly prüft über diesen Endpunkt, ob die Maschine noch lebt. Er darf
    // deshalb nie unbegrenzt blockieren, egal wie träge die Datenbank ist.
    let ping = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        sqlx::query_scalar::<_, i32>("select 1").fetch_one(&state.pool),
    )
    .await;

    match ping {
        Ok(Ok(_)) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "storage": state.storage.kind(),
                "bus": state.bus.kind(),
                // Steht der LISTEN-Kanal wirklich? Ohne ihn kommen Nachrichten
                // nur beim Neuladen an, obwohl sonst alles „ok“ meldet.
                "busConnected": state.bus.listening(),
                "push": state.push.enabled(),
                "connections": state.hub.connection_count(),
            })),
        ),
        Ok(Err(error)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "degraded", "error": error.to_string() })),
        ),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "degraded", "error": "database timeout" })),
        ),
    }
}

async fn not_found(uri: Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": {
                "code": "not_found",
                "message": format!("Kein Endpunkt für {uri}")
            }
        })),
    )
}
