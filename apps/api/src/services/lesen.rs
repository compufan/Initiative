//! Zählen, wie oft ferne Dateien gelesen werden – sparsam.
//!
//! # Was ein „Zugriff" ist
//!
//! Ein Video erzeugt beim Abspielen und Spulen Dutzende Bereichsanfragen. Für
//! die Frage „wird diese Datei häufig gebraucht?" ist das EIN Ansehen. Alle
//! Anfragen auf dieselbe Datei, die weniger als [`ZUGRIFF_PAUSE`] auseinander
//! liegen, sind deshalb ein Zugriff; erst nach einer Pause von zehn Minuten
//! zählt die nächste Anfrage neu.
//!
//! # Wie wenig geschrieben wird
//!
//! In der Anfrage selbst nur eine Zeile im Arbeitsspeicher (ein Schloss, eine
//! Hash-Tabelle). Der Dienst [`starten`] schreibt einmal je Minute, was sich
//! angesammelt hat – gebündelt in EINER Anweisung für alle betroffenen Dateien
//! –, in `anhang_lesen` (eine Zeile je Datei und Tag). Ein Absturz verliert
//! höchstens eine Minute Zählung; für eine Entscheidung „fünfmal in zwei
//! Wochen" ist das ohne Bedeutung.
//!
//! Gezählt wird nur, was `fern` liegt: Warme Dateien brauchen keine Rückholung.
//! Weitergegebene Kopien (`quelle_id`) zählen für ihr Original, denn nur das
//! wird bewegt.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use uuid::Uuid;

/// Anfragen auf dieselbe Datei innerhalb dieser Zeit sind ein Zugriff.
pub const ZUGRIFF_PAUSE: Duration = Duration::from_secs(10 * 60);

/// Wie oft in die Datenbank geschrieben wird.
const FLUSH_TAKT: Duration = Duration::from_secs(60);

/// Wie lange Tageszeilen aufgehoben werden. Mehr als jedes sinnvolle Fenster.
const AUFBEWAHREN_TAGE: i32 = 400;

#[derive(Default)]
pub struct LeseZaehler {
    /// Wann die Datei zuletzt angefragt wurde (zum Zusammenfassen).
    zuletzt: HashMap<Uuid, Instant>,
    /// Neue Zugriffe seit dem letzten Schreiben.
    neu: HashMap<Uuid, i32>,
}

impl LeseZaehler {
    /// Eine Anfrage melden. Gibt zurück, ob sie einen NEUEN Zugriff eröffnet.
    pub fn melden(&mut self, id: Uuid, jetzt: Instant) -> bool {
        let neuer_zugriff = match self.zuletzt.get(&id) {
            Some(&vorher) => jetzt.saturating_duration_since(vorher) >= ZUGRIFF_PAUSE,
            None => true,
        };
        // Auch eine laufende Wiedergabe hält den Zugriff offen: Wer eine
        // Stunde lang schaut, hat EINEN Zugriff gemacht, nicht sechs.
        self.zuletzt.insert(id, jetzt);
        if neuer_zugriff {
            *self.neu.entry(id).or_insert(0) += 1;
        }
        neuer_zugriff
    }

    /// Alles Angesammelte herausnehmen; alte Zusammenfassungen vergessen.
    pub fn leeren(&mut self, jetzt: Instant) -> Vec<(Uuid, i32)> {
        self.zuletzt
            .retain(|_, &mut t| jetzt.saturating_duration_since(t) < ZUGRIFF_PAUSE * 2);
        std::mem::take(&mut self.neu).into_iter().collect()
    }
}

static ZAEHLER: Mutex<Option<LeseZaehler>> = Mutex::new(None);

/// Meldet eine Anfrage auf eine Datei. Tut nichts, wenn sie nicht `fern` liegt.
pub fn melden(id: Uuid, ablage: &str) {
    if ablage != "fern" {
        return;
    }
    if let Ok(mut z) = ZAEHLER.lock() {
        z.get_or_insert_with(LeseZaehler::default)
            .melden(id, Instant::now());
    }
}

/// Schreibt das Angesammelte in die Datenbank. Gibt die Zahl der Dateien zurück.
pub async fn schreiben(pool: &PgPool) -> usize {
    let stapel = match ZAEHLER.lock() {
        Ok(mut z) => z
            .get_or_insert_with(LeseZaehler::default)
            .leeren(Instant::now()),
        Err(_) => return 0,
    };
    schreiben_stapel(pool, stapel).await
}

/// Der Schreibteil allein (für Tests mit eigenem Zähler).
pub async fn schreiben_stapel(pool: &PgPool, stapel: Vec<(Uuid, i32)>) -> usize {
    if stapel.is_empty() {
        return 0;
    }
    let ids: Vec<Uuid> = stapel.iter().map(|(i, _)| *i).collect();
    let anzahl: Vec<i32> = stapel.iter().map(|(_, n)| *n).collect();
    let n = stapel.len();
    // Ein Original zählt für alle seine Kopien: `coalesce(quelle_id, id)`.
    let ergebnis = sqlx::query(
        "insert into anhang_lesen (anhang_id, tag, zugriffe)
         select coalesce(a.quelle_id, a.id), current_date, sum(x.n)::int
           from unnest($1::uuid[], $2::int[]) as x(id, n)
           join attachments a on a.id = x.id
          group by 1
         on conflict (anhang_id, tag)
           do update set zugriffe = anhang_lesen.zugriffe + excluded.zugriffe",
    )
    .bind(&ids)
    .bind(&anzahl)
    .execute(pool)
    .await;
    match ergebnis {
        Ok(_) => n,
        Err(fehler) => {
            tracing::warn!(%fehler, "Lesezähler nicht gespeichert");
            0
        }
    }
}

/// Zugriffe auf eine Datei in den letzten `tage` Tagen (heute mitgezählt).
pub async fn zugriffe_seit(pool: &PgPool, id: Uuid, tage: i64) -> i64 {
    sqlx::query_scalar(
        "select coalesce(sum(zugriffe), 0)::bigint from anhang_lesen
          where anhang_id = $1 and tag > current_date - $2::int",
    )
    .bind(id)
    .bind(tage as i32)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
}

/// Tageszeilen wegräumen, die kein Fenster mehr braucht.
pub async fn aufraeumen(pool: &PgPool) -> u64 {
    sqlx::query("delete from anhang_lesen where tag < current_date - $1::int")
        .bind(AUFBEWAHREN_TAGE)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0)
}

/// Der Schreibdienst: einmal je Minute, und täglich aufräumen.
pub fn starten(pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut letzte_aufraeumung = Instant::now() - Duration::from_secs(86_400);
        loop {
            tokio::time::sleep(FLUSH_TAKT).await;
            schreiben(&pool).await;
            if letzte_aufraeumung.elapsed() > Duration::from_secs(86_400) {
                letzte_aufraeumung = Instant::now();
                aufraeumen(&pool).await;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viele_bereichsanfragen_sind_ein_zugriff() {
        let mut z = LeseZaehler::default();
        let id = Uuid::from_u128(1);
        let t0 = Instant::now();
        // Ein Video: 40 Anfragen in einer Minute.
        let neue = (0..40)
            .filter(|i| z.melden(id, t0 + Duration::from_secs(*i)))
            .count();
        assert_eq!(neue, 1);
        assert_eq!(z.leeren(t0), vec![(id, 1)]);
    }

    #[test]
    fn eine_laufende_wiedergabe_haelt_den_zugriff_offen() {
        let mut z = LeseZaehler::default();
        let id = Uuid::from_u128(2);
        let t0 = Instant::now();
        // Eine Stunde lang alle fünf Minuten eine Anfrage: nie 10 Minuten Pause.
        for i in 0..12 {
            z.melden(id, t0 + Duration::from_secs(300 * i));
        }
        assert_eq!(z.leeren(t0), vec![(id, 1)]);
    }

    #[test]
    fn nach_einer_pause_beginnt_ein_neuer_zugriff() {
        let mut z = LeseZaehler::default();
        let id = Uuid::from_u128(3);
        let t0 = Instant::now();
        assert!(z.melden(id, t0));
        assert!(!z.melden(id, t0 + Duration::from_secs(599)));
        assert!(z.melden(id, t0 + Duration::from_secs(599) + ZUGRIFF_PAUSE));
        assert_eq!(z.leeren(t0), vec![(id, 2)]);
        // Danach ist der Vorrat leer.
        assert!(z.leeren(t0).is_empty());
    }

    #[test]
    fn dateien_zaehlen_getrennt_und_nur_fern_wird_gemeldet() {
        let mut z = LeseZaehler::default();
        let (a, b) = (Uuid::from_u128(4), Uuid::from_u128(5));
        let t0 = Instant::now();
        z.melden(a, t0);
        z.melden(b, t0);
        let mut aus = z.leeren(t0);
        aus.sort();
        assert_eq!(aus, vec![(a, 1), (b, 1)]);
        // `melden` ausserhalb der Struktur ignoriert warme Dateien.
        melden(Uuid::from_u128(6), "lokal");
        melden(Uuid::from_u128(6), "wandert");
        assert!(ZAEHLER
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|z| !z.zuletzt.contains_key(&Uuid::from_u128(6))));
    }
}
