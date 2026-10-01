//! Einladen: eine Einladung, mehrere Karten – und wer eingeladen ist, steht
//! allein in der Teilnehmerliste.
//!
//! Die Regeln, die hier geprüft werden:
//!
//!   * **Wer den Termin sieht**: der Ersteller und jede Person mit
//!     Teilnehmerzeile. Ein Chat, in dem eine Karte steht, verleiht nichts.
//!   * **Wohin die Einladung geht**: Einzelkarten für alle Eingeladenen, die
//!     Gruppenkarte nur in einen ausdrücklich gewählten Gruppenchat, in dem
//!     ALLE Mitglieder eingeladen sind.
//!   * **Synchron**: Eine Zusage gilt in allen Karten, und der Rundruf trägt
//!     einen Stand, an dem man die neuere Fassung erkennt.
//!   * **Eine Mitteilung je Person**, nicht eine je Karte.
//!   * **Rückwärtsverträglich**: Anfragen ohne `zustellung` verhalten sich wie
//!     vorher.
//!
//! Die Mitteilungen werden nicht gesendet, sondern am Ausgang mitgeschrieben
//! (`PushService::mitschneiden`): Im Entwicklungsbetrieb gibt es keine
//! VAPID-Schlüssel, und am Bildschirm eines Geräts lässt sich nicht zählen,
//! wem wie viele Mitteilungen gingen.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::push::Mitschnitt;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
    state: AppState,
    push: Mitschnitt,
}

/// Schliesst den Verbindungsvorrat, wenn der Test zu Ende ist.
///
/// Ohne das behält jeder Test seine Verbindungen bis zum Ende des ganzen Laufs;
/// bei gut dreissig Tests ist dann der Datenbankserver voll, und die letzten
/// scheitern mit „Interner Serverfehler“ schon bei der Registrierung.
impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

struct Konto {
    token: String,
    id: String,
    name: String,
}

impl Konto {
    fn uuid(&self) -> Uuid {
        self.id.parse().unwrap()
    }
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Wie `call`, aber mit dem Körper als Text – für das Kalender-Abo, das
    /// kein JSON ist.
    async fn text(&self, uri: &str, token: Option<&str>) -> (StatusCode, String) {
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    /// Das Kalender-Abo eines Kontos als Text.
    async fn abo(&self, wer: &Konto) -> String {
        let (_, ich) = self
            .call("GET", "/api/v1/auth/me", Some(&wer.token), None)
            .await;
        let (status, text) = self
            .text(
                &format!(
                    "/api/v1/calendar/{}/feed.ics",
                    ich["calendarToken"].as_str().unwrap()
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{text}");
        text
    }

    async fn konto(&self, name: &str) -> Konto {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().to_string(),
            name: name.to_string(),
        }
    }

    /// Ein Gruppenchat; `inhaber` gründet und ist Owner.
    async fn gruppe(&self, inhaber: &Konto, titel: &str, mitglieder: &[&Konto]) -> String {
        let ids: Vec<&str> = mitglieder.iter().map(|konto| konto.id.as_str()).collect();
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(&inhaber.token),
                Some(json!({ "type": "group", "title": titel, "memberIds": ids })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    /// Der Einzelchat zwischen zwei Konten (angelegt oder vorhanden).
    async fn einzel(&self, von: &Konto, mit: &Konto) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(&von.token),
                Some(json!({ "type": "direct", "memberIds": [mit.id] })),
            )
            .await;
        assert!(status.is_success(), "{status}: {chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn termin(&self, von: &Konto, body: Value) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/calendar/events",
            Some(&von.token),
            Some(body),
        )
        .await
    }

    /// Ein Termin mit Vorgaben für Titel und Zeit; der Rest kommt von `zusatz`.
    async fn termin_mit(&self, von: &Konto, zusatz: Value) -> Value {
        let (status, termin) = self.termin(von, koerper(zusatz)).await;
        assert_eq!(status, StatusCode::CREATED, "{termin}");
        termin
    }

    async fn rsvp(&self, wer: &Konto, termin: &str, status: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("/api/v1/calendar/events/{termin}/rsvp"),
            Some(&wer.token),
            Some(json!({ "status": status })),
        )
        .await
    }

    async fn holen(&self, wer: &Konto, termin: &str) -> (StatusCode, Value) {
        self.call(
            "GET",
            &format!("/api/v1/calendar/events/{termin}"),
            Some(&wer.token),
            None,
        )
        .await
    }

    async fn aendern(&self, wer: &Konto, termin: &str, body: Value) -> (StatusCode, Value) {
        self.call(
            "PATCH",
            &format!("/api/v1/calendar/events/{termin}"),
            Some(&wer.token),
            Some(body),
        )
        .await
    }

    /// Alle Nachrichten eines Chats aus Sicht eines Kontos.
    async fn nachrichten(&self, wer: &Konto, chat: &str) -> Vec<Value> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"].as_array().cloned().unwrap_or_default()
    }

    /// Die (nicht gelöschten) Karten zu einem Termin in einem Chat.
    async fn karten(&self, wer: &Konto, chat: &str, termin: &str) -> Vec<Value> {
        self.nachrichten(wer, chat)
            .await
            .into_iter()
            .filter(|nachricht| {
                nachricht["type"] == "event"
                    && nachricht["deletedAt"].is_null()
                    && nachricht["metadata"]["eventId"] == termin
            })
            .collect()
    }

    /// Alle Karten eines Termins laut Tabelle: (Art, Chat, hat Nachricht).
    async fn platzierungen(&self, termin: &str) -> Vec<(String, String, bool)> {
        let id: Uuid = termin.parse().unwrap();
        let zeilen: Vec<(String, Uuid, Option<Uuid>)> = sqlx::query_as(
            "select art, conversation_id, message_id from event_placements
              where event_id = $1 order by created_at, id",
        )
        .bind(id)
        .fetch_all(&self.state.pool)
        .await
        .unwrap();
        zeilen
            .into_iter()
            .map(|(art, chat, nachricht)| (art, chat.to_string(), nachricht.is_some()))
            .collect()
    }

    /// Der Chat einer Karte, die als Einzelkarte an diese Person ging.
    async fn einzelkarten_chat(&self, termin: &str, person: &Konto) -> Option<String> {
        let id: Uuid = termin.parse().unwrap();
        sqlx::query_scalar::<_, Uuid>(
            "select conversation_id from event_placements
              where event_id = $1 and art = 'einzel' and user_id = $2",
        )
        .bind(id)
        .bind(person.uuid())
        .fetch_optional(&self.state.pool)
        .await
        .unwrap()
        .map(|chat| chat.to_string())
    }

    /// Ab jetzt mithören, was dieses Konto über den Rundruf bekommt.
    fn hoeren(&self, wer: &Konto) -> Hoerer {
        let (_, empfaenger, _) = self.state.hub.register(wer.uuid());
        Hoerer { empfaenger }
    }

    fn push_leeren(&self) {
        self.push.lock().unwrap().clear();
    }

    /// Was an dieses Konto gegangen wäre, nur Termin-Mitteilungen.
    fn push_an(&self, wer: &Konto) -> Vec<Value> {
        self.push
            .lock()
            .unwrap()
            .iter()
            .filter(|(person, _)| *person == wer.uuid())
            .map(|(_, payload)| serde_json::to_value(payload).unwrap())
            .collect()
    }

    fn push_anzahl(&self) -> usize {
        self.push.lock().unwrap().len()
    }
}

struct Hoerer {
    empfaenger: UnboundedReceiver<String>,
}

impl Hoerer {
    /// Alles, was seit dem letzten Mal angekommen ist.
    fn alles(&mut self) -> Vec<Value> {
        let mut gesammelt = Vec::new();
        while let Ok(rahmen) = self.empfaenger.try_recv() {
            gesammelt.push(serde_json::from_str(&rahmen).unwrap());
        }
        gesammelt
    }

    fn vom_typ(&mut self, art: &str) -> Vec<Value> {
        self.alles()
            .into_iter()
            .filter(|rahmen| rahmen["type"] == art)
            .collect()
    }
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    // Jeder Test baut seinen eigenen Zustand samt Verbindungsvorrat. Bei gut
    // zwanzig Tests nebeneinander sprengten zehn Verbindungen je Test die
    // hundert des Datenbankservers – und der Fehler zeigte sich als „Interner
    // Serverfehler“ bei der Registrierung, nicht als das, was er war.
    std::env::set_var("DATABASE_POOL_MAX", "4");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/einladen-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let push = state.push.mitschneiden();
    Some(Probe {
        router: app::build(state.clone()),
        state,
        push,
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

/// Titel und Zeit vorgegeben, der Rest aus `zusatz`.
fn koerper(zusatz: Value) -> Value {
    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let mut basis = json!({
        "title": "Grillen",
        "startsAt": beginn,
        "endsAt": beginn + chrono::Duration::hours(2),
    });
    for (schluessel, wert) in zusatz.as_object().cloned().unwrap_or_default() {
        basis[schluessel] = wert;
    }
    basis
}

fn ids(konten: &[&Konto]) -> Vec<String> {
    konten.iter().map(|konto| konto.id.clone()).collect()
}

fn status_von(termin: &Value, konto: &Konto) -> String {
    termin["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|teilnehmer| teilnehmer["userId"] == konto.id.as_str())
        .unwrap_or_else(|| panic!("{} fehlt unter den Teilnehmern: {termin}", konto.name))["status"]
        .as_str()
        .unwrap()
        .to_string()
}

fn ist_teilnehmer(termin: &Value, konto: &Konto) -> bool {
    termin["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .any(|teilnehmer| teilnehmer["userId"] == konto.id.as_str())
}

// ---------------------------------------------------------------------------
// Wohin die Einladung geht
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn alle_mitglieder_eingeladen_gruppenkarte_und_einzelkarten() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Skatrunde", &[&b, &c]).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "senden": true, "einzelchats": true, "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();

    // Der Termin selbst steht oben, wie bisher …
    assert_eq!(termin["conversationId"], g.as_str(), "{termin}");
    assert_eq!(termin["attendees"].as_array().unwrap().len(), 3);
    // … und darunter, was daraus geworden ist.
    let z = &termin["zustellung"];
    assert_eq!(z["gruppen"].as_array().unwrap().len(), 1, "{z}");
    assert_eq!(z["gruppen"][0]["conversationId"], g.as_str());
    assert!(z["gruppen"][0]["nachrichtId"].is_string(), "{z}");
    assert_eq!(z["einzelchats"], 2, "{z}");
    assert_eq!(
        z["neueEinzelchats"], 2,
        "es gab noch keine Einzelchats: {z}"
    );
    assert!(z["ausgelassen"].as_array().unwrap().is_empty(), "{z}");
    assert_eq!(z["ausstehend"], 0, "{z}");

    // Je EINE Karte: im Gruppenchat und in beiden Einzelchats.
    assert_eq!(probe.karten(&a, &g, id).await.len(), 1);
    let ab = probe
        .einzelkarten_chat(id, &b)
        .await
        .expect("Einzelkarte B");
    let ac = probe
        .einzelkarten_chat(id, &c)
        .await
        .expect("Einzelkarte C");
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    assert_eq!(probe.karten(&a, &ac, id).await.len(), 1);
    // Und der Eingeladene sieht seine Karte mit dem Termin darin.
    let karte_b = probe.karten(&b, &ab, id).await;
    assert_eq!(karte_b.len(), 1);
    assert_eq!(karte_b[0]["event"]["title"], "Grillen");

    // Die Tabelle kennt alle drei, jede mit Nachricht.
    let zeilen = probe.platzierungen(id).await;
    assert_eq!(zeilen.len(), 3, "{zeilen:?}");
    assert!(zeilen.iter().all(|(_, _, hat)| *hat), "{zeilen:?}");
    assert_eq!(
        zeilen.iter().filter(|(art, _, _)| art == "gruppe").count(),
        1
    );
    assert_eq!(
        zeilen.iter().filter(|(art, _, _)| art == "einzel").count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn nicht_alle_eingeladen_nur_einzelkarten() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Hütte", &[&b, &c]).await;

    // Cleo fehlt: Die Gruppe ist gewünscht, aber nicht vollständig.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let z = &termin["zustellung"];

    assert!(z["gruppen"].as_array().unwrap().is_empty(), "{z}");
    assert_eq!(z["ausgelassen"].as_array().unwrap().len(), 1, "{z}");
    assert_eq!(z["ausgelassen"][0]["conversationId"], g.as_str());
    assert_eq!(z["ausgelassen"][0]["fehlend"][0], c.id.as_str(), "{z}");
    assert_eq!(z["einzelchats"], 1);
    assert!(
        termin["conversationId"].is_null(),
        "ohne Gruppenkarte gehört der Termin keinem Chat: {termin}"
    );

    assert!(
        probe.karten(&a, &g, id).await.is_empty(),
        "G bekommt nichts"
    );
    let ab = probe
        .einzelkarten_chat(id, &b)
        .await
        .expect("Einzelkarte B");
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    assert!(probe.einzelkarten_chat(id, &c).await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn alle_waehlen_postet_in_keinen_gruppenchat() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g1 = probe.gruppe(&a, "Eins", &[&b, &c]).await;
    let g2 = probe.gruppe(&a, "Zwei", &[&b, &d]).await;

    // „Alle“: Alle Kontakte sind eingeladen, darunter vollständig die Mitglieder
    // beider Gruppen – und trotzdem kommt nirgends eine Gruppenkarte, weil keine
    // Gruppe ausdrücklich gewählt wurde.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c, &d]),
                "zustellung": { "gruppenChatIds": [] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();

    assert!(probe.karten(&a, &g1, id).await.is_empty());
    assert!(probe.karten(&a, &g2, id).await.is_empty());
    assert_eq!(termin["zustellung"]["einzelchats"], 3);
    assert!(termin["conversationId"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn einzelchats_werden_angelegt_oder_wiederverwendet() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let e = probe.konto(&format!("emil{n}")).await;

    // B: ein vorhandener Einzelchat, den B archiviert hat – er zählt trotzdem.
    let ab = probe.einzel(&a, &b).await;
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{ab}"),
            Some(&b.token),
            Some(json!({ "archived": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // D: zwei Einzelchats mit A (gleichzeitiges Anlegen) – der älteste gilt.
    let ad_alt = probe.einzel(&a, &d).await;
    let ad_neu = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, created_by) values ($1, 'direct', $2)")
        .bind(ad_neu)
        .bind(a.uuid())
        .execute(&probe.state.pool)
        .await
        .unwrap();
    for person in [a.uuid(), d.uuid()] {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'member')",
        )
        .bind(ad_neu)
        .bind(person)
        .execute(&probe.state.pool)
        .await
        .unwrap();
    }

    // E: nur ein Einzelchat, den E verlassen hat (ein Mitglied) – zählt nicht.
    let ae_halb = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, created_by) values ($1, 'direct', $2)")
        .bind(ae_halb)
        .bind(a.uuid())
        .execute(&probe.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "insert into conversation_members (conversation_id, user_id, role) values ($1, $2, 'owner')",
    )
    .bind(ae_halb)
    .bind(a.uuid())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    let mut hoerer_c = probe.hoeren(&c);
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c, &d, &e]),
                "zustellung": {}
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let z = &termin["zustellung"];
    assert_eq!(z["einzelchats"], 4, "{z}");
    assert_eq!(z["neueEinzelchats"], 2, "nur C und E waren neu: {z}");

    assert_eq!(
        probe.einzelkarten_chat(id, &b).await.unwrap(),
        ab,
        "archiviert, aber genutzt"
    );
    assert_eq!(
        probe.einzelkarten_chat(id, &d).await.unwrap(),
        ad_alt.as_str(),
        "der älteste"
    );
    let ae = probe.einzelkarten_chat(id, &e).await.unwrap();
    assert_ne!(
        ae,
        ae_halb.to_string(),
        "ein Chat mit einem Mitglied zählt nicht"
    );

    // Der neue Chat steht in der Liste beider Seiten …
    let (_, liste_c) = probe
        .call("GET", "/api/v1/conversations", Some(&c.token), None)
        .await;
    let ac = probe.einzelkarten_chat(id, &c).await.unwrap();
    assert!(
        liste_c["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chat| chat["id"] == ac.as_str()),
        "C sieht den neuen Chat: {liste_c}"
    );
    // … hat `sieht_ab` gesetzt wie jeder neue Chat …
    let ohne_grenze: i64 = sqlx::query_scalar(
        "select count(*) from conversation_members where conversation_id = $1 and sieht_ab is null",
    )
    .bind(ac.parse::<Uuid>().unwrap())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(ohne_grenze, 0);
    // … und C wurde über den Rundruf darauf gestoßen.
    let rundruf = hoerer_c.alles();
    assert!(
        rundruf.iter().any(|r| r["type"] == "conversation.updated"
            && r["payload"]["conversation"]["id"] == ac.as_str()),
        "C hätte den neuen Chat gemeldet bekommen müssen: {rundruf:?}"
    );
}

// ---------------------------------------------------------------------------
// Wer den Termin sieht
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn wer_nicht_eingeladen_ist_sieht_nichts() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Alle", &[&b, &c, &d]).await;

    // Dora sitzt im Gruppenchat, ist aber nicht eingeladen. Die Gruppe ist
    // deshalb nicht gewählt – der Termin steht nur in den Einzelchats.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    assert!(probe.karten(&a, &g, id).await.is_empty());

    let mut hoerer_d = probe.hoeren(&d);

    // Detail, Zusage, Notizen, Dokumente, Vorkommen: nichts davon öffnet sich.
    let (status, _) = probe.holen(&d, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "Detail");
    let (status, _) = probe.rsvp(&d, id, "yes").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "Zusage");
    for pfad in ["notes", "documents", "occurrences"] {
        let (status, antwort) = probe
            .call(
                "GET",
                &format!("/api/v1/calendar/events/{id}/{pfad}"),
                Some(&d.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{pfad}: {antwort}");
    }
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{id}/notes"),
            Some(&d.token),
            Some(json!({ "title": "Mein Senf", "body": "…" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "Notiz schreiben");

    // Die Liste und das Kalender-Abo auch nicht.
    let (_, liste) = probe
        .call("GET", "/api/v1/calendar/events", Some(&d.token), None)
        .await;
    assert!(
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["id"] != id),
        "die Liste zeigt ihn nicht: {liste}"
    );
    // Der Inhalt des Abos, nicht nur sein Statuscode: Ein Abo, das den Termin
    // einem Nicht-Eingeladenen zeigte, würde genau die Kennung preisgeben, mit
    // der `event.ics` ohne Anmeldung abrufbar ist.
    let abo_dora = probe.abo(&d).await;
    assert!(
        !abo_dora.contains(id),
        "das Abo von Dora nennt den Termin nicht: {abo_dora}"
    );
    assert!(!abo_dora.contains("SUMMARY:Grillen"));
    let abo_anna = probe.abo(&a).await;
    assert!(abo_anna.contains(id), "das Abo des Erstellers nennt ihn");
    assert!(probe.abo(&b).await.contains(id), "und das der Eingeladenen");
    let (_, eigenes) = probe
        .call("GET", "/api/v1/calendar/events", Some(&a.token), None)
        .await;
    assert!(eigenes["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == id));

    // Dora bekommt auch keinen Rundruf zu diesem Termin.
    probe.rsvp(&b, id, "yes").await;
    assert!(
        hoerer_d.vom_typ("event.updated").is_empty(),
        "kein Rundruf an die Nicht-Eingeladene"
    );

    // Die Berechtigung hängt an der Teilnehmerzeile und an nichts sonst: Auch
    // das Datei-Zugriffsrecht „Termin“ (Unterlagen) folgt ihr.
    let zugriff: bool = sqlx::query_scalar(
        "select exists (
           select 1 from calendar_events e
            where e.id = $1 and (e.created_by = $2
               or exists (select 1 from event_attendees t where t.event_id = e.id and t.user_id = $2)))",
    )
    .bind(id.parse::<Uuid>().unwrap())
    .bind(d.uuid())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert!(!zugriff);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_karte_im_chat_zeigt_dem_nicht_eingeladenen_nichts() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &d]).await;

    // Alle drei eingeladen, die Gruppenkarte steht in G.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &d]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    assert_eq!(probe.karten(&d, &g, id).await.len(), 1);

    // Dora wird ausgeladen. Die Gruppenkarte BLEIBT – Bodo verliert sonst seine
    // einzige Karte –, zeigt Dora aber weder den Termin noch seine Kennung.
    let (status, _) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b]) }))
        .await;
    assert_eq!(status, StatusCode::OK);

    let karten_d: Vec<Value> = probe
        .nachrichten(&d, &g)
        .await
        .into_iter()
        .filter(|m| m["type"] == "event" && m["deletedAt"].is_null())
        .collect();
    assert_eq!(karten_d.len(), 1, "die Karte bleibt stehen");
    assert!(
        karten_d[0]["event"].is_null(),
        "kein Termin: {}",
        karten_d[0]
    );
    assert!(
        karten_d[0]["metadata"].get("eventId").is_none(),
        "und keine Kennung, mit der sich der Termin holen liesse: {}",
        karten_d[0]
    );
    // Bodo sieht sie unverändert.
    let karten_b = probe.karten(&b, &g, id).await;
    assert_eq!(karten_b.len(), 1);
    assert_eq!(karten_b[0]["event"]["title"], "Grillen");

    // Eine Karte, die erst danach in den Chat kommt (Beitritt in der Sekunde des
    // Sendens, eingeschleuste Karte), wird an Dora gekürzt ausgespielt.
    let mut hoerer_b = probe.hoeren(&b);
    let mut hoerer_d = probe.hoeren(&d);
    initiative_api::services::messages::create_message(
        &probe.state,
        initiative_api::services::messages::NewMessage::entity(
            uuid_von(&g),
            a.uuid(),
            "event",
            "eventId",
            uuid_von(id),
        ),
    )
    .await
    .unwrap();
    let an_b = hoerer_b.vom_typ("message.new");
    let an_d = hoerer_d.vom_typ("message.new");
    assert_eq!(an_b.len(), 1);
    assert_eq!(an_d.len(), 1);
    assert_eq!(an_b[0]["payload"]["message"]["event"]["title"], "Grillen");
    assert!(
        an_d[0]["payload"]["message"]["event"].is_null(),
        "Dora bekommt den Termin nicht über den Rundruf: {}",
        an_d[0]
    );
    assert!(
        an_d[0]["payload"]["message"]["metadata"]
            .get("eventId")
            .is_none(),
        "auch die Kennung nicht: {}",
        an_d[0]
    );
}

fn uuid_von(text: &str) -> Uuid {
    text.parse().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn eingeladene_ausserhalb_des_chats_koennen_oeffnen_und_zusagen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let x = probe.konto(&format!("xaver{n}")).await;
    let g = probe.gruppe(&a, "Zwei", &[&b]).await;

    // Xaver ist in keinem Chat mit Anna und Bodo – nur eingeladen.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &x]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();

    let (status, detail) = probe.holen(&x, id).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let (status, antwort) = probe.rsvp(&x, id, "yes").await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(status_von(&antwort, &x), "yes");
    for pfad in ["notes", "documents"] {
        let (status, antwort) = probe
            .call(
                "GET",
                &format!("/api/v1/calendar/events/{id}/{pfad}"),
                Some(&x.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{pfad}: {antwort}");
    }
    // Und er sieht den Termin in seiner Liste.
    let (_, liste) = probe
        .call("GET", "/api/v1/calendar/events", Some(&x.token), None)
        .await;
    assert!(liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == id));
}

// ---------------------------------------------------------------------------
// Synchron
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn eine_zusage_gilt_in_allen_karten_und_geht_an_alle_eingeladenen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Vier", &[&b, &c, &d]).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let stand_vorher = termin["stand"].as_i64().unwrap();
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    let ac = probe.einzelkarten_chat(id, &c).await.unwrap();
    let mut hoerer_a = probe.hoeren(&a);
    let mut hoerer_b = probe.hoeren(&b);
    let mut hoerer_c = probe.hoeren(&c);
    let mut hoerer_d = probe.hoeren(&d);

    // Bodo sagt in SEINER Karte zu.
    let (status, _) = probe.rsvp(&b, id, "yes").await;
    assert_eq!(status, StatusCode::OK);

    // Die Karte im anderen Einzelchat (frisch geladen) zeigt denselben Stand.
    let karte_ac = probe.karten(&c, &ac, id).await;
    assert_eq!(status_von(&karte_ac[0]["event"], &b), "yes");
    let karte_ab = probe.karten(&a, &ab, id).await;
    assert_eq!(status_von(&karte_ab[0]["event"], &b), "yes");
    assert_eq!(karte_ab[0]["event"]["stand"], karte_ac[0]["event"]["stand"]);

    // Der Rundruf ging an alle Eingeladenen – mit demselben, höheren Stand –
    // und nicht an Dora.
    let stand = |rahmen: &Value| rahmen["payload"]["event"]["stand"].as_i64().unwrap();
    let an_a = hoerer_a.vom_typ("event.updated");
    let an_b = hoerer_b.vom_typ("event.updated");
    let an_c = hoerer_c.vom_typ("event.updated");
    assert_eq!((an_a.len(), an_b.len(), an_c.len()), (1, 1, 1));
    assert_eq!(stand(&an_a[0]), stand(&an_b[0]));
    assert_eq!(stand(&an_a[0]), stand(&an_c[0]));
    assert!(
        stand(&an_a[0]) > stand_vorher,
        "der Stand steigt bei jeder Zusage"
    );
    assert!(hoerer_d.vom_typ("event.updated").is_empty());

    // Eine zweite Zusage zählt weiter hoch – auch wenn sich nichts Sichtbares
    // ändert, das `updated_at` der Zeile bleibt stehen.
    let erster = stand(&an_a[0]);
    probe.rsvp(&c, id, "maybe").await;
    let danach = hoerer_a.vom_typ("event.updated");
    assert_eq!(danach.len(), 1);
    assert!(stand(&danach[0]) > erster);

    let _ = g;
}

// ---------------------------------------------------------------------------
// Eine Mitteilung je Person
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ein_push_je_person() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &c]).await;
    probe.push_leeren();

    // Karte im Gruppenchat UND in den Einzelchats – aber je Person genau eine
    // Mitteilung, über den Einzelchat.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    assert_eq!(termin["zustellung"]["benachrichtigt"], 2);

    assert_eq!(
        probe.push_anzahl(),
        2,
        "nicht vier, nicht sechs: {:?}",
        probe.push_an(&b)
    );
    let an_b = probe.push_an(&b);
    assert_eq!(an_b.len(), 1);
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    assert_eq!(an_b[0]["kind"], "event");
    assert_eq!(an_b[0]["url"], format!("/chats/{ab}"));
    assert_eq!(an_b[0]["conversationId"], ab.as_str());
    assert_eq!(an_b[0]["tag"], format!("termin:{id}"));
    assert_eq!(an_b[0]["title"], a.name.as_str());
    assert_eq!(an_b[0]["body"], "📅 Einladung: Grillen");
    assert!(an_b[0]["messageId"].is_string(), "zeigt auf die Karte");
    assert!(
        probe
            .push
            .lock()
            .unwrap()
            .iter()
            .all(|(_, payload)| payload.kind == "event"),
        "keine Mitteilung pro Nachricht – die Karten sind stumm"
    );

    // Bodo schaltet den Einzelchat stumm: Die Mitteilung geht über den
    // Gruppenchat.
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{ab}"),
            Some(&b.token),
            Some(json!({ "mutedUntil": chrono::Utc::now() + chrono::Duration::hours(2) })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    probe.push_leeren();
    let zweiter = probe
        .termin_mit(
            &a,
            json!({
                "title": "Zweiter",
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let an_b = probe.push_an(&b);
    assert_eq!(an_b.len(), 1, "{an_b:?}");
    assert_eq!(
        an_b[0]["url"],
        format!("/chats/{g}"),
        "Ausweichen auf die Gruppe"
    );
    assert_eq!(zweiter["zustellung"]["benachrichtigt"], 2);

    // Ist auch die Gruppe stumm, kommt für Bodo keine – und Cleo behält ihre.
    probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{g}"),
            Some(&b.token),
            Some(json!({ "mutedUntil": chrono::Utc::now() + chrono::Duration::hours(2) })),
        )
        .await;
    probe.push_leeren();
    probe
        .termin_mit(
            &a,
            json!({
                "title": "Dritter",
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    assert!(probe.push_an(&b).is_empty(), "alles stumm, also nichts");
    assert_eq!(probe.push_an(&c).len(), 1);

    // Ohne Einzelkarten läuft die Mitteilung über die Gruppe.
    probe.push_leeren();
    probe
        .termin_mit(
            &a,
            json!({
                "title": "Vierter",
                "attendeeIds": ids(&[&c]),
                "zustellung": { "einzelchats": false, "gruppenChatIds": [] }
            }),
        )
        .await;
    assert!(
        probe.push_an(&c).is_empty(),
        "weder Einzelkarte noch Gruppe: keine Karte, keine Einladungs-Mitteilung"
    );

    // Nur Gruppe: C bekommt sie über den Gruppenchat (B hat ihn stumm).
    let fuenfter = probe
        .termin_mit(
            &a,
            json!({
                "title": "Fünfter",
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "einzelchats": false, "gruppenChatIds": [g] }
            }),
        )
        .await;
    let an_c = probe.push_an(&c);
    assert_eq!(an_c.len(), 1);
    assert_eq!(an_c[0]["url"], format!("/chats/{g}"));
    assert_eq!(fuenfter["zustellung"]["einzelchats"], 0);

    // senden = false: niemand bekommt etwas – weder Karte noch Mitteilung.
    probe.push_leeren();
    let still = probe
        .termin_mit(
            &a,
            json!({
                "title": "Sechster",
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "senden": false, "gruppenChatIds": [g] }
            }),
        )
        .await;
    assert_eq!(probe.push_anzahl(), 0);
    assert_eq!(still["zustellung"]["einzelchats"], 0);
    assert!(still["zustellung"]["gruppen"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(probe
        .platzierungen(still["id"].as_str().unwrap())
        .await
        .is_empty());
    // Sie stehen trotzdem im Kalender: Eingeladen heisst nicht „angeschrieben“.
    assert!(ist_teilnehmer(&still, &b));
    assert!(ist_teilnehmer(&still, &c));
}

// ---------------------------------------------------------------------------
// Nachträglich einladen, ausladen, ändern, absagen, löschen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn nachtraeglich_einladen_liefert_nur_an_die_neuen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;

    let termin = probe
        .termin_mit(&a, json!({ "attendeeIds": ids(&[&b]), "zustellung": {} }))
        .await;
    let id = termin["id"].as_str().unwrap();
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    probe.push_leeren();
    let mut hoerer_c = probe.hoeren(&c);

    // Cleo kommt hinzu – Bodo bleibt, wie er ist.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b, &c]) }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["zustellung"]["einzelchats"], 1, "{antwort}");
    assert_eq!(antwort["zustellung"]["neueEinzelchats"], 1);
    assert_eq!(antwort["zustellung"]["benachrichtigt"], 1);

    assert_eq!(
        probe.karten(&a, &ab, id).await.len(),
        1,
        "Bodo bekommt keine zweite Karte"
    );
    let ac = probe
        .einzelkarten_chat(id, &c)
        .await
        .expect("Karte für Cleo");
    assert_eq!(probe.karten(&c, &ac, id).await.len(), 1);
    assert_eq!(probe.push_anzahl(), 1, "nur Cleo wird eingeladen");
    assert_eq!(probe.push_an(&c).len(), 1);
    assert!(probe.push_an(&b).is_empty());

    // Cleo hört davon über den Rundruf und kann den Termin öffnen.
    let rundruf = hoerer_c.alles();
    assert!(rundruf.iter().any(|r| r["type"] == "event.updated"));
    assert!(rundruf.iter().any(|r| r["type"] == "message.new"));
    let (status, _) = probe.holen(&c, id).await;
    assert_eq!(status, StatusCode::OK);

    // Die Einladungszeit steht an der Teilnehmerzeile – Bezugspunkt fürs Erinnern.
    let zeiten: Vec<(Uuid, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("select user_id, eingeladen_am from event_attendees where event_id = $1")
            .bind(uuid_von(id))
            .fetch_all(&probe.state.pool)
            .await
            .unwrap();
    let zeit_b = zeiten.iter().find(|(p, _)| *p == b.uuid()).unwrap().1;
    let zeit_c = zeiten.iter().find(|(p, _)| *p == c.uuid()).unwrap().1;
    assert!(zeit_c > zeit_b, "Cleo wurde später eingeladen als Bodo");

    // Dora ohne Karte: `senden: false` trägt sie nur in den Kalender ein.
    probe.push_leeren();
    let (status, antwort) = probe
        .aendern(
            &a,
            id,
            json!({
                "attendeeIds": ids(&[&b, &c, &d]),
                "zustellung": { "senden": false }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(ist_teilnehmer(&antwort, &d));
    assert!(probe.einzelkarten_chat(id, &d).await.is_none());
    assert_eq!(probe.push_anzahl(), 0);
    let (status, _) = probe.holen(&d, id).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread")]
async fn ausladen_beendet_zugang_entfernt_einzelkarte_laesst_gruppenkarte() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &c]).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let ac = probe.einzelkarten_chat(id, &c).await.unwrap();
    let karte_ac = probe.karten(&a, &ac, id).await;
    let nachricht_ac = karte_ac[0]["id"].as_str().unwrap().to_string();
    probe.push_leeren();
    let mut hoerer_a = probe.hoeren(&a);
    let mut hoerer_c = probe.hoeren(&c);

    // Cleo fällt aus der Liste.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b]) }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(!ist_teilnehmer(&antwort, &c));

    // Der Zugang endet sofort.
    let (status, _) = probe.holen(&c, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = probe.rsvp(&c, id, "yes").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Ihre Einzelkarte ist gelöscht – für beide Seiten, samt Rundruf …
    assert!(probe.karten(&a, &ac, id).await.is_empty());
    let geloescht_an_a = hoerer_a.vom_typ("message.deleted");
    let rundruf_c = hoerer_c.alles();
    assert!(
        geloescht_an_a
            .iter()
            .any(|r| r["payload"]["messageId"] == nachricht_ac.as_str()),
        "Anna erfährt, dass die Karte weg ist"
    );
    assert!(
        rundruf_c.iter().any(|r| r["type"] == "message.deleted"
            && r["payload"]["messageId"] == nachricht_ac.as_str()),
        "und Cleo auch: {rundruf_c:?}"
    );
    // … sie selbst erfährt es mit Grund, aber ohne Mitteilung.
    let ausgeladen = rundruf_c
        .iter()
        .find(|r| r["type"] == "event.deleted")
        .expect("Cleo bekommt event.deleted");
    assert_eq!(ausgeladen["payload"]["eventId"], id);
    assert_eq!(ausgeladen["payload"]["grund"], "ausgeladen");
    assert!(
        rundruf_c.iter().all(|r| r["type"] != "event.updated"),
        "kein Stand des Termins an Cleo: {rundruf_c:?}"
    );
    assert_eq!(probe.push_anzahl(), 0, "Stille ist die freundlichere Wahl");

    // Die Gruppenkarte bleibt – und zeigt Cleo nichts.
    let in_g: Vec<Value> = probe
        .nachrichten(&c, &g)
        .await
        .into_iter()
        .filter(|m| m["type"] == "event" && m["deletedAt"].is_null())
        .collect();
    assert_eq!(in_g.len(), 1);
    assert!(in_g[0]["event"].is_null());
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1);

    // Wieder einladen: Es entsteht eine NEUE Einzelkarte, nicht die gelöschte
    // Nachricht.
    let (status, _) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b, &c]) }))
        .await;
    assert_eq!(status, StatusCode::OK);
    let wieder = probe.karten(&a, &ac, id).await;
    assert_eq!(wieder.len(), 1);
    assert_ne!(wieder[0]["id"], nachricht_ac.as_str());
    let (status, _) = probe.holen(&c, id).await;
    assert_eq!(status, StatusCode::OK);

    // Die Gruppe abwählen löscht ihre Karte – eine ausdrückliche Handlung.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "zustellung": { "gruppenChatIds": [] } }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(probe.karten(&b, &g, id).await.is_empty());
    assert!(antwort["conversationId"].is_null(), "{antwort}");
    assert!(antwort["zustellung"]["gruppen"]
        .as_array()
        .unwrap()
        .is_empty());

    // Fehlt `zustellung` ganz (älterer App-Stand), bleiben die Gruppenkarten,
    // wie sie sind.
    let (status, _) = probe
        .aendern(&a, id, json!({ "zustellung": { "gruppenChatIds": [g] } }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1, "neu gestellt");
    let (status, _) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b, &c]) }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1, "unverändert");
}

#[tokio::test(flavor = "multi_thread")]
async fn das_einzelne_ausladen_laeuft_ueber_denselben_weg() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b, &c]), "zustellung": {} }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();

    // Nur der Ersteller lädt aus.
    let (status, antwort) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", c.id),
            Some(&b.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
    assert_eq!(
        antwort["error"]["message"],
        "Nur wer den Termin angelegt hat, kann Einladungen ändern"
    );

    // Der Ersteller kann sich nicht selbst ausladen.
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", a.id),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, antwort) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", c.id),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(!ist_teilnehmer(&antwort, &c));
    assert!(ist_teilnehmer(&antwort, &b));
    assert!(
        probe.einzelkarten_chat(id, &c).await.is_none(),
        "die Einzelkarte ist weg"
    );
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    let (status, _) = probe.holen(&c, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn zeit_und_ort_aenderung_benachrichtigt_ohne_neue_karte() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "location": "Wiese",
                "attendeeIds": ids(&[&b, &c, &d]),
                "zustellung": {}
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    // Cleo hat abgesagt, Dora nicht geantwortet, Bodo zugesagt.
    probe.rsvp(&b, id, "yes").await;
    probe.rsvp(&c, id, "no").await;
    let karten_vorher = sqlx::query_scalar::<_, i64>(
        "select count(*) from messages where type = 'event' and metadata ->> 'eventId' = $1",
    )
    .bind(id)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(karten_vorher, 3);
    probe.push_leeren();

    // Der Titel allein ist keine Nachricht wert.
    let (status, _) = probe.aendern(&a, id, json!({ "title": "Grillfest" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.push_anzahl(), 0);

    // Der Ort schon: an Bodo und Dora, nicht an Cleo (abgesagt) und nicht an
    // Anna (Auslöser).
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "location": "Waldhütte" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(antwort["location"], "Waldhütte");
    assert_eq!(probe.push_anzahl(), 2);
    let an_b = probe.push_an(&b);
    assert_eq!(an_b.len(), 1);
    assert_eq!(an_b[0]["body"], "📅 Grillfest – Ort geändert");
    assert_eq!(an_b[0]["url"], format!("/kalender/termin/{id}"));
    assert_eq!(an_b[0]["tag"], format!("termin:{id}"));
    assert_eq!(probe.push_an(&d).len(), 1);
    assert!(
        probe.push_an(&c).is_empty(),
        "wer abgesagt hat, braucht keine Nachricht"
    );
    assert!(probe.push_an(&a).is_empty(), "und der Auslöser auch nicht");

    // Die Antworten bleiben, wie sie sind.
    assert_eq!(status_von(&antwort, &b), "yes");
    assert_eq!(status_von(&antwort, &c), "no");
    assert_eq!(status_von(&antwort, &d), "pending");

    // Zeit UND Ort zusammen: ein eigener Text.
    probe.push_leeren();
    let neu = chrono::Utc::now() + chrono::Duration::days(9);
    probe
        .aendern(
            &a,
            id,
            json!({
                "startsAt": neu,
                "endsAt": neu + chrono::Duration::hours(1),
                "location": "Strand"
            }),
        )
        .await;
    assert_eq!(
        probe.push_an(&b)[0]["body"],
        "📅 Grillfest – Zeit und Ort geändert"
    );

    // Keine neue Karte, in keinem Chat.
    let karten_nachher = sqlx::query_scalar::<_, i64>(
        "select count(*) from messages where type = 'event' and metadata ->> 'eventId' = $1",
    )
    .bind(id)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(karten_nachher, 3);

    // Drei Mitteilungen je zehn Minuten und Termin, danach nur noch still.
    // Zwei davon sind schon verbraucht (Ort, Zeit und Ort).
    probe.push_leeren();
    probe.aendern(&a, id, json!({ "location": "Insel" })).await;
    assert_eq!(probe.push_an(&b).len(), 1, "die dritte geht noch");
    probe.push_leeren();
    let (status, antwort) = probe.aendern(&a, id, json!({ "location": "Gipfel" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(antwort["location"], "Gipfel", "geändert wird trotzdem");
    assert_eq!(probe.push_anzahl(), 0, "die vierte wird still geschrieben");
}

#[tokio::test(flavor = "multi_thread")]
async fn loeschen_entfernt_alle_karten() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Vier", &[&b, &c, &d]).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    // Noch eine Gruppenkarte: Dora dazu, Gruppe wählen.
    let (status, _) = probe
        .aendern(
            &a,
            id,
            json!({
                "attendeeIds": ids(&[&b, &c, &d]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    let ac = probe.einzelkarten_chat(id, &c).await.unwrap();
    assert_eq!(probe.karten(&a, &g, id).await.len(), 1);
    probe.rsvp(&b, id, "yes").await;
    probe.rsvp(&c, id, "no").await;
    probe.push_leeren();
    let mut hoerer_b = probe.hoeren(&b);
    let mut hoerer_d = probe.hoeren(&d);

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}"),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Alle Karten sind gelöscht, die Tabelle ist leer.
    assert!(probe.karten(&a, &g, id).await.is_empty());
    assert!(probe.karten(&a, &ab, id).await.is_empty());
    assert!(probe.karten(&a, &ac, id).await.is_empty());
    assert!(probe.platzierungen(id).await.is_empty());
    let noch_da: i64 = sqlx::query_scalar(
        "select count(*) from messages
          where type = 'event' and metadata ->> 'eventId' = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(noch_da, 0);

    // Die Karten fallen bei den Richtigen weg: Bodo in G und AB, Dora in G und
    // AD (sie kam beim Nachtragen mit Einzelkarte dazu).
    let an_b = hoerer_b.alles();
    let an_d = hoerer_d.alles();
    let geloescht = |rahmen: &[Value]| {
        rahmen
            .iter()
            .filter(|r| r["type"] == "message.deleted")
            .count()
    };
    assert_eq!(geloescht(&an_b), 2, "{an_b:?}");
    assert_eq!(geloescht(&an_d), 2, "{an_d:?}");
    // Und alle Teilnehmer erfahren, dass der Termin weg ist – mit Grund.
    for rundruf in [&an_b, &an_d] {
        let weg = rundruf
            .iter()
            .find(|r| r["type"] == "event.deleted")
            .expect("event.deleted");
        assert_eq!(weg["payload"]["grund"], "geloescht");
    }

    // „Entfällt“ geht nur an die, die planen: Bodo (zugesagt). Cleo hat
    // abgesagt, Dora nicht geantwortet, Anna hat gelöscht.
    assert_eq!(probe.push_anzahl(), 1, "{:?}", probe.push_an(&d));
    let an_b = probe.push_an(&b);
    assert_eq!(an_b[0]["body"], "📅 Entfällt: Grillen");
    assert_eq!(an_b[0]["url"], "/kalender");

    let (status, _) = probe.holen(&a, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn absagen_haelt_karten_und_sperrt_zusagen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &c]).await;

    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    probe.rsvp(&c, id, "no").await;
    probe.push_leeren();

    let (status, antwort) = probe
        .aendern(&a, id, json!({ "status": "cancelled" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["status"], "cancelled");
    assert!(
        antwort.get("zustellung").is_none(),
        "keine Einladung geändert"
    );

    // Die Karten stehen weiter und zeigen den neuen Stand.
    let karten = probe.karten(&b, &g, id).await;
    assert_eq!(karten.len(), 1);
    assert_eq!(karten[0]["event"]["status"], "cancelled");
    // Zusagen sind gesperrt.
    let (status, antwort) = probe.rsvp(&b, id, "yes").await;
    assert_eq!(status, StatusCode::CONFLICT, "{antwort}");
    assert_eq!(antwort["error"]["message"], "Der Termin ist abgesagt.");
    // Eine Mitteilung an alle ausser Auslöser und die, die abgesagt haben.
    assert_eq!(probe.push_anzahl(), 1);
    assert_eq!(probe.push_an(&b)[0]["body"], "📅 Abgesagt: Grillen");

    // Wiederaufnehmen: Zusagen gehen wieder, und es gibt keine zweite Mitteilung.
    probe.push_leeren();
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "status": "confirmed" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["status"], "confirmed");
    assert_eq!(probe.push_anzahl(), 0);
    let (status, _) = probe.rsvp(&b, id, "yes").await;
    assert_eq!(status, StatusCode::OK);

    // Ungültige Werte, und ein Termin in Abstimmung lässt sich nicht absagen.
    let (status, _) = probe.aendern(&a, id, json!({ "status": "planning" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, geplant) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&a.token),
            Some(json!({
                "conversationId": g,
                "title": "Wann?",
                "slots": [
                    { "startsAt": chrono::Utc::now() + chrono::Duration::days(2) },
                    { "startsAt": chrono::Utc::now() + chrono::Duration::days(3) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    let (status, antwort) = probe
        .aendern(
            &a,
            geplant["id"].as_str().unwrap(),
            json!({ "status": "cancelled" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        antwort["error"]["message"],
        "Ein Termin in Abstimmung lässt sich nicht absagen – lege zuerst den Zeitpunkt fest."
    );
}

// ---------------------------------------------------------------------------
// Rückwärtsverträglich
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn altes_anlegen_bleibt_wie_es_war() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &c]).await;
    probe.push_leeren();

    // Nur `conversationId`, wie es ältere App-Stände schicken: alle Mitglieder
    // werden eingeladen, eine Karte kommt in den Chat, sonst nichts.
    let (status, termin) = probe
        .termin(
            &a,
            koerper(json!({ "conversationId": g, "attendeeIds": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    let id = termin["id"].as_str().unwrap();
    assert_eq!(termin["conversationId"], g.as_str());
    assert_eq!(termin["attendees"].as_array().unwrap().len(), 3);
    assert!(
        termin.get("zustellung").is_none(),
        "die Antwort sieht aus wie früher: {termin}"
    );
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1);
    let zeilen = probe.platzierungen(id).await;
    assert_eq!(zeilen.len(), 1, "keine Einzelkarten: {zeilen:?}");
    assert_eq!(zeilen[0].0, "gruppe");
    assert!(probe.einzelkarten_chat(id, &b).await.is_none());

    // Die Nachricht ist nicht stumm: Es läuft die gewöhnliche Mitteilung je
    // Chat, nicht die Einladungs-Mitteilung.
    let an_b = probe.push_an(&b);
    assert_eq!(an_b.len(), 1, "{an_b:?}");
    assert_eq!(an_b[0]["kind"], "message");
    assert_eq!(an_b[0]["url"], format!("/chats/{g}"));

    // Die Liste kommt zur Gruppe dazu, der Chat ist kein Zugang: Ein später
    // Beigetretener (nicht eingeladen) sieht ihn nicht.
    let d = probe.konto(&format!("dora{n}")).await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{g}/members"),
            Some(&a.token),
            Some(json!({ "memberIds": [d.id] })),
        )
        .await;
    assert!(status.is_success());
    let (status, _) = probe.holen(&d, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Ohne `announce` im Chat kommt keine Karte – auch das wie früher.
    let (status, still) = probe
        .termin(
            &a,
            koerper(json!({ "conversationId": g, "announce": false, "title": "Still" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(probe
        .platzierungen(still["id"].as_str().unwrap())
        .await
        .is_empty());
    assert_eq!(
        still["attendees"].as_array().unwrap().len(),
        4,
        "alle Mitglieder, auch Dora"
    );

    // In einem Zweierchat ist die Karte eine Einzelkarte: Wer ausgeladen wird,
    // verliert sie.
    let ab = probe.einzel(&a, &b).await;
    let (status, zweier) = probe
        .termin(
            &a,
            koerper(json!({ "conversationId": ab, "title": "Zu zweit" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let zeilen = probe.platzierungen(zweier["id"].as_str().unwrap()).await;
    assert_eq!(zeilen, vec![("einzel".to_string(), ab.clone(), true)]);
    assert_eq!(
        probe
            .einzelkarten_chat(zweier["id"].as_str().unwrap(), &b)
            .await
            .unwrap(),
        ab
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn termin_aus_umfrage_und_terminfindung_bleiben() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Zwei", &[&b]).await;
    let ac = probe.einzel(&a, &c).await;

    // ---- Termin aus einer Terminumfrage ----------------------------------
    let start = chrono::Utc::now() + chrono::Duration::days(1);
    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&a.token),
            Some(json!({
                "conversationId": g,
                "kind": "date",
                "question": "Wann treffen wir uns?",
                "options": [
                    { "startsAt": start, "endsAt": start + chrono::Duration::hours(1) },
                    { "startsAt": start + chrono::Duration::days(1) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let umfrage_id = umfrage["id"].as_str().unwrap();
    let option = umfrage["options"][0]["id"].as_str().unwrap();
    probe
        .call(
            "POST",
            &format!("/api/v1/polls/{umfrage_id}/vote"),
            Some(&b.token),
            Some(json!({ "votes": [{ "optionId": option, "value": "yes" }] })),
        )
        .await;
    let (status, termin) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{umfrage_id}/event"),
            Some(&a.token),
            Some(json!({ "optionId": option })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    let id = termin["id"].as_str().unwrap();
    // Wie vorher: alle Chatmitglieder, die Zusage aus der Abstimmung, eine Karte
    // im Umfragechat.
    assert_eq!(termin["conversationId"], g.as_str());
    assert!(ist_teilnehmer(&termin, &a) && ist_teilnehmer(&termin, &b));
    assert_eq!(status_von(&termin, &b), "yes");
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1);
    assert_eq!(probe.platzierungen(id).await.len(), 1);

    // ---- Terminfindung, bestätigt ----------------------------------------
    let (status, geplant) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&a.token),
            Some(json!({
                "conversationId": g,
                "alsoIn": [ac],
                "title": "Wann grillen wir?",
                "slots": [
                    { "startsAt": start + chrono::Duration::days(2) },
                    { "startsAt": start + chrono::Duration::days(3) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    assert_eq!(geplant["status"], "planning");
    assert!(ist_teilnehmer(&geplant, &b));
    let geplant_id = geplant["id"].as_str().unwrap();
    let poll_id = geplant["pollId"].as_str().unwrap();

    // Cleo stimmt im Einzelchat ab – sie ist nicht in der Gruppe.
    let (_, poll) = probe
        .call(
            "GET",
            &format!("/api/v1/polls/{poll_id}"),
            Some(&c.token),
            None,
        )
        .await;
    let zeit = poll["options"][0]["id"].as_str().unwrap();
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{poll_id}/vote"),
            Some(&c.token),
            Some(json!({ "votes": [{ "optionId": zeit, "value": "yes" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, bestaetigt) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{geplant_id}/confirm"),
            Some(&a.token),
            Some(json!({ "optionId": zeit })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bestaetigt}");
    assert_eq!(bestaetigt["status"], "confirmed");
    assert!(ist_teilnehmer(&bestaetigt, &c), "Cleo wird Teilnehmerin");
    assert!(bestaetigt["stand"].as_i64().unwrap() > 0);

    // Und – die Reparatur – sie kann den Termin jetzt auch öffnen und zusagen.
    let (status, _) = probe.holen(&c, geplant_id).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = probe.rsvp(&c, geplant_id, "yes").await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread")]
async fn fremde_termin_karte_zeigt_nichts_und_nachrichtenweg_ist_zu() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let e = probe.konto(&format!("emil{n}")).await;

    // Ein Termin, den nur Anna und Bodo kennen.
    let termin = probe
        .termin_mit(&a, json!({ "attendeeIds": ids(&[&b]), "zustellung": {} }))
        .await;
    let id = termin["id"].as_str().unwrap();

    // Dora kennt die Kennung (Link, früherer Zugang) und versucht, sie in
    // einen Chat zu legen.
    let de = probe.einzel(&d, &e).await;
    for koerper in [
        json!({ "type": "event", "metadata": { "eventId": id } }),
        json!({ "type": "text", "body": "schau", "metadata": { "eventId": id } }),
        json!({ "type": "event", "body": "leer" }),
    ] {
        let (status, antwort) = probe
            .call(
                "POST",
                &format!("/api/v1/conversations/{de}/messages"),
                Some(&d.token),
                Some(koerper),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
        assert_eq!(
            antwort["error"]["message"],
            "Termin-Karten legt nur die Termin-Funktion an."
        );
    }

    // Kommt die Karte trotzdem hinein (direkt in die Datenbank gelegt), liefert
    // sie weder den Termin noch die Kennung.
    let eingeschleust = Uuid::now_v7();
    sqlx::query(
        "insert into messages (id, conversation_id, sender_id, type, metadata)
         values ($1, $2, $3, 'event', $4)",
    )
    .bind(eingeschleust)
    .bind(uuid_von(&de))
    .bind(d.uuid())
    .bind(json!({ "eventId": id }))
    .execute(&probe.state.pool)
    .await
    .unwrap();
    let karten: Vec<Value> = probe
        .nachrichten(&d, &de)
        .await
        .into_iter()
        .filter(|m| m["type"] == "event")
        .collect();
    assert_eq!(karten.len(), 1);
    assert!(karten[0]["event"].is_null(), "kein Termin: {}", karten[0]);
    assert!(
        karten[0]["metadata"].get("eventId").is_none(),
        "keine Kennung: {}",
        karten[0]
    );
    // Auch eine Nachricht anderer Art mit `eventId` bekommt keinen Termin.
    sqlx::query(
        "insert into messages (id, conversation_id, sender_id, type, body, metadata)
         values ($1, $2, $3, 'text', 'x', $4)",
    )
    .bind(Uuid::now_v7())
    .bind(uuid_von(&de))
    .bind(d.uuid())
    .bind(json!({ "eventId": id }))
    .execute(&probe.state.pool)
    .await
    .unwrap();
    let texte: Vec<Value> = probe
        .nachrichten(&d, &de)
        .await
        .into_iter()
        .filter(|m| m["type"] == "text")
        .collect();
    assert!(texte[0]["event"].is_null());
}

// ---------------------------------------------------------------------------
// Wiederholbar, nachliefern, Grenzen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn doppelsenden_und_nachliefern_sind_wiederholbar() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    probe.push_leeren();

    // Zweimal dieselbe Eingabe: ein Termin, nicht zwei.
    let schluessel = Uuid::now_v7().to_string();
    let eingabe = koerper(json!({
        "attendeeIds": ids(&[&b]),
        "zustellung": {},
        "clientId": schluessel,
    }));
    let (status, erster) = probe.termin(&a, eingabe.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{erster}");
    let id = erster["id"].as_str().unwrap();
    let pushes = probe.push_anzahl();
    assert_eq!(pushes, 1);

    let (status, zweiter) = probe.termin(&a, eingabe).await;
    assert_eq!(status, StatusCode::OK, "die Wiederholung: {zweiter}");
    assert_eq!(zweiter["id"], id);
    assert_eq!(zweiter["zustellung"]["einzelchats"], 1, "{zweiter}");
    assert_eq!(probe.platzierungen(id).await.len(), 1, "keine zweite Karte");
    assert_eq!(probe.push_anzahl(), pushes, "keine zweite Mitteilung");
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    let termine: i64 = sqlx::query_scalar(
        "select count(*) from calendar_events where created_by = $1 and client_id = $2",
    )
    .bind(a.uuid())
    .bind(&schluessel)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(termine, 1);
    // Gleichzeitig geht es auch: Der Eindeutigkeits-Index hält.
    let schluessel = Uuid::now_v7().to_string();
    let eingabe =
        koerper(json!({ "attendeeIds": ids(&[&b]), "zustellung": {}, "clientId": schluessel }));
    let (x, y) = tokio::join!(
        probe.termin(&a, eingabe.clone()),
        probe.termin(&a, eingabe.clone())
    );
    assert!(x.0.is_success() && y.0.is_success(), "{x:?} / {y:?}");
    assert_eq!(x.1["id"], y.1["id"], "derselbe Termin");

    // Eine Karte, deren Nachricht nicht ankam (Phase 2 abgebrochen).
    let (status, ohne) = probe
        .termin(
            &a,
            koerper(json!({
                "title": "Nachliefern",
                "attendeeIds": ids(&[&c]),
                "zustellung": { "senden": false }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let ohne_id = ohne["id"].as_str().unwrap();
    let ac = probe.einzel(&a, &c).await;
    sqlx::query(
        "insert into event_placements (id, event_id, conversation_id, art, user_id, created_by)
         values ($1, $2, $3, 'einzel', $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(uuid_von(ohne_id))
    .bind(uuid_von(&ac))
    .bind(c.uuid())
    .bind(a.uuid())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    let (status, stand) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{ohne_id}/zustellung"),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{stand}");
    assert_eq!(stand["ausstehend"], 1);
    assert_eq!(stand["einzelNutzerIds"][0], c.id.as_str());
    // Nur der Ersteller darf fragen.
    let (status, _) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{ohne_id}/zustellung"),
            Some(&c.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    probe.push_leeren();
    let (status, nachgeliefert) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{ohne_id}/zustellung/nachliefern"),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nachgeliefert}");
    assert_eq!(nachgeliefert["zustellung"]["ausstehend"], 0);
    assert_eq!(nachgeliefert["zustellung"]["einzelchats"], 1);
    assert_eq!(nachgeliefert["zustellung"]["benachrichtigt"], 1);
    assert_eq!(probe.karten(&a, &ac, ohne_id).await.len(), 1);
    assert_eq!(probe.push_an(&c).len(), 1, "die Einladung kommt jetzt an");

    // Ein zweiter Aufruf legt nichts mehr an und benachrichtigt nicht noch einmal.
    probe.push_leeren();
    let (status, nochmal) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{ohne_id}/zustellung/nachliefern"),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nochmal["zustellung"]["einzelchats"], 0);
    assert_eq!(probe.karten(&a, &ac, ohne_id).await.len(), 1);
    assert_eq!(probe.push_anzahl(), 0);
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{ohne_id}/zustellung/nachliefern"),
            Some(&c.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test(flavor = "multi_thread")]
async fn grenzen_und_fehlertexte() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let g = probe.gruppe(&a, "Zwei", &[&b]).await;
    let fremde_gruppe = probe.gruppe(&b, "Ohne Anna", &[&c]).await;
    let ab = probe.einzel(&a, &b).await;

    let fehler = |antwort: &Value| antwort["error"]["message"].as_str().unwrap().to_string();

    // 201 Eingeladene.
    let viele: Vec<String> = (0..201).map(|_| Uuid::now_v7().to_string()).collect();
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "attendeeIds": viele, "zustellung": {} })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(fehler(&antwort), "Zu viele Eingeladene (höchstens 200).");

    // Eine Kennung ohne Konto.
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "attendeeIds": [Uuid::now_v7()], "zustellung": {} })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(
        fehler(&antwort),
        "Unbekannte Personen unter den Eingeladenen."
    );

    // Elf Gruppenchats.
    let elf: Vec<String> = (0..11).map(|_| Uuid::now_v7().to_string()).collect();
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "zustellung": { "gruppenChatIds": elf } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(fehler(&antwort), "Zu viele Gruppenchats (höchstens 10).");

    // Ein Einzelchat als Ziel.
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "zustellung": { "gruppenChatIds": [ab] } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(
        fehler(&antwort),
        "Nur Gruppenchats lassen sich als Ziel wählen."
    );

    // Ein Gruppenchat, in dem man nicht Mitglied ist.
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "zustellung": { "gruppenChatIds": [fremde_gruppe] } })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
    assert_eq!(fehler(&antwort), "Du bist kein Mitglied dieses Chats");

    // Ein Chat, den es nicht gibt.
    let (status, _) = probe
        .termin(
            &a,
            koerper(json!({ "zustellung": { "gruppenChatIds": [Uuid::now_v7()] } })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // `conversationId` neben `zustellung`, der nicht unter den Gruppen steht.
    let (status, antwort) = probe
        .termin(
            &a,
            koerper(json!({ "conversationId": g, "zustellung": { "gruppenChatIds": [] } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(
        fehler(&antwort),
        "Bei „zustellung“ bestimmen die Gruppenchats den Chat des Termins."
    );
    // Steht er darunter, ist es in Ordnung.
    let (status, _) = probe
        .termin(
            &a,
            koerper(json!({ "conversationId": g, "zustellung": { "gruppenChatIds": [g] } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    // Ein zu langer Wiederholungsschutz-Schlüssel.
    let (status, _) = probe
        .termin(&a, koerper(json!({ "clientId": "x".repeat(65) })))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Die Person selbst in der Liste wird still ignoriert, Doppelte auch.
    let (status, termin) = probe
        .termin(
            &a,
            koerper(json!({
                "attendeeIds": [a.id, b.id, b.id],
                "zustellung": {}
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    assert_eq!(termin["attendees"].as_array().unwrap().len(), 2);
    assert_eq!(status_von(&termin, &a), "yes");

    // Die Bremse: dreissig Anfragen mit `zustellung` je Stunde.
    let mut letzte = StatusCode::CREATED;
    for _ in 0..31 {
        let (status, antwort) = probe
            .termin(&a, koerper(json!({ "zustellung": { "senden": false } })))
            .await;
        letzte = status;
        if status == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(
                fehler(&antwort),
                "Zu viele Einladungen in kurzer Zeit. Warte einen Moment."
            );
            break;
        }
    }
    assert_eq!(letzte, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test(flavor = "multi_thread")]
async fn nur_der_ersteller_aendert_einladungen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Vier", &[&b, &c, &d]).await;
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{g}/members/{}", b.id),
            Some(&a.token),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Bodo ist Gruppen-Admin UND eingeladen, die Gruppenkarte steht in G.
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b, &c, &d]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();

    // Inhalt ändern darf er …
    let (status, antwort) = probe
        .aendern(&b, id, json!({ "title": "Bodos Titel" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["title"], "Bodos Titel");
    // … einladen nicht: Der Ersteller ist Absender aller Karten.
    for body in [
        json!({ "attendeeIds": ids(&[&b, &c]) }),
        json!({ "zustellung": { "gruppenChatIds": [] } }),
    ] {
        let (status, antwort) = probe.aendern(&b, id, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
        assert_eq!(
            antwort["error"]["message"],
            "Nur wer den Termin angelegt hat, kann Einladungen ändern"
        );
    }
    // Ein einfaches Mitglied ändert gar nichts.
    let (status, _) = probe.aendern(&c, id, json!({ "title": "Nein" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Ein Admin OHNE Einladung bearbeitet nicht, was er nicht sehen darf.
    let zweiter = probe
        .termin_mit(
            &a,
            json!({
                "title": "Ohne Bodo",
                "attendeeIds": ids(&[&c]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    // Er bekommt 404 wie beim Lesen: Eine Rolle in der Gruppe verrät ihm nicht,
    // dass es den Termin gibt.
    let (status, _) = probe
        .aendern(
            &b,
            zweiter["id"].as_str().unwrap(),
            json!({ "title": "Doch" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Löschen darf der Admin, wenn er eingeladen ist und die Karte in seiner
    // Gruppe steht.
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}"),
            Some(&b.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

// ---------------------------------------------------------------------------
// Nachgestellte Befunde
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn eine_zusage_waehrend_des_ausladens_holt_niemanden_zurueck() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b]), "zustellung": { "senden": false } }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let termin_id: Uuid = id.parse().unwrap();

    // Das Ausladen hält die Zeile in der Schwebe: Bodos Zusage besteht die
    // Prüfung (die Zeile ist noch zu sehen) und wartet dann auf das Schreiben.
    let mut ausladen = probe.state.pool.begin().await.unwrap();
    sqlx::query("delete from event_attendees where event_id = $1 and user_id = $2")
        .bind(termin_id)
        .bind(b.uuid())
        .execute(&mut *ausladen)
        .await
        .unwrap();
    let zusage = probe.rsvp(&b, id, "yes");
    let abschluss = async {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        ausladen.commit().await.unwrap();
    };
    let ((status, antwort), _) = tokio::join!(zusage, abschluss);

    // Die Zusage trifft keine Zeile mehr – und legt auch keine neu an.
    assert_eq!(status, StatusCode::NOT_FOUND, "{antwort}");
    let dabei: bool = sqlx::query_scalar(
        "select exists (select 1 from event_attendees where event_id = $1 and user_id = $2)",
    )
    .bind(termin_id)
    .bind(b.uuid())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert!(!dabei, "Bodo bleibt ausgeladen");
    let (status, _) = probe.holen(&b, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn ort_und_beschreibung_haben_eine_grenze_auch_beim_aendern() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;

    let (status, antwort) = probe
        .termin(&a, koerper(json!({ "location": "o".repeat(301) })))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{antwort}");
    // Genau an der Grenze geht es.
    let termin = probe
        .termin_mit(&a, json!({ "location": "o".repeat(300) }))
        .await;
    let id = termin["id"].as_str().unwrap();

    // Beim Ändern gilt dasselbe – für Ort und Beschreibung.
    let (status, _) = probe
        .aendern(&a, id, json!({ "location": "o".repeat(301) }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = probe
        .aendern(&a, id, json!({ "description": "d".repeat(4001) }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, geaendert) = probe
        .aendern(&a, id, json!({ "description": "d".repeat(4000) }))
        .await;
    assert_eq!(status, StatusCode::OK, "{geaendert}");
    // Löschen (`null`) braucht keine Länge.
    let (status, geaendert) = probe
        .aendern(&a, id, json!({ "location": null, "description": null }))
        .await;
    assert_eq!(status, StatusCode::OK, "{geaendert}");
    assert!(geaendert["location"].is_null());

    // Auch die Terminfindung.
    let b = probe.konto(&format!("bodo{n}")).await;
    let g = probe.gruppe(&a, "Zwei", &[&b]).await;
    let (status, _) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&a.token),
            Some(json!({
                "conversationId": g,
                "title": "Wann?",
                "location": "o".repeat(301),
                "slots": [
                    { "startsAt": chrono::Utc::now() + chrono::Duration::days(2) },
                    { "startsAt": chrono::Utc::now() + chrono::Duration::days(3) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test(flavor = "multi_thread")]
async fn eingeladene_tragen_sich_selbst_aus() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b, &c]), "zustellung": {} }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let ab = probe.einzelkarten_chat(id, &b).await.unwrap();
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    let pfad = |wer: &Konto| format!("/api/v1/calendar/events/{id}/attendees/{}", wer.id);

    // Bodo hat abgesagt, der Termin bleibt trotzdem in seiner Liste – bis er
    // sich austrägt.
    probe.rsvp(&b, id, "no").await;
    let mut hoerer_b = probe.hoeren(&b);
    let (status, antwort) = probe.call("DELETE", &pfad(&b), Some(&b.token), None).await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(!ist_teilnehmer(&antwort, &b));
    assert!(
        antwort.get("zustellung").is_none() || antwort["zustellung"].is_null(),
        "wo der Termin steht, geht den Ersteller etwas an"
    );
    // Der Zugang endet, die Einzelkarte verschwindet, er hört es über den Rundruf.
    let (status, _) = probe.holen(&b, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(probe.karten(&a, &ab, id).await.is_empty());
    assert!(!hoerer_b.vom_typ("event.deleted").is_empty());
    // Der Ersteller und Cleo sehen ihn weiter.
    let (_, fuer_anna) = probe.holen(&a, id).await;
    assert!(!ist_teilnehmer(&fuer_anna, &b));
    assert!(ist_teilnehmer(&fuer_anna, &c));
    let (status, _) = probe.holen(&c, id).await;
    assert_eq!(status, StatusCode::OK);

    // Wer nicht eingeladen ist, kann niemanden austragen – und erfährt nicht
    // einmal, dass es den Termin gibt. Cleo trägt nur sich selbst aus.
    let (status, _) = probe.call("DELETE", &pfad(&c), Some(&d.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = probe.call("DELETE", &pfad(&d), Some(&d.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = probe.call("DELETE", &pfad(&a), Some(&c.token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "andere ausladen darf nur er");
    // Der Ersteller kann sich nicht selbst austragen.
    let (status, _) = probe.call("DELETE", &pfad(&a), Some(&a.token), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_grosser_altbestand_laesst_sich_verkleinern() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b]), "zustellung": { "senden": false } }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let termin_id: Uuid = id.parse().unwrap();

    // Der alte Weg und die Migration kennen keine Grenze: 230 Teilnehmer.
    let leute: Vec<Uuid> = (0..229).map(|_| Uuid::now_v7()).collect();
    let namen: Vec<String> = (0..229).map(|nummer| format!("alt{n}x{nummer}")).collect();
    sqlx::query(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         select t.id, t.name, t.name, 'x', t.id::text
           from unnest($1::uuid[], $2::text[]) as t(id, name)",
    )
    .bind(&leute)
    .bind(&namen)
    .execute(&probe.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into event_attendees (event_id, user_id, status)
         select $1, p, 'pending' from unnest($2::uuid[]) as p",
    )
    .bind(termin_id)
    .bind(&leute)
    .execute(&probe.state.pool)
    .await
    .unwrap();

    // Ausladen und Abwählen gehen: Die Liste schrumpft.
    let (status, antwort) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", b.id),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["attendees"].as_array().unwrap().len(), 230);
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "zustellung": { "gruppenChatIds": [] } }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");

    // Wachsen dürfte sie nicht.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b]) }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["attendees"].as_array().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn abgesagte_termine_stehen_im_abo_als_abgesagt() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let termin = probe
        .termin_mit(&a, json!({ "attendeeIds": ids(&[&b]), "zustellung": {} }))
        .await;
    let id = termin["id"].as_str().unwrap();
    let einzeln = format!("/api/v1/calendar/events/{id}/event.ics");

    let abo = probe.abo(&b).await;
    assert!(abo.contains(id) && !abo.contains("STATUS:CANCELLED"));
    let (_, ics) = probe.text(&einzeln, None).await;
    assert!(!ics.contains("STATUS:CANCELLED"));

    let (status, _) = probe
        .aendern(&a, id, json!({ "status": "cancelled" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    // Dieselbe Kennung, jetzt als abgesagt gekennzeichnet.
    let abo = probe.abo(&b).await;
    assert!(
        abo.contains(id) && abo.contains("STATUS:CANCELLED"),
        "{abo}"
    );
    let (_, ics) = probe.text(&einzeln, None).await;
    assert!(ics.contains("STATUS:CANCELLED"), "{ics}");

    // Wiederaufgenommen gilt er wieder.
    probe
        .aendern(&a, id, json!({ "status": "confirmed" }))
        .await;
    assert!(!probe.abo(&b).await.contains("STATUS:CANCELLED"));
}

#[tokio::test(flavor = "multi_thread")]
async fn absagen_im_wechsel_klingelt_nicht_beliebig_oft() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let termin = probe
        .termin_mit(&a, json!({ "attendeeIds": ids(&[&b]), "zustellung": {} }))
        .await;
    let id = termin["id"].as_str().unwrap();
    probe.push_leeren();

    for _ in 0..8 {
        let (status, _) = probe
            .aendern(&a, id, json!({ "status": "cancelled" }))
            .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = probe
            .aendern(&a, id, json!({ "status": "confirmed" }))
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    // Die Regel erlaubt drei Mitteilungen je zehn Minuten (und Termin): Die
    // übrigen Absagen stehen still in den Karten.
    let absagen = probe
        .push_an(&b)
        .iter()
        .filter(|push| {
            push["body"]
                .as_str()
                .is_some_and(|text| text.contains("Abgesagt"))
        })
        .count();
    assert_eq!(absagen, 3, "acht Absagen, drei Mitteilungen");
}

#[tokio::test(flavor = "multi_thread")]
async fn schreibende_wege_verraten_die_kennung_nicht() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let termin = probe
        .termin_mit(&a, json!({ "attendeeIds": ids(&[&b]), "zustellung": {} }))
        .await;
    let id = termin["id"].as_str().unwrap();
    let unbekannt = Uuid::now_v7().to_string();
    let sammlung = Uuid::now_v7().to_string();

    // Wer nicht eingeladen ist, bekommt auf eine bekannte und eine unbekannte
    // Kennung dieselbe Antwort.
    for kennung in [id, unbekannt.as_str()] {
        let wege: Vec<(&str, String, Option<Value>)> = vec![
            (
                "PATCH",
                format!("/api/v1/calendar/events/{kennung}"),
                Some(json!({ "title": "Neu" })),
            ),
            ("DELETE", format!("/api/v1/calendar/events/{kennung}"), None),
            (
                "DELETE",
                format!("/api/v1/calendar/events/{kennung}/attendees/{}", b.id),
                None,
            ),
            (
                "GET",
                format!("/api/v1/calendar/events/{kennung}/zustellung"),
                None,
            ),
            (
                "POST",
                format!("/api/v1/calendar/events/{kennung}/zustellung/nachliefern"),
                None,
            ),
            (
                "PATCH",
                format!("/api/v1/calendar/events/{kennung}/collection"),
                Some(json!({ "collectionId": sammlung })),
            ),
            (
                "POST",
                format!("/api/v1/calendar/events/{kennung}/confirm"),
                Some(json!({})),
            ),
        ];
        for (methode, pfad, koerper) in wege {
            let (status, antwort) = probe.call(methode, &pfad, Some(&c.token), koerper).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{methode} {pfad}: {antwort}");
        }
    }

    // Wer eingeladen ist, aber nichts ändern darf, bekommt 403.
    let (status, _) = probe.aendern(&b, id, json!({ "title": "Neu" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{id}/zustellung"),
            Some(&b.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_zustellung_ohne_zeile_raeumt_ihre_karte_wieder_weg() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let ab = probe.einzel(&a, &b).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b]), "zustellung": { "senden": false } }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let termin_id: Uuid = id.parse().unwrap();

    // Eine reservierte Karte, noch ohne Nachricht – wie nach Phase 1.
    let zeile = Uuid::now_v7();
    sqlx::query(
        "insert into event_placements (id, event_id, conversation_id, art, user_id, created_by)
         values ($1, $2, $3, 'einzel', $4, $5)",
    )
    .bind(zeile)
    .bind(termin_id)
    .bind(ab.parse::<Uuid>().unwrap())
    .bind(b.uuid())
    .bind(a.uuid())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    // Während die Karte angelegt wird, löscht jemand den Termin (oder lädt die
    // Person aus): Die Zeile verschwindet, bevor die Zustellung sie einträgt.
    let mut loeschen = probe.state.pool.begin().await.unwrap();
    sqlx::query("delete from event_placements where id = $1")
        .bind(zeile)
        .execute(&mut *loeschen)
        .await
        .unwrap();
    let state = probe.state.clone();
    let ersteller = a.uuid();
    let zustellen = tokio::spawn(async move {
        initiative_api::services::einladen::offene_karten_zustellen(
            &state, termin_id, ersteller, true,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    loeschen.commit().await.unwrap();
    let zugestellt = zustellen.await.unwrap().unwrap();

    // Keine Karte bleibt zurück: weder zugestellt noch sichtbar im Chat.
    assert!(zugestellt.karten.is_empty());
    assert!(probe.karten(&a, &ab, id).await.is_empty());
    assert!(probe.karten(&b, &ab, id).await.is_empty());
    assert!(probe.platzierungen(id).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_gelaufene_zustellung_laesst_dem_schnelleren_seine_karte() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let ab = probe.einzel(&a, &b).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({ "attendeeIds": ids(&[&b]), "zustellung": { "senden": false } }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let termin_id: Uuid = id.parse().unwrap();
    let zeile = Uuid::now_v7();
    sqlx::query(
        "insert into event_placements (id, event_id, conversation_id, art, user_id, created_by)
         values ($1, $2, $3, 'einzel', $4, $5)",
    )
    .bind(zeile)
    .bind(termin_id)
    .bind(ab.parse::<Uuid>().unwrap())
    .bind(b.uuid())
    .bind(a.uuid())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    // Zwei Runden gleichzeitig (etwa „Erneut zustellen“ neben der ersten):
    // Es bleibt genau eine Karte.
    let (erste, zweite) = tokio::join!(
        initiative_api::services::einladen::offene_karten_zustellen(
            &probe.state,
            termin_id,
            a.uuid(),
            true
        ),
        initiative_api::services::einladen::offene_karten_zustellen(
            &probe.state,
            termin_id,
            a.uuid(),
            true
        ),
    );
    let (erste, zweite) = (erste.unwrap(), zweite.unwrap());
    assert_eq!(erste.karten.len() + zweite.karten.len(), 1);
    assert_eq!(probe.karten(&a, &ab, id).await.len(), 1);
    let platzierungen = probe.platzierungen(id).await;
    assert_eq!(platzierungen.len(), 1);
    assert!(platzierungen[0].2, "die Zeile trägt die Nachricht");
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_geloeschte_karte_ist_keine_platzierung_mehr() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let g = probe.gruppe(&a, "Zwei", &[&b]).await;
    let termin = probe
        .termin_mit(
            &a,
            json!({
                "attendeeIds": ids(&[&b]),
                "zustellung": { "gruppenChatIds": [g] }
            }),
        )
        .await;
    let id = termin["id"].as_str().unwrap();
    let karten = probe.karten(&a, &g, id).await;
    assert_eq!(karten.len(), 1);
    assert_eq!(probe.platzierungen(id).await.len(), 2, "Gruppe und Einzel");

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{}", karten[0]["id"].as_str().unwrap()),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Der Editor sieht, dass die Karte nicht mehr steht …
    let (_, stand) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{id}/zustellung"),
            Some(&a.token),
            None,
        )
        .await;
    assert!(stand["gruppen"].as_array().unwrap().is_empty(), "{stand}");
    // … und kann sie wieder zustellen.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "zustellung": { "gruppenChatIds": [g] } }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(probe.karten(&b, &g, id).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_wiederholung_wartet_auf_die_laufende_zustellung() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let ab = probe.einzel(&a, &b).await;
    let schluessel = format!("wdh{n}");
    let anfrage = || {
        koerper(json!({
            "clientId": schluessel,
            "attendeeIds": ids(&[&b]),
            "zustellung": { "senden": false }
        }))
    };
    let (status, termin) = probe.termin(&a, anfrage()).await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    let termin_id: Uuid = termin["id"].as_str().unwrap().parse().unwrap();

    // Phase 2 der ersten Anfrage läuft noch: Die Zeile ist reserviert, die
    // Nachricht noch nicht da.
    let (status, nachricht) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{ab}/messages"),
            Some(&a.token),
            Some(json!({ "type": "text", "body": "Platzhalter" })),
        )
        .await;
    assert!(status.is_success(), "{nachricht}");
    let nachricht_id: Uuid = nachricht["id"].as_str().unwrap().parse().unwrap();
    sqlx::query(
        "insert into event_placements (id, event_id, conversation_id, art, user_id, created_by)
         values ($1, $2, $3, 'einzel', $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(termin_id)
    .bind(ab.parse::<Uuid>().unwrap())
    .bind(b.uuid())
    .bind(a.uuid())
    .execute(&probe.state.pool)
    .await
    .unwrap();

    let beginn = std::time::Instant::now();
    let wiederholung = probe.termin(&a, anfrage());
    let fertig = async {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        sqlx::query("update event_placements set message_id = $2 where event_id = $1")
            .bind(termin_id)
            .bind(nachricht_id)
            .execute(&probe.state.pool)
            .await
            .unwrap();
    };
    let ((status, antwort), _) = tokio::join!(wiederholung, fertig);
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert!(beginn.elapsed() >= std::time::Duration::from_millis(600));
    assert_eq!(antwort["id"], termin["id"]);
    // Nicht „ausstehend: 1“: Die Karte war gleich da.
    assert_eq!(antwort["zustellung"]["ausstehend"], 0, "{antwort}");
    assert_eq!(antwort["zustellung"]["einzelchats"], 1, "{antwort}");
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_terminfindung_nimmt_ausgeladene_nicht_wieder_auf() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let a = probe.konto(&format!("anna{n}")).await;
    let b = probe.konto(&format!("bodo{n}")).await;
    let c = probe.konto(&format!("cleo{n}")).await;
    let d = probe.konto(&format!("dora{n}")).await;
    let g = probe.gruppe(&a, "Drei", &[&b, &c]).await;
    let start = chrono::Utc::now() + chrono::Duration::days(2);
    let (status, geplant) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&a.token),
            Some(json!({
                "conversationId": g,
                "title": "Wann grillen wir?",
                "slots": [
                    { "startsAt": start },
                    { "startsAt": start + chrono::Duration::days(1) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    let id = geplant["id"].as_str().unwrap();
    let poll_id = geplant["pollId"].as_str().unwrap();
    assert!(ist_teilnehmer(&geplant, &b) && ist_teilnehmer(&geplant, &c));

    // Beide stimmen für den ersten Vorschlag.
    let (_, poll) = probe
        .call(
            "GET",
            &format!("/api/v1/polls/{poll_id}"),
            Some(&b.token),
            None,
        )
        .await;
    let zeit = poll["options"][0]["id"].as_str().unwrap();
    for wer in [&b, &c] {
        let (status, _) = probe
            .call(
                "POST",
                &format!("/api/v1/polls/{poll_id}/vote"),
                Some(&wer.token),
                Some(json!({ "votes": [{ "optionId": zeit, "value": "yes" }] })),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    // Weitere Personen lassen sich erst einladen, wenn der Zeitpunkt steht:
    // Sie bekämen eine Karte, könnten aber nicht abstimmen.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&b, &c, &d]) }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert!(antwort["error"]["message"]
        .as_str()
        .unwrap()
        .contains("abgestimmt"));
    let (status, _) = probe.holen(&d, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Bodo wird ausgeladen und stimmt dennoch mit (er sitzt in der Gruppe).
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", b.id),
            Some(&a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = probe.holen(&b, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, bestaetigt) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{id}/confirm"),
            Some(&a.token),
            Some(json!({ "optionId": zeit })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bestaetigt}");
    // Cleo bekommt ihre Zusage, Bodo bleibt ausgeladen.
    assert_eq!(status_von(&bestaetigt, &c), "yes");
    assert!(!ist_teilnehmer(&bestaetigt, &b));
    let (status, _) = probe.holen(&b, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = probe.rsvp(&b, id, "yes").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Nach der Festlegung lässt sich weiter einladen.
    let (status, antwort) = probe
        .aendern(&a, id, json!({ "attendeeIds": ids(&[&c, &d]) }))
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
}
