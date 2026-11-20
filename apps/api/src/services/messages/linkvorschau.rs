//! Link-Vorschau: Titel, Beschreibung und Bild einer Seite – geholt vom
//! eigenen Server, nur auf Wunsch des Absenders.
//!
//! # Datenschutz
//!
//! Der Abruf ist **opt-in** (Einstellung „Link-Vorschauen erzeugen“, Standard
//! aus) und geschieht nur, wenn der ABSENDER es auslöst. Die fremde Seite sieht
//! dann die Adresse dieses Servers, nicht die des Absenders – und die
//! Empfänger sehen gar nichts von ihr: Titel und Text stehen in der Nachricht,
//! das Bild liegt verkleinert im eigenen Medienspeicher. Niemand lädt beim
//! Öffnen eines Chats etwas von einem fremden Server.
//!
//! # SSRF – was hier verhindert, dass der Server intern herumfragt
//!
//! Eine Adresse, die ein Nutzer einreicht und die der Server abruft, ist der
//! klassische Weg ins interne Netz (Metadaten-Dienste der Cloud auf
//! 169.254.169.254, die Datenbank auf 127.0.0.1, der Router im LAN). Darum:
//!
//! * nur `http`/`https`, ohne Zugangsdaten in der Adresse;
//! * eine **IP als Host** muss öffentlich sein (`push::ist_oeffentlich`) – diese
//!   Adressen gehen an keinem Namensdienst vorbei, also hier geprüft;
//! * ein **Name** wird von einem eigenen Resolver aufgelöst, der nur
//!   öffentliche Adressen herausgibt – geprüft bei JEDER Verbindung, nicht
//!   einmal vorab (sonst zeigte der Name beim zweiten Mal auf 127.0.0.1);
//! * **Umleitungen** folgt nicht der HTTP-Client, sondern diese Schleife:
//!   höchstens drei, jede neue Adresse durchläuft dieselbe Prüfung;
//! * **kein Proxy** (der sähe die Prüfung nicht), **keine Kekse**;
//! * **Zeitlimit** 5 s für alles zusammen, **Grössenlimit** 512 KB HTML bzw.
//!   2 MB Bild – gelesen wird Stück für Stück und dann aufgehört;
//! * **kein JavaScript**: Gelesen wird der HTML-Text mit einem eigenen,
//!   begrenzten Scanner (keine neue Abhängigkeit), nur `<title>` und
//!   `<meta>` im Kopf.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::Url;

/// Zeit für die ganze Seite (alle Umleitungen und der Inhalt zusammen).
pub const ZEITLIMIT: Duration = Duration::from_secs(5);
/// Höchstens so viel HTML wird gelesen. Die Angaben stehen im Kopf; was
/// danach kommt, braucht die Vorschau nicht.
pub const HTML_MAX: usize = 512 * 1024;
/// Höchstens so gross darf das Vorschaubild beim Abruf sein.
pub const BILD_MAX: usize = 2 * 1024 * 1024;
/// Höchstens so vielen Umleitungen wird gefolgt.
pub const UMLEITUNGEN_MAX: usize = 3;
/// Der Scanner sieht sich höchstens so viele Tags an.
const TAGS_MAX: usize = 4000;

/// Warum es keine Vorschau gibt.
#[derive(Debug, PartialEq, Eq)]
pub enum Fehler {
    /// Die Adresse (oder ein Umleitungsziel) ist nicht erlaubt.
    Verboten(&'static str),
    /// Die Seite war nicht zu holen (Zeit, Netz, Status, kein HTML).
    NichtErreichbar(String),
}

/// Was die Seite über sich sagt.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Seite {
    pub titel: Option<String>,
    pub beschreibung: Option<String>,
    pub seitenname: Option<String>,
    /// Die Bildadresse aus `og:image`, wie sie dasteht (oft relativ).
    pub bild: Option<String>,
}

/// Eine Bildadresse gegen die Seite auflösen – nur http(s).
pub fn bild_aufloesen(seite: &Url, roh: &str) -> Option<Url> {
    seite
        .join(roh)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
}

/* ---------- Namen nur für Tests ------------------------------------------- */

fn testnamen() -> &'static Mutex<HashMap<String, IpAddr>> {
    static NAMEN: OnceLock<Mutex<HashMap<String, IpAddr>>> = OnceLock::new();
    NAMEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// **Nur für Tests**: Ein erfundener Name (etwa `vorschau.test`), der auf eine
/// lokale Adresse zeigt, an der ein Testserver lauscht. Im Betrieb ruft das
/// niemand auf; die Liste bleibt leer. Nur Namen – eine IP als Host geht nie
/// an dieser Liste vorbei, und `localhost` bleibt gesperrt.
pub fn testname_eintragen(name: &str, ip: IpAddr) {
    if let Ok(mut namen) = testnamen().lock() {
        namen.insert(name.to_ascii_lowercase(), ip);
    }
}

fn testname(name: &str) -> Option<IpAddr> {
    testnamen()
        .lock()
        .ok()
        .and_then(|namen| namen.get(&name.to_ascii_lowercase()).copied())
}

/* ---------- Adressen prüfen ----------------------------------------------- */

/// Darf diese Adresse abgerufen werden – soweit sich das ohne Namensauflösung
/// sagen lässt?
pub fn adresse_pruefen(url: &Url) -> Result<(), Fehler> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Fehler::Verboten("nur http und https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Fehler::Verboten("keine Zugangsdaten in der Adresse"));
    }
    match url.host() {
        None => Err(Fehler::Verboten("Adresse ohne Host")),
        Some(url::Host::Ipv4(ip)) => {
            if crate::push::ist_oeffentlich(IpAddr::V4(ip)) {
                Ok(())
            } else {
                Err(Fehler::Verboten("Adresse im internen Netz"))
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if crate::push::ist_oeffentlich(IpAddr::V6(ip)) {
                Ok(())
            } else {
                Err(Fehler::Verboten("Adresse im internen Netz"))
            }
        }
        Some(url::Host::Domain(_)) => Ok(()),
    }
}

/// Der Resolver: nur öffentliche Adressen (oder ein eingetragener Testname).
struct NurOeffentlich;

impl reqwest::dns::Resolve for NurOeffentlich {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_string();
        Box::pin(async move {
            if let Some(ip) = testname(&name) {
                let adressen: Vec<SocketAddr> = vec![SocketAddr::new(ip, 0)];
                return Ok(Box::new(adressen.into_iter()) as reqwest::dns::Addrs);
            }
            let adressen: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|adresse| crate::push::ist_oeffentlich(adresse.ip()))
                .collect();
            if adressen.is_empty() {
                return Err("Name zeigt auf keine öffentliche Adresse".into());
            }
            Ok(Box::new(adressen.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn client() -> Result<reqwest::Client, Fehler> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(NurOeffentlich)
        .timeout(ZEITLIMIT)
        .connect_timeout(Duration::from_secs(3))
        .user_agent("Mozilla/5.0 (compatible; Initiative-Linkvorschau)")
        .build()
        .map_err(|_| Fehler::NichtErreichbar("HTTP-Client".into()))
}

/// Holt eine Adresse samt Umleitungen und liest höchstens `max` Bytes. Gibt
/// die endgültige Adresse, den Inhaltstyp und die Bytes zurück.
async fn holen(
    client: &reqwest::Client,
    start: Url,
    akzeptiert: &str,
    max: usize,
) -> Result<(Url, String, Vec<u8>), Fehler> {
    let mut adresse = start;
    for _ in 0..=UMLEITUNGEN_MAX {
        adresse_pruefen(&adresse)?;
        let mut antwort = client
            .get(adresse.clone())
            .header(reqwest::header::ACCEPT, akzeptiert)
            .send()
            .await
            .map_err(|fehler| {
                // Der Resolver lehnt interne Ziele mit einem Fehler ab – das
                // ist ein Verbot, kein Netzproblem.
                let text = format!("{fehler:?}");
                if text.contains("keine öffentliche Adresse") {
                    Fehler::Verboten("Adresse im internen Netz")
                } else if fehler.is_timeout() {
                    Fehler::NichtErreichbar("Zeitlimit".into())
                } else {
                    Fehler::NichtErreichbar("Seite nicht erreichbar".into())
                }
            })?;
        if antwort.status().is_redirection() {
            let ziel = antwort
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|wert| wert.to_str().ok())
                .and_then(|wert| adresse.join(wert).ok())
                .ok_or_else(|| Fehler::NichtErreichbar("Umleitung ohne Ziel".into()))?;
            adresse = ziel;
            continue;
        }
        if !antwort.status().is_success() {
            return Err(Fehler::NichtErreichbar(format!(
                "Status {}",
                antwort.status().as_u16()
            )));
        }
        let typ = antwort
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|wert| wert.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        // Eine angekündigte Länge über der Grenze: gar nicht erst lesen.
        if antwort
            .content_length()
            .is_some_and(|laenge| laenge as usize > max && akzeptiert.starts_with("image"))
        {
            return Err(Fehler::NichtErreichbar("zu gross".into()));
        }
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(stueck) = antwort
            .chunk()
            .await
            .map_err(|_| Fehler::NichtErreichbar("Abbruch beim Lesen".into()))?
        {
            let rest = max.saturating_sub(bytes.len());
            if stueck.len() >= rest {
                bytes.extend_from_slice(&stueck[..rest]);
                // Für ein Bild ist ein abgeschnittenes eins kein Bild.
                if akzeptiert.starts_with("image") {
                    return Err(Fehler::NichtErreichbar("zu gross".into()));
                }
                break;
            }
            bytes.extend_from_slice(&stueck);
        }
        return Ok((adresse, typ, bytes));
    }
    Err(Fehler::NichtErreichbar("zu viele Umleitungen".into()))
}

/// Holt eine Seite und liest ihre Angaben – alles in [`ZEITLIMIT`].
pub async fn seite_abrufen(url: &str) -> Result<(Seite, Option<Url>), Fehler> {
    let start = Url::parse(url).map_err(|_| Fehler::Verboten("keine gültige Adresse"))?;
    adresse_pruefen(&start)?;
    let client = client()?;
    let (endgueltig, typ, bytes) = tokio::time::timeout(
        ZEITLIMIT,
        holen(&client, start, "text/html,application/xhtml+xml", HTML_MAX),
    )
    .await
    .map_err(|_| Fehler::NichtErreichbar("Zeitlimit".into()))??;
    if !(typ.starts_with("text/html") || typ.starts_with("application/xhtml+xml")) {
        return Err(Fehler::NichtErreichbar("keine HTML-Seite".into()));
    }
    let text = String::from_utf8_lossy(&bytes);
    let seite = kopf_lesen(&text);
    // Das Bild relativ zur endgültigen Seite (nach Umleitungen) auflösen.
    let bild = seite
        .bild
        .as_deref()
        .and_then(|roh| bild_aufloesen(&endgueltig, roh));
    Ok((seite, bild))
}

/// Holt ein Vorschaubild (höchstens [`BILD_MAX`], nur `image/*`).
pub async fn bild_abrufen(url: Url) -> Result<Vec<u8>, Fehler> {
    let client = client()?;
    let (_, typ, bytes) = tokio::time::timeout(ZEITLIMIT, holen(&client, url, "image/*", BILD_MAX))
        .await
        .map_err(|_| Fehler::NichtErreichbar("Zeitlimit".into()))??;
    if !typ.starts_with("image/") || typ.contains("svg") {
        return Err(Fehler::NichtErreichbar("kein Bild".into()));
    }
    Ok(bytes)
}

/* ---------- Der Scanner ---------------------------------------------------- */

fn entitaeten(text: &str) -> String {
    let mut aus = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(stelle) = rest.find('&') {
        aus.push_str(&rest[..stelle]);
        rest = &rest[stelle..];
        let fenster = rest
            .char_indices()
            .nth(12)
            .map_or(rest.len(), |(stelle, _)| stelle);
        let Some(ende) = rest[..fenster].find(';') else {
            aus.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..ende];
        let zeichen = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if name.starts_with("#x") || name.starts_with("#X") => {
                u32::from_str_radix(&name[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if name.starts_with('#') => name[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match zeichen {
            Some(z) => {
                aus.push(z);
                rest = &rest[ende + 1..];
            }
            None => {
                aus.push('&');
                rest = &rest[1..];
            }
        }
    }
    aus.push_str(rest);
    aus
}

/// Leerraum zusammenziehen, Steuerzeichen weg, kürzen.
fn sauber(text: &str, max: usize) -> Option<String> {
    let zusammen: String = entitaeten(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if zusammen.is_empty() {
        return None;
    }
    Some(if zusammen.chars().count() > max {
        let mut k: String = zusammen.chars().take(max.saturating_sub(1)).collect();
        k.push('…');
        k
    } else {
        zusammen
    })
}

/// Die Attribute eines Tags (`name="wert"`, `name='wert'`, `name=wert`),
/// Namen klein geschrieben.
fn attribute(tag: &str) -> HashMap<String, String> {
    let mut aus = HashMap::new();
    let zeichen: Vec<char> = tag.chars().collect();
    let mut i = 0;
    // Den Tag-Namen überspringen.
    while i < zeichen.len() && !zeichen[i].is_whitespace() {
        i += 1;
    }
    while i < zeichen.len() {
        while i < zeichen.len() && (zeichen[i].is_whitespace() || zeichen[i] == '/') {
            i += 1;
        }
        let anfang = i;
        while i < zeichen.len() && !zeichen[i].is_whitespace() && zeichen[i] != '=' {
            i += 1;
        }
        let name: String = zeichen[anfang..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        while i < zeichen.len() && zeichen[i].is_whitespace() {
            i += 1;
        }
        if i < zeichen.len() && zeichen[i] == '=' {
            i += 1;
            while i < zeichen.len() && zeichen[i].is_whitespace() {
                i += 1;
            }
            let wert: String = if i < zeichen.len() && (zeichen[i] == '"' || zeichen[i] == '\'') {
                let quote = zeichen[i];
                i += 1;
                let a = i;
                while i < zeichen.len() && zeichen[i] != quote {
                    i += 1;
                }
                let w = zeichen[a..i].iter().collect();
                i += 1;
                w
            } else {
                let a = i;
                while i < zeichen.len() && !zeichen[i].is_whitespace() {
                    i += 1;
                }
                zeichen[a..i].iter().collect()
            };
            if !name.is_empty() {
                aus.entry(name).or_insert(wert);
            }
        } else if !name.is_empty() {
            aus.entry(name).or_insert_with(String::new);
        }
    }
    aus
}

/**
 * Liest Titel, Beschreibung, Seitenname und Bild aus dem Kopf einer Seite.
 *
 * Kein HTML-Parser: Er sucht `<title>` und `<meta …>`, überspringt Kommentare
 * und `<script>`/`<style>`-Inhalte und hört am Ende des Kopfes (`</head>`,
 * `<body`) auf – oder nach [`TAGS_MAX`] Tags. OpenGraph geht vor Twitter, das
 * vor dem schlichten `<title>` / `description`.
 */
pub fn kopf_lesen(html: &str) -> Seite {
    let mut og: HashMap<String, String> = HashMap::new();
    let mut titel_tag: Option<String> = None;
    let klein = html.to_ascii_lowercase();
    let mut pos = 0;
    let mut tags = 0;
    while let Some(stelle) = klein[pos..].find('<') {
        let anfang = pos + stelle;
        tags += 1;
        if tags > TAGS_MAX {
            break;
        }
        let rest = &klein[anfang..];
        if rest.starts_with("<!--") {
            pos = match rest.find("-->") {
                Some(e) => anfang + e + 3,
                None => break,
            };
            continue;
        }
        if rest.starts_with("</head") || rest.starts_with("<body") {
            break;
        }
        for roh in ["<script", "<style"] {
            if rest.starts_with(roh) {
                let schluss = if roh == "<script" {
                    "</script"
                } else {
                    "</style"
                };
                pos = match rest.find(schluss) {
                    Some(e) => anfang + e + 1,
                    None => klein.len(),
                };
            }
        }
        if rest.starts_with("<script") || rest.starts_with("<style") {
            continue;
        }
        let Some(ende) = rest.find('>') else { break };
        let tag_klein = &rest[1..ende];
        let tag_original = &html[anfang + 1..anfang + ende];
        if tag_klein.starts_with("title")
            && (tag_klein.len() == 5 || tag_klein[5..].starts_with(char::is_whitespace))
        {
            let inhalt_anfang = anfang + ende + 1;
            if let Some(e) = klein[inhalt_anfang..].find("</title") {
                titel_tag.get_or_insert_with(|| html[inhalt_anfang..inhalt_anfang + e].to_string());
            }
        } else if tag_klein.starts_with("meta") && tag_klein[4..].starts_with(char::is_whitespace) {
            let attr = attribute(tag_original);
            let schluessel = attr
                .get("property")
                .or_else(|| attr.get("name"))
                .map(|s| s.to_ascii_lowercase());
            if let (Some(schluessel), Some(inhalt)) = (schluessel, attr.get("content")) {
                og.entry(schluessel).or_insert_with(|| inhalt.clone());
            }
        }
        pos = anfang + ende + 1;
    }

    let erstes = |namen: &[&str]| namen.iter().find_map(|n| og.get(*n).cloned());
    Seite {
        titel: erstes(&["og:title", "twitter:title"])
            .or(titel_tag)
            .and_then(|t| sauber(&t, super::regeln::VORSCHAU_TITEL_MAX)),
        beschreibung: erstes(&["og:description", "twitter:description", "description"])
            .and_then(|t| sauber(&t, super::regeln::VORSCHAU_TEXT_MAX)),
        seitenname: erstes(&["og:site_name"])
            .and_then(|t| sauber(&t, super::regeln::VORSCHAU_SEITE_MAX)),
        bild: erstes(&["og:image", "og:image:url", "twitter:image"])
            .map(|t| entitaeten(t.trim()))
            .filter(|t| !t.is_empty() && t.len() <= super::regeln::VORSCHAU_URL_MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liest_opengraph_vor_title_und_entitaeten() {
        let html = r#"<!doctype html><html><head>
            <title>Schlichter Titel</title>
            <!-- <meta property="og:title" content="Kommentar"> -->
            <meta property="og:title" content="Gro&szlig;es &amp; Kleines &#x263A;">
            <meta name='description' content='Eine Seite'>
            <meta property=og:site_name content=Beispiel>
            <script>var x = "<meta property='og:image' content='http://evil/'>";</script>
            <meta property="og:image" content="/bild.png">
            </head><body><meta property="og:description" content="zu spät"></body>"#;
        let seite = kopf_lesen(html);
        assert_eq!(seite.titel.as_deref(), Some("Gro&szlig;es & Kleines ☺"));
        assert_eq!(seite.beschreibung.as_deref(), Some("Eine Seite"));
        assert_eq!(seite.seitenname.as_deref(), Some("Beispiel"));
        assert_eq!(seite.bild.as_deref(), Some("/bild.png"));
        let basis = Url::parse("https://beispiel.de/a/b").unwrap();
        assert_eq!(
            bild_aufloesen(&basis, "/bild.png").unwrap().as_str(),
            "https://beispiel.de/bild.png"
        );
        assert!(bild_aufloesen(&basis, "javascript:alert(1)").is_none());
    }

    #[test]
    fn ohne_opengraph_der_title() {
        let seite = kopf_lesen("<html><head><TITLE>  Nur\n Titel </TITLE></head></html>");
        assert_eq!(seite.titel.as_deref(), Some("Nur Titel"));
        assert!(seite.bild.is_none());
    }

    #[test]
    fn kaputtes_html_haelt_den_scanner_nicht_auf() {
        for html in [
            "<",
            "<meta",
            "<!--",
            "<title>offen",
            "<meta content=\"x",
            "&#xFFFFFFFF;",
        ] {
            let _ = kopf_lesen(html);
        }
        assert_eq!(entitaeten("a &unbekannt; b &#65;"), "a &unbekannt; b A");
    }

    #[test]
    fn nur_oeffentliche_http_adressen() {
        let gut = Url::parse("https://example.org/x").unwrap();
        assert!(adresse_pruefen(&gut).is_ok());
        for schlecht in [
            "http://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "ftp://example.org/",
            "file:///etc/passwd",
            "https://nutzer:pw@example.org/",
            "http://0.0.0.0/",
        ] {
            let url = Url::parse(schlecht).unwrap();
            assert!(adresse_pruefen(&url).is_err(), "{schlecht}");
        }
    }
}
