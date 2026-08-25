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
        .route("/readyz", get(ready))
        // Bewusst auf der Wurzel und nicht unter /api/v1: Wer wissen will, was
        // mit seinen Daten geschieht, soll dafuer weder ein Konto brauchen
        // noch die App installieren muessen.
        .merge(crate::modules::datenschutz::router())
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

/// Lebenszeichen – **das**, was Fly abfragt (`[[http_service.checks]]`).
///
/// Antwortet immer mit 200, solange dieser Prozess überhaupt antworten kann.
/// Was im Argen liegt, steht im Rumpf unter `status` und `error`.
///
/// Das ist keine Nachlässigkeit, sondern die Lehre aus einem selbst gebauten
/// Rückfall: Flys Prüfung entscheidet über die **Zustellung**. Meldet sie
/// „ungesund“, nimmt der Vermittler die Maschine aus dem Verkehr – und dann
/// passiert genau das, was diesen Ausfall so teuer gemacht hat: Die Anfrage
/// wird angenommen, keine Maschine übernimmt sie, der Browser wartet ohne
/// Fehlermeldung. Eine App mit blockierten Migrationen kann Chats aber
/// tadellos ausliefern. Sie deswegen unerreichbar zu machen, verwandelt ein
/// kleines Problem in einen Totalausfall.
///
/// Die strenge Antwort gibt es unter `/readyz` – für Deploy-Abläufe und zum
/// Nachsehen, nicht für die Zustellung.
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    (StatusCode::OK, Json(zustand(&state).await.0))
}

/// Betriebsbereit? – die strenge Fassung.
///
/// 503, sobald irgendetwas nicht stimmt: Datenbank nicht erreichbar, oder ein
/// Problem beim Hochfahren. Danach richten sich die Deploy-Abläufe; ein Deploy,
/// nach dem etwas fehlt, darf nicht grün sein. Fly fragt das bewusst **nicht**
/// ab – siehe `health`.
async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let (bericht, gesund) = zustand(&state).await;
    let code = if gesund {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(bericht))
}

/// Der gemeinsame Befund beider Endpunkte: einmal erhoben, zweimal verwendet.
/// Nur die Schlussfolgerung unterscheidet sich.
async fn zustand(state: &AppState) -> (serde_json::Value, bool) {
    // Fly prüft hierüber, ob die Maschine noch lebt. Das darf nie unbegrenzt
    // blockieren, egal wie träge die Datenbank ist.
    let ping = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        sqlx::query_scalar::<_, i32>("select 1").fetch_one(&state.pool),
    )
    .await;

    let datenbank = match ping {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("database timeout".to_string()),
    };
    let startproblem = state.startup_problem();

    // Reihenfolge mit Absicht: Ist die Datenbank weg, ist alles andere
    // Folgeerscheinung. Der obenauf liegende Grund gehört nach `error`.
    let grund = datenbank.clone().or_else(|| startproblem.clone());
    let gesund = grund.is_none();

    (
        json!({
            "status": if gesund { "ok" } else { "degraded" },
            "error": grund,
            "database": if datenbank.is_none() { "ok" } else { "nicht erreichbar" },
            "startupProblem": startproblem,
            "storage": state.storage.kind(),
            "bus": state.bus.kind(),
            // Steht der LISTEN-Kanal wirklich? Ohne ihn kommen Nachrichten
            // nur beim Neuladen an, obwohl sonst alles „ok“ meldet.
            "busConnected": state.bus.listening(),
            "version": state.config.git_sha,
            "push": state.push.enabled(),
            "connections": state.hub.connection_count(),
        }),
        gesund,
    )
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
