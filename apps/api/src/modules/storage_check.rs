//! Selbsttest für den Objektspeicher.
//!
//! Wenn ein Upload im Browser scheitert, sagt die Fehlermeldung dort fast
//! nichts: Ein blockierter Cross-Origin-Upload bricht ohne Statuscode ab. Von
//! hier aus lässt sich dagegen jeder Schritt einzeln prüfen – Zugangsdaten,
//! Endpunkt, Bucket und vor allem die CORS-Regel, die der Browser braucht.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::AdminUser;
use crate::config::StorageDriver;
use crate::error::AppResult;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/admin/storage-check", get(storage_check))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    name: String,
    ok: bool,
    detail: String,
    /// Was zu tun ist, falls der Schritt fehlschlägt.
    hint: Option<String>,
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
                ok: false,
                detail: "STORAGE_DRIVER steht auf local".into(),
                hint: Some(
                    "Für R2 muss STORAGE_DRIVER=r2 gesetzt sein, sonst liegen alle Dateien im Container und gehen beim nächsten Deploy verloren.".into(),
                ),
            }],
            verdict: "Objektspeicher ist nicht eingerichtet".into(),
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
        // `read` reicht bei S3 bewusst nie Objekte durch (immer None), deshalb
        // wird hier über eine signierte Download-URL geprüft – genau der Weg,
        // den auch die App für Bilder benutzt.
        let url = state
            .storage
            .download_url(&key, &crate::storage::DownloadOptions::default());
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
