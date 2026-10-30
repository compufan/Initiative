//! Selbsttest für den Objektspeicher.
//!
//! Wenn ein Upload im Browser scheitert, sagt die Fehlermeldung dort fast
//! nichts: Ein blockierter Cross-Origin-Upload bricht ohne Statuscode ab. Von
//! hier aus lässt sich dagegen jeder Schritt einzeln prüfen – Zugangsdaten,
//! Endpunkt, Bucket und vor allem die CORS-Regel, die der Browser braucht.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::AdminUser;
use crate::config::StorageDriver;
use crate::error::AppResult;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/storage-check", get(storage_check))
        .route("/admin/storage-check/kalt", get(kalt_check))
        .route("/admin/storage-check/konsistenz", get(konsistenz_check))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    /// Was zu tun ist, falls der Schritt fehlschlägt.
    pub hint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    driver: String,
    endpoint: Option<String>,
    bucket: Option<String>,
    path_style: Option<bool>,
    /// Origin, den der Browser beim Hochladen benutzt.
    browser_origin: String,
    steps: Vec<Step>,
    verdict: String,
}

async fn storage_check(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<CheckResult>> {
    let s3 = state.config.s3.as_ref();
    let origin = state.config.public_app_url.clone();
    let mut steps: Vec<Step> = Vec::new();

    if state.config.storage_driver == StorageDriver::Local {
        return Ok(Json(CheckResult {
            driver: "local".into(),
            endpoint: None,
            bucket: None,
            path_style: None,
            browser_origin: origin,
            steps: vec![Step {
                name: "Treiber".into(),
                // Kein Fehler: Auf einem eigenen Server ist das der Normalfall
                // und die richtige Wahl. Der Text sagte frueher, die Dateien
                // gingen "beim naechsten Deploy verloren" – das stimmt nur
                // dort, wo das Dateisystem fluechtig ist (Fly.io), und stiftet
                // auf einer Maschine mit dauerhaftem Datentraeger Verwirrung.
                ok: true,
                detail: "STORAGE_DRIVER steht auf local – die Dateien liegen im Dateisystem des Servers".into(),
                hint: Some(
                    "Richtig, solange dieses Verzeichnis dauerhaft ist (eigener Server, eingehängter Datenträger) UND im Backup steht – Bilder liegen nicht in der Datenbank. Auf einer Plattform mit flüchtigem Container-Dateisystem gehen sie beim nächsten Deploy verloren; dort gehört STORAGE_DRIVER auf r2.".into(),
                ),
            }],
            verdict: "Dateien liegen lokal – Backup nicht vergessen".into(),
        }));
    }

    // 1. Schreiben, lesen, löschen – beweist Zugangsdaten, Endpunkt und Bucket.
    let key = format!("_selbsttest/{}.txt", Uuid::now_v7());
    let payload = axum::body::Bytes::from_static(b"initiative-selbsttest");
    let write = state.storage.put(&key, payload.clone(), "text/plain").await;
    match &write {
        Ok(()) => steps.push(Step {
            name: "Schreiben".into(),
            ok: true,
            detail: "Testdatei wurde in den Bucket geschrieben".into(),
            hint: None,
        }),
        Err(error) => steps.push(Step {
            name: "Schreiben".into(),
            ok: false,
            detail: error.to_string(),
            hint: Some(
                "Prüfe S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID und S3_SECRET_ACCESS_KEY. Der Endpunkt enthält NUR Account-ID und Domain, nicht den Bucket-Namen.".into(),
            ),
        }),
    }

    if write.is_ok() {
        // Geprüft wird über eine signierte Download-Adresse – genau der Weg, den
        // auch die App zum Anzeigen von Bildern benutzt. (Der Treiber kann
        // seit Kurzem auch selbst lesen, aber das ist der Weg für
        // `/media/{id}/bytes`, nicht der für die Anzeige.)
        let url = state
            .storage
            .adresse(&key, &crate::storage::DownloadOptions::default())
            .await;
        steps.push(match url {
            Ok(Some(url)) => {
                let fetched = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .build()
                    .map(|client| client.get(url).send());
                match fetched {
                    Ok(future) => match future.await {
                        Ok(res) if res.status().is_success() => Step {
                            name: "Lesen".into(),
                            ok: true,
                            detail: "Testdatei konnte über eine signierte URL zurückgelesen werden"
                                .into(),
                            hint: None,
                        },
                        Ok(res) => Step {
                            name: "Lesen".into(),
                            ok: false,
                            detail: format!("Antwort {}", res.status()),
                            hint: Some(
                                "Das Token braucht Object Read & Write, nicht nur Write.".into(),
                            ),
                        },
                        Err(error) => Step {
                            name: "Lesen".into(),
                            ok: false,
                            detail: error.to_string(),
                            hint: None,
                        },
                    },
                    Err(error) => Step {
                        name: "Lesen".into(),
                        ok: false,
                        detail: error.to_string(),
                        hint: None,
                    },
                }
            }
            Ok(None) => Step {
                name: "Lesen".into(),
                ok: true,
                detail: "Öffentliche Bucket-Domain gesetzt, signierte URLs entfallen".into(),
                hint: None,
            },
            Err(error) => Step {
                name: "Lesen".into(),
                ok: false,
                detail: error.to_string(),
                hint: None,
            },
        });
        let _ = state.storage.delete(&key).await;
    }

    // 2. Die CORS-Vorabanfrage – genau die, an der ein Browser-Upload scheitert.
    if let Some(settings) = s3 {
        let target = state.storage.presign_upload(&key, "image/webp");
        match target {
            Ok(upload) => {
                let probe = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .build();
                match probe {
                    Ok(client) => {
                        let response = client
                            .request(reqwest::Method::OPTIONS, &upload.url)
                            .header("Origin", &origin)
                            .header("Access-Control-Request-Method", "PUT")
                            .header("Access-Control-Request-Headers", "content-type")
                            .send()
                            .await;
                        steps.push(match response {
                            Ok(res) => {
                                let status = res.status();
                                let allow_origin = res
                                    .headers()
                                    .get("access-control-allow-origin")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                                    .to_string();
                                let allow_methods = res
                                    .headers()
                                    .get("access-control-allow-methods")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                                    .to_string();
                                let allow_headers = res
                                    .headers()
                                    .get("access-control-allow-headers")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                                    .to_string();

                                let origin_ok = allow_origin == origin || allow_origin == "*";
                                let method_ok = allow_methods.to_uppercase().contains("PUT");
                                let ok = origin_ok && method_ok;

                                Step {
                                    name: "CORS-Regel".into(),
                                    ok,
                                    detail: format!(
                                        "Antwort {status}; allow-origin: {}; allow-methods: {}; allow-headers: {}",
                                        if allow_origin.is_empty() { "(keiner)" } else { &allow_origin },
                                        if allow_methods.is_empty() { "(keine)" } else { &allow_methods },
                                        if allow_headers.is_empty() { "(keine)" } else { &allow_headers },
                                    ),
                                    hint: if ok {
                                        None
                                    } else if allow_origin.is_empty() {
                                        Some(format!(
                                            "Der Bucket schickt gar keine CORS-Kopfzeilen zurück. Trage im Bucket unter Settings → CORS Policy eine Regel mit AllowedOrigins [\"{origin}\"], AllowedMethods [\"PUT\",\"GET\"] und AllowedHeaders [\"content-type\"] ein."
                                        ))
                                    } else if !origin_ok {
                                        Some(format!(
                                            "Die Regel erlaubt \"{allow_origin}\", der Browser meldet sich aber als \"{origin}\". Beide müssen exakt übereinstimmen – ohne Schrägstrich am Ende. Stimmt PUBLIC_APP_URL mit der echten Adresse der App überein?"
                                        ))
                                    } else {
                                        Some("In AllowedMethods fehlt PUT.".into())
                                    },
                                }
                            }
                            Err(error) => Step {
                                name: "CORS-Regel".into(),
                                ok: false,
                                detail: error.to_string(),
                                hint: Some("Der Speicher-Endpunkt war nicht erreichbar.".into()),
                            },
                        });
                    }
                    Err(error) => steps.push(Step {
                        name: "CORS-Regel".into(),
                        ok: false,
                        detail: error.to_string(),
                        hint: None,
                    }),
                }
            }
            Err(error) => steps.push(Step {
                name: "CORS-Regel".into(),
                ok: false,
                detail: error.to_string(),
                hint: None,
            }),
        }

        let all_ok = steps.iter().all(|step| step.ok);
        return Ok(Json(CheckResult {
            driver: state.storage.kind().to_string(),
            endpoint: settings.endpoint.clone(),
            bucket: Some(settings.bucket.clone()),
            path_style: Some(settings.path_style),
            browser_origin: origin,
            verdict: if all_ok {
                "Alles in Ordnung – Uploads sollten funktionieren.".into()
            } else {
                "Es hakt. Die Hinweise unten nennen die Ursache.".into()
            },
            steps,
        }));
    }

    Ok(Json(CheckResult {
        driver: state.storage.kind().to_string(),
        endpoint: None,
        bucket: None,
        path_style: None,
        browser_origin: origin,
        verdict: "S3-Konfiguration fehlt".into(),
        steps,
    }))
}

/* ==========================================================================
 * Grossdatei-Probe für die kalte Ablage
 * ========================================================================== */

#[derive(serde::Deserialize)]
struct KaltFrage {
    /// Grösse der Probe in MiB (Vorgabe 64, höchstens 512).
    mib: Option<u64>,
}

/// Das Prüfmuster: jedes Byte hängt nur von seiner Stelle in der Datei ab.
/// So lässt sich nach einem Bereichslesen ohne Kopie der Datei prüfen, ob
/// WIRKLICH die richtigen Bytes von der richtigen Stelle kamen – und nicht
/// zufällig ein Anfang, der gleich aussieht.
fn muster_byte(stelle: u64) -> u8 {
    (stelle.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
}

fn muster(ab: u64, laenge: usize) -> Vec<u8> {
    (0..laenge as u64).map(|i| muster_byte(ab + i)).collect()
}

fn schritt(name: &str, ok: bool, detail: String, hint: Option<&str>) -> Step {
    Step {
        name: name.into(),
        ok,
        detail,
        hint: hint.map(str::to_string),
    }
}

fn mb_pro_s(bytes: u64, dauer: std::time::Duration) -> String {
    format!(
        "{:.1} MB/s in {:.1} s",
        bytes as f64 / 1_048_576.0 / dauer.as_secs_f64().max(0.001),
        dauer.as_secs_f64()
    )
}

/**
 * Schreibt eine Datei von `mib` MiB in die kalte Ablage, misst sie nach,
 * liest Bereiche aus der Mitte und vom Ende, löscht sie wieder – und stoppt
 * jeden Schritt.
 *
 * # Warum das eine eigene Probe ist
 *
 * Der kleine Selbsttest (ein paar Byte) beweist Zugangsdaten und Berechtigung.
 * Er beweist NICHT, dass ein Video von Gigabytes hinüberkommt: Zeitfristen,
 * Teilstück und Umbenennen, die Grössenprüfung drüben und vor allem das
 * Bereichslesen (Spulen im Video) zeigen sich erst an einer Datei, die gross
 * genug ist, um mehr als ein Paket zu brauchen.
 *
 * # Ohne die Platte zu füllen
 *
 * Die Datei entsteht in einem Durchgang in 1-MiB-Stücken im Teile-Verzeichnis
 * (`mib` MiB, höchstens 512) und wird nach der Probe sofort entfernt. Sie ist
 * eine KOPIE des Musters, nichts Dauerhaftes – und sie wird unabhängig vom
 * Ausgang gelöscht (auch drüben).
 */
pub async fn grossdatei_probe(
    kalt: &std::sync::Arc<dyn crate::storage::Storage>,
    teile_dir: &std::path::Path,
    mib: u64,
) -> Vec<Step> {
    use crate::storage::ByteRange;
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut schritte = Vec::new();
    let mib = mib.clamp(1, 512);
    let laenge = mib * 1_048_576;
    let schluessel = format!("_selbsttest/gross-{}.bin", Uuid::now_v7());
    let quelle = teile_dir.join(format!("selbsttest-{}.bin", Uuid::now_v7().simple()));

    match kalt.kapazitaet().await {
        Some((frei, gesamt)) => schritte.push(schritt(
            "Platz auf der Box",
            frei >= laenge,
            format!(
                "{:.1} GB frei von {:.1} GB",
                frei as f64 / 1e9,
                gesamt as f64 / 1e9
            ),
            (frei < laenge).then_some("Auf der Box ist weniger Platz als die Probe braucht."),
        )),
        None => schritte.push(schritt(
            "Platz auf der Box",
            true,
            "Die Gegenstelle meldet ihren Platz nicht (statvfs fehlt) – nicht geprüft".into(),
            None,
        )),
    }

    // 1. Die Quelle erzeugen.
    let erzeugt = async {
        tokio::fs::create_dir_all(teile_dir).await?;
        let mut datei = tokio::fs::File::create(&quelle).await?;
        for stueck in 0..mib {
            datei
                .write_all(&muster(stueck * 1_048_576, 1_048_576))
                .await?;
        }
        datei.flush().await
    }
    .await;
    if let Err(fehler) = erzeugt {
        let _ = tokio::fs::remove_file(&quelle).await;
        schritte.push(schritt(
            "Probedatei erzeugen",
            false,
            fehler.to_string(),
            Some("Im Verzeichnis der Teildateien ist kein Platz oder keine Schreibberechtigung."),
        ));
        return schritte;
    }

    // 2. Hinüberschreiben, im Strom und mehrteilig.
    let start = std::time::Instant::now();
    let geschrieben = kalt
        .put_datei(&schluessel, &quelle, "application/octet-stream")
        .await;
    let _ = tokio::fs::remove_file(&quelle).await;
    match &geschrieben {
        Ok(()) => schritte.push(schritt(
            "Grosse Datei schreiben",
            true,
            format!("{mib} MiB: {}", mb_pro_s(laenge, start.elapsed())),
            None,
        )),
        Err(fehler) => {
            schritte.push(schritt(
                "Grosse Datei schreiben",
                false,
                fehler.to_string(),
                Some("Ein Umzug grosser Videos würde genauso scheitern. Prüfe Verbindung, Platz auf der Box und die Fristen."),
            ));
            let _ = kalt.delete(&schluessel).await;
            return schritte;
        }
    }

    // 3. Nachmessen, wie der Auslagerungsdienst es tut.
    match kalt.read(&schluessel, None).await {
        Ok(Some(o)) if o.total_size == Some(laenge) => schritte.push(schritt(
            "Grösse drüben",
            true,
            format!("{laenge} Bytes – wie geschrieben"),
            None,
        )),
        Ok(Some(o)) => schritte.push(schritt(
            "Grösse drüben",
            false,
            format!("{:?} statt {laenge} Bytes", o.total_size),
            Some("Die Box hat nicht alles behalten – der Auslagerungsdienst würde solche Dateien nicht löschen, aber auch nicht verschieben."),
        )),
        Ok(None) => schritte.push(schritt("Grösse drüben", false, "Datei nicht gefunden".into(), None)),
        Err(fehler) => schritte.push(schritt("Grösse drüben", false, fehler.to_string(), None)),
    }

    // 4. Bereiche lesen – Spulen im Video. Mitte (ungerade Stelle, über eine
    //    Blockgrenze) und Ende; dazu ein Vollabruf für die Geschwindigkeit.
    let proben = [
        ("Mitte", laenge / 2 + 17, 300_000u64),
        ("Ende", laenge - 4096, 4096u64),
        ("Anfang", 0, 4096u64),
    ];
    for (name, ab, wieviel) in proben {
        let t = std::time::Instant::now();
        let ergebnis = async {
            let Some(o) = kalt
                .read(
                    &schluessel,
                    Some(ByteRange {
                        start: ab,
                        end: Some(ab + wieviel - 1),
                    }),
                )
                .await?
            else {
                return Ok::<_, crate::error::AppError>(None);
            };
            let mut roh = Vec::new();
            let mut strom = o.stream;
            while let Some(teil) = strom.next().await {
                roh.extend_from_slice(&teil?);
            }
            Ok(Some(roh))
        }
        .await;
        schritte.push(match ergebnis {
            Ok(Some(roh)) if roh == muster(ab, wieviel as usize) => schritt(
                &format!("Bereich lesen ({name})"),
                true,
                format!(
                    "{wieviel} Bytes ab {ab} stimmen, {} ms",
                    t.elapsed().as_millis()
                ),
                None,
            ),
            Ok(Some(roh)) => schritte_falsch(name, roh.len(), wieviel),
            Ok(None) => schritt(
                &format!("Bereich lesen ({name})"),
                false,
                "Datei nicht gefunden".into(),
                None,
            ),
            Err(fehler) => schritt(
                &format!("Bereich lesen ({name})"),
                false,
                fehler.to_string(),
                None,
            ),
        });
    }

    let t = std::time::Instant::now();
    let voll = async {
        let Some(o) = kalt.read(&schluessel, None).await? else {
            return Ok::<_, crate::error::AppError>(None);
        };
        let mut strom = o.stream;
        let mut n = 0u64;
        let mut stelle = 0u64;
        let mut stimmt = true;
        while let Some(teil) = strom.next().await {
            let teil = teil?;
            // Stichprobe je Paket genügt: erstes und letztes Byte.
            if let (Some(a), Some(z)) = (teil.first(), teil.last()) {
                stimmt &=
                    *a == muster_byte(stelle) && *z == muster_byte(stelle + teil.len() as u64 - 1);
            }
            stelle += teil.len() as u64;
            n += teil.len() as u64;
        }
        Ok(Some((n, stimmt)))
    }
    .await;
    schritte.push(match voll {
        Ok(Some((n, true))) if n == laenge => schritt(
            "Ganz lesen",
            true,
            format!("{n} Bytes: {}", mb_pro_s(n, t.elapsed())),
            None,
        ),
        Ok(Some((n, stimmt))) => schritt(
            "Ganz lesen",
            false,
            format!("{n} von {laenge} Bytes, Inhalt stimmt: {stimmt}"),
            None,
        ),
        Ok(None) => schritt("Ganz lesen", false, "Datei nicht gefunden".into(), None),
        Err(fehler) => schritt("Ganz lesen", false, fehler.to_string(), None),
    });

    // 5. Löschen – und prüfen, dass wirklich nichts liegen bleibt.
    let weg = kalt.delete(&schluessel).await;
    let danach = kalt.read(&schluessel, None).await;
    schritte.push(match (weg, danach) {
        (Ok(()), Ok(None)) => schritt("Löschen", true, "Datei und Teilstück sind weg".into(), None),
        (Err(fehler), _) => schritt(
            "Löschen",
            false,
            fehler.to_string(),
            Some("Ein gelöschtes Video bliebe auf der Box liegen."),
        ),
        (Ok(()), _) => schritt(
            "Löschen",
            false,
            "Die Datei ist nach dem Löschen noch lesbar".into(),
            None,
        ),
    });
    schritte
}

fn schritte_falsch(name: &str, bekommen: usize, wieviel: u64) -> Step {
    schritt(
        &format!("Bereich lesen ({name})"),
        false,
        format!("{bekommen} Bytes statt {wieviel}, oder andere Bytes als erwartet"),
        Some("Bereichslesen liefert falsche Daten – Vorspulen im Video würde Müll zeigen."),
    )
}

async fn kalt_check(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(frage): Query<KaltFrage>,
) -> AppResult<Json<CheckResult>> {
    let origin = state.config.public_app_url.clone();
    let Some(kalt) = state.speicher.kalt.clone() else {
        return Ok(Json(CheckResult {
            driver: "keine".into(),
            endpoint: None,
            bucket: None,
            path_style: None,
            browser_origin: origin,
            steps: vec![schritt(
                "Kalte Ablage",
                false,
                "KALT_TREIBER steht auf aus".into(),
                Some("Setze KALT_TREIBER=sftp (oder lokal zum Ausprobieren)."),
            )],
            verdict: "Keine kalte Ablage eingerichtet".into(),
        }));
    };
    let mut steps = grossdatei_probe(
        &kalt,
        std::path::Path::new(&state.config.upload_teile_dir),
        frage.mib.unwrap_or(64),
    )
    .await;
    if let Some(zustand) = kalt.zustand().await {
        steps.push(schritt(
            "Verbindungen",
            !zustand.contains("antwortet nicht"),
            zustand,
            Some("Eine Verbindung antwortet nicht – sie wird beim nächsten Zugriff neu aufgebaut. Bleibt es dabei, sind die gleichzeitigen Verbindungen der Box (Limit 10) womöglich aufgebraucht."),
        ));
    }
    let alles = steps.iter().all(|s| s.ok);
    Ok(Json(CheckResult {
        driver: kalt.kind().to_string(),
        endpoint: state.config.kalt_sftp.as_ref().map(|s| s.wirt.clone()),
        bucket: None,
        path_style: None,
        browser_origin: origin,
        verdict: if alles {
            "Grosse Dateien gehen hin und zurück – Umzug und Spulen sollten funktionieren.".into()
        } else {
            "Es hakt. Die Hinweise nennen die Ursache.".into()
        },
        steps,
    }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KonsistenzFrage {
    /// Wie viele Dateien ganz gelesen und per SHA-256 geprüft werden (Vorgabe 3, höchstens 20).
    stichprobe: Option<usize>,
    /// Grösste Datei der Stichprobe in MiB (Vorgabe 256, höchstens 1024).
    max_mib: Option<u64>,
}

/**
 * `GET /admin/storage-check/konsistenz` – Datenbank gegen Box.
 *
 * Vergleicht die Anhangszeilen mit `ablage = 'fern'` mit den Objekten auf der
 * Box (fehlend, verwaist, falsche Grösse) und liest eine kleine Stichprobe
 * ganz, um deren SHA-256 gegen `attachments.sha256` zu halten. Liest sonst
 * nur Verzeichnisse. Siehe `services::konsistenz`.
 */
async fn konsistenz_check(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(frage): Query<KonsistenzFrage>,
) -> AppResult<Json<serde_json::Value>> {
    use crate::services::konsistenz::{self, Optionen};
    let origin = state.config.public_app_url.clone();
    let Some(kalt) = state.speicher.kalt.clone() else {
        return Ok(Json(serde_json::json!({
            "driver": "keine", "endpoint": null, "bucket": null, "pathStyle": null,
            "browserOrigin": origin,
            "steps": [schritt("Kalte Ablage", false, "KALT_TREIBER steht auf aus".into(),
                Some("Setze KALT_TREIBER=sftp (oder lokal zum Ausprobieren)."))],
            "verdict": "Keine kalte Ablage eingerichtet",
        })));
    };
    let opt = Optionen {
        stichprobe: frage.stichprobe.unwrap_or(3).min(20),
        stichprobe_max_bytes: frage.max_mib.unwrap_or(256).clamp(1, 1024) * 1_048_576,
        mit_tresor: state.config.media_key.is_some(),
    };
    let t = std::time::Instant::now();
    let bericht = match konsistenz::pruefen(&state.pool, &kalt, &state.storage, opt).await {
        Ok(Some(b)) => b,
        Ok(None) => {
            return Ok(Json(serde_json::json!({
                "driver": kalt.kind(), "endpoint": null, "bucket": null, "pathStyle": null,
                "browserOrigin": origin,
                "steps": [schritt("Auflisten", false,
                    "Diese Ablage kann ihren Inhalt nicht auflisten".into(), None)],
                "verdict": "Der Abgleich ist für diese Ablage nicht möglich",
            })))
        }
        Err(fehler) => {
            return Ok(Json(serde_json::json!({
                "driver": kalt.kind(), "endpoint": null, "bucket": null, "pathStyle": null,
                "browserOrigin": origin,
                "steps": [schritt("Auflisten", false, fehler.to_string(),
                    Some("Die Box antwortet nicht oder der Pfad stimmt nicht. Probiere erst /admin/storage-check/kalt."))],
                "verdict": "Es hakt. Die Hinweise nennen die Ursache.",
            })))
        }
    };

    let befund = |name: &str, b: &konsistenz::Befund, fehler: bool, hint: &str| {
        let beispiele = if b.beispiele.is_empty() {
            String::new()
        } else {
            format!(" – z. B. {}", b.beispiele.join("; "))
        };
        schritt(
            name,
            b.anzahl == 0 || !fehler,
            if b.anzahl == 0 {
                "keine".to_string()
            } else {
                format!("{}{beispiele}", b.anzahl)
            },
            (b.anzahl > 0).then_some(hint),
        )
    };
    let mut steps = vec![
        schritt(
            "Auflisten",
            true,
            format!(
                "{} Objekte auf der Box, {} Zeilen mit ablage=fern, in {} ms",
                bericht.objekte_box, bericht.zeilen_fern, bericht.auflisten_ms
            ),
            None,
        ),
        befund(
            "Fehlende Dateien",
            &bericht.fehlend,
            true,
            "Die Datenbank sagt „fern“, auf der Box liegt nichts. Liegt die Datei nicht mehr warm, ist sie verloren: aus der Sicherung (Snapshot der Box, zweite Kopie) zurückholen.",
        ),
        befund(
            "Falsche Grösse",
            &bericht.falsche_groesse,
            true,
            "Drüben liegt etwas anderes als vermerkt (abgebrochene Übertragung, anderer Schlüssel?). Aus der Sicherung ersetzen.",
        ),
        befund(
            "Verwaiste Objekte",
            &bericht.verwaist,
            true,
            "Auf der Box liegt etwas ohne Datenbankzeile – kostet Platz, schadet sonst nicht. Prüfe, ob die Datenbank zu einem älteren Stand zurückgespielt wurde.",
        ),
        befund(
            "Reste eines Umzugs",
            &bericht.rest_von_umzug,
            false,
            "Ein Umzug brach nach dem Hinüberschreiben ab; die Datei liegt an beiden Orten. Harmlos, der nächste Durchgang bereinigt es.",
        ),
        befund(
            "Teilreste (*.teil)",
            &bericht.teilreste,
            false,
            "Abgebrochene Übertragungen; der Auslagerungsdienst räumt sie nach drei Tagen weg.",
        ),
    ];
    if opt.stichprobe > 0 {
        let mb_s = if bericht.stichprobe_ms > 0 {
            bericht.stichprobe_bytes as f64 / 1_048_576.0 / (bericht.stichprobe_ms as f64 / 1000.0)
        } else {
            0.0
        };
        let ok = bericht.stichprobe_abweichend.anzahl == 0
            && bericht.stichprobe_nicht_lesbar.anzahl == 0;
        let mut detail = format!(
            "{} Dateien ganz gelesen ({:.1} MB in {} ms, {:.1} MB/s)",
            bericht.stichprobe_geprueft,
            bericht.stichprobe_bytes as f64 / 1_048_576.0,
            bericht.stichprobe_ms,
            mb_s
        );
        for b in [&bericht.stichprobe_abweichend, &bericht.stichprobe_nicht_lesbar] {
            if b.anzahl > 0 {
                detail.push_str(&format!("; {} Auffälligkeiten: {}", b.anzahl, b.beispiele.join("; ")));
            }
        }
        if bericht.stichprobe_geprueft == 0 && ok {
            detail.push_str(" – keine Datei mit gespeicherter Prüfsumme in dieser Grösse (nur Uploads in Stücken haben eine)");
        }
        steps.push(schritt(
            "Prüfsummen-Stichprobe",
            ok,
            detail,
            (!ok).then_some("Der Inhalt auf der Box weicht von dem ab, was hochgeladen wurde (Bitfehler?). Betroffene Datei aus der Sicherung ersetzen."),
        ));
    }
    let alles = bericht.in_ordnung();
    Ok(Json(serde_json::json!({
        "driver": kalt.kind(),
        "endpoint": state.config.kalt_sftp.as_ref().map(|s| s.wirt.clone()),
        "bucket": null, "pathStyle": null,
        "browserOrigin": origin,
        "steps": steps,
        "verdict": if alles {
            format!("Datenbank und Box stimmen überein ({} ms gesamt).", t.elapsed().as_millis())
        } else {
            "Es gibt Abweichungen. Die Hinweise nennen die Ursache.".to_string()
        },
        "bericht": bericht,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn die_grossdatei_probe_laeuft_gegen_die_lokale_ablage_durch() {
        let wurzel = std::env::temp_dir().join(format!("kaltprobe-{}", Uuid::now_v7().simple()));
        let kalt: std::sync::Arc<dyn crate::storage::Storage> = std::sync::Arc::new(
            crate::storage::local::LocalStorage::new(wurzel.join("kalt").to_str().unwrap()),
        );
        let schritte = grossdatei_probe(&kalt, &wurzel.join("teile"), 3).await;
        let _ = std::fs::remove_dir_all(&wurzel);
        for s in &schritte {
            assert!(s.ok, "{}: {}", s.name, s.detail);
        }
        assert!(schritte.iter().any(|s| s.name == "Löschen"));
        assert!(schritte.len() >= 7, "{} Schritte", schritte.len());
    }

    #[test]
    fn das_muster_haengt_nur_von_der_stelle_ab() {
        assert_eq!(muster(1000, 16), muster(0, 1016)[1000..].to_vec());
    }
}
