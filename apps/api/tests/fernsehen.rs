//! Die Eintrittskarte, mit der ein Fernseher eine Datei abholt.
//!
//! # Warum es diesen Weg überhaupt gibt
//!
//! Beim Streamen holt das Gerät im Zimmer die Datei SELBST. Es ist kein
//! Rahmen im Browser und keine zweite Lasche, sondern ein eigener Rechner,
//! der nichts bekommt als eine Adresse – also weder den `Authorization`-Kopf
//! noch den Medien-Keks. Beide bestehenden Wege fallen damit aus, und es
//! bleibt nur einer: Der Ausweis muss in der Adresse stehen.
//!
//! # Was hier zusammengehalten wird
//!
//! Dass diese Adresse **eine** Datei aufschliesst und keine zweite. Das ist
//! der Unterschied zwischen einer Eintrittskarte und einem Generalschlüssel,
//! und man sieht ihn keiner der beiden an: Beide funktionieren beim ersten
//! Ausprobieren tadellos.
//!
//! Und dass die Rechte weiter GEFRAGT werden – beim Ausstellen wie beim
//! Abholen. Eine Karte, die nur beim Ausstellen geprüft wird, überlebt jeden
//! Austritt aus einem Gespräch, solange sie gilt.

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

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Ein Abruf ganz ohne Ausweis – so, wie ein Fernseher fragt.
    async fn wie_ein_fernseher(
        &self,
        uri: &str,
        bereich: Option<&str>,
    ) -> (StatusCode, Vec<u8>, Option<String>) {
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(bereich) = bereich {
            builder = builder.header("range", bereich);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let inhalt = response
            .headers()
            .get("content-range")
            .and_then(|w| w.to_str().ok())
            .map(str::to_string);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec(), inhalt)
    }

    async fn hochladen(&self, token: &str, inhalt: &[u8]) -> String {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "video",
                    "mime": "video/mp4",
                    "size": inhalt.len(),
                    "fileName": "urlaub.mp4",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let grenze = "----initiativefernsehen";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"urlaub.mp4\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: video/mp4\r\n\r\n");
        body.extend_from_slice(inhalt);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/media/uploads/{kennung}/data"))
            .header("authorization", format!("Bearer {token}"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )
            .body(Body::from(body))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::OK, "Upload");
        kennung
    }

    /// Ein Abruf mit Token, der die Bytes und die Kopfzeilen zurückgibt.
    async fn mit_token(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
    ) -> (StatusCode, Vec<u8>, Vec<(String, String)>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let kopf = response
            .headers()
            .iter()
            .map(|(n, w)| {
                (
                    n.as_str().to_string(),
                    w.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec(), kopf)
    }

    /// Eine Datei beliebiger Art hochladen.
    async fn hochladen_bytes(
        &self,
        token: &str,
        art: &str,
        typ: &str,
        name: &str,
        inhalt: &[u8],
    ) -> String {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": art,
                    "mime": typ,
                    "size": inhalt.len(),
                    "fileName": name,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let grenze = "----initiativebytes";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {typ}\r\n\r\n").as_bytes());
        body.extend_from_slice(inhalt);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/media/uploads/{kennung}/data"))
            .header("authorization", format!("Bearer {token}"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )
            .body(Body::from(body))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::OK, "Upload {name}");
        kennung
    }

    async fn anmelden(&self, was: &str) -> String {
        self.anmelden_mit_id(was, "Fernseh Test").await.0
    }

    /// Dasselbe, aber mit Kennung und Anzeigename – für Chats braucht es beides.
    async fn anmelden_mit_id(&self, was: &str, anzeige: &str) -> (String, String) {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{was}{}", &kennung[kennung.len() - 12..]);
        let (status, konto) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": &name,
                    "displayName": anzeige,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{konto}");
        (
            konto["accessToken"].as_str().expect("Token").to_string(),
            konto["user"]["id"].as_str().expect("Kennung").to_string(),
        )
    }

    /// Ein Gespräch anlegen und seine Kennung zurückgeben.
    async fn gespraech(&self, token: &str, mit: &[&str], titel: Option<&str>) -> String {
        let mut koerper = json!({
            "type": if titel.is_some() { "group" } else { "direct" },
            "memberIds": mit,
        });
        if let Some(titel) = titel {
            koerper["title"] = json!(titel);
        }
        let (status, chat) = self
            .call("POST", "/api/v1/conversations", Some(token), Some(koerper))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().expect("Kennung").to_string()
    }

    /// Eine Textnachricht schicken und ihre Kennung zurückgeben.
    async fn schreiben(&self, token: &str, gespraech: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{gespraech}/messages"),
                Some(token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().expect("Kennung").to_string()
    }

    /// Einen Fernseher anmelden: Code und Geheimnis.
    async fn fernseher(&self) -> (String, String) {
        let (status, sitzung) = self.ohne_konto("POST", "/api/v1/tv/sitzungen").await;
        assert_eq!(status, StatusCode::CREATED, "{sitzung}");
        (
            sitzung["code"].as_str().expect("Code").to_string(),
            sitzung["geheim"].as_str().expect("Geheimnis").to_string(),
        )
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
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/fernsehen-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::remove_var("MEDIA_KEY");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

/// Aus der vollen Adresse den Teil machen, den der Router sieht.
fn pfad(url: &str) -> String {
    let ohne_schema = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let ab_pfad = ohne_schema
        .find('/')
        .map(|i| &ohne_schema[i..])
        .unwrap_or("/");
    ab_pfad.to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_karte_oeffnet_genau_eine_datei() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("fernseh").await;
    let inhalt: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
    let video = probe.hochladen(&token, &inhalt).await;
    let anderes = probe.hochladen(&token, b"ein anderes video").await;

    let (status, karte) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{karte}");
    let adresse = karte["url"].as_str().expect("Adresse").to_string();
    assert!(
        adresse.contains("tv="),
        "die Karte muss IN der Adresse stehen – ein Fernseher kann nichts anderes mitschicken: {adresse}"
    );
    assert!(
        adresse.starts_with("http://localhost:8080/"),
        "die Adresse muss von aussen erreichbar sein, nicht relativ: {adresse}"
    );

    /*
     * Der eigentliche Punkt: ohne Kopf, ohne Keks – so fragt das Gerät.
     */
    let (status, bytes, _) = probe.wie_ein_fernseher(&pfad(&adresse), None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "der Fernseher kommt nicht an die Datei"
    );
    assert_eq!(bytes, inhalt, "es kamen andere Bytes zurück");

    /*
     * Ohne Karte bleibt die Tür zu. Sonst prüfte der Test nur, dass die
     * Auslieferung überhaupt Bytes herausgibt.
     */
    let (status, _, _) = probe
        .wie_ein_fernseher(&format!("/api/v1/media/{video}"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "ohne Karte darf ein anonymer Abruf nicht durchkommen"
    );

    /*
     * Und der Unterschied zwischen Eintrittskarte und Generalschlüssel:
     * dieselbe Karte, andere Datei.
     */
    let karte_roh = adresse.split("tv=").nth(1).expect("Karte").to_string();
    let (status, _, _) = probe
        .wie_ein_fernseher(&format!("/api/v1/media/{anderes}?tv={karte_roh}"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "eine Karte für ein Video hat eine zweite Datei aufgeschlossen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn der_fernseher_darf_vorspulen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("spulen").await;
    let inhalt: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
    let video = probe.hochladen(&token, &inhalt).await;
    let (_, karte) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&token),
            None,
        )
        .await;
    let adresse = pfad(karte["url"].as_str().expect("Adresse"));

    /*
     * Ein Fernseher spult mit Bereichsanfragen, und zwar mitten im Film.
     * Käme dabei die ganze Datei oder eine 401, stünde das Bild.
     */
    let (status, bytes, bereich) = probe
        .wie_ein_fernseher(&adresse, Some("bytes=100-199"))
        .await;
    assert_eq!(
        status,
        StatusCode::PARTIAL_CONTENT,
        "kein Vorspulen möglich"
    );
    assert_eq!(bytes.len(), 100);
    assert_eq!(bytes, inhalt[100..200]);
    assert_eq!(bereich.as_deref(), Some("bytes 100-199/4096"));
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_die_datei_nicht_sehen_darf_bekommt_keine_karte() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let besitzer = probe.anmelden("besitz").await;
    let fremd = probe.anmelden("fremd").await;
    let video = probe.hochladen(&besitzer, b"privat").await;

    /*
     * Die Karte ist eine Rechteerweiterung auf Zeit. Wer sie ausstellen darf,
     * ohne die Datei sehen zu dürfen, hat den ganzen Zugriffsschutz umgangen –
     * und zwar auf einem Weg, der in keiner Auslieferung auftaucht.
     */
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&fremd),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine fremde Person hat eine Karte bekommen: {antwort}"
    );

    // Ohne Anmeldung erst recht nicht.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/* ==========================================================================
 * Das Blatt auf dem Fernseher: Code, Geheimnis, Diashow.
 * ========================================================================== */

impl Probe {
    /// Ein Abruf mit Abfrageteil, ohne jeden Ausweis – so fragt das Blatt.
    async fn ohne_konto(&self, method: &str, uri: &str) -> (StatusCode, Value) {
        self.call(method, uri, None, None).await
    }

    async fn sammlung(&self, token: &str, name: &str) -> String {
        let (status, antwort) = self
            .call(
                "POST",
                "/api/v1/collections",
                Some(token),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{antwort}");
        antwort["id"].as_str().expect("Kennung").to_string()
    }

    async fn einlegen(&self, token: &str, sammlung: &str, anhang: &str) {
        let (status, antwort) = self
            .call(
                "POST",
                &format!("/api/v1/collections/{sammlung}/items"),
                Some(token),
                Some(json!({ "attachmentId": anhang })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{antwort}");
    }

    async fn hochladen_bild(&self, token: &str, name: &str) -> String {
        let inhalt = format!("bild {name}");
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "image",
                    "mime": "image/jpeg",
                    "size": inhalt.len(),
                    "fileName": name,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let grenze = "----initiativebild";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(b"Content-Type: image/jpeg\r\n\r\n");
        body.extend_from_slice(inhalt.as_bytes());
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/media/uploads/{kennung}/data"))
            .header("authorization", format!("Bearer {token}"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )
            .body(Body::from(body))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::OK, "Upload {name}");
        kennung
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_sammlung_wird_zur_diashow() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("diashow").await;

    // --- Der Fernseher meldet sich an -------------------------------------
    let (status, sitzung) = probe.ohne_konto("POST", "/api/v1/tv/sitzungen").await;
    assert_eq!(status, StatusCode::CREATED, "{sitzung}");
    let code = sitzung["code"].as_str().expect("Code").to_string();
    let geheim = sitzung["geheim"].as_str().expect("Geheimnis").to_string();
    assert_eq!(code.len(), 9, "acht Zeichen und ein Strich: {code}");
    assert!(
        geheim.len() >= 40,
        "das Geheimnis ist zu kurz: {}",
        geheim.len()
    );

    // Vor dem Verbinden gibt es nichts zu holen – das Blatt zeigt den Code.
    let (status, stand) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/stand?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{stand}");
    assert_eq!(stand["verbunden"], json!(false));

    // --- Das Telefon stellt eine Sammlung ein -----------------------------
    let sammlung = probe.sammlung(&token, "Urlaub").await;
    let eins = probe.hochladen_bild(&token, "eins.jpg").await;
    let zwei = probe.hochladen_bild(&token, "zwei.jpg").await;
    probe.einlegen(&token, &sammlung, &eins).await;
    probe.einlegen(&token, &sammlung, &zwei).await;

    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&token),
            Some(json!({ "collectionId": sammlung, "modus": "zufall", "sekunden": 4 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["stueckzahl"], json!(2));

    // --- Und der Fernseher holt sie ab ------------------------------------
    let (status, programm) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{programm}");
    assert_eq!(programm["modus"], json!("zufall"));
    assert_eq!(programm["sekunden"], json!(4));
    let stuecke = programm["stuecke"].as_array().expect("Stücke");
    assert_eq!(stuecke.len(), 2);
    // Die Reihenfolge der Sammlung, nicht die der Datenbank.
    assert_eq!(stuecke[0]["id"], json!(eins));
    assert_eq!(stuecke[1]["id"], json!(zwei));

    /*
     * Der Kern: Diese Adresse muss OHNE Konto funktionieren. Der Fernseher hat
     * keines und bekommt auch keines; wenn hier nichts kommt, bleibt das Bild
     * schwarz.
     */
    let adresse = stuecke[0]["url"].as_str().expect("Adresse");
    let (status, bytes, _) = probe.wie_ein_fernseher(&pfad(adresse), None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "der Fernseher kommt nicht an das Foto"
    );
    assert_eq!(bytes, b"bild eins.jpg");

    /*
     * --- Die Fernbedienung wiederfinden ---------------------------------
     *
     * Ein Anwender hat berichtet, die Fernbedienung lasse sich „schliessen,
     * aber nicht wieder öffnen, während weiter gestreamt wird". Der Grund
     * war, dass der Code allein im Blatt auf dem Telefon lebte – und am
     * Fernseher stand er auch nicht mehr, weil dort die Diashow lief.
     *
     * Der Server weiss es ohnehin. Diese Route ist die Auskunft, und sie
     * wird hier geprüft, BEVOR die Fernbedienung benutzt wird: Wer sie nicht
     * hat, kommt an den Rest gar nicht heran.
     */
    let (status, meine) = probe
        .call("GET", "/api/v1/tv/meine", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{meine}");
    let liste = meine["items"].as_array().expect("Liste");
    assert_eq!(liste.len(), 1, "die laufende Sitzung fehlt: {meine}");
    assert_eq!(liste[0]["code"], json!(code.replace('-', "")));
    assert_eq!(liste[0]["stueckzahl"], json!(2));
    assert!(
        liste[0]["gesehenVorSekunden"].as_i64().unwrap_or(9999) < 60,
        "der Fernseher gilt als still, obwohl er gerade abgeholt hat: {meine}"
    );

    // Und ein anderer sieht sie nicht – es ist nicht seine.
    let fremder = probe.anmelden("diashowfremd").await;
    let (status, fremd) = probe
        .call("GET", "/api/v1/tv/meine", Some(&fremder), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{fremd}");
    assert_eq!(
        fremd["items"].as_array().map(Vec::len),
        Some(0),
        "eine fremde Sitzung steht in der Liste: {fremd}"
    );

    // --- Die Fernbedienung -------------------------------------------------
    let vorher = programm["fassung"].as_i64().expect("Fassung");
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/tv/sitzungen/{code}"),
            Some(&token),
            Some(json!({ "stelle": 1, "pausiert": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, stand) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/stand?geheim={geheim}"),
        )
        .await;
    assert_eq!(stand["stelle"], json!(1));
    assert_eq!(stand["pausiert"], json!(true));
    /*
     * Die Fassungsnummer muss steigen. Sie ist das einzige, was der Fernseher
     * im Sekundentakt abfragt – bewegt sie sich nicht, holt er die Liste nie
     * wieder, und die Fernbedienung wäre wirkungslos.
     */
    assert!(
        stand["fassung"].as_i64().expect("Fassung") > vorher,
        "die Fassungsnummer steht still"
    );

    /*
     * Im Kreis, nicht geklemmt: Wer beim letzten Bild „weiter" drückt, will
     * wieder von vorn. Und „zurück" auf Stelle null darf nicht bei -1 landen.
     */
    let (_, antwort) = probe
        .call(
            "PATCH",
            &format!("/api/v1/tv/sitzungen/{code}"),
            Some(&token),
            Some(json!({ "stelle": 2 })),
        )
        .await;
    assert_eq!(
        antwort["stelle"],
        json!(0),
        "am Ende geht es wieder von vorn"
    );
    let (_, antwort) = probe
        .call(
            "PATCH",
            &format!("/api/v1/tv/sitzungen/{code}"),
            Some(&token),
            Some(json!({ "stelle": -1 })),
        )
        .await;
    assert_eq!(
        antwort["stelle"],
        json!(1),
        "zurück vom Anfang geht ans Ende"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ohne_geheimnis_kommt_niemand_an_die_bilder() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("geheim").await;
    let (_, sitzung) = probe.ohne_konto("POST", "/api/v1/tv/sitzungen").await;
    let code = sitzung["code"].as_str().expect("Code").to_string();
    let geheim = sitzung["geheim"].as_str().expect("Geheimnis").to_string();

    let sammlung = probe.sammlung(&token, "Privat").await;
    let bild = probe.hochladen_bild(&token, "privat.jpg").await;
    probe.einlegen(&token, &sammlung, &bild).await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&token),
            Some(json!({ "collectionId": sammlung })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");

    /*
     * Der Code steht gross auf dem Fernseher und ist kurz genug zum Abtippen –
     * also auch kurz genug zum Raten. Wäre er allein der Schlüssel, sähe jeder
     * Rater die Diashow eines Fremden mit. Das Geheimnis entsteht beim
     * Fernseher und steht nie auf dem Schirm.
     */
    for falsch in ["", "falsch", "AAAA"] {
        let (status, _) = probe
            .ohne_konto(
                "GET",
                &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={falsch}"),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "mit dem Geheimnis {falsch:?} kam jemand an die Bilder"
        );
    }
    // Mit dem richtigen schon.
    let (status, _) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_fremde_sammlung_kommt_nicht_auf_den_fernseher() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let besitzer = probe.anmelden("eigner").await;
    let fremd = probe.anmelden("gast").await;
    let (_, sitzung) = probe.ohne_konto("POST", "/api/v1/tv/sitzungen").await;
    let code = sitzung["code"].as_str().expect("Code").to_string();

    let sammlung = probe.sammlung(&besitzer, "Nur für mich").await;
    let bild = probe.hochladen_bild(&besitzer, "geheim.jpg").await;
    probe.einlegen(&besitzer, &sammlung, &bild).await;

    /*
     * Ein eigener Fernseher, aber eine fremde Sammlung. Die Sitzung gehört
     * dem, der sie verbindet – die Bilder nicht.
     */
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&fremd),
            Some(json!({ "collectionId": sammlung })),
        )
        .await;
    assert!(
        status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN,
        "eine fremde Sammlung ging auf den Fernseher: {status} {antwort}"
    );

    // Dasselbe für eine einzelne fremde Datei.
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&fremd),
            Some(json!({ "attachmentIds": [bild] })),
        )
        .await;
    assert!(
        status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN,
        "eine fremde Datei ging auf den Fernseher: {status} {antwort}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_fremdes_telefon_uebernimmt_keine_laufende_sitzung() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let erster = probe.anmelden("erst").await;
    let zweiter = probe.anmelden("zweit").await;
    let (_, sitzung) = probe.ohne_konto("POST", "/api/v1/tv/sitzungen").await;
    let code = sitzung["code"].as_str().expect("Code").to_string();

    let sammlung = probe.sammlung(&erster, "Abend").await;
    let bild = probe.hochladen_bild(&erster, "abend.jpg").await;
    probe.einlegen(&erster, &sammlung, &bild).await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&erster),
            Some(json!({ "collectionId": sammlung })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");

    /*
     * Jetzt kennt jemand anderes den Code – abgelesen, abgefotografiert,
     * geraten. Er darf die laufende Sitzung weder übernehmen noch steuern.
     */
    let eigene = probe.sammlung(&zweiter, "Meins").await;
    let eigenes_bild = probe.hochladen_bild(&zweiter, "meins.jpg").await;
    probe.einlegen(&zweiter, &eigene, &eigenes_bild).await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&zweiter),
            Some(json!({ "collectionId": eigene })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "ein Fremder hat eine laufende Sitzung übernommen"
    );

    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/tv/sitzungen/{code}"),
            Some(&zweiter),
            Some(json!({ "stelle": 5 })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "ein Fremder hat gesteuert");

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/tv/sitzungen/{code}"),
            Some(&zweiter),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "ein Fremder hat beendet");
}

/* ==========================================================================
 * Miniaturbilder – dieselbe Rechteprüfung, nur kleiner.
 * ========================================================================== */

#[tokio::test(flavor = "multi_thread")]
async fn ein_miniaturbild_kostet_ein_paar_kilobyte_und_haelt_dieselbe_tuer_zu() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let besitzer = probe.anmelden("mini").await;
    let fremd = probe.anmelden("minifremd").await;

    // Ein unruhiges PNG – ein glattes packte auf ein Zwanzigstel und der
    // Vergleich wäre geschönt.
    let png = {
        let mut bild = image::RgbImage::new(1200, 900);
        for (x, y, punkt) in bild.enumerate_pixels_mut() {
            *punkt = image::Rgb([
                ((x * 7 + y * 13) % 256) as u8,
                ((x * 29 + y * 3) % 256) as u8,
                ((x * 5 + y * 31) % 256) as u8,
            ]);
        }
        let mut raus = Vec::new();
        image::DynamicImage::ImageRgb8(bild)
            .write_to(
                &mut std::io::Cursor::new(&mut raus),
                image::ImageFormat::Png,
            )
            .expect("PNG");
        raus
    };
    let kennung = probe
        .hochladen_bytes(&besitzer, "image", "image/png", "gross.png", &png)
        .await;

    let (status, klein, kopf) = probe
        .mit_token(
            "GET",
            &format!("/api/v1/media/{kennung}/miniatur?kante=320"),
            Some(&besitzer),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        kopf.iter()
            .find(|(n, _)| n == "content-type")
            .map(|(_, w)| w.as_str()),
        Some("image/jpeg")
    );
    /*
     * Der Zweck in einer Zahl: Eine Kachel kostet ein paar Kilobyte statt des
     * ganzen Fotos. Ohne diese Schranke könnte die Route das Original
     * durchreichen, und jede andere Prüfung hier bestünde trotzdem.
     *
     * Die Schranken stehen bewusst auf dem SCHLECHTESTEN Fall: Das Bild oben
     * ist reines Rauschen – jeder Punkt anders als sein Nachbar –, und das
     * gibt es in keiner Kamera. Gemessen kommen dabei 75 kB aus 2,4 MB
     * heraus, also ein Dreissigstel. Bei einem echten Foto sind es 20 bis 35
     * kB; der erste Anlauf stand deshalb bei 60 kB und ist an der eigenen
     * Prüfungsvorlage gescheitert, nicht an der Sache.
     */
    assert!(
        klein.len() < 100_000,
        "die Kachel ist zu schwer: {} Bytes",
        klein.len()
    );
    assert!(
        klein.len() * 20 < png.len(),
        "die Kachel spart zu wenig: {} von {} Bytes",
        klein.len(),
        png.len()
    );

    /*
     * Beim zweiten Mal kommt sie aus dem Speicher. Geprüft wird das am
     * ERGEBNIS und nicht an der Zeit: Byte für Byte dasselbe heisst, dass
     * nicht zweimal gerechnet wurde – ein zweiter Lauf des Bildwandlers
     * lieferte zwar dasselbe Bild, aber das ist hier nicht der Punkt: Läge im
     * Speicher nichts, käme auch bei der dritten Anfrage nichts an.
     */
    let (status, nochmal, _) = probe
        .mit_token(
            "GET",
            &format!("/api/v1/media/{kennung}/miniatur?kante=320"),
            Some(&besitzer),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nochmal, klein);

    /*
     * Und dieselbe Tür wie bei der Auslieferung. Ein Miniaturbild ist das
     * Bild, nur kleiner – es darf keine Hintertür daneben sein.
     */
    let (status, _, _) = probe
        .mit_token(
            "GET",
            &format!("/api/v1/media/{kennung}/miniatur?kante=320"),
            Some(&fremd),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine fremde Person bekam die Kachel"
    );
    let (status, _, _) = probe
        .mit_token("GET", &format!("/api/v1/media/{kennung}/miniatur"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "ohne Anmeldung ging es auch"
    );

    /*
     * Ein Video bekommt keine – dafür bräuchte es einen Videodekodierer auf
     * dem Server. Die Absage ist wichtig: Der Browser fällt darauf zurück,
     * die eingebettete Vorschau zu zeigen, und täte das nicht, wenn hier eine
     * kaputte Antwort käme.
     */
    let video = probe.hochladen(&besitzer, b"kein echtes video").await;
    let (status, _, _) = probe
        .mit_token(
            "GET",
            &format!("/api/v1/media/{video}/miniatur"),
            Some(&besitzer),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "ein Video bekam ein Miniaturbild"
    );
}

/* ---------- Der Chat auf dem Fernseher ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn ein_chat_kommt_auf_den_fernseher() {
    /*
     * Der Wunsch war „die gesamte App auf dem Fernseher spiegeln, um bspw.
     * auch Chats zu zeigen". Pixel-Spiegeln kann eine Web-App nicht (die
     * Belege stehen in docs/FEATURES.md); was geht, ist eine zweite ANSICHT,
     * vom Telefon ferngesteuert – derselbe Code, dieselbe Sitzung, dieselbe
     * Fernbedienung wie bei der Diashow, nur eine andere Art von Programm.
     *
     * Dieser Test geht den ganzen Weg: anmelden, einstellen, abholen – und
     * prüft die eine Sache, die eine Diashow nicht hat und ein Chat braucht:
     * dass der Fernseher MERKT, wenn jemand schreibt.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.anmelden_mit_id("chatanna", "Anna").await;
    let (bert, bert_id) = probe.anmelden_mit_id("chatbert", "Bert").await;
    let chat = probe.gespraech(&anna, &[&bert_id], None).await;
    probe.schreiben(&anna, &chat, "Kommt ihr heute?").await;
    probe.schreiben(&bert, &chat, "Bin um acht da").await;

    let (code, geheim) = probe.fernseher().await;

    // --- Das Telefon stellt den Chat ein ----------------------------------
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&anna),
            Some(json!({ "conversationId": chat })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["art"], json!("chat"));

    // --- Und der Fernseher holt ihn ab ------------------------------------
    let (status, programm) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{programm}");
    assert_eq!(programm["art"], json!("chat"));
    /*
     * Der Name steht auf dem Schirm, BEVOR die erste Nachricht kommt.
     *
     * Ein Zweiergespräch hat keinen Titel – sein Name ist „die andere
     * Person", und die ist je nach Blickrichtung eine andere. Aus Annas Sicht
     * heisst der Chat also „Bert". Das ist nicht Beiwerk: Ein vertippter Code
     * trifft mit sehr kleiner Wahrscheinlichkeit eine fremde Sitzung, und bei
     * Nachrichten wäre das ein Leck in eine fremde Wohnung. Wer den Namen
     * liest, merkt es.
     */
    assert_eq!(programm["titel"], json!("Bert"));

    let nachrichten = programm["nachrichten"].as_array().expect("Nachrichten");
    assert_eq!(nachrichten.len(), 2, "{programm}");
    // Von oben nach unten wie im Chat: die älteste zuerst.
    assert_eq!(nachrichten[0]["text"], json!("Kommt ihr heute?"));
    assert_eq!(nachrichten[1]["text"], json!("Bin um acht da"));
    assert_eq!(nachrichten[0]["absender"], json!("Anna"));
    assert_eq!(nachrichten[1]["absender"], json!("Bert"));
    // Aus Sicht des Besitzers der Sitzung – daran hängt die Seite, auf der
    // eine Blase steht.
    assert_eq!(nachrichten[0]["eigen"], json!(true));
    assert_eq!(nachrichten[1]["eigen"], json!(false));

    /*
     * --- Der Kern: Der Fernseher merkt, dass jemand geschrieben hat -------
     *
     * `fassung` steigt nur, wenn jemand die SITZUNG ändert. Eine neue
     * Nachricht tut das nicht. Ohne eine eigene Ableitung bliebe der
     * Fernseher auf dem Stand vom Einstellen stehen – lautlos, ohne Fehler,
     * und niemand käme auf die Idee, die Sitzung zu verdächtigen.
     */
    let (status, vorher) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/stand?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{vorher}");
    assert_eq!(vorher["art"], json!("chat"));
    assert_eq!(vorher["verbunden"], json!(true));

    probe.schreiben(&bert, &chat, "Bring ich was mit?").await;

    let (_, nachher) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/stand?geheim={geheim}"),
        )
        .await;
    assert_ne!(
        vorher["marke"], nachher["marke"],
        "der Fernseher hat nicht gemerkt, dass eine Nachricht dazugekommen ist"
    );
    assert_eq!(
        vorher["fassung"], nachher["fassung"],
        "eine neue Nachricht ändert die SITZUNG nicht – nur, was auf dem Schirm steht"
    );

    /*
     * --- Und die Fernbedienung findet auch einen Chat --------------------
     *
     * `meine` verlangte einmal `jsonb_array_length(stuecke) > 0`. Ein Chat
     * HAT keine Stücke – mit der alten Bedingung wäre seine Fernbedienung
     * nicht zurückzuholen gewesen, also genau der Fehler, den diese Route
     * behoben hat, noch einmal.
     */
    let (status, meine) = probe
        .call("GET", "/api/v1/tv/meine", Some(&anna), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{meine}");
    let laufend = meine["items"].as_array().expect("Liste");
    assert_eq!(laufend.len(), 1, "{meine}");
    assert_eq!(laufend[0]["art"], json!("chat"));
    assert_eq!(laufend[0]["gespraechId"], json!(chat));
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_fremder_chat_kommt_nicht_auf_den_fernseher() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.anmelden_mit_id("fremdanna", "Anna").await;
    let (bert, bert_id) = probe.anmelden_mit_id("fremdbert", "Bert").await;
    let (clara, _) = probe.anmelden_mit_id("fremdclara", "Clara").await;
    let chat = probe.gespraech(&anna, &[&bert_id], None).await;
    probe.schreiben(&bert, &chat, "unter uns").await;

    let (code, geheim) = probe.fernseher().await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&clara),
            Some(json!({ "conversationId": chat })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "ein fremdes Gespräch ist auf einen Fernseher gekommen: {antwort}"
    );

    // Und der Fernseher hat auch nichts zu holen.
    let (status, _) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_die_gruppe_verlaesst_dessen_fernseher_geht_dunkel() {
    /*
     * Der Unterschied zur Diashow, und der wichtigste Satz dieses Weges.
     *
     * Bei Fotos wird EINMAL beim Einstellen geprüft und die Liste eingefroren
     * – die Begründung steht in Migration 0017, und sie ist dort richtig. Ein
     * Gesprächsverlauf ist aber nichts, was man einfriert: Er wächst weiter,
     * und mit ihm wüchse ein Fernseher, der einer Person gehört, die längst
     * nicht mehr dabei ist.
     *
     * Deshalb wird hier bei JEDEM Abruf geprüft. Das ist strenger als der
     * Fotoweg und kostet nichts.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, anna_id) = probe.anmelden_mit_id("raus_anna", "Anna").await;
    let (bert, bert_id) = probe.anmelden_mit_id("raus_bert", "Bert").await;
    let chat = probe
        .gespraech(&anna, &[&bert_id], Some("Wir für Bier"))
        .await;
    probe.schreiben(&anna, &chat, "Prost").await;

    let (code, geheim) = probe.fernseher().await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&bert),
            Some(json!({ "conversationId": chat })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Solange er dabei ist, läuft es – und die Gruppe heisst, wie sie heisst.
    let (status, programm) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{programm}");
    assert_eq!(programm["titel"], json!("Wir für Bier"));

    // Anna wirft Bert aus der Gruppe.
    let (status, raus) = probe
        .call(
            "DELETE",
            &format!("/api/v1/conversations/{chat}/members/{bert_id}"),
            Some(&anna),
            None,
        )
        .await;
    assert!(
        status.is_success(),
        "das Entfernen ging nicht: {status} {raus}"
    );
    let _ = anna_id;

    // Und in derselben Sekunde ist der Fernseher dunkel.
    let (status, antwort) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "der Fernseher zeigt den Chat einer Person weiter, die nicht mehr dabei ist: {antwort}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn geloeschte_nachrichten_bleiben_vom_schirm() {
    /*
     * Die Filter müssen mitwandern. Der Fernseher fragt niemanden – was
     * einmal in der Antwort steht, steht auf dem Schirm, vier Meter breit, im
     * Wohnzimmer, vor Gästen.
     *
     * Die App zeigt für eine zurückgenommene Nachricht einen Platzhalter. Auf
     * dem Fernseher wäre eine Reihe von „Nachricht gelöscht" nur Rauschen
     * zwischen dem, was zählt – und im schlimmsten Fall die Einladung,
     * nachzufragen, was da stand.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.anmelden_mit_id("weganna", "Anna").await;
    let (bert, bert_id) = probe.anmelden_mit_id("wegbert", "Bert").await;
    let chat = probe.gespraech(&anna, &[&bert_id], None).await;
    let peinlich = probe.schreiben(&anna, &chat, "das war peinlich").await;
    probe.schreiben(&bert, &chat, "alles gut").await;

    let (code, geheim) = probe.fernseher().await;
    probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&anna),
            Some(json!({ "conversationId": chat })),
        )
        .await;

    let (status, weg) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{peinlich}"),
            Some(&anna),
            None,
        )
        .await;
    assert!(status.is_success(), "{status} {weg}");

    let (status, programm) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{programm}");
    let nachrichten = programm["nachrichten"].as_array().expect("Nachrichten");
    assert_eq!(nachrichten.len(), 1, "{programm}");
    assert_eq!(nachrichten[0]["text"], json!("alles gut"));
    assert!(
        !programm.to_string().contains("das war peinlich"),
        "eine zurückgenommene Nachricht steht auf dem Fernseher: {programm}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_chat_und_bilder_zusammen_geht_nicht() {
    /*
     * „Diashow UND Chat" wäre ein dritter Zustand, den jemand auf dem
     * Fernseher anzeigen, auf dem Telefon steuern und in der Datenbank prüfen
     * müsste – und es gibt keinen Wunsch dahinter. Die Absage steht in der
     * Bedingung von Migration 0021; hier steht sie als Satz, den ein Mensch
     * liest.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.anmelden_mit_id("beidesanna", "Anna").await;
    let (_, bert_id) = probe.anmelden_mit_id("beidesbert", "Bert").await;
    let chat = probe.gespraech(&anna, &[&bert_id], None).await;
    let bild = probe.hochladen_bild(&anna, "eins.jpg").await;

    let (code, _) = probe.fernseher().await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&anna),
            Some(json!({ "conversationId": chat, "attachmentIds": [bild] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
}

#[tokio::test(flavor = "multi_thread")]
async fn nach_einem_chat_laeuft_wieder_eine_diashow() {
    /*
     * Derselbe Fernseher, dasselbe Blatt, ein anderes Programm.
     *
     * Die Bedingung in Migration 0021 lässt `art = 'chat'` nur mit einem
     * Gespräch zu und `art = 'diashow'` nur ohne. Wer beim Umstellen auf eine
     * Diashow `art` und `gespraech_id` stehen liesse, bekäme einen Fehler aus
     * der Datenbank – und der Anwender einen Fernseher, der beim zweiten
     * Programm nicht mehr mitmacht.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.anmelden_mit_id("zurueckanna", "Anna").await;
    let (_, bert_id) = probe.anmelden_mit_id("zurueckbert", "Bert").await;
    let chat = probe.gespraech(&anna, &[&bert_id], None).await;
    probe.schreiben(&anna, &chat, "hallo").await;
    let bild = probe.hochladen_bild(&anna, "eins.jpg").await;

    let (code, geheim) = probe.fernseher().await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&anna),
            Some(json!({ "conversationId": chat })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/tv/sitzungen/{code}/programm"),
            Some(&anna),
            Some(json!({ "attachmentIds": [bild] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");

    let (status, programm) = probe
        .ohne_konto(
            "GET",
            &format!("/api/v1/tv/sitzungen/{code}/programm?geheim={geheim}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{programm}");
    assert_eq!(programm["stuecke"].as_array().expect("Stücke").len(), 1);
    assert!(
        programm["nachrichten"].is_null(),
        "nach dem Umstellen standen noch Nachrichten im Programm: {programm}"
    );
}
