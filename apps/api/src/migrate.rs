//! Migrationen hochfahren – und den Fall behandeln, dass eine bereits
//! ausgeführte Migrationsdatei nachträglich verändert wurde.
//!
//! # Warum es diese Datei gibt
//!
//! sqlx merkt sich zu jeder ausgeführten Migration eine Prüfsumme über den
//! Dateiinhalt. Weicht die Datei später auch nur um ein Zeichen davon ab,
//! verweigert sqlx den Dienst mit `VersionMismatch(n)` – und zwar **bevor**
//! irgendeine neue Migration läuft. Das ist im Kern richtig: Eine Migration,
//! die schon auf einer echten Datenbank lief, ist Geschichte und kein Entwurf
//! mehr.
//!
//! Nur war die Folge hier fatal. Der Fehler wanderte aus `main` heraus, der
//! Prozess beendete sich mit Code 1, Fly startete ihn neu, wieder Code 1 – bis
//! „machine has reached its max restart count of 10“. Von aussen sah man davon
//! nichts: Der Fly-Vermittler nahm jede Anfrage an, suchte eine Maschine, fand
//! keine, und liess den Browser ins Leere laufen. Kein Fehlercode, keine
//! Meldung, nur Warten. Ein halber Tag Ausfall wegen einer Prüfsumme.
//!
//! Deshalb zwei Dinge:
//!
//! 1. Scheitern die Migrationen, **beendet sich der Server nicht mehr**. Er
//!    läuft weiter und sagt über `/healthz` im Klartext, was fehlt. Eine App,
//!    die antwortet und sich erklärt, ist in Minuten repariert; eine, die sich
//!    auflöst, kostet Stunden.
//! 2. Die Prüfsumme lässt sich **auf Ansage** angleichen – nicht von selbst.
//!    Das Angleichen ist der Griff, der eine solche Blockade löst, aber es ist
//!    auch der Griff, der eine echte Änderung stillschweigend unter den Teppich
//!    kehrt. Er gehört an einen Schalter, nicht in den Normalbetrieb.

use sqlx::migrate::{MigrateError, Migrator};
use sqlx::{Connection, PgConnection, PgPool};

/// Was beim Hochfahren der Migrationen passiert ist – für Protokoll und
/// `/healthz`.
#[derive(Debug, Default)]
pub struct Bericht {
    /// Angeglichene Prüfsummen, je eine Zeile im Klartext.
    pub angeglichen: Vec<String>,
}

/// Führt die Migrationen aus.
///
/// `reparieren` gleicht vorher die Prüfsummen bereits ausgeführter
/// Migrationen an die mitgelieferten Dateien an (Schalter:
/// `MIGRATIONS_REPAIR=1`).
///
/// Der Fehlerfall ist bewusst ein `String` und kein `sqlx`-Fehler: Was hier
/// herauskommt, liest ein Mensch – im Fly-Protokoll oder in der Antwort von
/// `/healthz`. `VersionMismatch(1)` allein hilft niemandem weiter.
pub async fn hochfahren(
    pool: &PgPool,
    migrator: &Migrator,
    reparieren: bool,
) -> Result<Bericht, String> {
    // Eine eigene Verbindung, die am Ende **geschlossen** wird – und
    // ausdrücklich nicht in den Vorrat zurückwandert.
    //
    // sqlx nimmt für die Migration eine `pg_advisory_lock`, damit nicht zwei
    // Maschinen gleichzeitig migrieren. Gibt es aber eine
    // Prüfsummen-Abweichung, kehrt `run_direct` sofort mit dem Fehler zurück
    // und lässt das dazugehörige `conn.unlock()` aus (sqlx-core 0.8.6,
    // migrate/migrator.rs: die frühen `return Err(...)` liegen vor dem
    // Entsperren). Die Sperre hängt dann an der Verbindung, solange die lebt.
    //
    // Bisher fiel das nicht auf, weil sich der Prozess danach beendete. Jetzt
    // läuft er weiter – eine im Vorrat schlummernde Verbindung mit gehaltener
    // Sperre würde jeden späteren Migrationsversuch lautlos blockieren, auch
    // den auf einer zweiten Maschine. Also: Verbindung zu, Sperre weg.
    let mut conn = match pool.acquire().await {
        Ok(verbindung) => verbindung.detach(),
        Err(fehler) => return Err(format!("Keine Verbindung zur Datenbank: {fehler}")),
    };
    let ergebnis = auf_verbindung(&mut conn, migrator, reparieren).await;
    let _ = conn.close().await;
    ergebnis
}

async fn auf_verbindung(
    conn: &mut PgConnection,
    migrator: &Migrator,
    reparieren: bool,
) -> Result<Bericht, String> {
    let mut bericht = Bericht::default();

    if reparieren {
        match pruefsummen_angleichen(conn, migrator).await {
            Ok(zeilen) => bericht.angeglichen = zeilen,
            Err(fehler) => {
                return Err(format!(
                    "Die Prüfsummen liessen sich nicht angleichen: {fehler}"
                ))
            }
        }
    }

    match migrator.run(&mut *conn).await {
        Ok(()) => Ok(bericht),
        Err(MigrateError::VersionMismatch(version)) => {
            let name = dateiname(migrator, version);
            Err(format!(
                "Migration {version} ({name}) wurde nach dem Ausführen verändert. \
                 Die Datenbank hat sie längst angewendet, nur passt die Prüfsumme \
                 nicht mehr zur Datei – deshalb läuft KEINE der neueren \
                 Migrationen. Lösung: In GitHub → Actions → „API-Wartung“ die \
                 Aufgabe „migration-reparieren“ starten. Sie gleicht die \
                 Prüfsumme an und lässt die offenen Migrationen durchlaufen."
            ))
        }
        Err(MigrateError::Dirty(version)) => {
            let name = dateiname(migrator, version);
            Err(format!(
                "Migration {version} ({name}) steht als halb ausgeführt in der \
                 Datenbank. Hier muss jemand nachsehen, was von ihr wirklich \
                 angekommen ist – automatisch aufräumen wäre geraten."
            ))
        }
        Err(fehler) => Err(format!("Migrationen fehlgeschlagen: {fehler}")),
    }
}

fn dateiname(migrator: &Migrator, version: i64) -> String {
    migrator
        .iter()
        .find(|migration| migration.version == version)
        // sqlx macht aus `0001_init.sql` die Beschreibung `init` und ersetzt
        // dabei Unterstriche durch Leerzeichen. Für den Dateinamen muss das
        // wieder zurück, sonst sucht man nach `0007_zwei worte.sql`.
        .map(|migration| {
            format!(
                "{:04}_{}.sql",
                migration.version,
                migration.description.replace(' ', "_")
            )
        })
        .unwrap_or_else(|| "unbekannte Datei".to_string())
}

/// Schreibt für bereits **erfolgreich** ausgeführte Migrationen die Prüfsumme
/// der mitgelieferten Datei zurück in `_sqlx_migrations`.
///
/// Nur für Zeilen mit `success = true`: Dass eine Migration dort steht und als
/// gelungen vermerkt ist, ist der Beleg, dass ihr SQL gelaufen ist. Was das
/// Angleichen nicht beweisen kann, ist, ob die Datei seither um *neues* SQL
/// gewachsen ist – dieses käme dann nie an. Deshalb wird jede Änderung einzeln
/// protokolliert, statt still zu geschehen.
async fn pruefsummen_angleichen(
    conn: &mut PgConnection,
    migrator: &Migrator,
) -> Result<Vec<String>, sqlx::Error> {
    // Frische Datenbank: Es gibt noch nichts anzugleichen.
    let tabelle: Option<String> =
        sqlx::query_scalar("select to_regclass('_sqlx_migrations')::text")
            .fetch_one(&mut *conn)
            .await?;
    if tabelle.is_none() {
        return Ok(Vec::new());
    }

    let vermerkt: Vec<(i64, String, Vec<u8>)> =
        sqlx::query_as("select version, description, checksum from _sqlx_migrations where success")
            .fetch_all(&mut *conn)
            .await?;

    let mut zeilen = Vec::new();
    for (version, beschreibung, alt) in vermerkt {
        let Some(datei) = migrator.iter().find(|eintrag| eintrag.version == version) else {
            // Eine Migration, die es im Abbild gar nicht mehr gibt. Nicht unser
            // Fall, und ohne die Datei liesse sich ohnehin nichts angleichen.
            continue;
        };
        if datei.checksum.as_ref() == alt.as_slice() {
            continue;
        }

        sqlx::query("update _sqlx_migrations set checksum = $1 where version = $2")
            .bind(datei.checksum.as_ref())
            .bind(version)
            .execute(&mut *conn)
            .await?;

        zeilen.push(format!(
            "Migration {version} ({beschreibung}): Prüfsumme {} → {}",
            kurz(&alt),
            kurz(datei.checksum.as_ref())
        ));
    }

    Ok(zeilen)
}

/// Die ersten Bytes einer Prüfsumme als Hex – zum Wiedererkennen im Protokoll.
/// Die vollen 48 Bytes bringen dort niemandem etwas.
fn kurz(checksum: &[u8]) -> String {
    checksum
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        + "…"
}

#[cfg(test)]
mod tests {
    use super::kurz;

    #[test]
    fn kuerzt_pruefsummen_lesbar() {
        assert_eq!(
            kurz(&[0x10, 0x1d, 0x68, 0xbc, 0x0f, 0xf9, 0x6a]),
            "101d68bc0ff9…"
        );
        assert_eq!(kurz(&[]), "…");
    }
}
