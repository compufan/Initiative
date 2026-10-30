//! Häufig gelesene ferne Dateien zurück auf die Platte holen.
//!
//! # Die Idee
//!
//! Ausgelagert wird nach Grösse und Alter – eine Schätzung, wer die Datei noch
//! braucht. Manchmal irrt sie: Das Video vom Sommerfest wandert nach drei
//! Monaten auf die Box, und im Herbst schaut es sich die Gruppe ständig wieder
//! an, jedes Mal über SSH. Wer eine ferne Datei oft liest, hat damit gezeigt,
//! dass sie warm gehört. Dieser Dienst holt sie zurück.
//!
//! # Wann zurückgeholt wird (alles zugleich)
//!
//!   * Die Datei liegt `fern`, ist fertig und ein Original (`quelle_id is null`).
//!   * Sie wurde in den letzten `KALT_RUECKHOLEN_TAGE` Tagen (Vorgabe 14) mindestens
//!     `KALT_RUECKHOLEN_ZUGRIFFE`-mal (Vorgabe 5) **gelesen** – als Zugriffe
//!     gezählt, nicht als Anfragen (siehe [`crate::services::lesen`]).
//!   * **Klassen:** `niedrig` wird nie zurückgeholt (das war die Aussage des
//!     Besitzers: „braucht auf dem schnellen Speicher keinen Platz"). `hoch`
//!     bleibt eher warm: Es genügt die Hälfte der Zugriffe (mindestens zwei) und
//!     es kommt zuerst dran.
//!   * **Hysterese gegen Ping-Pong:** Frühestens 7 Tage nach dem Auslagern
//!     (`ausgelagert_at`); und nach der Rückholung wird die Datei mindestens 14
//!     Tage nicht wieder ausgelagert (`zurueckgeholt_at`, geprüft in
//!     `auslagern::kandidaten`) – auch nicht als `niedrig`.
//!   * **Platz:** Die warme Belegung bleibt nach der Rückholung mindestens
//!     [`LUFT`] unter der Auslagerungsschwelle (nicht nur knapp darunter: sonst
//!     wäre der Dienst beim nächsten Upload wieder am Zug), und die Platte
//!     selbst hat danach noch Reserve + offene Uploads + Notfallpuffer frei.
//!
//! # Wie zurückgeholt wird
//!
//! Wie das Auslagern, nur andersherum – und wieder so, dass die Datei in jedem
//! Augenblick erreichbar bleibt:
//!
//! 1. Im Strom von der Box in eine Teildatei neben dem Zielort (derselbe
//!    Datenträger, damit der Abschluss ein `rename` ist). Die Zeile sagt dabei
//!    weiter `fern`; gelesen wird also weiter drüben.
//! 2. **Nachmessen:** Länge der Teildatei = Länge drüben; bei unverschlüsselten
//!    Dateien mit bekannter SHA-256 auch diese.
//! 3. Teildatei an ihren Platz, Länge dort nachmessen.
//! 4. `ablage = 'lokal'`, `zurueckgeholt_at = now()`.
//! 5. **Erst danach** die ferne Fassung löschen. Scheitert das, bleibt ein
//!    harmloser Rest (der Konsistenzcheck nennt ihn).
//!
//! **Abbrechbar:** Zwischen den Brocken wird geprüft, ob [`abbrechen`] gerufen
//! wurde oder der Platz knapp wird (Weckruf des Auslagerungsdienstes). Dann
//! wird die Teildatei gelöscht, die Datei bleibt fern, und es ist nichts
//! passiert.
//!
//! **Backoff:** Scheitert eine Datei, wird sie erst nach 5, 10, 20 … Minuten
//! (höchstens einen Tag) wieder versucht; scheitert die Box selbst, ruht der
//! ganze Dienst eine Weile. Das Mass ist klein: höchstens drei Dateien und
//! 4 GiB je Durchgang, damit die einzige Bulk-Verbindung nicht stundenlang an
//! einer Rückholung hängt.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::Config;
use crate::storage::tresor::geheimtext_laenge;
use crate::storage::Storage;

/// Mindestens so lange nach dem Auslagern wird nicht zurückgeholt.
pub const MIN_TAGE_NACH_AUSLAGERN: i64 = 7;

/// Mindestens so lange nach dem Zurückholen wird nicht wieder ausgelagert.
/// (Die Zahl steht in `auslagern::kandidaten` als SQL; hier zur Dokumentation
/// und für die Tests.)
pub const MIN_TAGE_NACH_RUECKHOLEN: i64 = 14;

/// Wie weit UNTER der Auslagerungsschwelle die warme Belegung nach der
/// Rückholung bleiben muss. Doppelt so viel wie der Abstand, bei dem der
/// Auslagerungsdienst aufhört (`auslagern::ABSTAND`).
pub const LUFT: i64 = 2 * crate::services::auslagern::ABSTAND;

/// Höchstens so viele Dateien und Bytes je Durchgang.
const STAPEL: usize = 3;
const BYTES_JE_DURCHGANG: i64 = 4 * 1024 * 1024 * 1024;

const BACKOFF_START: Duration = Duration::from_secs(300);
const BACKOFF_MAX: Duration = Duration::from_secs(86_400);
const RUHE_BOX_DOWN: Duration = Duration::from_secs(900);

static ABBRUCH: AtomicBool = AtomicBool::new(false);

/// Bricht eine laufende Rückholung ab (zwischen zwei Brocken). Wirkt auf den
/// nächsten Prüfpunkt; die Teildatei wird gelöscht, die Datei bleibt fern.
pub fn abbrechen() {
    ABBRUCH.store(true, Ordering::SeqCst);
}

/// Für Tests und den Start eines Durchgangs: Abbruchflagge zurücksetzen.
pub fn abbruch_zuruecksetzen() {
    ABBRUCH.store(false, Ordering::SeqCst);
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Bilanz {
    pub zurueckgeholt: usize,
    pub bytes: i64,
    pub gescheitert: usize,
    /// Abgebrochen (Flagge oder Platz knapp) – nichts verloren, später wieder.
    pub abgebrochen: bool,
    /// Wegen Platzmangel/Schwelle nicht angefasst.
    pub zu_wenig_platz: usize,
}

/// Merkt sich Fehlschläge und die Ruhe nach einem Ausfall der Box.
#[derive(Default)]
pub struct Zustand {
    fehler: HashMap<Uuid, (u32, Instant)>,
    ruhe_bis: Option<Instant>,
}

impl Zustand {
    fn gesperrt(&self, id: Uuid, jetzt: Instant) -> bool {
        self.fehler.get(&id).is_some_and(|(_, ab)| jetzt < *ab)
    }

    fn fehlgeschlagen(&mut self, id: Uuid, jetzt: Instant) {
        let n = self.fehler.get(&id).map_or(0, |(n, _)| *n) + 1;
        let warten = BACKOFF_START
            .saturating_mul(2u32.saturating_pow(n - 1))
            .min(BACKOFF_MAX);
        self.fehler.insert(id, (n, jetzt + warten));
    }

    /// Wie oft diese Datei schon gescheitert ist.
    pub fn fehlversuche(&self, id: Uuid) -> u32 {
        self.fehler.get(&id).map_or(0, |(n, _)| *n)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Kandidat {
    id: Uuid,
    storage_key: String,
    size: i64,
    mime: String,
    sha256: Option<String>,
}

/// Dateien, die nach den Regeln oben zurückgeholt werden dürften – `hoch`
/// zuerst, dann nach Zugriffen.
async fn kandidaten(pool: &PgPool, tage: i64, zugriffe: i64) -> Vec<Kandidat> {
    sqlx::query_as(
        "select a.id, a.storage_key, a.size, a.mime, a.sha256
           from attachments a
           join (select anhang_id, sum(zugriffe) as n
                   from anhang_lesen
                  where tag > current_date - $1::int
                  group by anhang_id) z on z.anhang_id = a.id
          where a.ablage = 'fern' and a.status = 'ready' and a.quelle_id is null
            and a.size > 0
            and a.prioritaet <> 'niedrig'
            and z.n >= case a.prioritaet when 'hoch' then greatest(2, ($2 + 1) / 2) else $2 end
            and (a.ausgelagert_at is null
                 or a.ausgelagert_at < now() - make_interval(days => $3))
            and (a.zurueckgeholt_at is null
                 or a.zurueckgeholt_at < now() - make_interval(days => $4))
          order by (a.prioritaet = 'hoch') desc, z.n desc, a.created_at
          limit 20",
    )
    .bind(tage as i32)
    .bind(zugriffe)
    .bind(MIN_TAGE_NACH_AUSLAGERN as i32)
    .bind(MIN_TAGE_NACH_RUECKHOLEN as i32)
    .fetch_all(pool)
    .await
    .unwrap_or_default()
}

/// Warum eine Rückholung nicht zustande kam.
enum Grund {
    /// Die Box macht Ärger – der ganze Dienst soll ruhen.
    Kalt(String),
    /// An dieser Datei liegt es.
    Datei(String),
    /// Abgebrochen (Flagge/Platz) – kein Fehler.
    Abbruch,
}

/**
 * Ein Durchgang. `grenze` ist die Auslagerungsschwelle (`KALT_GRENZE_GB`) in
 * Bytes, `jetzt` die Uhr für das Backoff (hereingereicht, damit es prüfbar ist).
 */
pub async fn durchgang(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    config: &Config,
    grenze: i64,
    zustand: &mut Zustand,
    jetzt: Instant,
) -> Bilanz {
    let mut bilanz = Bilanz::default();
    if config.kalt_rueckholen_zugriffe <= 0 {
        return bilanz;
    }
    if zustand.ruhe_bis.is_some_and(|bis| jetzt < bis) || !crate::services::auslagern::kalt_erreichbar()
    {
        return bilanz;
    }
    abbruch_zuruecksetzen();
    let liste = kandidaten(pool, config.kalt_rueckholen_tage, config.kalt_rueckholen_zugriffe).await;
    let mut belegt = crate::services::auslagern::belegt(pool).await;
    let mut bytes_dieser_runde = 0i64;

    for k in liste {
        if bilanz.zurueckgeholt >= STAPEL || bytes_dieser_runde + k.size > BYTES_JE_DURCHGANG {
            // Die Grösse sprengt NUR diese Runde; kleinere dürfen weiter.
            if bilanz.zurueckgeholt >= STAPEL {
                break;
            }
            continue;
        }
        if zustand.gesperrt(k.id, jetzt) {
            continue;
        }
        // Platz: unter der Schwelle mit Luft UND auf der Platte genug frei.
        if belegt + k.size + LUFT > grenze
            || crate::services::auslagern::platzbedarf_mit(pool, config, k.size).await > 0
        {
            bilanz.zu_wenig_platz += 1;
            continue;
        }
        match holen(pool, warm, kalt, config, &k).await {
            Ok(0) => {}
            Ok(bytes) => {
                bilanz.zurueckgeholt += 1;
                bilanz.bytes += bytes;
                bytes_dieser_runde += bytes;
                belegt += bytes;
                tracing::info!(
                    schluessel = %k.storage_key, mib = bytes / 1_048_576,
                    "Häufig gelesene Datei von der Box zurückgeholt"
                );
            }
            Err(Grund::Abbruch) => {
                bilanz.abgebrochen = true;
                break;
            }
            Err(Grund::Datei(text)) => {
                bilanz.gescheitert += 1;
                zustand.fehlgeschlagen(k.id, jetzt);
                tracing::warn!(fehler = %text, "Rückholen gescheitert (Datei bleibt fern)");
            }
            Err(Grund::Kalt(text)) => {
                bilanz.gescheitert += 1;
                zustand.fehlgeschlagen(k.id, jetzt);
                zustand.ruhe_bis = Some(jetzt + RUHE_BOX_DOWN);
                tracing::warn!(fehler = %text, "Rückholen: die Box macht Ärger – Ruhe, nichts verloren");
                break;
            }
        }
    }
    bilanz
}

/// Wird abgebrochen, weil jemand es will oder der Platz knapp wird?
fn soll_abbrechen() -> bool {
    use futures_util::FutureExt;
    if ABBRUCH.load(Ordering::SeqCst) {
        return true;
    }
    // Ein Weckruf heisst „Platte knapp" – das Auslagern hat Vorrang. Den
    // verbrauchten Ruf geben wir weiter, damit der Hauptdienst ihn noch sieht.
    if crate::services::auslagern::WECKEN.notified().now_or_never().is_some() {
        crate::services::auslagern::WECKEN.notify_one();
        return true;
    }
    false
}

/// Eine Datei zurückholen. `Ok(0)`: gab es nicht mehr / schon erledigt.
async fn holen(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    config: &Config,
    k: &Kandidat,
) -> Result<i64, Grund> {
    let datei = |t: String| Grund::Datei(format!("{}: {t}", k.storage_key));
    let kalt_fehler = |t: String| Grund::Kalt(format!("{}: {t}", k.storage_key));

    // Noch fern? (Zwischen Auswahl und jetzt kann gelöscht worden sein.)
    let noch: Option<(i64,)> = sqlx::query_as(
        "select size from attachments where id = $1 and ablage = 'fern' and status = 'ready'",
    )
    .bind(k.id)
    .fetch_optional(pool)
    .await
    .map_err(|f| datei(f.to_string()))?;
    if noch.is_none() {
        return Ok(0);
    }

    let Some(objekt) = kalt
        .read(&k.storage_key, None)
        .await
        .map_err(|f| kalt_fehler(format!("Lesen drüben: {f}")))?
    else {
        return Err(datei("drüben nicht gefunden (siehe Konsistenzcheck)".into()));
    };
    let drueben = objekt.total_size.unwrap_or(0);
    let klar = k.size as u64;
    let erwartet_ok = drueben == klar || (config.media_key.is_some() && drueben == geheimtext_laenge(klar));
    if !erwartet_ok {
        return Err(datei(format!(
            "drüben liegen {drueben} Bytes, erwartet {klar}{}",
            if config.media_key.is_some() {
                format!(" oder {}", geheimtext_laenge(klar))
            } else {
                String::new()
            }
        )));
    }

    // 1. In eine Teildatei auf demselben Datenträger wie der Zielort.
    let teil: PathBuf = PathBuf::from(&config.upload_teile_dir)
        .join(format!("rueckholen-{}.teil", Uuid::now_v7().simple()));
    if let Some(ordner) = teil.parent() {
        tokio::fs::create_dir_all(ordner)
            .await
            .map_err(|f| datei(f.to_string()))?;
    }
    let weg = |teil: PathBuf| async move {
        let _ = tokio::fs::remove_file(teil).await;
    };
    let mut aus = tokio::fs::File::create(&teil)
        .await
        .map_err(|f| datei(format!("Teildatei: {f}")))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut gelesen = 0u64;
    let mut strom = objekt.stream;
    let mut brocken = 0u32;
    while let Some(stueck) = strom.next().await {
        let stueck = match stueck {
            Ok(s) => s,
            Err(f) => {
                weg(teil).await;
                return Err(kalt_fehler(format!("Lesen abgebrochen: {f}")));
            }
        };
        sha2::Digest::update(&mut hasher, &stueck);
        gelesen += stueck.len() as u64;
        if let Err(f) = aus.write_all(&stueck).await {
            weg(teil).await;
            return Err(datei(format!("Schreiben auf die Platte: {f}")));
        }
        brocken += 1;
        // Etwa alle 8 MiB nachsehen, ob es abgebrochen werden soll.
        if brocken & 31 == 0 && soll_abbrechen() {
            weg(teil).await;
            return Err(Grund::Abbruch);
        }
    }
    if let Err(f) = aus.flush().await {
        weg(teil).await;
        return Err(datei(format!("Schreiben auf die Platte: {f}")));
    }
    let _ = aus.sync_data().await;
    drop(aus);

    // 2. Nachmessen.
    let auf_platte = tokio::fs::metadata(&teil).await.map(|m| m.len()).unwrap_or(0);
    if gelesen != drueben || auf_platte != drueben {
        weg(teil).await;
        return Err(kalt_fehler(format!(
            "gelesen {gelesen}, auf der Platte {auf_platte}, drüben {drueben} Bytes"
        )));
    }
    if config.media_key.is_none() {
        if let Some(soll) = &k.sha256 {
            let ist = hex::encode(sha2::Digest::finalize(hasher));
            if &ist != soll {
                weg(teil).await;
                return Err(kalt_fehler(format!(
                    "Prüfsumme stimmt nicht ({ist} statt {soll})"
                )));
            }
        }
    }
    if soll_abbrechen() {
        weg(teil).await;
        return Err(Grund::Abbruch);
    }

    // 3. An den Platz, dort nachmessen.
    if let Err(f) = warm.uebernehmen(&k.storage_key, &teil, &k.mime).await {
        weg(teil).await;
        return Err(datei(format!("Ablegen warm: {f}")));
    }
    let warm_laenge = warm
        .read(
            &k.storage_key,
            Some(crate::storage::ByteRange {
                start: 0,
                end: Some(0),
            }),
        )
        .await
        .ok()
        .flatten()
        .and_then(|o| o.total_size);
    if warm_laenge != Some(drueben) {
        let _ = warm.delete(&k.storage_key).await;
        return Err(datei(format!(
            "warm liegen {warm_laenge:?} statt {drueben} Bytes – zurückgenommen"
        )));
    }

    // 4. Umschreiben (alle Zeilen auf diesen Bytes, wie beim Auslagern).
    let geschrieben = sqlx::query(
        "update attachments set ablage = 'lokal', zurueckgeholt_at = now()
          where storage_key = $1 and ablage = 'fern'",
    )
    .bind(&k.storage_key)
    .execute(pool)
    .await
    .map_err(|f| datei(f.to_string()))?
    .rows_affected();
    if geschrieben == 0 {
        // Die Zeile ist inzwischen weg (gelöscht). Die Müllliste kümmert sich um
        // die ferne Fassung; die warme, die wir eben angelegt haben, räumen wir selbst.
        let _ = warm.delete(&k.storage_key).await;
        return Ok(0);
    }

    // 5. Erst jetzt die ferne Fassung. Scheitert das, bleibt ein Rest drüben –
    //    die Datei ist ja warm und erreichbar.
    if let Err(f) = kalt.delete(&k.storage_key).await {
        tracing::warn!(schluessel = %k.storage_key, fehler = %f, "Zurückgeholt, aber die ferne Fassung blieb liegen");
    }
    Ok(k.size)
}
