//! Die Datenschutzerklärung – als Seite, nicht als Anhang.
//!
//! Sie liegt beim Server und nicht in der PWA, damit sie auch ohne Anmeldung
//! und ohne installierte App erreichbar ist. Wer wissen will, was mit seinen
//! Daten geschieht, soll dafür nicht erst ein Konto anlegen müssen.
//!
//! Der Text ist bewusst schlicht gehalten und nennt die Dinge beim Namen. Eine
//! Erklärung, die niemand liest, erfüllt Art. 13 DSGVO dem Buchstaben nach und
//! ihrem Zweck nach überhaupt nicht.
//!
//! **Betreiberangaben füllt die Konfiguration**: `OPERATOR_NAME`,
//! `OPERATOR_ADDRESS` und `OPERATOR_EMAIL`. Fehlen sie, sagt die Seite das
//! deutlich, statt eine Lücke zu verstecken.

use axum::extract::State;
use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/datenschutz", get(seite))
}

async fn seite(State(state): State<AppState>) -> Response {
    let betreiber = state.config.operator.as_ref();
    let name = betreiber
        .map(|angaben| angaben.name.as_str())
        .unwrap_or("— noch nicht eingetragen —");
    let anschrift = betreiber
        .and_then(|angaben| angaben.address.as_deref())
        .unwrap_or("— noch nicht eingetragen —");
    let email = betreiber
        .map(|angaben| angaben.email.as_str())
        .unwrap_or("— noch nicht eingetragen —");

    let fehlt = betreiber.is_none();
    let warnung = if fehlt {
        r#"<p class="warn">Diese Seite ist noch unvollständig: Es fehlen Name, Anschrift und
        E-Mail des Betreibers. Ohne sie erfüllt sie Artikel 13 der Datenschutz-Grundverordnung
        nicht. Zu setzen als <code>OPERATOR_NAME</code>, <code>OPERATOR_ADDRESS</code> und
        <code>OPERATOR_EMAIL</code>.</p>"#
    } else {
        ""
    };

    let html = format!(
        r##"<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Datenschutz – Initiative</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         line-height: 1.6; max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }}
  h1 {{ font-size: 1.6rem; }}
  h2 {{ font-size: 1.15rem; margin-top: 2.2rem; }}
  code {{ background: rgba(127,127,127,.18); padding: .1em .35em; border-radius: .25em; }}
  .warn {{ background: rgba(220,38,38,.12); border-left: 3px solid #dc2626;
           padding: .75rem 1rem; border-radius: .3rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
  th, td {{ text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(127,127,127,.3);
            vertical-align: top; font-size: .95rem; }}
  .muted {{ opacity: .75; font-size: .9rem; }}
</style>
</head>
<body>
<h1>Datenschutz</h1>
{warnung}

<h2>Wer verantwortlich ist</h2>
<p>{name}<br>{anschrift}<br>{email}</p>

<h2>Worum es hier geht</h2>
<p>Initiative ist eine private App für einen kleinen Kreis. Es gibt <strong>keine
Werbung, keine Analyse-Werkzeuge, kein Tracking</strong> und keine Weitergabe an Dritte
zu Werbezwecken. Es wird nichts gespeichert, was die App nicht zum Funktionieren
braucht.</p>

<h2>Was gespeichert wird</h2>
<table>
<tr><th>Was</th><th>Wozu</th><th>Wie lange</th></tr>
<tr><td>Benutzername, Anzeigename, Passwort (nur als Prüfwert, nie im Klartext)</td>
    <td>Damit du dich anmelden kannst und andere dich erkennen</td>
    <td>Bis du dein Konto löschst</td></tr>
<tr><td>Nachrichten, Bilder, Dateien, Termine, Ausgaben</td>
    <td>Das ist der Dienst selbst</td>
    <td>Bis du sie löschst oder dein Konto</td></tr>
<tr><td>Anmelde-Sitzungen (Gerät, Zeitpunkt)</td>
    <td>Damit du angemeldet bleibst und Sitzungen beenden kannst</td>
    <td>60 Tage ohne Nutzung</td></tr>
<tr><td>Push-Abonnement (Adresse beim Browserhersteller, Schlüssel, Gerätekennung)</td>
    <td>Nur wenn du Benachrichtigungen erlaubst</td>
    <td>Bis du sie abschaltest</td></tr>
</table>

<h2>Wo die Daten liegen</h2>
<p>Der Server läuft bei <strong>Fly.io</strong> in Frankfurt, die Datenbank bei
<strong>Neon</strong>, hochgeladene Dateien bei <strong>Cloudflare R2</strong>, die
App selbst wird über <strong>Vercel</strong> ausgeliefert. Alle vier sind
Auftragsverarbeiter; mit allen bestehen die dafür vorgesehenen Verträge. Es sind
US-Unternehmen; die Übermittlung stützt sich auf ihre Zertifizierung im
EU-US Data Privacy Framework und auf Standardvertragsklauseln.</p>

<h2>Push-Benachrichtigungen</h2>
<p>Wenn du sie erlaubst, läuft die Zustellung technisch bedingt über den
Push-Dienst deines Browserherstellers (Google, Mozilla oder Apple). Der
<strong>Inhalt ist dabei verschlüsselt</strong> und für den Dienst nicht lesbar –
er sieht nur, dass etwas für dein Gerät da ist. Du kannst das jederzeit in den
Einstellungen abschalten.</p>

<h2>Was auf deinem Gerät bleibt</h2>
<p>Die App legt in deinem Browser ab: den Anmelde-Token, deine noch nicht
gesendeten Nachrichten, einen Zwischenspeicher der Chats für den Betrieb ohne
Netz, und ein paar Einstellungen wie das Farbschema. Das alles ist für den
Dienst erforderlich, den du angefordert hast – deshalb gibt es hier kein
Einwilligungsbanner. Ein Tracker, für den man eines bräuchte, ist nicht
vorhanden.</p>

<h2>Deine Rechte</h2>
<p>Du kannst Auskunft verlangen, deine Daten mitnehmen, sie berichtigen oder
löschen lassen, der Verarbeitung widersprechen und dich bei einer
Datenschutz-Aufsichtsbehörde beschweren.</p>
<p><strong>Zwei davon erledigst du selbst, sofort</strong>, unter
Profil → Einstellungen → Deine Daten: <em>Meine Daten herunterladen</em> gibt dir
alles als Datei, <em>Konto löschen</em> löscht es. Für alles Übrige genügt eine
Nachricht an die oben genannte Adresse.</p>

<h2>Was beim Löschen geschieht</h2>
<p>Dein Konto und alles, was daran hängt, wird entfernt. Was du in Chats
geschrieben hast, bleibt bei den anderen stehen, aber ohne deinen Namen – sonst
rissen deine Nachrichten Löcher in fremde Gespräche. Wenn du auch deine Texte
entfernt haben willst, lösche sie vorher im Chat.</p>

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
