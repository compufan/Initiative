//! Die kalte Ablage an der echten Route.
//!
//! Die Gewichtung hat ihre eigenen Tests in `services/auslagern.rs` – dort
//! geht es um Reihenfolgen und Zahlen. Hier geht es um den Satz, den der
//! Anwender gesagt hat: „Auch auf Dateien in der Storage Box soll man in der
//! App genauso Zugriff haben wie auf Dateien, die auf dem Server direkt
//! liegen."
//!
//! Das ist eine Behauptung über den GANZEN Weg – hochladen, wegschieben,
//! nachmessen, umschreiben, löschen, wieder ausliefern – und sie lässt sich
//! nur am Ende dieses Weges prüfen, nicht an seinen Teilen.
//!
//! # Warum das ohne Storage Box geht
//!
//! `KALT_TREIBER=lokal` legt die kalte Ablage in ein zweites Verzeichnis. Für
//! alles oberhalb des Treibers – Weiche, Tresor, Auslagerungsdienst, Route –
//! ist das derselbe Weg wie über SFTP; unterschiedlich ist nur, wie lange er
//! dauert. Ein Weg, der sich nur mit fremder Hardware prüfen liesse, würde
//! nicht geprüft, und das wäre der schlechtere Tausch.
//!
//! # Warum jeder Test sein eigenes Schema bekommt
//!
//! Der Auslagerungsdienst fragt die Datenbank nach einer GLOBALEN Grösse:
//! „wie viel liegt gerade lokal" ist eine Summe über alle Anhänge, nicht über
//! die eines Nutzers. Genau das macht ihn in einer geteilten Testdatenbank
//! unprüfbar – dort standen beim ersten Anlauf 2306 Anhänge aus anderen
//! Testbinärdateien, zwölf Tage alt und damit schwerer als alles, was dieser
//! Test gerade hochlädt. Der Dienst wählte brav die fremden aus, fand ihre
//! Dateien nicht (sie liegen in anderen Verzeichnissen) und rührte die
//! eigenen nie an.
//!
//! Die Antwort darauf ist nicht, die Abfrage des Dienstes enger zu machen –
//! sie ist richtig, wie sie ist. Die Antwort ist ein eigenes Postgres-Schema
//! je Test: `set search_path`, Migrationen hinein, fertig. Was danach in
//! `attachments` steht, hat dieser Test hingelegt.
//!
//! # Warum mit Verschlüsselung
//!
//! Weil der Tresor AUSSEN liegt und die Weiche innen, und weil genau diese
//! Reihenfolge die interessante ist: Eine wandernde Datei darf nicht
//! umgeschlüsselt werden, sie soll Byte für Byte hinübergehen. Das lässt sich
//! nur mit eingeschalteter Verschlüsselung zeigen – und nur, indem man die
//! rohen Bytes vorher und nachher vergleicht.

//! # Was diese Tests NICHT fangen – und warum das so bleibt
//!
//! Zwölf Mutationen wurden gegen sie gefahren; zehn fielen auf. Zwei
//! überlebten, und beide sind dieselbe Art von Code:
//!
//!   * **`Lage::Unbekannt` als kalt statt als warm.** Betrifft Miniaturbilder
//!     und den Prüfschlüssel. Der Rückfall in die andere Ablage findet sie
//!     trotzdem – die Antwort bleibt richtig, sie kostet einen Umlauf mehr.
//!   * **Der Rückfall selbst.** Er springt nur in dem Fenster ein, in dem
//!     eine Datei zwischen Hinüberschreiben und Umschreiben der Zeile steht,
//!     also nach einem Absturz genau dazwischen.
//!
//! Beides ist Redundanz: Code, dessen Zweck es ist, dass nichts geschieht,
//! wenn etwas schiefgeht. Ein Test dafür müsste den Absturz erzeugen, und der
//! Aufbau dafür wäre mehr Maschinerie als das, was er absichert. Das hier
//! festzuhalten ist ehrlicher, als eine Zusicherung zu erfinden, die nur so
//! aussieht, als prüfte sie etwas.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::services::auslagern;
use initiative_api::state::AppState;
use initiative_api::storage::muell::aufraeumen;
use initiative_api::{app, MIGRATOR};

const GIB: i64 = 1024 * 1024 * 1024;

struct Probe {
    router: Router,
    state: AppState,
    warm: String,
    kalt: String,
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
        for (name, value) in kopfzeilen {
            builder = builder.header(name, value);
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
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, kopf, bytes.to_vec())
    }

    /// Ein frisches Konto samt Zugangsmarke.
    async fn konto(&self, vorsilbe: &str) -> String {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{vorsilbe}{}", &kennung[kennung.len() - 12..]);
        let (status, konto) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": &name,
                    "displayName": "Auslager Test",
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{konto}");
        konto["accessToken"].as_str().expect("Token").to_string()
    }

    /// Lädt Bytes hoch und gibt die Anhangskennung zurück.
    async fn hochladen(&self, token: &str, daten: &[u8]) -> Uuid {
        self.hochladen_als(
            token,
            "file",
            "application/octet-stream",
            "urlaub.bin",
            daten,
        )
        .await
    }

    async fn hochladen_als(
        &self,
        token: &str,
        art: &str,
        mime: &str,
        name: &str,
        daten: &[u8],
    ) -> Uuid {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": art,
                    "mime": mime,
                    "size": daten.len(),
                    "fileName": name,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let anhang = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let boundary = "----initiativekalt";
        let (status, _, _) = self
            .roh(
                "POST",
                &format!("/api/v1/media/uploads/{anhang}/data"),
                Some(token),
                vec![(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )],
                Body::from(multipart(boundary, mime, name, daten)),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        Uuid::parse_str(&anhang).expect("Kennung")
    }

    async fn prioritaet_setzen(&self, anhang: Uuid, wert: &str) {
        sqlx::query("update attachments set prioritaet = $2 where id = $1")
            .bind(anhang)
            .bind(wert)
            .execute(&self.state.pool)
            .await
            .expect("Priorität setzen");
    }

    async fn ablage(&self, anhang: Uuid) -> (String, bool) {
        let zeile: (String, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as("select ablage, ausgelagert_at from attachments where id = $1")
                .bind(anhang)
                .fetch_one(&self.state.pool)
                .await
                .expect("Anhang");
        (zeile.0, zeile.1.is_some())
    }

    /// Ein Durchgang mit eigenen Grenzen.
    async fn durchgang(&self, grenze: i64, grenze_hoch: i64) -> auslagern::Bilanz {
        let kalt = self.state.speicher.kalt.clone().expect("kalte Ablage");
        auslagern::durchgang(
            &self.state.pool,
            &self.state.speicher.warm,
            &kalt,
            grenze,
            grenze_hoch,
        )
        .await
    }
}

fn multipart(boundary: &str, mime: &str, name: &str, daten: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(daten);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Ein unruhiges PNG – ein glattes packte auf ein Zwanzigstel zusammen.
fn buntes_png() -> Vec<u8> {
    let mut bild = image::RgbImage::new(900, 700);
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
}

/// Der Aufbau muss nacheinander laufen – die Umgebung gehört dem Prozess,
/// nicht dem einzelnen Test. Sonst setzt der zweite `KALT_LOKAL_DIR` um,
/// während der erste noch seinen Zustand baut.
static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let kennung = Uuid::now_v7().simple();
    let warm = format!("./.data/kalt-warm-{name}-{kennung}");
    let kalt = format!("./.data/kalt-kalt-{name}-{kennung}");
    let schema = format!("kaltprobe_{name}");

    let config = {
        let _schloss = AUFBAU.lock().await;
        std::env::set_var("DATABASE_URL", &url);
        std::env::set_var("NODE_ENV", "test");
        std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
        std::env::set_var("REALTIME_BUS", "memory");
        std::env::set_var("STORAGE_DRIVER", "local");
        std::env::set_var("LOCAL_STORAGE_DIR", &warm);
        std::env::set_var("KALT_TREIBER", "lokal");
        std::env::set_var("KALT_LOKAL_DIR", &kalt);
        std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
        std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
        std::env::set_var("MEDIA_KEY", STANDARD.encode([7u8; 32]));
        Arc::new(Config::from_env().expect("config"))
    };

    /*
     * Das Schema wird verworfen und neu angelegt, nicht nur angelegt: Ein
     * Testlauf, der mittendrin abbricht, lässt seine Zeilen stehen, und der
     * nächste Lauf soll davon nichts merken. Der Name hängt am Testnamen und
     * nicht an einer Zufallszahl – sonst sammelte sich bei jedem Lauf ein
     * weiteres Schema in der Entwicklungsdatenbank an.
     */
    let vorbereiten = sqlx::PgPool::connect(&url).await.expect("Datenbank");
    sqlx::query(&format!("drop schema if exists {schema} cascade"))
        .execute(&vorbereiten)
        .await
        .expect("Schema verwerfen");
    sqlx::query(&format!("create schema {schema}"))
        .execute(&vorbereiten)
        .await
        .expect("Schema anlegen");
    vorbereiten.close().await;

    let fuer_pfad = schema.clone();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |verbindung, _| {
            let schema = fuer_pfad.clone();
            Box::pin(async move {
                sqlx::query(&format!("set search_path to {schema}"))
                    .execute(verbindung)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .expect("Pool");

    let state = AppState::from_pool(pool, config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
        warm,
        kalt,
    })
}

/// Ein Inhalt, der über mehrere Tresorblöcke geht (die sind 64 KiB gross).
fn urlaubsvideo() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn niedrig_wandert_sofort_und_bleibt_lesbar() {
    let Some(probe) = aufbauen("niedrig").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.konto("kaltnied").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&token, &daten).await;

    // Vorher: genau eine Datei, und zwar warm.
    let warm_vorher = dateien_sammeln(&probe.warm);
    assert_eq!(warm_vorher.len(), 1, "genau eine warme Datei erwartet");
    assert!(
        dateien_sammeln(&probe.kalt).is_empty(),
        "kalt darf noch nichts liegen"
    );
    let roh_vorher = std::fs::read(&warm_vorher[0]).expect("warme Datei lesen");
    assert!(
        roh_vorher.starts_with(b"INIVLT"),
        "die warme Fassung ist nicht verschlüsselt – der Test misst dann nichts"
    );

    /*
     * Die Grenzen stehen auf ihren ECHTEN Werten, und der Server ist im Test
     * praktisch leer. „Niedrig" heisst trotzdem „wandert sofort" – das ist
     * die Bedeutung dieser Einstellung und nicht ein Nebeneffekt eines vollen
     * Servers.
     */
    probe.prioritaet_setzen(anhang, "niedrig").await;
    let bilanz = probe.durchgang(100 * GIB, 120 * GIB).await;
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(bilanz.bytes, daten.len() as i64, "{bilanz:?}");

    let (ablage, ausgelagert) = probe.ablage(anhang).await;
    assert_eq!(ablage, "fern");
    assert!(ausgelagert, "ausgelagert_at fehlt");

    // Die warme Fassung ist weg, die kalte da – und zwar dieselben Bytes.
    assert!(
        dateien_sammeln(&probe.warm).is_empty(),
        "die warme Fassung liegt noch da – der Platz wurde nicht frei"
    );
    let kalt_nachher = dateien_sammeln(&probe.kalt);
    assert_eq!(kalt_nachher.len(), 1, "genau eine kalte Datei erwartet");
    let roh_nachher = std::fs::read(&kalt_nachher[0]).expect("kalte Datei lesen");
    assert_eq!(
        roh_nachher, roh_vorher,
        "sie wurde umgeschlüsselt statt Byte für Byte kopiert"
    );

    // Und jetzt der Satz, um den es geht: genauso Zugriff wie vorher.
    let (status, _, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{anhang}/bytes"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "kalt gelesen gibt es keine Antwort");
    assert_eq!(zurueck, daten, "kalt gelesen kommt etwas anderes zurück");

    /*
     * Vorspulen über die kalte Ablage.
     *
     * Das ist die Stelle, an der ein Treiber ohne echte Bereichsabfragen
     * auffliegt: Der Tresor liest ZWEIMAL je Anfrage – erst 36 Byte Kopf,
     * dann den Blockbereich. Wer beim zweiten Mal wieder bei null anfängt,
     * liefert ein Video, das an der falschen Stelle weiterläuft, und zwar
     * ohne Fehlermeldung.
     */
    for (von, bis) in [
        (0usize, 99usize),
        (65_530, 65_545),
        (65_536, 131_071),
        (131_090, 299_999),
        (299_999, 299_999),
    ] {
        let (status, kopf, teil) = probe
            .roh(
                "GET",
                &format!("/api/v1/media/{anhang}/bytes"),
                Some(&token),
                vec![("range", format!("bytes={von}-{bis}"))],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{von}-{bis}");
        let bereich = kopf
            .iter()
            .find(|(name, _)| name == "content-range")
            .map(|(_, wert)| wert.clone())
            .unwrap_or_default();
        assert_eq!(
            bereich,
            format!("bytes {von}-{bis}/{}", daten.len()),
            "Content-Range bei {von}-{bis}"
        );
        assert_eq!(teil, &daten[von..=bis], "Inhalt bei {von}-{bis}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn normal_wartet_auf_hundert_und_hoch_auf_hundertzwanzig() {
    let Some(probe) = aufbauen("grenzen").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.konto("kaltgrenz").await;
    let daten = urlaubsvideo();
    let gewoehnlich = probe.hochladen(&token, &daten).await;
    let wichtig = probe.hochladen(&token, &daten).await;
    probe.prioritaet_setzen(wichtig, "hoch").await;

    // 1. Unter der ersten Grenze rührt sich nichts. Der Server ist leer, und
    //    „normal" heisst nicht „sobald es geht".
    let bilanz = probe.durchgang(100 * GIB, 120 * GIB).await;
    assert_eq!(bilanz, auslagern::Bilanz::default(), "{bilanz:?}");
    assert_eq!(probe.ablage(gewoehnlich).await.0, "lokal");
    assert_eq!(probe.ablage(wichtig).await.0, "lokal");

    // 2. Über der ersten, unter der zweiten: das Gewöhnliche wandert, das
    //    Wichtige bleibt. Genau dafür gibt es die zweite Grenze.
    let bilanz = probe.durchgang(0, 100 * GIB).await;
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(gewoehnlich).await.0, "fern");
    assert_eq!(
        probe.ablage(wichtig).await.0,
        "lokal",
        "„hoch\" ist vor der zweiten Grenze gewandert"
    );

    // 3. Über der zweiten kommt auch das Wichtige dran – „nur wenn keine
    //    andere Datei vorher ausgelagert werden kann" ist in Schritt 2 schon
    //    geschehen.
    let bilanz = probe.durchgang(0, 0).await;
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(wichtig).await.0, "fern");

    // Beide liegen jetzt drüben – und beide lassen sich lesen.
    assert!(dateien_sammeln(&probe.warm).is_empty());
    assert_eq!(dateien_sammeln(&probe.kalt).len(), 2);
    for anhang in [gewoehnlich, wichtig] {
        let (status, _, zurueck) = probe
            .roh(
                "GET",
                &format!("/api/v1/media/{anhang}/bytes"),
                Some(&token),
                vec![],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{anhang}");
        assert_eq!(zurueck, daten, "{anhang}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn geloescht_heisst_auch_drueben_geloescht() {
    /*
     * Der blinde Fleck, den Migration 0019 schliesst.
     *
     * Beim Löschen gibt es die Anhangszeile nicht mehr – das ist ja der
     * Anlass. Ohne `storage_muell.ablage` wüsste der Aufräumdienst nicht,
     * dass die Datei drüben liegt, löschte brav die warme Fassung (die es
     * gar nicht mehr gibt), meldete Erfolg – und die Storage Box wüchse
     * still weiter, ohne dass es je irgendwo aufflöge.
     */
    let Some(probe) = aufbauen("loeschen").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.konto("kaltloesch").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&token, &daten).await;
    probe.prioritaet_setzen(anhang, "niedrig").await;
    probe.durchgang(100 * GIB, 120 * GIB).await;
    assert_eq!(probe.ablage(anhang).await.0, "fern");
    assert_eq!(dateien_sammeln(&probe.kalt).len(), 1);

    let schluessel: String =
        sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(anhang)
            .fetch_one(&probe.state.pool)
            .await
            .expect("Schlüssel");
    sqlx::query("delete from attachments where id = $1")
        .bind(anhang)
        .execute(&probe.state.pool)
        .await
        .expect("löschen");

    // Der Auslöser aus 0019 muss die Ablage mitgeschrieben haben.
    let vermerkt: String =
        sqlx::query_scalar("select ablage from storage_muell where storage_key = $1")
            .bind(&schluessel)
            .fetch_one(&probe.state.pool)
            .await
            .expect("Müllzeile");
    assert_eq!(
        vermerkt, "fern",
        "der Auslöser hat die Ablage nicht mitgeschrieben"
    );

    let storage: Arc<dyn initiative_api::storage::Storage> = probe.state.storage.clone();
    aufraeumen(&probe.state.pool, &storage).await;
    assert!(
        dateien_sammeln(&probe.kalt).is_empty(),
        "die ferne Fassung liegt noch da – sie wird nie wieder jemand finden"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_selbst_loescht_ist_sofort_auch_drueben_los() {
    /*
     * Der andere Löschweg – und der einzige, an dem sich die Weiche beim
     * ANHANG entscheidet.
     *
     * `DELETE /api/v1/media/{id}` räumt den Speicher weg, SOLANGE die
     * Anhangszeile noch steht; erst danach fällt die Zeile. Die Weiche hat
     * hier also die Auskunft, die sie beim Aufräumdienst nicht hat, und muss
     * sie auch benutzen: Wer nur warm löscht, lässt die ferne Fassung liegen.
     *
     * Dass der Auslöser sie hinterher in die Müllliste schreibt und der
     * Aufräumdienst sie irgendwann doch noch holt, ist ein Netz und kein
     * Grund: Gelöscht heisst gelöscht, nicht „in der nächsten Viertelstunde".
     * Deshalb wird hier ohne Aufräumdienst nachgesehen.
     */
    let Some(probe) = aufbauen("selbst").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.konto("kaltselbst").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&token, &daten).await;
    probe.prioritaet_setzen(anhang, "niedrig").await;
    probe.durchgang(100 * GIB, 120 * GIB).await;
    assert_eq!(probe.ablage(anhang).await.0, "fern");
    assert_eq!(dateien_sammeln(&probe.kalt).len(), 1);

    let (status, _, _) = probe
        .roh(
            "DELETE",
            &format!("/api/v1/media/{anhang}"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(
        dateien_sammeln(&probe.kalt).is_empty(),
        "gelöscht, und die ferne Fassung liegt trotzdem noch da"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_ausgelagerte_sammlung_zeigt_ihre_kacheln_weiter_schnell() {
    /*
     * Der wichtigste Einzelfall der Weiche.
     *
     * Eine Kachelansicht fragt vierzig Miniaturbilder auf einmal ab. Lägen
     * die drüben, wäre ein ausgelagerter Urlaubsordner unbenutzbar – vierzig
     * SFTP-Umläufe, jeder mit Verbindungsaufbau. Geschrieben wird deshalb
     * IMMER warm, auch wenn das Original längst kalt liegt: Ein Miniaturbild
     * ist ein paar Kilobyte gegen ein paar Megabyte, und es ist genau das,
     * was oft gebraucht wird.
     *
     * Der Test misst das an den Verzeichnissen: Nach dem Abruf muss die neue
     * Datei WARM liegen und drüben darf weiterhin nur das Original stehen.
     */
    let Some(probe) = aufbauen("kacheln").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.konto("kaltkachel").await;
    let png = buntes_png();
    let anhang = probe
        .hochladen_als(&token, "image", "image/png", "urlaub.png", &png)
        .await;
    probe.prioritaet_setzen(anhang, "niedrig").await;
    probe.durchgang(100 * GIB, 120 * GIB).await;
    assert_eq!(probe.ablage(anhang).await.0, "fern");
    assert!(dateien_sammeln(&probe.warm).is_empty());
    assert_eq!(dateien_sammeln(&probe.kalt).len(), 1);

    let (status, kopf, klein) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{anhang}/miniatur?kante=320"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "aus dem kalten Original liess sich kein Miniaturbild rechnen"
    );
    assert_eq!(
        kopf.iter()
            .find(|(n, _)| n == "content-type")
            .map(|(_, w)| w.as_str()),
        Some("image/jpeg")
    );
    assert!(klein.len() < png.len() / 4, "das ist keine Kachel");

    /*
     * Das Ablegen läuft nebenher (die Route wartet bewusst nicht darauf) –
     * also kurz Zeit lassen, statt eine Zusicherung zu prüfen, die es nicht
     * gibt.
     */
    for _ in 0..50 {
        if !dateien_sammeln(&probe.warm).is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        1,
        "das Miniaturbild liegt nicht warm – eine Kachelansicht ginge über SFTP"
    );
    assert_eq!(
        dateien_sammeln(&probe.kalt).len(),
        1,
        "drüben ist etwas dazugekommen, das dort nicht hingehört"
    );

    // Und beim zweiten Mal kommt es aus der warmen Ablage, nicht aus dem
    // Bildwandler.
    let (status, _, nochmal) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{anhang}/miniatur?kante=320"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nochmal, klein);
}

fn dateien_sammeln(wurzel: &str) -> Vec<String> {
    let mut gefunden = Vec::new();
    let mut offen = vec![std::path::PathBuf::from(wurzel)];
    while let Some(pfad) = offen.pop() {
        let Ok(eintraege) = std::fs::read_dir(&pfad) else {
            continue;
        };
        for eintrag in eintraege.flatten() {
            let pfad = eintrag.path();
            if pfad.is_dir() {
                offen.push(pfad);
            } else {
                gefunden.push(pfad.to_string_lossy().to_string());
            }
        }
    }
    gefunden.sort();
    gefunden
}
