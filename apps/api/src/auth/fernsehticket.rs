//! Die Eintrittskarte, mit der ein Fernseher eine Datei abholt.
//!
//! # Warum es weder mit dem Kopf noch mit dem Keks geht
//!
//! Beim Streamen auf einen Fernseher holt **das Gerät selbst** die Datei. Ein
//! Chromecast ist kein Rahmen im Browser und keine zweite Lasche – er ist ein
//! eigener Rechner am anderen Ende des Zimmers, der nichts weiter bekommt als
//! eine Adresse. Er schickt deshalb:
//!
//!   * keinen `Authorization`-Kopf – die Seite kann ihm keinen mitgeben,
//!   * keinen Keks – er hat nie eine Anmeldung gesehen, und der Medien-Keks
//!     ist ohnehin `HttpOnly` und an eine andere Stelle gebunden.
//!
//! Damit fallen beide bestehenden Wege aus, und es bleibt nur einer: Was der
//! Ausweis ist, muss IN der Adresse stehen.
//!
//! # Warum nicht einfach der Zugangstoken
//!
//! Weil `AuthUser` einen Token aus `?token=` annimmt, wäre das ein Einzeiler –
//! und ein schlechter Tausch. Diese Adresse steht anschliessend
//!
//!   * im Verlauf des Fernsehers,
//!   * im Protokoll jedes Zwischenknotens, der sie sieht,
//!   * und, bei manchen Geräten, in einer Liste „zuletzt gespielt“, die
//!     Wochen überdauert.
//!
//! Wer sie abgreift, hätte damit ein ganzes Konto: Nachrichten lesen,
//! schreiben, löschen. Die Karte hier kann genau eines – eine Datei abholen –,
//! und `jwt::decode` prüft `typ`, so dass sie auf keiner anderen Route zählt
//! und ein Zugangstoken auch hier nicht durchkommt.
//!
//! # Was darin steht, und warum beides
//!
//! `sub` ist `"{person}:{datei}"`, also BEIDES:
//!
//!   * Die **Datei**, damit eine Karte für ein Urlaubsvideo nicht jede andere
//!     Datei aufschliesst. Ohne diese Bindung wäre sie ein Generalschlüssel
//!     auf Zeit.
//!   * Die **Person**, damit beim Ausliefern weiterhin `darf_anhang_sehen`
//!     nach der HEUTIGEN Lage gefragt werden kann – genau wie auf dem
//!     Keksweg. Ein Austritt aus dem Gespräch beendet damit auch das Bild auf
//!     dem Fernseher, und nicht erst, wenn die Karte abläuft.
//!
//! # Wie lange
//!
//! Sechs Stunden. Ein Spielfilm dauert zwei, eine Diashow eines Abends selten
//! mehr; alles darüber ist kein Abspielen mehr, sondern ein weitergereichter
//! Verweis. Kürzer ginge nicht gut: Der Fernseher fragt beim Vorspulen mit
//! neuen Bereichsanfragen nach, und eine Karte, die mitten im Film abläuft,
//! bricht das Bild ab.

use uuid::Uuid;

use super::jwt;

pub const TYP: &str = "fernseher";
/// Der Name des Abfrageteils in der Adresse.
pub const FELD: &str = "tv";
/// Sechs Stunden – siehe Kopf.
pub const DAUER_S: i64 = 6 * 60 * 60;

/// Eine Karte für genau diese Person und genau diese Datei.
pub fn ausstellen(user_id: Uuid, attachment_id: Uuid, secret: &str) -> String {
    jwt::encode(&format!("{user_id}:{attachment_id}"), TYP, secret, DAUER_S)
}

/**
 * Wer hinter einer Karte steckt – oder `None`.
 *
 * `attachment_id` ist die Datei, die gerade angefragt wird. Sie wird nicht aus
 * der Karte übernommen, sondern gegen sie GEPRÜFT: Eine Karte, die auf eine
 * andere Datei ausgestellt ist, gilt hier nicht. Ohne diesen Vergleich wäre
 * jede Karte ein Schlüssel für den ganzen Speicher.
 */
pub fn betrachter(karte: &str, attachment_id: Uuid, secret: &str) -> Option<Uuid> {
    let claims = jwt::decode(karte, secret)?;
    if claims.typ != TYP {
        return None;
    }
    let (person, datei) = claims.sub.split_once(':')?;
    if Uuid::parse_str(datei).ok()? != attachment_id {
        return None;
    }
    Uuid::parse_str(person).ok()
}

/// Die Karte aus der Abfrage fischen – `?tv=…`, wie sie beim Gerät ankommt.
pub fn aus_abfrage(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|paar| {
        let (name, wert) = paar.split_once('=')?;
        if name != FELD || wert.is_empty() {
            return None;
        }
        urlencoding::decode(wert).ok().map(|k| k.into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GEHEIM: &str = "test-secret-value-at-least-16-characters";

    #[test]
    fn eine_karte_nennt_ihre_person() {
        let person = Uuid::now_v7();
        let datei = Uuid::now_v7();
        let karte = ausstellen(person, datei, GEHEIM);
        assert_eq!(betrachter(&karte, datei, GEHEIM), Some(person));
    }

    #[test]
    fn eine_karte_gilt_nur_fuer_ihre_datei() {
        // Der wichtigste Test hier: Ohne diesen Vergleich wäre jede
        // ausgestellte Karte ein Generalschlüssel auf sechs Stunden.
        let person = Uuid::now_v7();
        let datei = Uuid::now_v7();
        let andere = Uuid::now_v7();
        let karte = ausstellen(person, datei, GEHEIM);
        assert_eq!(betrachter(&karte, andere, GEHEIM), None);
    }

    #[test]
    fn ein_zugangstoken_taugt_als_karte_nicht() {
        let person = Uuid::now_v7();
        let datei = Uuid::now_v7();
        let zugang = jwt::encode(&format!("{person}:{datei}"), "access", GEHEIM, 60);
        assert_eq!(betrachter(&zugang, datei, GEHEIM), None);
        // Und die Karte taugt umgekehrt nicht als Zugangstoken: `jwt::decode`
        // gibt sie zwar her, `AuthUser` verlangt aber `typ == "access"`.
        let karte = ausstellen(person, datei, GEHEIM);
        assert_eq!(
            jwt::decode(&karte, GEHEIM).map(|c| c.typ),
            Some(TYP.to_string())
        );
    }

    #[test]
    fn ein_fremdes_geheimnis_zaehlt_nicht() {
        let person = Uuid::now_v7();
        let datei = Uuid::now_v7();
        let karte = ausstellen(person, datei, "ein-ganz-anderes-geheimnis-hier");
        assert_eq!(betrachter(&karte, datei, GEHEIM), None);
    }

    #[test]
    fn eine_abgelaufene_karte_zaehlt_nicht() {
        let person = Uuid::now_v7();
        let datei = Uuid::now_v7();
        let alt = jwt::encode(&format!("{person}:{datei}"), TYP, GEHEIM, -1);
        assert_eq!(betrachter(&alt, datei, GEHEIM), None);
    }

    #[test]
    fn unfug_im_sub_faellt_durch() {
        let datei = Uuid::now_v7();
        for sub in ["", ":", "ohne-doppelpunkt", "keine-uuid:auch-keine"] {
            let karte = jwt::encode(sub, TYP, GEHEIM, 60);
            assert_eq!(betrachter(&karte, datei, GEHEIM), None, "sub = {sub:?}");
        }
    }

    #[test]
    fn die_karte_wird_aus_der_abfrage_gefischt() {
        assert_eq!(
            aus_abfrage(Some("tv=abc.def.ghi")).as_deref(),
            Some("abc.def.ghi")
        );
        assert_eq!(
            aus_abfrage(Some("x=1&tv=abc.def.ghi&y=2")).as_deref(),
            Some("abc.def.ghi")
        );
        assert_eq!(aus_abfrage(Some("token=abc")), None);
        assert_eq!(aus_abfrage(Some("tv=")), None);
        assert_eq!(aus_abfrage(None), None);
        // `atv=…` ist nicht `tv=…` – ein Präfixvergleich wäre hier falsch.
        assert_eq!(aus_abfrage(Some("atv=abc")), None);
    }
}
