//! Löst EINEN Durchgang des Erinnerungsdienstes aus – nur für Entwicklung und
//! Tests, nicht für den Betrieb.
//!
//! `erinnern_einmal --plus-stunden 49` rechnet mit der Uhr der Datenbank plus 49
//! Stunden, `erinnern_einmal --jetzt 2026-10-05T10:00:00Z` mit einem festen
//! Zeitpunkt. Auf der Standardausgabe steht die Bilanz als eine Zeile JSON.
//!
//! # Warum ein eigenes Programm
//!
//! Die Erinnerungen werden erst nach Stunden fällig, und ein Browser-Test kann
//! nicht zwei Tage warten. Eine HTTP-Route dafür wäre in der Produktions-Datei,
//! und ein Umgebungswert, der die Uhr des Servers verschiebt, wirkte auf den
//! laufenden Dienst – beides kann in Produktion versehentlich scharf werden.
//! Dieses Programm ist **nicht im Abbild** (der Dockerfile baut nur
//! `initiative-api` und `seed`), hat keinen Weg von aussen und gibt dem, der es
//! aufrufen kann, nichts, was er mit dem Zugang zur Datenbank nicht ohnehin hätte.
//! Es spricht dieselbe Datenbank wie der Server, ein gleichzeitig laufender
//! Dienst beansprucht atomar mit.

use chrono::{DateTime, Duration, Utc};
use initiative_api::config::Config;
use initiative_api::services::erinnern::{datenbankzeit, durchgang};
use initiative_api::state::AppState;

const HILFE: &str = "\
erinnern_einmal – löst einen Durchgang des Erinnerungsdienstes aus.
NUR FÜR ENTWICKLUNG UND TESTS. Kein Teil des Produktionsabbilds.

  erinnern_einmal --plus-stunden <Zahl>   Uhr der Datenbank plus Stunden (auch gebrochen)
  erinnern_einmal --jetzt <Zeitpunkt>     fester Zeitpunkt, z. B. 2026-10-05T10:00:00Z
  erinnern_einmal --help

Ohne Angabe gilt die Uhr der Datenbank. Die Bilanz steht als JSON auf stdout.";

enum Zeit {
    Datenbank,
    PlusStunden(f64),
    Fest(DateTime<Utc>),
}

fn argumente() -> Result<Zeit, String> {
    let mut args = std::env::args().skip(1);
    let mut zeit = Zeit::Datenbank;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--plus-stunden" => {
                let wert = args.next().ok_or("--plus-stunden braucht eine Zahl")?;
                let stunden: f64 = wert
                    .parse()
                    .map_err(|_| format!("„{wert}“ ist keine Zahl"))?;
                if !stunden.is_finite() {
                    return Err(format!("„{wert}“ ist keine endliche Zahl"));
                }
                zeit = Zeit::PlusStunden(stunden);
            }
            "--jetzt" => {
                let wert = args.next().ok_or("--jetzt braucht einen Zeitpunkt")?;
                let punkt = DateTime::parse_from_rfc3339(&wert)
                    .map_err(|_| format!("„{wert}“ ist kein Zeitpunkt (RFC 3339)"))?;
                zeit = Zeit::Fest(punkt.with_timezone(&Utc));
            }
            anderes => return Err(format!("Unbekannte Angabe: {anderes}")),
        }
    }
    Ok(zeit)
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HILFE}");
        return;
    }
    let zeit = match argumente() {
        Ok(zeit) => zeit,
        Err(fehler) => {
            eprintln!("{fehler}\n\n{HILFE}");
            std::process::exit(2);
        }
    };

    // Auf stderr: Auf stdout steht nur die Bilanz, damit ein Aufrufer sie als
    // eine Zeile JSON lesen kann.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "initiative_api=info".into()),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();

    if dotenvy::dotenv().is_err() {
        let _ = dotenvy::from_filename("apps/api/.env");
    }
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(fehler) => {
            eprintln!("{fehler}");
            std::process::exit(1);
        }
    };
    let state = match AppState::new(config).await {
        Ok(state) => state,
        Err(fehler) => {
            eprintln!("{fehler}");
            std::process::exit(1);
        }
    };

    let jetzt = match zeit {
        Zeit::Datenbank => datenbankzeit(&state.pool).await,
        Zeit::PlusStunden(stunden) => {
            datenbankzeit(&state.pool).await + Duration::seconds((stunden * 3600.0) as i64)
        }
        Zeit::Fest(punkt) => punkt,
    };
    let bilanz = durchgang(&state, jetzt).await;
    match serde_json::to_string(&bilanz) {
        Ok(zeile) => println!("{zeile}"),
        Err(fehler) => {
            eprintln!("{fehler}");
            std::process::exit(1);
        }
    }
}
