//! Die Sammlung zum Termin: wer anlegen und verknüpfen darf, und was der
//! Ordnerbaum aushält.
//!
//! Gegenprüfung der Wege, die das Blatt „Neue Sammlung“ geht: anlegen
//! (auch unter einem Ordner), freigeben, verknüpfen. Ohne Datenbank
//! (`DATABASE_URL`) überspringt sich der Test.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
}

struct Konto {
    id: String,
    token: String,
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        konto: &Konto,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {}", konto.token));
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        let status = antwort.status();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn konto(&self, name: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "username": name, "password": "passwort123", "displayName": name })
                    .to_string(),
            ))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::CREATED);
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        let sitzung: Value = serde_json::from_slice(&bytes).unwrap();
        Konto {
            id: sitzung["user"]["id"].as_str().unwrap().to_string(),
            token: sitzung["accessToken"].as_str().unwrap().to_string(),
        }
    }

    /// Legt eine Sammlung an und gibt ihre Kennung zurück.
    async fn sammlung(&self, wer: &Konto, name: &str, eltern: Option<&str>) -> (StatusCode, Value) {
        let mut body = json!({ "name": name, "memberLevel": "none" });
        if let Some(eltern) = eltern {
            body["parentId"] = json!(eltern);
        }
        self.call("POST", "/api/v1/collections", wer, Some(body)).await
    }
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

fn kurz() -> String {
    let einfach = Uuid::now_v7().simple().to_string();
    einfach[einfach.len() - 8..].to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_umzug_haelt_die_tiefe_auch_fuer_den_ganzen_zweig() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let a = probe.konto(&format!("tiefe{}", kurz())).await;

    // Eine Kette bis Ebene 7, daneben ein Zweig mit drei Ebenen.
    let mut eltern: Option<String> = None;
    for n in 1..=7 {
        let (status, s) = probe.sammlung(&a, &format!("E{n}"), eltern.as_deref()).await;
        assert_eq!(status, StatusCode::CREATED);
        eltern = Some(s["id"].as_str().unwrap().to_string());
    }
    let ende = eltern.unwrap();
    let (_, x) = probe.sammlung(&a, "X", None).await;
    let x = x["id"].as_str().unwrap().to_string();
    let (_, y) = probe.sammlung(&a, "Y", Some(&x)).await;
    let y = y["id"].as_str().unwrap().to_string();
    let (status, _) = probe.sammlung(&a, "Z", Some(&y)).await;
    assert_eq!(status, StatusCode::CREATED);

    // X unter Ebene 7 hängen ergäbe X auf 8, Y auf 9, Z auf 10: mehr als
    // COLLECTION_DEPTH_MAX. Anlegen lehnt Ebene 9 ab – Umhängen muss das auch.
    let (status, antwort) = probe
        .call(
            "PATCH",
            &format!("/api/v1/collections/{x}"),
            &a,
            Some(json!({ "parentId": ende })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
}

#[tokio::test(flavor = "multi_thread")]
async fn freigeben_an_eine_unbekannte_person_ist_kein_serverfehler() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let a = probe.konto(&format!("frei{}", kurz())).await;
    let (_, s) = probe.sammlung(&a, "Frei", None).await;
    let s = s["id"].as_str().unwrap();
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/collections/{s}/grants"),
            &a,
            Some(json!({ "userId": Uuid::now_v7(), "level": "view" })),
        )
        .await;
    assert!(
        status.is_client_error(),
        "unbekannte Person: {status} {antwort}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn anlegen_unter_einem_ordner_braucht_aendern_und_verknuepfen_auch() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let (_, eltern) = probe.sammlung(&a, "Familie", None).await;
    let eltern = eltern["id"].as_str().unwrap().to_string();

    // Fremder Ordner: unsichtbar (404), nur ansehen (403), ändern (201).
    let (status, _) = probe.sammlung(&b, "Wochenende", Some(&eltern)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let grant = |stufe: &'static str| json!({ "userId": b.id, "level": stufe });
    let pfad = format!("/api/v1/collections/{eltern}/grants");
    let (status, _) = probe.call("POST", &pfad, &a, Some(grant("view"))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = probe.sammlung(&b, "Wochenende", Some(&eltern)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = probe.call("POST", &pfad, &a, Some(grant("edit"))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, kind) = probe.sammlung(&b, "Wochenende", Some(&eltern)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(kind["myLevel"], "own");
    let kind = kind["id"].as_str().unwrap().to_string();

    // Bobs Unterordner gehört ihm, Annas Ordner aber nicht – und vererbt wird
    // nach unten: Anna sieht und verwaltet Bobs Kind.
    let (status, ansicht) = probe
        .call("GET", &format!("/api/v1/collections/{kind}"), &a, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ansicht["myLevel"], "own");

    // Gleicher Name am selben Ort ist erlaubt (die Oberfläche warnt nur).
    let (status, _) = probe.sammlung(&b, "Wochenende", Some(&eltern)).await;
    assert_eq!(status, StatusCode::CREATED);

    // Verknüpfen: Bob ist eingeladen, aber nicht Ersteller → 403 am Termin.
    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let (status, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            &a,
            Some(json!({
                "title": "Wochenende",
                "startsAt": beginn,
                "endsAt": beginn + chrono::Duration::hours(2),
                "attendeeIds": [b.id],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    let termin = termin["id"].as_str().unwrap();
    let verknuepfen = format!("/api/v1/calendar/events/{termin}/collection");
    let (status, _) = probe
        .call("PATCH", &verknuepfen, &b, Some(json!({ "collectionId": kind })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, dto) = probe
        .call("PATCH", &verknuepfen, &a, Some(json!({ "collectionId": kind })))
        .await;
    assert_eq!(status, StatusCode::OK, "{dto}");
    assert_eq!(dto["collectionId"], json!(kind));

    // Eine Sammlung, an der Anna nichts darf, lässt sich nicht verknüpfen.
    let (_, bobs) = probe.sammlung(&b, "Nur Bobs", None).await;
    let bobs = bobs["id"].as_str().unwrap();
    let (status, _) = probe
        .call("PATCH", &verknuepfen, &a, Some(json!({ "collectionId": bobs })))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
