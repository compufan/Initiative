//! Hochladen in Stücken (`modules/stuecke.rs`) – von aussen, über den Router.
//!
//! Was hier festgehalten wird, ist das Versprechen an den Client: Stücke
//! dürfen in jeder Reihenfolge, doppelt und nach einem Abriss noch einmal
//! kommen, und am Ende liegt genau die Datei da, die gemeint war – samt
//! Prüfsumme, Bereichsabruf und Aufräumen. Und das, was nicht durchgehen darf:
//! fremde Sitzungen, falsche Bereiche, zu viel auf einmal, eine volle Platte.

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::Digest;
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::constants::STUECK_GROESSE;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const STUECK: usize = STUECK_GROESSE as usize;

struct Probe {
    router: Router,
    state: AppState,
    ablage: String,
}

impl Drop for Probe {
    fn drop(&mut self) {
        // Testdateien sofort weg – die Platte ist knapp.
        let _ = std::fs::remove_dir_all(&self.ablage);
    }
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(body) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&body).unwrap())
            }
            None => Body::empty(),
        };
        let antwort = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = antwort.status();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Ein Stück senden; `bereich` überschreibt die Content-Range.
    async fn stueck(
        &self,
        token: &str,
        sitzung: &str,
        start: usize,
        daten: &[u8],
        gesamt: usize,
    ) -> (StatusCode, Value) {
        self.stueck_roh(
            token,
            sitzung,
            &format!("bytes {}-{}/{}", start, start + daten.len() - 1, gesamt),
            Body::from(daten.to_vec()),
        )
        .await
    }

    async fn stueck_roh(
        &self,
        token: &str,
        sitzung: &str,
        bereich: &str,
        body: Body,
    ) -> (StatusCode, Value) {
        let anfrage = Request::builder()
            .method("PUT")
            .uri(format!("/api/v1/media/stuecke/{sitzung}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .header("content-range", bereich)
            .body(body)
            .unwrap();
        let antwort = self.router.clone().oneshot(anfrage).await.unwrap();
        let status = antwort.status();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Ein Stück mit Prüfsumme im Kopf (`X-Stueck-Sha256`).
    async fn stueck_mit_summe(
        &self,
        token: &str,
        sitzung: &str,
        start: usize,
        daten: &[u8],
        gesamt: usize,
        summe: &str,
    ) -> (StatusCode, Value) {
        let anfrage = Request::builder()
            .method("PUT")
            .uri(format!("/api/v1/media/stuecke/{sitzung}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .header(
                "content-range",
                format!("bytes {}-{}/{}", start, start + daten.len() - 1, gesamt),
            )
            .header("x-stueck-sha256", summe)
            .body(Body::from(daten.to_vec()))
            .unwrap();
        let antwort = self.router.clone().oneshot(anfrage).await.unwrap();
        let status = antwort.status();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn holen(
        &self,
        token: &str,
        uri: &str,
        bereich: Option<&str>,
    ) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
        let mut builder = Request::builder()
            .method("GET")
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        if let Some(bereich) = bereich {
            builder = builder.header("range", bereich);
        }
        let antwort = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = antwort.status();
        let kopf = antwort
            .headers()
            .iter()
            .map(|(n, w)| {
                (
                    n.as_str().to_string(),
                    w.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        (status, kopf, bytes.to_vec())
    }

    async fn konto(&self) -> String {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("stueck{}", &kennung[kennung.len() - 12..]);
        let anfrage = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "username": name,
                    "displayName": "Stück Test",
                    "password": "richtigespasswort",
                }))
                .unwrap(),
            ))
            .unwrap();
        let antwort = self.router.clone().oneshot(anfrage).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::CREATED);
        let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
        let konto: Value = serde_json::from_slice(&bytes).unwrap();
        konto["accessToken"].as_str().unwrap().to_string()
    }

    async fn anlegen(
        &self,
        token: &str,
        kind: &str,
        mime: &str,
        groesse: usize,
        sha256: Option<&str>,
    ) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/media/stuecke",
            token,
            Some(json!({ "kind": kind, "mime": mime, "size": groesse, "fileName": "probe.bin", "sha256": sha256 })),
        )
        .await
    }

    fn teil(&self, sitzung: &str) -> std::path::PathBuf {
        let id = Uuid::parse_str(sitzung).unwrap();
        std::path::PathBuf::from(&self.state.config.upload_teile_dir)
            .join(format!("{}.teil", id.simple()))
    }
}

async fn aufbauen(anpassen: impl FnOnce(&mut Config)) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::remove_var("MEDIA_KEY");

    let ablage = format!("./.data/stuecke-{}", Uuid::now_v7().simple());
    let mut config = Config::from_env().expect("config");
    config.local_storage_dir = format!("{ablage}/medien");
    config.upload_teile_dir = format!("{ablage}/medien/.teile");
    config.rate_limit = false;
    config.media_key = None;
    // Die Platte des Prüfrechners ist knapp; die Vorgabe (1 GiB Reserve) ist
    // für die kleinen Tests hier gleichgültig, aber nicht falsch.
    config.upload_platte_reserve_bytes = 64 * 1024 * 1024;
    anpassen(&mut config);

    let state = AppState::new(config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
        ablage,
    })
}

/// Reproduzierbare Pseudozufallsbytes – kein `rand` nötig, und dieselbe Folge
/// lässt sich zum Vergleichen jederzeit neu erzeugen.
fn muster(laenge: usize, saat: u64) -> Vec<u8> {
    let mut x = saat | 1;
    (0..laenge)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn sha(daten: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(daten))
}

fn kopfzeile(kopf: &[(String, String)], name: &str) -> String {
    kopf.iter()
        .find(|(n, _)| n == name)
        .map(|(_, w)| w.clone())
        .unwrap_or_default()
}

macro_rules! probe {
    ($anpassen:expr) => {
        match aufbauen($anpassen).await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
                return;
            }
        }
    };
}

#[tokio::test(flavor = "multi_thread")]
async fn stuecke_in_beliebiger_reihenfolge_und_doppelt_ergeben_die_datei() {
    let probe = probe!(|_| {});
    let token = probe.konto().await;
    let daten = muster(2 * STUECK + 1234, 7);
    let pruef = sha(&daten);

    let (status, stand) = probe
        .anlegen(
            &token,
            "file",
            "application/octet-stream",
            daten.len(),
            Some(&pruef),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{stand}");
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();
    assert_eq!(stand["stueckGroesse"], STUECK as i64);
    assert_eq!(stand["anzahl"], 3);
    assert_eq!(stand["empfangen"], json!([]));
    // Dünn besetzt angelegt: volle Länge, aber (fast) kein belegter Platz.
    assert_eq!(
        std::fs::metadata(probe.teil(&sitzung)).unwrap().len(),
        daten.len() as u64
    );

    // Hinten zuerst, dann vorn, vorn noch einmal, dann die Mitte.
    for (start, ende) in [
        (2 * STUECK, daten.len()),
        (0, STUECK),
        (0, STUECK),
        (STUECK, 2 * STUECK),
    ] {
        let (status, stand) = probe
            .stueck(&token, &sitzung, start, &daten[start..ende], daten.len())
            .await;
        assert_eq!(status, StatusCode::OK, "{stand}");
    }
    let (status, stand) = probe
        .call(
            "GET",
            &format!("/api/v1/media/stuecke/{sitzung}"),
            &token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stand["empfangen"], json!([0, 1, 2]));
    assert_eq!(stand["empfangenBytes"], daten.len() as i64);

    let (status, anhang) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{anhang}");
    assert_eq!(anhang["status"], "ready");
    assert_eq!(anhang["size"], daten.len() as i64);
    assert!(
        !probe.teil(&sitzung).exists(),
        "die Teildatei wurde umbenannt, nicht kopiert"
    );

    // Ein wiederholter Abschluss (Antwort verloren) bekommt denselben Anhang.
    let (status, nochmal) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nochmal["id"], anhang["id"]);

    // --- Auslieferung: ganz und in Bereichen -----------------------------
    let id = anhang["id"].as_str().unwrap();
    let (status, kopf, ganz) = probe
        .holen(&token, &format!("/api/v1/media/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(kopfzeile(&kopf, "content-length"), daten.len().to_string());
    assert_eq!(kopfzeile(&kopf, "accept-ranges"), "bytes");
    assert_eq!(sha(&ganz), pruef);

    // Über eine Stückgrenze hinweg.
    let (a, b) = (STUECK - 100, STUECK + 99);
    let (status, kopf, teil) = probe
        .holen(
            &token,
            &format!("/api/v1/media/{id}"),
            Some(&format!("bytes={a}-{b}")),
        )
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        kopfzeile(&kopf, "content-range"),
        format!("bytes {a}-{b}/{}", daten.len())
    );
    assert_eq!(teil, &daten[a..=b]);

    // Offen bis zum Ende (fortsetzbarer Download) und das Ende allein.
    let (status, _, rest) = probe
        .holen(
            &token,
            &format!("/api/v1/media/{id}/download"),
            Some(&format!("bytes={}-", 2 * STUECK)),
        )
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(rest, &daten[2 * STUECK..]);
    let (status, _, ende) = probe
        .holen(&token, &format!("/api/v1/media/{id}"), Some("bytes=-10"))
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(ende, &daten[daten.len() - 10..]);
    let (status, _, _) = probe
        .holen(
            &token,
            &format!("/api/v1/media/{id}"),
            Some(&format!("bytes={}-", daten.len())),
        )
        .await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_abgerissenes_stueck_wird_nicht_gebucht_und_laesst_sich_wiederholen() {
    let probe = probe!(|_| {});
    let token = probe.konto().await;
    let daten = muster(STUECK + 10, 11);
    let (_, stand) = probe
        .anlegen(
            &token,
            "file",
            "application/octet-stream",
            daten.len(),
            None,
        )
        .await;
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();

    // Das Netz reisst nach drei Megabyte ab.
    let vorn = Bytes::copy_from_slice(&daten[..3 * 1024 * 1024]);
    let strom = futures_util::stream::iter(vec![
        Ok::<_, std::io::Error>(vorn),
        Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "Funkloch",
        )),
    ]);
    let (status, _) = probe
        .stueck_roh(
            &token,
            &sitzung,
            &format!("bytes 0-{}/{}", STUECK - 1, daten.len()),
            Body::from_stream(strom),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Ebenso: zu früh zu Ende (ohne Fehler, nur zu kurz).
    let (status, _) = probe
        .stueck_roh(
            &token,
            &sitzung,
            &format!("bytes 0-{}/{}", STUECK - 1, daten.len()),
            Body::from(daten[..1000].to_vec()),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, stand) = probe
        .call(
            "GET",
            &format!("/api/v1/media/stuecke/{sitzung}"),
            &token,
            None,
        )
        .await;
    assert_eq!(
        stand["empfangen"],
        json!([]),
        "ein halbes Stück gilt nicht als empfangen"
    );

    // Abschliessen geht noch nicht – und lässt die Sitzung offen.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Fortsetzen: beide Stücke, das erste jetzt vollständig.
    probe
        .stueck(&token, &sitzung, STUECK, &daten[STUECK..], daten.len())
        .await;
    let (status, _) = probe
        .stueck(&token, &sitzung, 0, &daten[..STUECK], daten.len())
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, anhang) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{anhang}");
    let (_, _, ganz) = probe
        .holen(
            &token,
            &format!("/api/v1/media/{}", anhang["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(ganz, daten);
}

#[tokio::test(flavor = "multi_thread")]
async fn falsches_und_fremdes_wird_abgelehnt() {
    let probe = probe!(|_| {});
    let token = probe.konto().await;
    let fremd = probe.konto().await;
    let daten = muster(STUECK + 100, 3);
    let n = daten.len();
    let (_, stand) = probe
        .anlegen(&token, "file", "application/octet-stream", n, None)
        .await;
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();

    // Falsche Gesamtgrösse, kein Stückanfang, falsche Länge, hinter dem Ende.
    for bereich in [
        format!("bytes 0-{}/{}", STUECK - 1, n + 1),
        format!("bytes 5-{}/{n}", STUECK + 4),
        format!("bytes 0-99/{n}"),
        format!("bytes {}-{}/{n}", 2 * STUECK, 2 * STUECK + 9),
        "Quatsch".to_string(),
    ] {
        let (status, _) = probe
            .stueck_roh(&token, &sitzung, &bereich, Body::from(vec![0u8; 100]))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bereich}");
    }

    // Mehr Bytes als angesagt – ohne Content-Length, als Strom.
    let zu_viel =
        futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(vec![1u8; 200]))]);
    let (status, _) = probe
        .stueck_roh(
            &token,
            &sitzung,
            &format!("bytes {STUECK}-{}/{n}", n - 1),
            Body::from_stream(zu_viel),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // Eine fremde Sitzung gibt es für den anderen schlicht nicht.
    let pfad = format!("/api/v1/media/stuecke/{sitzung}");
    assert_eq!(
        probe.call("GET", &pfad, &fremd, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        probe
            .stueck(&fremd, &sitzung, 0, &daten[..STUECK], n)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        probe
            .call(
                "POST",
                &format!("{pfad}/abschliessen"),
                &fremd,
                Some(json!({}))
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        probe.call("DELETE", &pfad, &fremd, None).await.0,
        StatusCode::NOT_FOUND
    );

    // Und ohne Anmeldung gar nichts.
    let ohne = Request::builder()
        .method("GET")
        .uri(&pfad)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        probe.router.clone().oneshot(ohne).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    // Der unfertige Anhang ist für Fremde nicht abrufbar.
    let anhang = stand["attachmentId"].as_str().unwrap();
    let (status, _, _) = probe
        .holen(&fremd, &format!("/api/v1/media/{anhang}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Eine falsche Prüfsumme verwirft die Sitzung – die Datei kam kaputt an.
    let (_, stand) = probe
        .anlegen(
            &token,
            "file",
            "application/octet-stream",
            10,
            Some(&"0".repeat(64)),
        )
        .await;
    let kaputt = stand["sitzungId"].as_str().unwrap().to_string();
    probe.stueck(&token, &kaputt, 0, b"0123456789", 10).await;
    let (status, fehler) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{kaputt}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{fehler}");
    assert_eq!(
        probe
            .call(
                "GET",
                &format!("/api/v1/media/stuecke/{kaputt}"),
                &token,
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(!probe.teil(&kaputt).exists());

    // Unter „Video" kein HTML.
    let html = b"<html><script>alert(1)</script></html>";
    let (status, stand) = probe
        .anlegen(&token, "video", "video/mp4", html.len(), None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{stand}");
    let video = stand["sitzungId"].as_str().unwrap().to_string();
    probe.stueck(&token, &video, 0, html, html.len()).await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{video}/abschliessen"),
            &token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // Ein Typ, der für die Art nicht erlaubt ist, kommt gar nicht erst hinein.
    let (status, _) = probe.anlegen(&token, "video", "text/html", 100, None).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // Ebensowenig ein unsinniger Prüfsummenwert.
    let (status, _) = probe
        .anlegen(&token, "file", "application/pdf", 100, Some("xyz"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Abbrechen räumt Sitzung, Teildatei und den unfertigen Anhang weg.
    let (status, _) = probe.call("DELETE", &pfad, &token, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!probe.teil(&sitzung).exists());
    let (status, _, _) = probe
        .holen(&token, &format!("/api/v1/media/{anhang}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn grenzen_quote_und_freier_platz() {
    let probe = probe!(|config| {
        config.upload_max_bytes = 50 * 1024 * 1024;
        config.upload_offen_max_bytes = 30 * 1024 * 1024;
    });
    let token = probe.konto().await;

    // Über der Grenze je Datei.
    let (status, fehler) = probe
        .anlegen(&token, "video", "video/mp4", 60 * 1024 * 1024, None)
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{fehler}");
    // Bild und Ton behalten ihre alten Grenzen.
    let (status, _) = probe
        .anlegen(&token, "image", "image/jpeg", 26 * 1024 * 1024, None)
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // Die Quote offener Sitzungen je Konto.
    let (status, _) = probe
        .anlegen(&token, "file", "application/zip", 20 * 1024 * 1024, None)
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, fehler) = probe
        .anlegen(&token, "file", "application/zip", 20 * 1024 * 1024, None)
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{fehler}");
    // Ein anderes Konto hat seine eigene.
    let anderes = probe.konto().await;
    let (status, _) = probe
        .anlegen(&anderes, "file", "application/zip", 20 * 1024 * 1024, None)
        .await;
    assert_eq!(status, StatusCode::CREATED);

    // Freier Platz: Mit einer Reserve, die keine Platte hat, gibt es eine
    // klare Absage statt einer vollen Platte.
    let knapp = probe!(|config| {
        config.upload_platte_reserve_bytes = i64::MAX / 4;
    });
    let token = knapp.konto().await;
    let (status, fehler) = knapp
        .anlegen(&token, "file", "application/zip", 1024, None)
        .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{fehler}");
    assert_eq!(fehler["error"]["code"], "insufficient_storage");
}

#[tokio::test(flavor = "multi_thread")]
async fn verwaiste_sitzungen_und_teildateien_werden_aufgeraeumt() {
    let probe = probe!(|_| {});
    let token = probe.konto().await;
    let (_, alt) = probe
        .anlegen(&token, "file", "application/zip", 1000, None)
        .await;
    let (_, frisch) = probe
        .anlegen(&token, "file", "application/zip", 1000, None)
        .await;
    let alt_id = alt["sitzungId"].as_str().unwrap().to_string();
    let frisch_id = frisch["sitzungId"].as_str().unwrap().to_string();

    sqlx::query(
        "update upload_sitzungen set aktualisiert_at = now() - interval '25 hours' where id = $1",
    )
    .bind(Uuid::parse_str(&alt_id).unwrap())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    // Eine Teildatei ohne Sitzung (Absturz zwischen Datei und Zeile), alt.
    let streuner = std::path::PathBuf::from(&probe.state.config.upload_teile_dir)
        .join(format!("{}.teil", Uuid::now_v7().simple()));
    let datei = std::fs::File::create(&streuner).unwrap();
    datei
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
        .unwrap();
    drop(datei);
    // Und eine junge – die könnte gerade angelegt werden und bleibt.
    let jung = std::path::PathBuf::from(&probe.state.config.upload_teile_dir)
        .join(format!("{}.teil", Uuid::now_v7().simple()));
    std::fs::write(&jung, b"").unwrap();

    let weg = initiative_api::modules::stuecke::aufraeumen(
        &probe.state.pool,
        &probe.state.config.upload_teile_dir,
        24,
    )
    .await;
    assert!(weg >= 2, "weggeräumt: {weg}");

    assert_eq!(
        probe
            .call(
                "GET",
                &format!("/api/v1/media/stuecke/{alt_id}"),
                &token,
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(!probe.teil(&alt_id).exists());
    let anhang: Option<(Uuid,)> = sqlx::query_as("select id from attachments where id = $1")
        .bind(Uuid::parse_str(alt["attachmentId"].as_str().unwrap()).unwrap())
        .fetch_optional(&probe.state.pool)
        .await
        .unwrap();
    assert!(anhang.is_none(), "der unfertige Anhang geht mit");

    assert_eq!(
        probe
            .call(
                "GET",
                &format!("/api/v1/media/stuecke/{frisch_id}"),
                &token,
                None
            )
            .await
            .0,
        StatusCode::OK
    );
    assert!(probe.teil(&frisch_id).exists());
    assert!(!streuner.exists());
    assert!(jung.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn mit_verschluesselung_liegt_geheimtext_und_bereiche_stimmen() {
    let probe = probe!(|config| {
        config.media_key = Some([9u8; 32]);
    });
    let token = probe.konto().await;
    let mut daten = muster(STUECK + 70_000, 21);
    // Sieht aus wie ein MP4 – für die Prüfung der ersten Bytes.
    daten[4..8].copy_from_slice(b"ftyp");
    let (status, stand) = probe
        .anlegen(
            &token,
            "video",
            "video/mp4",
            daten.len(),
            Some(&sha(&daten)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{stand}");
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();
    probe
        .stueck(&token, &sitzung, STUECK, &daten[STUECK..], daten.len())
        .await;
    probe
        .stueck(&token, &sitzung, 0, &daten[..STUECK], daten.len())
        .await;
    let (status, anhang) = probe
        .call(
            "POST",
            &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
            &token,
            Some(json!({ "width": 640, "height": 360, "durationMs": 1000 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{anhang}");
    assert_eq!(anhang["width"], 640);

    // Auf der Platte steht kein Klartext.
    let schluessel: (String,) = sqlx::query_as("select storage_key from attachments where id = $1")
        .bind(Uuid::parse_str(anhang["id"].as_str().unwrap()).unwrap())
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    let roh = std::fs::read(format!(
        "{}/{}",
        probe.state.config.local_storage_dir, schluessel.0
    ))
    .unwrap();
    assert_eq!(&roh[..6], b"INIVLT");
    assert!(roh.windows(64).all(|f| f != &daten[1000..1064]));

    // Ausgeliefert wird Klartext – ganz und als Bereich mitten im Block.
    let id = anhang["id"].as_str().unwrap();
    let (_, _, ganz) = probe
        .holen(&token, &format!("/api/v1/media/{id}"), None)
        .await;
    assert_eq!(ganz, daten);
    let (status, _, teil) = probe
        .holen(
            &token,
            &format!("/api/v1/media/{id}"),
            Some("bytes=8388000-8400000"),
        )
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(teil, &daten[8_388_000..=8_400_000]);
}

#[tokio::test(flavor = "multi_thread")]
async fn die_wirksamen_grenzen_kommen_vom_server() {
    // UPLOAD_MAX_BYTES gesenkt: Die App muss DIESE Zahl erfahren, nicht die
    // Vorgabe aus dem gemeinsamen Paket.
    let probe = probe!(|c| c.upload_max_bytes = 1_500_000_000);
    let token = probe.konto().await;

    let (status, g) = probe.call("GET", "/api/v1/media/grenzen", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["maxUploadBytes"]["video"], 1_500_000_000i64);
    assert_eq!(g["maxUploadBytes"]["file"], 1_500_000_000i64);
    // Bild und Ton behalten ihre festen Grenzen.
    assert_eq!(g["maxUploadBytes"]["image"], 25 * 1024 * 1024);
    assert_eq!(g["maxUploadBytes"]["audio"], 50 * 1024 * 1024);
    assert_eq!(g["maxUploadBytes"]["sticker"], 4 * 1024 * 1024);
    assert_eq!(g["direktUploadMax"]["video"], 200 * 1024 * 1024);
    assert_eq!(g["direktUploadMax"]["file"], 100 * 1024 * 1024);
    assert_eq!(g["stueckGroesse"], STUECK as i64);
    assert_eq!(g["uploadMaxBytes"], 1_500_000_000i64);

    // Und der Server hält sich daran: knapp darüber wird abgewiesen.
    let (status, _) = probe
        .anlegen(&token, "file", "application/octet-stream", 1_500_000_001, None)
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // Ohne Anmeldung gibt es sie nicht.
    let antwort = probe
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/media/grenzen")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(antwort.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_falsche_stueck_summe_wird_abgewiesen_und_nichts_gebucht() {
    let probe = probe!(|_| {});
    let token = probe.konto().await;
    let daten = muster(STUECK + 777, 11);

    let (status, stand) = probe
        .anlegen(&token, "file", "application/octet-stream", daten.len(), None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{stand}");
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();
    let stand_url = format!("/api/v1/media/stuecke/{sitzung}");

    // Falsche Summe (das Stück kam „verändert" an): 422, nichts gebucht.
    let erstes = &daten[..STUECK];
    let falsch = sha(b"etwas anderes");
    let (status, antwort) = probe
        .stueck_mit_summe(&token, &sitzung, 0, erstes, daten.len(), &falsch)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{antwort}");
    let (_, stand) = probe.call("GET", &stand_url, &token, None).await;
    assert_eq!(stand["empfangen"], json!([]), "ein beschädigtes Stück wurde gebucht");
    assert_eq!(stand["empfangenBytes"], 0);

    // Kein Hex: 400, ebenfalls nichts gebucht.
    let (status, _) = probe
        .stueck_mit_summe(&token, &sitzung, 0, erstes, daten.len(), "zzz")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Das Wiederholen mit der richtigen Summe geht durch (grosse Buchstaben
    // sind erlaubt) und überschreibt, was der falsche Versuch hinterliess.
    let (status, stand) = probe
        .stueck_mit_summe(&token, &sitzung, 0, erstes, daten.len(), &sha(erstes).to_uppercase())
        .await;
    assert_eq!(status, StatusCode::OK, "{stand}");
    assert_eq!(stand["empfangen"], json!([0]));

    // Das letzte Stück OHNE Kopfzeile geht weiterhin (ältere Clients).
    let (status, _) = probe
        .stueck(&token, &sitzung, STUECK, &daten[STUECK..], daten.len())
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, anhang) = probe
        .call("POST", &format!("{stand_url}/abschliessen"), &token, Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{anhang}");
    // Der Abschluss liefert die Gesamt-Prüfsumme des Servers, auch ohne dass
    // der Client eine angesagt hätte – und sie steht in der Anhangszeile.
    assert_eq!(anhang["sha256"], sha(&daten));
    let id: Uuid = anhang["id"].as_str().unwrap().parse().unwrap();
    let gespeichert: Option<String> = sqlx::query_scalar("select sha256 from attachments where id = $1")
        .bind(id)
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(gespeichert.as_deref(), Some(sha(&daten).as_str()));

    // Ein wiederholter Abschluss (Antwort verloren) liefert sie ebenfalls.
    let (status, nochmal) = probe
        .call("POST", &format!("{stand_url}/abschliessen"), &token, Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nochmal["sha256"], sha(&daten));
}
