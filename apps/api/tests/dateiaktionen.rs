//! Was man mit einer Datei tun kann, ohne sie noch einmal hochzuladen.
//!
//! Drei Handgriffe: Priorität setzen, in einen Chat weitergeben, löschen. Der
//! erste bestimmt, wann sie auf den grossen Speicher wandert; der zweite ist
//! der interessante.
//!
//! # Warum Weitergeben nicht Kopieren ist
//!
//! Eine weitergegebene Datei bekommt eine zweite Zeile in `attachments`, aber
//! kein zweites Byte: derselbe `storage_key`, `quelle_id` aufs Original. Das
//! ist billig und es ist gefährlich, und beides wird hier geprüft:
//!
//!   * Wer eine der beiden Zeilen löscht, darf die Bytes nicht anfassen,
//!     solange die andere steht. Sonst wäre die verbliebene ein toter Verweis
//!     – nicht als Fehlermeldung, sondern als Bild, das nicht mehr lädt.
//!   * Der Auslagerungsdienst darf dieselben Bytes nicht zweimal zählen. Sonst
//!     hielte er ein dreimal geteiltes Video für vier Videos und räumte Platz
//!     frei, den es gar nicht gibt.
//!
//! Jeder Test bekommt sein eigenes Postgres-Schema – der Auslagerungsdienst
//! fragt nach einer globalen Grösse, und in einer geteilten Testdatenbank
//! stehen die Anhänge aller anderen Testbinärdateien mit drin.

//! # Was hier nicht gefangen wird
//!
//! Elf Mutationen, zehn gefallen. Die eine, die überlebt, ist
//! `kandidaten`s Filter `quelle_id is null`: Nimmt man ihn weg, wird die
//! Kopie zwar mit ausgewählt, aber beim Umzug stellt sich heraus, dass ihre
//! Zeile schon auf `fern` steht – der Durchgang zählt sie nicht und bewegt
//! nichts doppelt.
//!
//! Sichtbar würde der Unterschied erst unter Druck: `auswahl_mit` zieht die
//! Grösse jedes gewählten Kandidaten vom Füllstand ab und hört auf, sobald das
//! Ziel erreicht ist. Zählt eine Kopie mit, hört es zu früh auf. Dafür bräuchte
//! es einen Testbestand von über hundert Gigabyte. Der Filter bleibt trotzdem,
//! und zwar aus demselben Grund, aus dem er in `belegt` steht – dort ist er
//! geprüft.

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
use initiative_api::{app, MIGRATOR};

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
    ) -> (StatusCode, Vec<u8>) {
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
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec())
    }

    /// Ein frisches Konto: Zugangsmarke und eigene Kennung.
    async fn konto(&self, vorsilbe: &str) -> (String, Uuid) {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{vorsilbe}{}", &kennung[kennung.len() - 12..]);
        let (status, konto) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": &name,
                    "displayName": "Aktions Test",
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{konto}");
        (
            konto["accessToken"].as_str().expect("Token").to_string(),
            Uuid::parse_str(konto["user"]["id"].as_str().expect("Kennung")).expect("Kennung"),
        )
    }

    async fn hochladen(&self, token: &str, daten: &[u8]) -> Uuid {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "file",
                    "mime": "application/octet-stream",
                    "size": daten.len(),
                    "fileName": "urlaub.bin",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let anhang = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let boundary = "----initiativeaktion";
        let (status, _) = self
            .roh(
                "POST",
                &format!("/api/v1/media/uploads/{anhang}/data"),
                Some(token),
                vec![(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )],
                Body::from(multipart(boundary, daten)),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        Uuid::parse_str(&anhang).expect("Kennung")
    }

    /// Eine Sammlung anlegen und eine Datei hineinlegen. Gibt die Kennung des
    /// Eintrags zurück.
    async fn sammlung_mit(&self, token: &str, anhang: Uuid) -> (Uuid, Uuid) {
        let (status, sammlung) = self
            .call(
                "POST",
                "/api/v1/collections",
                Some(token),
                Some(json!({ "name": "Urlaub" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{sammlung}");
        let sammlung_id = Uuid::parse_str(sammlung["id"].as_str().expect("Kennung")).unwrap();

        let (status, eintrag) = self
            .call(
                "POST",
                &format!("/api/v1/collections/{sammlung_id}/items"),
                Some(token),
                Some(json!({ "attachmentId": anhang })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{eintrag}");
        let eintrag_id = Uuid::parse_str(eintrag["id"].as_str().expect("Kennung")).unwrap();
        (sammlung_id, eintrag_id)
    }

    async fn prioritaet(&self, anhang: Uuid) -> String {
        sqlx::query_scalar("select prioritaet from attachments where id = $1")
            .bind(anhang)
            .fetch_one(&self.state.pool)
            .await
            .expect("Anhang")
    }

    async fn schluessel(&self, anhang: Uuid) -> String {
        sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(anhang)
            .fetch_one(&self.state.pool)
            .await
            .expect("Anhang")
    }

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

fn multipart(boundary: &str, daten: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"urlaub.bin\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(daten);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let kennung = Uuid::now_v7().simple();
    let warm = format!("./.data/aktion-warm-{name}-{kennung}");
    let kalt = format!("./.data/aktion-kalt-{name}-{kennung}");
    let schema = format!("aktionprobe_{name}");

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
        std::env::set_var("MEDIA_KEY", STANDARD.encode([9u8; 32]));
        Arc::new(Config::from_env().expect("config"))
    };

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

fn urlaubsvideo() -> Vec<u8> {
    (0..120_000u32).map(|i| (i % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn prioritaet_darf_nur_wer_die_datei_verwaltet() {
    let Some(probe) = aufbauen("prio").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (besitzer, _) = probe.konto("prioeig").await;
    let (fremd, _) = probe.konto("priofremd").await;
    let anhang = probe.hochladen(&besitzer, &urlaubsvideo()).await;

    // Standard ist „normal" – alles andere wäre eine Entscheidung, die
    // niemand getroffen hat.
    assert_eq!(probe.prioritaet(anhang).await, "normal");

    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&besitzer),
            Some(json!({ "ids": [anhang], "prioritaet": "hoch" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["geaendert"], 1, "{antwort}");
    assert_eq!(probe.prioritaet(anhang).await, "hoch");

    /*
     * Ein Fremder bekommt keinen Fehler, sondern eine Absage in der Liste.
     *
     * Der Unterschied ist nicht kosmetisch: Wer zwanzig Dateien auswählt und
     * bei einer das Recht nicht hat, soll die neunzehn trotzdem bekommen. Ein
     * Alles-oder-nichts wäre hier die unfreundlichere Wahrheit.
     */
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&fremd),
            Some(json!({ "ids": [anhang], "prioritaet": "niedrig" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["geaendert"], 0, "{antwort}");
    assert_eq!(antwort["abgelehnt"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        probe.prioritaet(anhang).await,
        "hoch",
        "ein Fremder hat die Priorität verstellt"
    );

    // Und Unsinn wird gar nicht erst angenommen.
    let (status, _) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&besitzer),
            Some(json!({ "ids": [anhang], "prioritaet": "sehr hoch" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_die_sammlung_pflegen_darf_darf_auch_die_prioritaet_setzen() {
    /*
     * Der Weg, den der Anwender meint.
     *
     * „In einer Sammlung sollte man Fotos mit einer Priorität versehen
     * können" – das ist nicht der Hochladende, das ist der, der den Ordner
     * pflegt. Wer ihn pflegen darf, darf auch entscheiden, was davon schnell
     * erreichbar bleiben muss.
     */
    let Some(probe) = aufbauen("sammlung").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (besitzer, _) = probe.konto("sameig").await;
    let (helfer, helfer_id) = probe.konto("samhelf").await;
    let (nurgucker, gucker_id) = probe.konto("samguck").await;
    let anhang = probe.hochladen(&besitzer, &urlaubsvideo()).await;
    let (sammlung, _) = probe.sammlung_mit(&besitzer, anhang).await;

    for (wer, stufe) in [(helfer_id, "edit"), (gucker_id, "view")] {
        let (status, antwort) = probe
            .call(
                "POST",
                &format!("/api/v1/collections/{sammlung}/grants"),
                Some(&besitzer),
                Some(json!({ "userId": wer, "level": stufe })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{antwort}");
    }

    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&helfer),
            Some(json!({ "ids": [anhang], "prioritaet": "niedrig" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["geaendert"], 1, "{antwort}");
    assert_eq!(probe.prioritaet(anhang).await, "niedrig");

    // Ansehen ist nicht ändern.
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&nurgucker),
            Some(json!({ "ids": [anhang], "prioritaet": "hoch" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(
        antwort["geaendert"], 0,
        "wer nur ansehen darf, hat die Priorität verstellt: {antwort}"
    );
    assert_eq!(probe.prioritaet(anhang).await, "niedrig");
}

#[tokio::test(flavor = "multi_thread")]
async fn weitergeben_legt_keine_zweite_datei_an() {
    let Some(probe) = aufbauen("teilen").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("teilanna").await;
    let (bert, bert_id) = probe.konto("teilbert").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&anna, &daten).await;

    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "direct", "memberIds": [bert_id] })),
        )
        .await;
    assert!(status.is_success(), "{chat}");
    let chat_id = chat["id"].as_str().expect("Kennung").to_string();

    // Vorher: genau eine Datei auf der Platte.
    assert_eq!(dateien_sammeln(&probe.warm).len(), 1);

    let (status, nachricht) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&anna),
            Some(json!({
                "ids": [anhang],
                "conversationId": chat_id,
                "body": "Schau mal",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nachricht}");
    let kopie = Uuid::parse_str(
        nachricht["attachments"][0]["id"]
            .as_str()
            .expect("Anhang an der Nachricht"),
    )
    .expect("Kennung");
    assert_ne!(kopie, anhang, "es ist dieselbe Zeile geblieben");
    /*
     * Der Typ entscheidet, wie die Blase im Chat aussieht.
     *
     * `text` wäre bequem und falsch: Ein weitergegebenes Foto käme dann als
     * Textnachricht mit einem Anhang daneben an statt als Bild. Hier wurde
     * eine gewöhnliche Datei geteilt, also `file`.
     */
    assert_eq!(nachricht["type"], "file", "{nachricht}");

    // Dieselben Bytes: derselbe Schlüssel, und kein zweites Objekt.
    assert_eq!(
        probe.schluessel(kopie).await,
        probe.schluessel(anhang).await
    );
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        1,
        "das Weitergeben hat die Datei kopiert statt verwiesen"
    );
    let quelle: Option<Uuid> =
        sqlx::query_scalar("select quelle_id from attachments where id = $1")
            .bind(kopie)
            .fetch_one(&probe.state.pool)
            .await
            .expect("Kopie");
    assert_eq!(quelle, Some(anhang), "die Kopie kennt ihr Original nicht");

    // Und Bert kann sie lesen – vollständig und unverändert.
    let (status, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kopie}/bytes"),
            Some(&bert),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zurueck, daten);

    /*
     * Das Original selbst bleibt für Bert verschlossen.
     *
     * Weitergegeben wurde eine Fassung IN DIESEN CHAT. Daraus ein Recht am
     * Original abzuleiten hiesse, dass jede Weitergabe die Sammlung öffnet,
     * aus der die Datei kam.
     */
    let (status, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{anhang}/bytes"),
            Some(&bert),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "die Weitergabe hat das Original mit geöffnet"
    );

    /*
     * Und Bert kann Annas Original nicht seinerseits irgendwohin geben.
     *
     * Bert ist Mitglied dieses Chats und darf hier alles Mögliche
     * hineinstellen – nur nicht Annas Original, das er selbst nicht sehen
     * darf. Ohne diese Prüfung wäre „teilen" ein Weg, an jede Datei zu
     * kommen, deren Kennung man kennt: einmal weitergeben, und die
     * Zugriffsprüfung des Originals ist umgangen.
     */
    let (status, antwort) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&bert),
            Some(json!({ "ids": [anhang], "conversationId": chat_id })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "eine fremde Datei liess sich weitergeben: {antwort}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_sein_original_loescht_nimmt_dem_anderen_nichts_weg() {
    let Some(probe) = aufbauen("loeschen").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("loeanna").await;
    let (bert, bert_id) = probe.konto("loebert").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&anna, &daten).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "direct", "memberIds": [bert_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().expect("Kennung").to_string();
    let (status, nachricht) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&anna),
            Some(json!({ "ids": [anhang], "conversationId": chat_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nachricht}");
    let kopie = nachricht["attachments"][0]["id"]
        .as_str()
        .expect("Anhang")
        .to_string();

    // Anna löscht ihr Original. Sie darf das: Es hängt an keiner Nachricht.
    let (status, _) = probe
        .roh(
            "DELETE",
            &format!("/api/v1/media/{anhang}"),
            Some(&anna),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    /*
     * Die Bytes müssen stehen bleiben – Bert hält dieselbe Datei.
     *
     * Ohne die Prüfung in `remove` und ohne den Auslöser aus Migration 0020
     * wäre Berts Nachricht hier ein toter Verweis: Die Zeile stünde noch, das
     * Bild lüde nicht mehr. Und zwar ohne Fehlermeldung irgendwo.
     */
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        1,
        "das Löschen des Originals hat die geteilten Bytes mitgenommen"
    );
    let (status, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{kopie}/bytes"),
            Some(&bert),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zurueck, daten);

    // Auch der Aufräumdienst darf sie nicht holen.
    let storage: Arc<dyn initiative_api::storage::Storage> = probe.state.storage.clone();
    initiative_api::storage::muell::aufraeumen(&probe.state.pool, &storage).await;
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        1,
        "der Aufräumdienst hat die geteilten Bytes geholt"
    );

    // Erst wenn auch die letzte Zeile geht, darf aufgeräumt werden.
    sqlx::query("delete from attachments where id = $1::uuid")
        .bind(Uuid::parse_str(&kopie).unwrap())
        .execute(&probe.state.pool)
        .await
        .expect("löschen");
    initiative_api::storage::muell::aufraeumen(&probe.state.pool, &storage).await;
    assert!(
        dateien_sammeln(&probe.warm).is_empty(),
        "die letzte Zeile ist weg und die Bytes liegen noch da"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_geteilte_datei_zaehlt_und_wandert_einmal() {
    let Some(probe) = aufbauen("zaehlen").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("zaehlanna").await;
    let (_bert, bert_id) = probe.konto("zaehlbert").await;
    let daten = urlaubsvideo();
    let anhang = probe.hochladen(&anna, &daten).await;

    assert_eq!(
        auslagern::belegt(&probe.state.pool).await,
        daten.len() as i64
    );

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "direct", "memberIds": [bert_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().expect("Kennung").to_string();
    let (status, nachricht) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&anna),
            Some(json!({ "ids": [anhang], "conversationId": chat_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nachricht}");
    let kopie = Uuid::parse_str(nachricht["attachments"][0]["id"].as_str().unwrap()).unwrap();

    /*
     * Die Zahl darf sich durch das Weitergeben NICHT ändern.
     *
     * Sonst hielte der Dienst ein dreimal geteiltes Video für vier Videos und
     * räumte Platz frei, den es gar nicht gibt – oder schlimmer: Er räumte
     * weiter, obwohl längst genug frei ist.
     */
    assert_eq!(
        auslagern::belegt(&probe.state.pool).await,
        daten.len() as i64,
        "das Weitergeben hat den Füllstand verdoppelt"
    );

    // Bewegt wird sie einmal – und beide Zeilen wissen es danach.
    let bilanz = probe.durchgang(0, 0).await;
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(bilanz.bytes, daten.len() as i64, "{bilanz:?}");

    for (welche, wer) in [("Original", anhang), ("Kopie", kopie)] {
        let ablage: String = sqlx::query_scalar("select ablage from attachments where id = $1")
            .bind(wer)
            .fetch_one(&probe.state.pool)
            .await
            .expect("Zeile");
        assert_eq!(
            ablage, "fern",
            "{welche} behauptet weiter „lokal\", während die Bytes drüben liegen"
        );
    }
    assert!(dateien_sammeln(&probe.warm).is_empty());
    assert_eq!(dateien_sammeln(&probe.kalt).len(), 1);

    /*
     * Die Priorität gilt für beide Zeilen.
     *
     * Ausgelagert wird ohnehin nur nach dem Original – aber eine Kopie, die
     * weiter „normal" anzeigt, während das Original auf „hoch" steht, wäre in
     * der Oberfläche schlicht gelogen. Gesetzt wird hier an der KOPIE, damit
     * die Richtung stimmt: Sie muss bis zum Original durchschlagen.
     */
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/media/prioritaet",
            Some(&anna),
            Some(json!({ "ids": [kopie], "prioritaet": "hoch" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(probe.prioritaet(kopie).await, "hoch");
    assert_eq!(
        probe.prioritaet(anhang).await,
        "hoch",
        "die Kopie sagt „hoch\", das Original weiter etwas anderes"
    );

    // Ein zweiter Durchgang findet nichts mehr – sonst liefe der Dienst ewig.
    let bilanz = probe.durchgang(0, 0).await;
    assert_eq!(bilanz, auslagern::Bilanz::default(), "{bilanz:?}");

    // Und lesbar ist sie weiterhin, über beide Zeilen.
    for wer in [anhang, kopie] {
        let (status, zurueck) = probe
            .roh(
                "GET",
                &format!("/api/v1/media/{wer}/bytes"),
                Some(&anna),
                vec![],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{wer}");
        assert_eq!(zurueck, daten, "{wer}");
    }
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
