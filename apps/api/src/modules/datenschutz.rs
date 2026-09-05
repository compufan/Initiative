//! Datenschutzerklärung und Impressum – als Seiten, nicht als Anhang.
//!
//! Sie liegen beim Server und nicht in der PWA, damit sie auch ohne Anmeldung
//! und ohne installierte App erreichbar sind. Wer wissen will, was mit seinen
//! Daten geschieht, soll dafür nicht erst ein Konto anlegen müssen. § 5 DDG
//! verlangt für das Impressum ausdrücklich „leicht erkennbar, unmittelbar
//! erreichbar und ständig verfügbar“ – das schliesst eine Seite hinter einer
//! Anmeldung aus.
//!
//! # Warum so viel davon aus der Konfiguration kommt
//!
//! Weil eine Erklärung, die etwas anderes behauptet als die Software tut,
//! schlechter ist als gar keine: Sie sieht aus, als sei sie geprüft worden.
//! Genau das war hier der Fall. Der Absatz „Wo die Daten liegen“ nannte vier
//! fremde Anbieter weiter, obwohl der Umzug auf einen eigenen Server im
//! selben Repo schon vollzogen war.
//!
//! Deshalb steht hier so wenig fest einkompiliert wie möglich. Was die
//! Installation über sich selbst weiß – wo Dateien liegen, ob sie
//! verschlüsselt sind, ob Benachrichtigungen überhaupt eingerichtet sind, wie
//! lange eine Sitzung gilt –, das liest diese Seite zur Laufzeit aus der
//! Konfiguration, statt es zu behaupten.
//!
//! **Betreiberangaben füllt die Konfiguration**: `OPERATOR_NAME`,
//! `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` und `OPERATOR_HOSTING`. Fehlen sie,
//! sagen die Seiten das deutlich, statt eine Lücke zu verstecken.

use axum::extract::State;
use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::config::{RegistrationMode, StorageDriver};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/datenschutz", get(datenschutz))
        .route("/impressum", get(impressum))
}

/// Macht fremden Text für HTML unschädlich.
///
/// Die Betreiberangaben kommen aus der Umgebung. Das ist zwar keine
/// Nutzereingabe, aber ein `&` im Firmennamen soll die Seite trotzdem nicht
/// zerlegen, und ein `<script>` in einer falsch gesetzten Variablen erst
/// recht nicht.
fn sicher(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

struct Angaben {
    name: String,
    anschrift: String,
    email: String,
    hosting: Option<String>,
    fehlt: bool,
}

fn angaben(state: &AppState) -> Angaben {
    let betreiber = state.config.operator.as_ref();
    Angaben {
        name: betreiber
            .map(|a| sicher(&a.name))
            .unwrap_or_else(|| "— noch nicht eingetragen —".into()),
        anschrift: betreiber
            .and_then(|a| a.address.as_deref())
            .map(sicher)
            .unwrap_or_else(|| "— noch nicht eingetragen —".into()),
        email: betreiber
            .map(|a| sicher(&a.email))
            .unwrap_or_else(|| "— noch nicht eingetragen —".into()),
        hosting: betreiber.and_then(|a| a.hosting.as_deref()).map(sicher),
        fehlt: betreiber.is_none(),
    }
}

fn warnung(fehlt: bool, seite: &str) -> String {
    if !fehlt {
        return String::new();
    }
    format!(
        r#"<p class="warn">Diese Seite ist noch unvollständig: Es fehlen Name, Anschrift und
        E-Mail des Betreibers. Ohne sie erfüllt {seite}. Zu setzen als
        <code>OPERATOR_NAME</code>, <code>OPERATOR_ADDRESS</code>,
        <code>OPERATOR_EMAIL</code> und <code>OPERATOR_HOSTING</code>.</p>"#
    )
}

/// Das Gerüst beider Seiten – ein Stil, eine Kopfzeile, ein Fusszeilenhinweis.
fn rahmen(titel: &str, inhalt: &str) -> Response {
    let html = format!(
        r##"<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{titel} – Initiative</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         line-height: 1.6; max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }}
  h1 {{ font-size: 1.6rem; }}
  h2 {{ font-size: 1.15rem; margin-top: 2.2rem; }}
  code {{ background: rgba(127,127,127,.18); padding: .1em .35em; border-radius: .25em; }}
  .warn {{ background: rgba(220,38,38,.12); border-left: 3px solid #dc2626;
           padding: .75rem 1rem; border-radius: .3rem; }}
  .merk {{ background: rgba(127,127,127,.12); border-left: 3px solid rgba(127,127,127,.5);
           padding: .75rem 1rem; border-radius: .3rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
  th, td {{ text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(127,127,127,.3);
            vertical-align: top; font-size: .95rem; }}
  .muted {{ opacity: .75; font-size: .9rem; }}
  nav a {{ margin-right: 1rem; }}
</style>
</head>
<body>
<nav class="muted"><a href="/datenschutz">Datenschutz</a><a href="/impressum">Impressum</a></nav>
{inhalt}
<p class="muted">Diese Seite beschreibt den tatsächlichen Stand der Software. Sie
ist keine Rechtsberatung.</p>
</body>
</html>"##
    );
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Html(html),
    )
        .into_response()
}

async fn impressum(State(state): State<AppState>) -> Response {
    let a = angaben(&state);
    let hinweis = warnung(a.fehlt, "sie § 5 DDG nicht");
    let inhalt = format!(
        r##"<h1>Impressum</h1>
{hinweis}

<h2>Angaben nach § 5 DDG</h2>
<p>{name}<br>{anschrift}</p>
<p>E-Mail: {email}</p>

<h2>Verantwortlich für den Inhalt</h2>
<p>{name}, Anschrift wie oben.</p>

<h2>Was das hier ist</h2>
<p>Initiative ist eine selbst betriebene App für einen kleinen Kreis –
Nachrichten, Kalender, gemeinsame Ausgaben, Umfragen und ein paar Spiele. Der
Quelltext ist offen und steht unter der MIT-Lizenz. Die verwendete fremde
Software ist in der App unter <em>Profil → Einstellungen → Über → Verwendete
Software</em> vollständig aufgeführt.</p>

<h2>Streitbeilegung</h2>
<p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren
vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>"##,
        name = a.name,
        anschrift = a.anschrift,
        email = a.email,
    );
    rahmen("Impressum", &inhalt)
}

async fn datenschutz(State(state): State<AppState>) -> Response {
    let a = angaben(&state);
    let hinweis = warnung(
        a.fehlt,
        "sie Artikel 13 der Datenschutz-Grundverordnung nicht",
    );

    /*
     * Was diese Installation über sich selbst weiß.
     *
     * Jede dieser Zeilen stand hier vorher als feste Behauptung im Text – und
     * mindestens eine davon war falsch. Jetzt kommen sie aus derselben
     * Konfiguration, nach der sich auch die Software richtet. Damit können
     * Text und Verhalten nicht mehr auseinanderlaufen.
     */
    let dateien = match state.config.storage_driver {
        StorageDriver::Local => {
            "auf demselben Server, im Dateisystem – sie verlassen ihn nicht".to_string()
        }
        StorageDriver::S3 | StorageDriver::R2 => {
            let ort = state
                .config
                .s3
                .as_ref()
                .and_then(|s3| s3.endpoint.as_deref())
                .map(sicher)
                .unwrap_or_else(|| "einem S3-kompatiblen Speicher".into());
            format!("in einem Objektspeicher unter <code>{ort}</code>")
        }
    };
    let verschluesselt = if state.config.media_key.is_some() {
        "Sie liegen dort <strong>verschlüsselt</strong> (AES-256-GCM, ein eigener Schlüssel je \
         Datei). Wer die Dateien in die Hand bekäme, ohne den Schlüssel zu haben, kann sie nicht \
         lesen."
    } else {
        "Sie liegen dort <strong>unverschlüsselt</strong>. Wer Zugriff auf den Speicher hat, kann \
         sie ansehen. (Die Verschlüsselung ist eingebaut und wird eingeschaltet, sobald \
         <code>MEDIA_KEY</code> gesetzt ist.)"
    };
    let push = if state.config.push_enabled() {
        "eingerichtet"
    } else {
        "auf diesem Server nicht eingerichtet – es werden keine Benachrichtigungen verschickt"
    };
    let tage = state.config.refresh_token_ttl.as_secs() / 86_400;
    let einladung = match state.config.registration_mode {
        RegistrationMode::Open => "Ein Konto kann jeder anlegen, der die Adresse kennt.",
        RegistrationMode::Invite => "Ein Konto kann nur anlegen, wer einen Einladungscode hat.",
        RegistrationMode::Closed => {
            "Neue Konten legt zurzeit nur der Betreiber an; die Selbstregistrierung ist zu."
        }
    };
    /*
     * Der Satz zum Drittland haengt am Speicherort und darf nicht pauschal
     * dastehen. Cloudflare R2 gehoert einem US-Unternehmen; wer es einstellt,
     * uebermittelt in ein Drittland, und die Erklaerung muss das sagen.
     */
    let drittland = match state.config.storage_driver {
        StorageDriver::Local | StorageDriver::S3 => {
            "Eine Übermittlung in Länder ausserhalb der EU findet dabei nicht statt. Die einzige              Ausnahme sind Push-Benachrichtigungen – siehe unten."
        }
        StorageDriver::R2 => {
            "Der Dateispeicher ist Cloudflare R2. Cloudflare ist ein US-Unternehmen; die              Übermittlung stützt sich auf dessen Zertifizierung im EU-US Data Privacy Framework              und auf Standardvertragsklauseln. Die zweite Übermittlung ausserhalb der EU sind              Push-Benachrichtigungen – siehe unten."
        }
    };
    let hosting = a.hosting.clone().unwrap_or_else(|| {
        "<em>— nicht eingetragen. Zu setzen als <code>OPERATOR_HOSTING</code>, damit hier steht, \
         wer den Server wirklich betreibt. —</em>"
            .to_string()
    });

    let inhalt = format!(
        r##"<h1>Datenschutz</h1>
{hinweis}

<h2>Wer verantwortlich ist</h2>
<p>{name}<br>{anschrift}<br>{email}</p>
<p>Ein Datenschutzbeauftragter ist nicht bestellt. Bei Fragen zum Datenschutz wende
dich bitte direkt an diese Adresse.</p>

<h2>Worum es hier geht</h2>
<p>Initiative ist eine selbst betriebene App für einen kleinen Kreis. Es gibt
<strong>keine Werbung, keine Analyse-Werkzeuge, kein Tracking</strong> und keine
Weitergabe an Dritte zu Werbezwecken. Die Seite lädt nichts von fremden Servern –
keine Schriftart, kein Symbol, kein Zählpixel. Es wird nichts gespeichert, was die
App nicht zum Funktionieren braucht.</p>

<h2>Was du angeben musst – und was nicht</h2>
<p>Für ein Konto brauchen wir zwei Dinge: einen Benutzernamen und ein Passwort.
{einladung}</p>
<p>Alles andere ist freiwillig: Anzeigename, Profilbild, Kurzbeschreibung,
Zahlungsangaben, Benachrichtigungen, Kalender-Abo, Anmeldung per Passkey. Lässt du
davon etwas weg, funktioniert die betreffende Sache nicht – das Konto und der Rest
der App schon.</p>
<p><strong>Eine E-Mail-Adresse fragen wir nicht ab.</strong> Das hat eine Folge, die
du kennen solltest: Ein vergessenes Passwort lässt sich nicht per E-Mail
zurücksetzen. Es gibt keinen Weg zurück ins Konto ausser über eine andere
angemeldete Sitzung oder einen Passkey.</p>

<h2>Was gespeichert wird</h2>
<table>
<tr><th>Was</th><th>Wozu</th><th>Wie lange</th></tr>
<tr><td>Benutzername, Anzeigename, Passwort (nur als Prüfwert, nie im Klartext)</td>
    <td>Damit du dich anmelden kannst und andere dich erkennen</td>
    <td>Bis du dein Konto löschst</td></tr>
<tr><td>Profilbild, Kurzbeschreibung, Farbe</td>
    <td>Damit man dich in der Liste wiedererkennt</td>
    <td>Bis du sie änderst oder dein Konto löschst</td></tr>
<tr><td>Nachrichten, Bilder, Videos, Sprachnachrichten, Dateien, Termine, Umfragen,
        Spielstände, gemeinsame Ausgaben</td>
    <td>Das ist der Dienst selbst</td>
    <td>Bis du sie löschst oder dein Konto</td></tr>
<tr><td>Reaktionen, Lesestand, Tippanzeige, „zuletzt gesehen“</td>
    <td>Damit ein Gespräch sich wie eines anfühlt</td>
    <td>Lesestand und „zuletzt gesehen“ werden laufend überschrieben; die Tippanzeige
        wird gar nicht gespeichert, sondern nur weitergereicht</td></tr>
<tr><td>Zahlungsangaben, wenn du sie hinterlegst (PayPal.Me-Name, IBAN, BIC,
        Kontoinhaber, Notiz)</td>
    <td>Damit dir andere aus der Gruppe Geld zurückschicken können, ohne jedes Mal
        zu fragen</td>
    <td>Bis du sie löschst oder dein Konto</td></tr>
<tr><td>Anmelde-Sitzungen (Browserkennung des Geräts, Zeitpunkt)</td>
    <td>Damit du angemeldet bleibst und Sitzungen beenden kannst</td>
    <td>{tage} Tage ohne Nutzung; der Eintrag selbst wird spätestens eine Woche
        danach entfernt</td></tr>
<tr><td>Passkeys, wenn du welche anlegst (öffentlicher Schlüssel, Kennung, Zähler)</td>
    <td>Anmelden ohne Passwort</td>
    <td>Bis du den Passkey oder dein Konto löschst</td></tr>
<tr><td>Kalender-Kennung für das Abo</td>
    <td>Damit dein Kalenderprogramm die Termine ohne Anmeldung abholen kann</td>
    <td>Bis du dein Konto löschst</td></tr>
<tr><td>Push-Abonnement (Adresse beim Browserhersteller, Schlüssel)</td>
    <td>Nur wenn du Benachrichtigungen erlaubst</td>
    <td>Bis du sie abschaltest</td></tr>
</table>

<h2>Worauf sich das stützt</h2>
<table>
<tr><th>Verarbeitung</th><th>Rechtsgrundlage</th></tr>
<tr><td>Konto, Anmeldung, angemeldet bleiben</td>
    <td>Art. 6 Abs. 1 lit. b DSGVO – Erfüllung des Nutzungsvertrags</td></tr>
<tr><td>Chats, Dateien, Termine, Umfragen, Ausgaben – der Dienst selbst</td>
    <td>Art. 6 Abs. 1 lit. b DSGVO</td></tr>
<tr><td>Freiwilliges: Profilbild, Zahlungsangaben, Kalender-Abo, Passkeys</td>
    <td>Art. 6 Abs. 1 lit. a DSGVO – deine Einwilligung, jederzeit widerrufbar,
        indem du die Angabe löschst</td></tr>
<tr><td>Push-Benachrichtigungen</td>
    <td>Art. 6 Abs. 1 lit. a DSGVO – die Erlaubnis erteilst du im Browser</td></tr>
<tr><td>Begrenzung der Anmeldeversuche, Protokoll des Webservers</td>
    <td>Art. 6 Abs. 1 lit. f DSGVO – berechtigtes Interesse an einem Betrieb, der
        nicht überrannt wird</td></tr>
</table>

<h2>Wer was von dir zu sehen bekommt</h2>
<p>Das ist der Abschnitt, der in einer App unter Freunden am ehesten überrascht.</p>
<ul>
<li><strong>Deine Nachrichten, Bilder und Dateien</strong> sehen die Mitglieder des
jeweiligen Chats. Dafür sind sie da.</li>
<li><strong>Dein Profil ist für alle Konten sichtbar</strong>, nicht nur für deine
Chatpartner: Wer deinen Namen kennt, findet dich über die Personensuche und sieht
Anzeigename, Bild, Kurzbeschreibung und wann du zuletzt da warst.</li>
<li><strong>Dein Online-Status</strong> wird jedem gemeldet, mit dem du mindestens
einen Chat teilst – automatisch, sobald die App eine Verbindung hat.</li>
<li><strong>Dein Lesestand</strong> geht an alle Mitglieder eines Chats, sobald du
den Verlauf bis unten gelesen hast. Beides lässt sich derzeit nicht abschalten.</li>
<li><strong>Deine Zahlungsangaben sieht jeder</strong>, mit dem du mindestens eine
Ausgabengruppe teilst – dafür sind sie gedacht, aber es ist gut, es zu wissen,
bevor man eine IBAN einträgt.</li>
<li><strong>In einer „anonymen“ Umfrage</strong> wird deine Stimme dem Konto
zugeordnet gespeichert. Die App zeigt sie den anderen nicht, aber sie ist in der
Datenbank vorhanden – „anonym“ heisst hier <em>nicht sichtbar</em>, nicht
<em>nicht gespeichert</em>.</li>
</ul>

<h2>Bilder und Dateien: die Adresse ist der Schlüssel</h2>
<p>Ein Anhang bekommt eine sehr lange Zufallsadresse und ist unter dieser Adresse
<strong>ohne Anmeldung</strong> abrufbar. Das ist Absicht – nur so lassen sich
Bilder im Chat, Vorschauen und das Teilen mit dem Betriebssystem zuverlässig
anzeigen. Die Folge: <em>Wer die Adresse hat, hat die Datei.</em> Erraten lässt sie
sich nicht, aber weitergegeben werden kann sie.</p>
<p class="merk"><strong>Zwei Dinge, die du wissen solltest.</strong> Fotos werden
vor dem Senden neu berechnet; dabei fallen die eingebetteten Zusatzdaten weg,
einschliesslich des Aufnahmeorts. <strong>Videos gehen unverändert auf den
Server</strong> – mit allem, was die Kamera hineingeschrieben hat, unter Umständen
auch GPS-Koordinaten. Und wenn du eine Nachricht „für alle löschst“, verschwindet
sie aus der App und aus der Datenbank; die Datei selbst bleibt vorerst im Speicher
liegen. Beides ist bekannt und soll behoben werden.</p>

<h2>Was der Server mitschreibt</h2>
<p>Jeder Aufruf hinterlässt eine Zeile im Protokoll des Webservers: Zeitpunkt,
aufgerufene Adresse, Antwortcode, Browserkennung und die IP-Adresse. Das ist
nötig, um Störungen und Angriffe überhaupt bemerken zu können. Die Protokolle
werden nach Grösse umgewälzt und dabei nach spätestens sieben Tagen gelöscht.</p>
<p>Getrennt davon zählt die App Anmeldeversuche je IP-Adresse, um Passwortraten zu
bremsen. Diese Zähler stehen nur im Arbeitsspeicher, laufen nach Minuten ab und
werden nirgends gespeichert.</p>

<h2>Wo die Daten liegen</h2>
<p>{hosting}</p>
<p>Hochgeladene Dateien liegen {dateien}. {verschluesselt}</p>
<p>{drittland}</p>

<h2>Push-Benachrichtigungen</h2>
<p>Sie sind {push}.</p>
<p>Wenn du sie erlaubst, läuft die Zustellung technisch bedingt über den Push-Dienst
des Herstellers deines Browsers (Google, Mozilla oder Apple). Der <strong>Inhalt ist
dabei verschlüsselt</strong> und für den Dienst nicht lesbar – er sieht nur, dass
etwas für dein Gerät vorliegt. Diese Dienste sitzen zum Teil in den USA, also
ausserhalb der EU; es entstehen dort Metadaten darüber, wann für dein Gerät etwas
anliegt. Welchen Dienst dein Gerät benutzt, entscheidet dein Browser, nicht wir –
wir haben mit ihnen keinen Vertrag und können auch keinen schliessen. Grundlage ist
deine Einwilligung (Art. 6 Abs. 1 lit. a, Art. 49 Abs. 1 lit. a DSGVO). Du kannst
sie jederzeit in den Einstellungen zurücknehmen.</p>

<h2>Kalender-Abo</h2>
<p>Wenn du die Kalender-Adresse in Google Kalender, iCloud oder Outlook einträgst,
holt <strong>deren Server</strong> die Termine regelmässig bei uns ab – mit Titel,
Beschreibung, Ort und Zeit. Die Adresse enthält eine geheime Kennung und ist ohne
Anmeldung abrufbar, damit Kalenderprogramme überhaupt damit umgehen können. Wer sie
weitergibt, gibt seinen Kalender weiter. Du kannst sie in den Einstellungen neu
erzeugen lassen.</p>

<h2>Was auf deinem Gerät bleibt</h2>
<p>Die App legt in deinem Browser ab: den Anmelde-Token, deine noch nicht gesendeten
Nachrichten, einen Zwischenspeicher der Chats für den Betrieb ohne Netz, deine
Einstellungen – und <strong>jedes Bild und Video, das du angesehen hast</strong>.
Dieser Medienspeicher hat keine Obergrenze; er wächst, solange du angemeldet bleibst.
Geleert wird er beim Abmelden und mit „Offline-Daten löschen“ in den Einstellungen.</p>
<p>Das alles ist für den Dienst erforderlich, den du angefordert hast – deshalb gibt
es hier kein Einwilligungsbanner. Ein Tracker, für den man eines bräuchte, ist nicht
vorhanden.</p>

<h2>Die Modelle für Bildbearbeitung</h2>
<p>Freistellen und Tiefenschärfe im Foto-Editor benutzen kleine KI-Modelle. Sie
werden von <strong>unserem eigenen Server</strong> geladen – nicht von einem fremden
Dienst – und rechnen danach vollständig <strong>in deinem Gerät</strong>. Deine
Bilder verlassen es dabei nicht; es werden keine Bilddaten an uns oder an Dritte
gesendet. Jedes Modell ist einzeln abschaltbar und die grösseren sind von Haus aus
aus, weil sie beim ersten Benutzen einen Download kosten.</p>

<h2>Was andere über dich eintragen</h2>
<p>Nicht alles, was hier über dich steht, kommt von dir. Wer dich in eine Gruppe
holt, dich bei einer Ausgabe als Beteiligten einträgt oder dich zu einem Termin
einlädt, legt damit Daten über dich an, die wir nicht bei dir erhoben haben
(Art. 14 DSGVO). Du siehst all das in der App und kannst dort widersprechen, es
ändern lassen oder die Gruppe verlassen.</p>

<h2>Deine Rechte</h2>
<p>Du kannst Auskunft verlangen (Art. 15), deine Daten mitnehmen (Art. 20), sie
berichtigen (Art. 16) oder löschen lassen (Art. 17), die Verarbeitung einschränken
(Art. 18) und der Verarbeitung widersprechen (Art. 21).</p>
<p><strong>Zwei davon erledigst du selbst, sofort</strong>, unter
Profil → Einstellungen → Deine Daten: <em>Meine Daten herunterladen</em> gibt dir
alles als Datei, <em>Konto löschen</em> löscht es. Für alles Übrige genügt eine
Nachricht an die oben genannte Adresse.</p>

<h2>Widerspruchsrecht (Art. 21 DSGVO)</h2>
<p>Gegen die Verarbeitung, die wir auf ein berechtigtes Interesse stützen – das sind
die Begrenzung der Anmeldeversuche und die Protokolle des Webservers –, kannst du
jederzeit Widerspruch einlegen, aus Gründen, die sich aus deiner besonderen Situation
ergeben.</p>

<h2>Beschwerderecht (Art. 77 DSGVO)</h2>
<p>Du kannst dich bei jeder Datenschutz-Aufsichtsbehörde beschweren, insbesondere bei
der deines Wohnorts. Für uns zuständig ist:</p>
<p>Der Hessische Beauftragte für Datenschutz und Informationsfreiheit<br>
Postfach 31 63, 65021 Wiesbaden<br>
Hausanschrift: Gustav-Stresemann-Ring 1, 65189 Wiesbaden<br>
Telefon: +49 611 1408-0<br>
E-Mail: poststelle@datenschutz.hessen.de</p>

<h2>Automatisierte Entscheidungen</h2>
<p>Es findet keine automatisierte Entscheidungsfindung im Sinne des Art. 22 DSGVO
statt und es wird kein Profiling betrieben. Die App bewertet dich nicht und legt kein
Profil deines Verhaltens an. Automatisch läuft hier nur Handwerk: Eine Bremse zählt
Anmeldeversuche, Ausgaben werden auf Wunsch gleichmässig geteilt, und ein
Push-Abonnement wird nach mehreren Fehlversuchen entfernt.</p>

<h2>Was beim Löschen geschieht</h2>
<p>Dein Konto und alles, was daran hängt, wird entfernt. Was du in Chats geschrieben
hast, bleibt bei den anderen stehen, aber ohne deinen Namen – sonst rissen deine
Nachrichten Löcher in fremde Gespräche. Wenn du auch deine Texte entfernt haben
willst, lösche sie vorher im Chat.</p>

<h2>Verwendete fremde Software</h2>
<p>Diese App benutzt Bibliotheken, Rechenwerke und Modelle von anderen. Welche das
sind, mit Rechteinhaber und Lizenz, steht in der App unter
<em>Profil → Einstellungen → Über → Verwendete Software</em>.</p>"##,
        name = a.name,
        anschrift = a.anschrift,
        email = a.email,
    );
    rahmen("Datenschutz", &inhalt)
}
