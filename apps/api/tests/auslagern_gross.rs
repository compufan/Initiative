//! Sehr grosse Dateien und die kalte Ablage: Fehler, Abbrüche, volle Platte.
//!
//! `tests/auslagern.rs` zeigt den guten Weg. Hier steht, was bei Dateien von
//! Gigabytes zählt, wenn etwas schiefgeht – mit einer Attrappe der kalten
//! Ablage, die auf Befehl ausfällt, mittendrin abbricht, zu wenig behält oder
//! die Datei löscht, während sie noch unterwegs ist. Der SFTP-Treiber selbst
//! wird in `tests/sftp_gross.rs` gegen einen echten SFTP-Server geprüft.
//!
//! Die Platzprüfung beim Anlegen eines Uploads bekommt eine „volle" Platte
//! über `UPLOAD_PLATTE_RESERVE_BYTES` in Höhe des echten freien Platzes plus
//! etwas: Es muss kein Terabyte geschrieben werden, um die Regel zu zeigen.
//! Was auslagerbar wäre, steht in der Datenbank (`attachments.size`) – die
//! Zeile genügt, die Datei muss es für die Platzrechnung nicht geben.

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
use initiative_api::storage::Storage;
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

/// Der Aufbau muss nacheinander laufen – die Umgebung gehört dem Prozess,
/// nicht dem einzelnen Test. Sonst setzt der zweite `KALT_LOKAL_DIR` um,
/// während der erste noch seinen Zustand baut.
static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn aufbauen(name: &str, kalt_treiber: &str, reserve: Option<i64>) -> Option<Probe> {
    aufbauen_mit(name, kalt_treiber, reserve, true).await
}

async fn aufbauen_mit(
    name: &str,
    kalt_treiber: &str,
    reserve: Option<i64>,
    mit_schluessel: bool,
) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let kennung = Uuid::now_v7().simple();
    let warm = format!("./.data/kalt-warm-{name}-{kennung}");
    let kalt = format!("./.data/kalt-kalt-{name}-{kennung}");
    let schema = format!("kaltgross_{name}");

    let config = {
        let _schloss = AUFBAU.lock().await;
        std::env::set_var("DATABASE_URL", &url);
        std::env::set_var("NODE_ENV", "test");
        std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
        std::env::set_var("REALTIME_BUS", "memory");
        std::env::set_var("STORAGE_DRIVER", "local");
        std::env::set_var("LOCAL_STORAGE_DIR", &warm);
        std::env::set_var("KALT_TREIBER", kalt_treiber);
        match reserve {
            Some(r) => std::env::set_var("UPLOAD_PLATTE_RESERVE_BYTES", r.to_string()),
            None => std::env::remove_var("UPLOAD_PLATTE_RESERVE_BYTES"),
        }
        std::env::set_var("KALT_LOKAL_DIR", &kalt);
        std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
        std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
        if mit_schluessel {
            std::env::set_var("MEDIA_KEY", STANDARD.encode([7u8; 32]));
        } else {
            std::env::remove_var("MEDIA_KEY");
        }
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

const MIB: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Wie {
    Gesund,
    /// Die Box antwortet nicht.
    Tot,
    /// Die Hälfte kommt an, dann reisst die Verbindung.
    HalbDannAbbruch,
    /// Meldet Erfolg, hat aber nur die Hälfte behalten.
    ZuKurz,
    /// Die Nachricht wird gelöscht, während die Datei unterwegs ist.
    GeloeschtUnterwegs,
    /// Gleich lang, aber ein Byte in der Mitte ist anders (Bitfehler auf der Box).
    Verfaelscht,
}

struct Attrappe {
    innen: Arc<dyn Storage>,
    wie: std::sync::Mutex<Wie>,
    pool: sqlx::PgPool,
}

impl Attrappe {
    fn wie(&self) -> Wie {
        *self.wie.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl Storage for Attrappe {
    fn kind(&self) -> &'static str {
        "attrappe"
    }
    fn supports_presigned_upload(&self) -> bool {
        false
    }
    fn presign_upload(
        &self,
        k: &str,
        m: &str,
    ) -> initiative_api::error::AppResult<initiative_api::storage::PresignedUpload> {
        self.innen.presign_upload(k, m)
    }
    fn download_url(
        &self,
        k: &str,
        o: &initiative_api::storage::DownloadOptions,
    ) -> initiative_api::error::AppResult<Option<String>> {
        self.innen.download_url(k, o)
    }
    async fn put(
        &self,
        k: &str,
        b: axum::body::Bytes,
        m: &str,
    ) -> initiative_api::error::AppResult<()> {
        self.innen.put(k, b, m).await
    }
    async fn put_datei(
        &self,
        k: &str,
        pfad: &std::path::Path,
        m: &str,
    ) -> initiative_api::error::AppResult<()> {
        let roh = std::fs::read(pfad).unwrap();
        match self.wie() {
            Wie::Gesund => self.innen.put_datei(k, pfad, m).await,
            Wie::Tot => Err(initiative_api::error::AppError::internal(
                "Storage Box nicht erreichbar",
            )),
            Wie::HalbDannAbbruch => {
                self.innen
                    .put(k, axum::body::Bytes::from(roh[..roh.len() / 2].to_vec()), m)
                    .await?;
                Err(initiative_api::error::AppError::internal(
                    "Verbindung abgerissen",
                ))
            }
            Wie::ZuKurz => {
                self.innen
                    .put(k, axum::body::Bytes::from(roh[..roh.len() / 2].to_vec()), m)
                    .await
            }
            Wie::Verfaelscht => {
                let mut kaputt = roh.clone();
                let mitte = kaputt.len() / 2;
                kaputt[mitte] ^= 0xff;
                self.innen
                    .put(k, axum::body::Bytes::from(kaputt), m)
                    .await
            }
            Wie::GeloeschtUnterwegs => {
                self.innen.put_datei(k, pfad, m).await?;
                sqlx::query("delete from attachments where storage_key = $1")
                    .bind(k)
                    .execute(&self.pool)
                    .await
                    .unwrap();
                Ok(())
            }
        }
    }
    async fn read(
        &self,
        k: &str,
        r: Option<initiative_api::storage::ByteRange>,
    ) -> initiative_api::error::AppResult<Option<initiative_api::storage::ObjectStream>> {
        if self.wie() == Wie::Tot {
            return Err(initiative_api::error::AppError::internal(
                "Storage Box nicht erreichbar",
            ));
        }
        self.innen.read(k, r).await
    }
    async fn delete(&self, k: &str) -> initiative_api::error::AppResult<()> {
        self.innen.delete(k).await
    }
}

impl Probe {
    fn attrappe(&self, wie: Wie) -> (Arc<Attrappe>, Arc<dyn Storage>) {
        let a = Arc::new(Attrappe {
            innen: self.state.speicher.kalt.clone().expect("kalte Ablage"),
            wie: std::sync::Mutex::new(wie),
            pool: self.state.pool.clone(),
        });
        let dyn_a: Arc<dyn Storage> = a.clone();
        (a, dyn_a)
    }

    async fn durchgang_regeln(
        &self,
        kalt: &Arc<dyn Storage>,
        regeln: auslagern::Regeln,
    ) -> auslagern::Bilanz {
        auslagern::durchgang_mit_regeln(
            &self.state.pool,
            &self.state.speicher.warm,
            kalt,
            100 * GIB,
            120 * GIB,
            0,
            regeln,
        )
        .await
    }

    async fn durchgang_mit(&self, kalt: &Arc<dyn Storage>, bedarf: i64) -> auslagern::Bilanz {
        auslagern::durchgang_mit_bedarf(
            &self.state.pool,
            &self.state.speicher.warm,
            kalt,
            100 * GIB,
            120 * GIB,
            bedarf,
        )
        .await
    }

    /// Einen Anhang mit Zeile, aber ohne Datei – genug für die Platzrechnung.
    async fn leere_zeile(&self, token: &str, groesse: i64) {
        let uid: uuid::Uuid =
            sqlx::query_scalar("select id from users order by created_at desc limit 1")
                .fetch_one(&self.state.pool)
                .await
                .unwrap();
        let _ = token;
        sqlx::query(
            "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
             values ($1, $2, 'file', 'application/octet-stream', $3, $4, 'ready')",
        )
        .bind(Uuid::now_v7())
        .bind(uid)
        .bind(groesse)
        .bind(format!("file/{}", Uuid::now_v7()))
        .execute(&self.state.pool)
        .await
        .expect("Zeile");
    }

    async fn stueck_anlegen(&self, token: &str, groesse: i64) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/media/stuecke",
            Some(token),
            Some(json!({"kind": "file", "mime": "application/octet-stream", "size": groesse, "fileName": "gross.bin"})),
        )
        .await
    }
}

/// Alle Tests dieser Datei teilen den Zustand „kalte Ablage erreichbar".
static REIHE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn frei_jetzt() -> i64 {
    initiative_api::modules::stuecke::frei_auf_platte(std::path::Path::new(".")).expect("statvfs")
        as i64
}

fn video(n: usize) -> Vec<u8> {
    (0..n as u32).map(|i| (i % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_tote_box_bricht_den_durchgang_ab_und_nichts_geht_verloren() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("tot", "lokal", None).await else {
        return;
    };
    let token = probe.konto("gtot").await;
    let ids = [
        probe.hochladen(&token, &video(3 * MIB)).await,
        probe.hochladen(&token, &video(3 * MIB + 1)).await,
        probe.hochladen(&token, &video(3 * MIB + 2)).await,
    ];
    for id in ids {
        probe.prioritaet_setzen(id, "niedrig").await;
    }
    let (a, kalt) = probe.attrappe(Wie::Tot);
    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    // Zwei Fehlschläge an der Box genügen: Der dritte Umzug wird gar nicht erst versucht.
    assert!(bilanz.kalt_gestoert, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 2, "{bilanz:?}");
    assert!(!auslagern::kalt_erreichbar());
    for id in ids {
        assert_eq!(probe.ablage(id).await.0, "lokal", "Ablage nach Ausfall");
    }
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        3,
        "warme Dateien fehlen"
    );

    // Die Box kommt wieder: Der nächste Durchgang holt alles nach.
    *a.wie.lock().unwrap() = Wie::Gesund;
    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 3, "{bilanz:?}");
    assert!(auslagern::kalt_erreichbar());
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_abbruch_mittendrin_laesst_die_datei_warm_und_lesbar() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("halb", "lokal", None).await else {
        return;
    };
    let token = probe.konto("ghalb").await;
    let daten = video(4 * MIB);
    let id = probe.hochladen(&token, &daten).await;
    probe.prioritaet_setzen(id, "niedrig").await;
    let (a, kalt) = probe.attrappe(Wie::HalbDannAbbruch);

    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 0, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 1);
    assert_eq!(probe.ablage(id).await.0, "lokal");
    let (status, _, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{id}/bytes"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        zurueck, daten,
        "nach dem Abbruch ist die Datei nicht mehr lesbar"
    );

    // Wiederholung mit gesunder Box gelingt und überschreibt die halbe Fassung.
    *a.wie.lock().unwrap() = Wie::Gesund;
    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    let (_, _, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{id}/bytes"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(zurueck, daten);
}

#[tokio::test(flavor = "multi_thread")]
async fn drueben_zu_kurz_heisst_die_warme_fassung_bleibt() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("kurz", "lokal", None).await else {
        return;
    };
    let token = probe.konto("gkurz").await;
    let id = probe.hochladen(&token, &video(2 * MIB)).await;
    probe.prioritaet_setzen(id, "niedrig").await;
    let (_, kalt) = probe.attrappe(Wie::ZuKurz);

    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 0, "{bilanz:?}");
    assert_eq!(probe.ablage(id).await.0, "lokal");
    assert_eq!(
        dateien_sammeln(&probe.warm).len(),
        1,
        "die warme Fassung wurde gelöscht"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn wird_die_datei_unterwegs_geloescht_bleibt_drueben_nichts_liegen() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("unterwegs", "lokal", None).await else {
        return;
    };
    let token = probe.konto("gunter").await;
    let id = probe.hochladen(&token, &video(2 * MIB)).await;
    probe.prioritaet_setzen(id, "niedrig").await;
    let (_, kalt) = probe.attrappe(Wie::GeloeschtUnterwegs);

    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 0, "{bilanz:?}");
    assert!(
        dateien_sammeln(&probe.kalt).is_empty(),
        "die ferne Fassung einer gelöschten Datei blieb liegen: {:?}",
        dateien_sammeln(&probe.kalt)
    );
    assert!(dateien_sammeln(&probe.warm).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn mitten_im_umzug_geloeschte_dateien_werden_in_beiden_ablagen_geloescht() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("wandert", "lokal", None).await else {
        return;
    };
    let token = probe.konto("gwand").await;
    let id = probe.hochladen(&token, &video(2 * MIB)).await;
    let schluessel: String =
        sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(id)
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    // Zustand „wandert": warm vollständig, drüben ein Teil.
    let warm_datei = dateien_sammeln(&probe.warm).remove(0);
    let kalt_datei = warm_datei.replacen(&probe.warm, &probe.kalt, 1);
    std::fs::create_dir_all(std::path::Path::new(&kalt_datei).parent().unwrap()).unwrap();
    std::fs::write(&kalt_datei, b"halb").unwrap();
    sqlx::query("update attachments set ablage = 'wandert' where id = $1")
        .bind(id)
        .execute(&probe.state.pool)
        .await
        .unwrap();
    sqlx::query("delete from attachments where id = $1")
        .bind(id)
        .execute(&probe.state.pool)
        .await
        .unwrap();
    let vermerkt: String =
        sqlx::query_scalar("select ablage from storage_muell where storage_key = $1")
            .bind(&schluessel)
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(vermerkt, "wandert");

    let storage: Arc<dyn Storage> = probe.state.storage.clone();
    aufraeumen(&probe.state.pool, &storage).await;
    assert!(dateien_sammeln(&probe.warm).is_empty(), "warm blieb liegen");
    assert!(dateien_sammeln(&probe.kalt).is_empty(), "kalt blieb liegen");
}

#[tokio::test(flavor = "multi_thread")]
async fn bei_knapper_platte_wandert_auch_normales_und_hohes_in_der_reihenfolge_der_klassen() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen("bedarf", "lokal", None).await else {
        return;
    };
    let token = probe.konto("gbed").await;
    let hoch = probe.hochladen(&token, &video(2 * MIB)).await;
    let normal = probe.hochladen(&token, &video(2 * MIB + 1)).await;
    let niedrig = probe.hochladen(&token, &video(2 * MIB + 2)).await;
    probe.prioritaet_setzen(hoch, "hoch").await;
    probe.prioritaet_setzen(niedrig, "niedrig").await;
    let (_, kalt) = probe.attrappe(Wie::Gesund);

    // Ohne Bedarf: nur „niedrig" – der Server ist ja fast leer.
    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(niedrig).await.0, "fern");
    assert_eq!(probe.ablage(normal).await.0, "lokal");

    // Mit Bedarf von drei Megabyte: erst „normal" (2 MiB reichen nicht), dann „hoch".
    let bilanz = probe.durchgang_mit(&kalt, 3 * MIB as i64).await;
    assert_eq!(bilanz.bewegt, 2, "{bilanz:?}");
    assert_eq!(probe.ablage(normal).await.0, "fern");
    assert_eq!(probe.ablage(hoch).await.0, "fern");

    // Ein kleiner Bedarf holt nur so viel, wie nötig ist, und beginnt bei „normal".
    let a = probe.hochladen(&token, &video(2 * MIB + 3)).await;
    let b = probe.hochladen(&token, &video(2 * MIB + 4)).await;
    probe.prioritaet_setzen(b, "hoch").await;
    let bilanz = probe.durchgang_mit(&kalt, 1).await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(
        probe.ablage(a).await.0,
        "fern",
        "die normale muss vor der hohen gehen"
    );
    assert_eq!(probe.ablage(b).await.0, "lokal");
}

#[tokio::test(flavor = "multi_thread")]
async fn volle_platte_ohne_kalte_ablage_lehnt_ab_mit_kalter_ablage_nimmt_sie_an() {
    let _r = REIHE.lock().await;
    // „Voll": Die Reserve ist grösser als alles, was frei ist.
    let reserve = frei_jetzt() + GIB;

    // 1. Keine kalte Ablage → klare Absage wie bisher.
    let Some(ohne) = aufbauen("voll_ohne", "aus", Some(reserve)).await else {
        return;
    };
    let token = ohne.konto("gvollo").await;
    let (status, antwort) = ohne.stueck_anlegen(&token, 10 * MIB as i64).await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{antwort}");

    // 2. Kalte Ablage, aber nichts Auslagerbares da → Absage, die das sagt.
    auslagern::kalt_erreichbar_setzen(true);
    let Some(mit) = aufbauen("voll_mit", "lokal", Some(reserve)).await else {
        return;
    };
    let token = mit.konto("gvollm").await;
    let (status, antwort) = mit.stueck_anlegen(&token, 10 * MIB as i64).await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{antwort}");
    assert!(
        antwort.to_string().contains("auslagern"),
        "die Absage nennt den Grund nicht: {antwort}"
    );

    // 3. Es liegt genug Auslagerbares warm (nur die Zeile zählt) → angenommen.
    mit.leere_zeile(&token, 3 * GIB).await;
    let (status, antwort) = mit.stueck_anlegen(&token, 10 * MIB as i64).await;
    assert_eq!(status, StatusCode::CREATED, "{antwort}");

    // 4. Dieselbe Lage, aber die Box ist nicht erreichbar → Absage mit diesem Grund.
    auslagern::kalt_erreichbar_setzen(false);
    let (status, antwort) = mit.stueck_anlegen(&token, 11 * MIB as i64).await;
    auslagern::kalt_erreichbar_setzen(true);
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{antwort}");
    assert!(
        antwort.to_string().contains("nicht erreichbar"),
        "die Absage nennt die Box nicht: {antwort}"
    );
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

fn sha_hex(daten: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(daten))
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_falsche_pruefsumme_drueben_haelt_die_datei_warm_und_raeumt_die_ferne_weg() {
    let _r = REIHE.lock().await;
    // Ohne Tresor: Drüben liegt Klartext, die gespeicherte Summe gilt ihm.
    let Some(probe) = aufbauen_mit("summe", "lokal", None, false).await else {
        return;
    };
    let token = probe.konto("gsumme").await;
    let daten = video(2 * MIB + 5);
    let id = probe.hochladen(&token, &daten).await;
    probe.prioritaet_setzen(id, "niedrig").await;
    sqlx::query("update attachments set sha256 = $2 where id = $1")
        .bind(id)
        .bind(sha_hex(&daten))
        .execute(&probe.state.pool)
        .await
        .unwrap();
    let regeln = auslagern::Regeln {
        pruefsumme_bis: 64 * MIB as u64,
    };

    // Bitfehler auf der Box, gleiche Länge: Die Grösse allein hätte es durchgelassen.
    let (a, kalt) = probe.attrappe(Wie::Verfaelscht);
    let bilanz = probe.durchgang_regeln(&kalt, regeln).await;
    assert_eq!(bilanz.bewegt, 0, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(id).await.0, "lokal");
    assert_eq!(dateien_sammeln(&probe.warm).len(), 1, "die warme Fassung muss bleiben");
    assert_eq!(
        dateien_sammeln(&probe.kalt).len(),
        0,
        "die verfälschte ferne Fassung muss weg sein"
    );

    // Ohne Gegenlesen (0) ginge dieselbe Verfälschung durch – das ist die
    // Grenze, die in `Regeln` begründet ist.
    let bilanz = probe
        .durchgang_regeln(&kalt, auslagern::Regeln::default())
        .await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    let _ = a;
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_richtige_pruefsumme_laesst_den_umzug_durch_und_grosse_dateien_werden_nicht_gegengelesen() {
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen_mit("summe2", "lokal", None, false).await else {
        return;
    };
    let token = probe.konto("gsumme2").await;
    let klein = video(MIB + 3);
    let gross = video(3 * MIB);
    let id_klein = probe.hochladen(&token, &klein).await;
    let id_gross = probe.hochladen(&token, &gross).await;
    for (id, daten) in [(id_klein, &klein), (id_gross, &gross)] {
        probe.prioritaet_setzen(id, "niedrig").await;
        sqlx::query("update attachments set sha256 = $2 where id = $1")
            .bind(id)
            .bind(sha_hex(daten))
            .execute(&probe.state.pool)
            .await
            .unwrap();
    }
    // Schwelle zwischen klein (1 MiB) und gross (3 MiB), dazu eine
    // verfälschende Box: Nur die kleine wird geprüft – und fällt durch; die
    // grosse geht mangels Gegenlesen durch (Grösse stimmt ja).
    let (_a, kalt) = probe.attrappe(Wie::Verfaelscht);
    let bilanz = probe
        .durchgang_regeln(
            &kalt,
            auslagern::Regeln {
                pruefsumme_bis: 2 * MIB as u64,
            },
        )
        .await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(id_klein).await.0, "lokal");
    assert_eq!(probe.ablage(id_gross).await.0, "fern");

    // Mit gesunder Box und richtiger Summe geht die kleine durch.
    let (_a, gesund) = probe.attrappe(Wie::Gesund);
    let bilanz = probe
        .durchgang_regeln(
            &gesund,
            auslagern::Regeln {
                pruefsumme_bis: 2 * MIB as u64,
            },
        )
        .await;
    assert_eq!(bilanz.bewegt, 1, "{bilanz:?}");
    assert_eq!(probe.ablage(id_klein).await.0, "fern");
}

#[tokio::test(flavor = "multi_thread")]
async fn der_konsistenzcheck_findet_fehlendes_falsche_groessen_verwaistes_und_bitfehler() {
    use initiative_api::services::konsistenz::{self, Optionen};
    let _r = REIHE.lock().await;
    let Some(probe) = aufbauen_mit("konsist", "lokal", None, false).await else {
        return;
    };
    let token = probe.konto("gkons").await;
    let mut ids = Vec::new();
    let mut inhalte = Vec::new();
    for i in 0..4usize {
        let daten = video(MIB + 100 + i);
        let id = probe.hochladen(&token, &daten).await;
        probe.prioritaet_setzen(id, "niedrig").await;
        sqlx::query("update attachments set sha256 = $2 where id = $1")
            .bind(id)
            .bind(sha_hex(&daten))
            .execute(&probe.state.pool)
            .await
            .unwrap();
        ids.push(id);
        inhalte.push(daten);
    }
    let kalt = probe.state.speicher.kalt.clone().unwrap();
    let bilanz = probe.durchgang_mit(&kalt, 0).await;
    assert_eq!(bilanz.bewegt, 4, "{bilanz:?}");

    let opt = Optionen {
        stichprobe: 10,
        stichprobe_max_bytes: 64 * MIB as u64,
        mit_tresor: false,
    };
    let aussen = probe.state.storage.clone();

    // Heil: alles in Ordnung, die Stichprobe liest alle vier ganz.
    let b = konsistenz::pruefen(&probe.state.pool, &kalt, &aussen, opt)
        .await
        .unwrap()
        .unwrap();
    assert!(b.in_ordnung(), "{b:?}");
    assert_eq!(b.zeilen_fern, 4);
    assert_eq!(b.objekte_box, 4);
    assert_eq!(b.stichprobe_geprueft, 4);

    // Schlüssel der vier Dateien.
    let mut keys = Vec::new();
    for id in &ids {
        let k: String = sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(id)
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
        keys.push(k);
    }
    let drueben = |k: &str| std::path::Path::new(&probe.kalt).join(k);
    // 1: fehlt. 2: zu kurz. 3: gleich lang, aber ein Byte anders.
    std::fs::remove_file(drueben(&keys[1])).unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(drueben(&keys[2])).unwrap();
    f.set_len(1000).unwrap();
    let mut roh = std::fs::read(drueben(&keys[3])).unwrap();
    roh[500] ^= 0x55;
    std::fs::write(drueben(&keys[3]), roh).unwrap();
    // Verwaist, ein Teilrest und ein Rest eines Umzugs (Zeile lokal).
    std::fs::create_dir_all(drueben("file/2026/01/x")).unwrap();
    std::fs::write(drueben("file/2026/01/x/waise.bin"), b"waise").unwrap();
    std::fs::write(drueben("file/2026/01/x/halb.bin.teil"), b"halb").unwrap();
    let lokal_id = probe.hochladen(&token, &video(2000)).await;
    let lokal_key: String = sqlx::query_scalar("select storage_key from attachments where id = $1")
        .bind(lokal_id)
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    std::fs::create_dir_all(drueben(&lokal_key).parent().unwrap()).unwrap();
    std::fs::write(drueben(&lokal_key), video(2000)).unwrap();

    let b = konsistenz::pruefen(&probe.state.pool, &kalt, &aussen, opt)
        .await
        .unwrap()
        .unwrap();
    assert!(!b.in_ordnung());
    assert_eq!(b.fehlend.anzahl, 1, "{b:?}");
    assert_eq!(b.fehlend.beispiele, vec![keys[1].clone()]);
    assert_eq!(b.falsche_groesse.anzahl, 1, "{b:?}");
    assert!(b.falsche_groesse.beispiele[0].contains(&keys[2]));
    assert_eq!(b.verwaist.anzahl, 1, "{b:?}");
    assert_eq!(b.verwaist.beispiele, vec!["file/2026/01/x/waise.bin".to_string()]);
    assert_eq!(b.rest_von_umzug.anzahl, 1, "{b:?}");
    assert_eq!(b.teilreste.anzahl, 1, "{b:?}");
    // Der Bitfehler (gleiche Länge) fällt NUR durch die Stichprobe auf; die
    // zu kurze Datei zusätzlich auch dort. Die fehlende wird nicht doppelt gemeldet.
    assert_eq!(b.stichprobe_abweichend.anzahl, 2, "{b:?}");
    assert!(b
        .stichprobe_abweichend
        .beispiele
        .iter()
        .any(|t| t.contains(&keys[3])));

    // Über HTTP: nur für Admins, mit lesbarem Ergebnis.
    let (status, _) = probe
        .call("GET", "/api/v1/admin/storage-check/konsistenz", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    sqlx::query("update users set is_admin = true")
        .execute(&probe.state.pool)
        .await
        .unwrap();
    let (status, antwort) = probe
        .call(
            "GET",
            "/api/v1/admin/storage-check/konsistenz?stichprobe=10",
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    let schritte = antwort["steps"].as_array().unwrap();
    let schritt = |name: &str| schritte.iter().find(|s| s["name"] == name).unwrap().clone();
    assert_eq!(schritt("Fehlende Dateien")["ok"], false);
    assert_eq!(schritt("Reste eines Umzugs")["ok"], true);
    assert_eq!(schritt("Prüfsummen-Stichprobe")["ok"], false);
    assert_eq!(antwort["bericht"]["fehlend"]["anzahl"], 1);
    assert!(antwort["verdict"].as_str().unwrap().contains("Abweichungen"));
}
