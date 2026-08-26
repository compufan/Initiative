//! Listen in Notizen – „A von allen, B von 3, C gar nicht, D von einer Person“.
//!
//! Der Anwender hat das Modell genau beschrieben, und es hat eine Eigenheit,
//! die man leicht übersieht: Die Soll-Zahl steht am EINZELNEN PUNKT, nicht an
//! der Liste. In derselben Packliste kann „Zahnbürste“ von jedem einzeln
//! abzuhaken sein (es geht um sein eigenes Gepäck), während „Kuchen backen“
//! nur einer erledigen muss.
//!
//! Und „alle“ ist keine festgeschriebene Zahl, sondern die Einladungsliste:
//! Wer später dazukommt, muss ebenfalls abhaken. Genau das prüft der letzte
//! Abschnitt.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
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

    async fn anmelden(&self, suffix: &str, name: &str) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": format!("{name}{suffix}"),
                    "displayName": format!("{name} {suffix}"),
                    "password": "passwort123",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
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
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

/// Einen Punkt aus einer Notiz-Antwort holen.
fn punkt<'a>(note: &'a Value, text: &str) -> &'a Value {
    note["items"]
        .as_array()
        .unwrap_or_else(|| panic!("keine Punkte in {note}"))
        .iter()
        .find(|eintrag| eintrag["text"] == json!(text))
        .unwrap_or_else(|| panic!("Punkt „{text}“ fehlt in {note}"))
}

/// Einen Punkt abhaken und die neue Notiz zurueckgeben.
async fn haken(probe: &Probe, event_id: &str, note_id: &str, token: &str, item: &str) -> Value {
    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items/{item}/check"),
            Some(token),
            Some(json!({ "checked": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "abhaken: {body}");
    body
}

#[tokio::test(flavor = "multi_thread")]
async fn a_von_allen_b_von_drei_c_gar_nicht_d_von_einer_person() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (a_token, a_id) = probe.anmelden(&suffix, "lisa").await;
    let (b_token, b_id) = probe.anmelden(&suffix, "mark").await;
    let (c_token, c_id) = probe.anmelden(&suffix, "nora").await;
    let (d_token, d_id) = probe.anmelden(&suffix, "olaf").await;

    // Vier Leute in einer Gruppe.
    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&a_token),
            Some(json!({
                "type": "group",
                "title": "Huette",
                "memberIds": [b_id, c_id, d_id],
            })),
        )
        .await;

    let beginn = chrono::Utc::now() + chrono::Duration::days(7);
    let (_, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&a_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Huettenwochenende",
                "startsAt": beginn.to_rfc3339(),
                "endsAt": (beginn + chrono::Duration::hours(4)).to_rfc3339(),
                "attendeeIds": [a_id, b_id, c_id, d_id],
            })),
        )
        .await;
    let event_id = termin["id"].as_str().unwrap().to_string();

    // Die Liste, genau wie beschrieben.
    let (status, notiz) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            Some(json!({
                "title": "Packliste",
                "body": "",
                "editScope": "author",
                "checkScope": "members",
                "items": [
                    { "text": "A", "requiredAll": true },
                    { "text": "B", "requiredChecks": 3 },
                    { "text": "C" },
                    { "text": "D", "requiredChecks": 1 },
                ],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{notiz}");
    let note_id = notiz["id"].as_str().unwrap().to_string();

    // „Alle“ ist aufgeloest: vier Eingeladene.
    assert_eq!(punkt(&notiz, "A")["needed"], json!(4), "A: alle vier");
    assert_eq!(punkt(&notiz, "B")["needed"], json!(3));
    assert_eq!(punkt(&notiz, "C")["needed"], json!(0), "C muss niemand");
    assert_eq!(punkt(&notiz, "D")["needed"], json!(1));

    // Ein Punkt ohne Soll ist nie „erledigt“ – er ist nur eine Zeile.
    assert_eq!(punkt(&notiz, "C")["done"], json!(false));

    let a_item = punkt(&notiz, "A")["id"].as_str().unwrap().to_string();
    let b_item = punkt(&notiz, "B")["id"].as_str().unwrap().to_string();
    let d_item = punkt(&notiz, "D")["id"].as_str().unwrap().to_string();

    // --- D: einer genuegt ------------------------------------------------
    let nach = haken(&probe, &event_id, &note_id, &b_token, &d_item).await;
    assert_eq!(
        punkt(&nach, "D")["done"],
        json!(true),
        "einer reicht fuer D"
    );

    // --- B: drei muessen ------------------------------------------------
    let nach = haken(&probe, &event_id, &note_id, &a_token, &b_item).await;
    assert_eq!(
        punkt(&nach, "B")["done"],
        json!(false),
        "einer reicht nicht"
    );
    let nach = haken(&probe, &event_id, &note_id, &b_token, &b_item).await;
    assert_eq!(punkt(&nach, "B")["done"], json!(false), "zwei auch nicht");
    let nach = haken(&probe, &event_id, &note_id, &c_token, &b_item).await;
    assert_eq!(punkt(&nach, "B")["done"], json!(true), "drei reichen");

    // --- A: alle vier ----------------------------------------------------
    for token in [&a_token, &b_token, &c_token] {
        haken(&probe, &event_id, &note_id, token, &a_item).await;
    }
    let (_, notizen) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            None,
        )
        .await;
    let aktuell = &notizen["items"][0];
    assert_eq!(punkt(aktuell, "A")["done"], json!(false), "drei von vier");

    let nach = haken(&probe, &event_id, &note_id, &d_token, &a_item).await;
    assert_eq!(punkt(&nach, "A")["done"], json!(true), "jetzt alle vier");

    // --- Und „alle“ waechst mit ------------------------------------------
    // Genau dafuer ist `requiredAll` ein eigenes Feld und keine feste Zahl:
    // Wer spaeter eingeladen wird, muss ebenfalls abhaken.
    let (_, spaet_id) = probe.anmelden(&suffix, "pia").await;
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/calendar/events/{event_id}"),
            Some(&a_token),
            Some(json!({ "attendeeIds": [spaet_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (_, notizen) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            None,
        )
        .await;
    let aktuell = &notizen["items"][0];
    assert_eq!(
        punkt(aktuell, "A")["needed"],
        json!(5),
        "jetzt fuenf Eingeladene"
    );
    assert_eq!(
        punkt(aktuell, "A")["done"],
        json!(false),
        "und damit wieder offen – der Neue fehlt noch"
    );
    // B bleibt bei drei: eine feste Zahl waechst nicht mit.
    assert_eq!(punkt(aktuell, "B")["needed"], json!(3));
    assert_eq!(punkt(aktuell, "B")["done"], json!(true));
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_nicht_darf_hakt_nicht_ab() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (a_token, a_id) = probe.anmelden(&suffix, "quin").await;
    let (b_token, b_id) = probe.anmelden(&suffix, "rita").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&a_token),
            Some(json!({ "type": "group", "title": "Test", "memberIds": [b_id] })),
        )
        .await;
    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let (_, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&a_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Nur lesen",
                "startsAt": beginn.to_rfc3339(),
                "endsAt": (beginn + chrono::Duration::hours(2)).to_rfc3339(),
                "attendeeIds": [a_id, b_id],
            })),
        )
        .await;
    let event_id = termin["id"].as_str().unwrap().to_string();

    // Eine Liste zum Nachlesen: niemand hakt ab, auch der Verfasser nicht.
    let (_, notiz) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            Some(json!({
                "title": "Ablauf",
                "body": "",
                "checkScope": "nobody",
                "items": [{ "text": "18 Uhr Begruessung", "requiredChecks": 1 }],
            })),
        )
        .await;
    let note_id = notiz["id"].as_str().unwrap();
    let item_id = punkt(&notiz, "18 Uhr Begruessung")["id"].as_str().unwrap();

    assert_eq!(notiz["canCheck"], json!(false), "auch fuer den Verfasser");

    for token in [&a_token, &b_token] {
        let (status, _) = probe
            .call(
                "POST",
                &format!(
                    "/api/v1/calendar/events/{event_id}/notes/{note_id}/items/{item_id}/check"
                ),
                Some(token),
                Some(json!({ "checked": true })),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "hier hakt niemand ab");
    }

    // Und hinzufuegen darf nur der Verfasser (Vorgabe folgt editScope).
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items"),
            Some(&b_token),
            Some(json!({ "text": "Nachtrag" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// „Das übernimmt Nora“ – namentlich statt einer Zahl.
///
/// Oft weiss man schon, wer. Dann ist „einer muss“ die schlechtere Angabe: Es
/// hakt irgendwer ab, und niemand weiss hinterher, ob der Kuchen jetzt
/// gebacken wird. Sind Personen benannt, schlagen sie die Zahl.
#[tokio::test(flavor = "multi_thread")]
async fn namentlich_zugewiesen_schlaegt_die_zahl() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (a_token, a_id) = probe.anmelden(&suffix, "sven").await;
    let (b_token, b_id) = probe.anmelden(&suffix, "tina").await;
    let (c_token, c_id) = probe.anmelden(&suffix, "udo").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&a_token),
            Some(json!({ "type": "group", "title": "Fest", "memberIds": [b_id, c_id] })),
        )
        .await;
    let beginn = chrono::Utc::now() + chrono::Duration::days(4);
    let (_, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&a_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Sommerfest",
                "startsAt": beginn.to_rfc3339(),
                "endsAt": (beginn + chrono::Duration::hours(5)).to_rfc3339(),
                "attendeeIds": [a_id, b_id, c_id],
            })),
        )
        .await;
    let event_id = termin["id"].as_str().unwrap().to_string();

    // „Kuchen backen“ übernimmt Tina. Ausdrücklich MIT einer Zahl daneben,
    // damit sich zeigt, dass der Name sie schlägt.
    let (status, notiz) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            Some(json!({
                "title": "Aufgaben",
                "body": "",
                "checkScope": "members",
                "items": [{
                    "text": "Kuchen backen",
                    "requiredChecks": 3,
                    "assigneeIds": [b_id],
                }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{notiz}");
    let note_id = notiz["id"].as_str().unwrap().to_string();
    let kuchen = punkt(&notiz, "Kuchen backen");
    let item_id = kuchen["id"].as_str().unwrap().to_string();

    assert_eq!(kuchen["assigneeIds"], json!([b_id]));
    assert_eq!(kuchen["needed"], json!(1), "der Name schlaegt die 3");
    assert_eq!(kuchen["done"], json!(false));

    // Udo hakt ab – er ist nicht zustaendig, der Punkt wird davon nicht fertig.
    let nach = haken(&probe, &event_id, &note_id, &c_token, &item_id).await;
    let kuchen = punkt(&nach, "Kuchen backen");
    assert_eq!(
        kuchen["done"],
        json!(false),
        "ein fremder Haken macht den Punkt nicht fertig: {kuchen}"
    );
    assert!(
        kuchen["checkedBy"]
            .as_array()
            .unwrap()
            .contains(&json!(c_id)),
        "sein Haken zaehlt aber sichtbar mit – mitgeholfen ist keine Falschangabe"
    );

    // Erst Tina schliesst ihn ab.
    let nach = haken(&probe, &event_id, &note_id, &b_token, &item_id).await;
    assert_eq!(punkt(&nach, "Kuchen backen")["done"], json!(true));

    // Und die Zuweisung laesst sich zuruecknehmen – dann gilt wieder die Zahl.
    let (status, nach) = probe
        .call(
            "PATCH",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items/{item_id}"),
            Some(&a_token),
            Some(json!({ "assigneeIds": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nach}");
    let kuchen = punkt(&nach, "Kuchen backen");
    assert_eq!(kuchen["needed"], json!(3), "wieder die Zahl");
    assert_eq!(kuchen["done"], json!(false), "zwei von drei");
}

/// Rechte einer Liste **nachträglich** ändern.
///
/// Der Fehler, den das hier festhält, war unangenehm still: Die Oberfläche
/// schickte `addScope` und `checkScope` bei jedem Speichern mit, aber
/// `UpdateNoteInput` kannte die beiden Felder nicht – und serde wirft
/// unbekannte Felder kommentarlos weg. Die Route antwortete daraufhin 200 mit
/// dem **alten** Wert, die Oberfläche schrieb ihn zurück in ihren Zustand, und
/// der Regler sprang zurück. Kein Fehler, keine Meldung, nichts im Protokoll.
///
/// Beim Anlegen ging es immer, weil `NoteInput` die Felder kennt. Genau das
/// machte es so schwer zu glauben – man ändert etwas, es springt zurück, und
/// eine neue Liste mit demselben Wert funktioniert.
///
/// Der Test prüft deshalb nicht nur die Antwort, sondern die **Wirkung**: ob
/// jemand danach wirklich darf, was die neue Stufe erlaubt.
#[tokio::test(flavor = "multi_thread")]
async fn geaenderte_rechte_einer_liste_bleiben_geaendert() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (a_token, a_id) = probe.anmelden(&suffix, "rechtea").await;
    let (b_token, b_id) = probe.anmelden(&suffix, "rechteb").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&a_token),
            Some(json!({ "type": "group", "title": "Rechte", "memberIds": [b_id] })),
        )
        .await;

    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let (_, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&a_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Einkauf",
                "startsAt": beginn.to_rfc3339(),
                "endsAt": (beginn + chrono::Duration::hours(2)).to_rfc3339(),
                "attendeeIds": [a_id, b_id],
            })),
        )
        .await;
    let event_id = termin["id"].as_str().unwrap().to_string();

    // Eng angelegt: nur der Verfasser darf ergänzen und abhaken.
    let (status, notiz) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(&a_token),
            Some(json!({
                "title": "Einkaufsliste",
                "body": "",
                "editScope": "author",
                "addScope": "author",
                "checkScope": "author",
                "items": [{ "text": "Milch" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{notiz}");
    let note_id = notiz["id"].as_str().unwrap().to_string();

    // Mark darf jetzt noch nicht ergänzen.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items"),
            Some(&b_token),
            Some(json!({ "text": "Brot" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "vorher darf Mark nicht");

    // --- Die Änderung, um die es geht -----------------------------------
    // `editScope` bleibt bewusst unerwähnt: Genau so schickt die Oberfläche
    // eine reine Änderung der beiden anderen Rechte.
    let (status, geaendert) = probe
        .call(
            "PATCH",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}"),
            Some(&a_token),
            Some(json!({ "addScope": "members", "checkScope": "members" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{geaendert}");

    // Die Antwort muss den NEUEN Wert tragen. Stand hier der alte, schrieb die
    // Oberfläche ihn zurück – das war der sichtbare Teil des Fehlers.
    assert_eq!(
        geaendert["addScope"],
        json!("members"),
        "die Antwort trägt den alten Wert zurück: {geaendert}"
    );
    assert_eq!(geaendert["checkScope"], json!("members"), "{geaendert}");

    // Und noch einmal frisch geladen – nicht nur die Antwort, auch die Ablage.
    let gespeichert = &notiz_laden(&probe, &event_id, &note_id, &a_token).await;
    assert_eq!(
        gespeichert["addScope"],
        json!("members"),
        "nach dem Neuladen wieder der alte Wert"
    );
    assert_eq!(gespeichert["checkScope"], json!("members"));

    // --- Die Wirkung ----------------------------------------------------
    // Ein gespeicherter Wert, der nichts erlaubt, wäre nur die halbe Miete.
    let (status, punkt) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items"),
            Some(&b_token),
            Some(json!({ "text": "Brot" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "Mark darf jetzt ergänzen: {punkt}");

    let milch = punkt_von(&probe, &event_id, &note_id, &a_token, "Milch").await;
    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/notes/{note_id}/items/{milch}/check"),
            Some(&b_token),
            Some(json!({ "checked": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "Mark darf jetzt abhaken: {body}");
}

/// Eine Notiz frisch vom Server holen – nicht die Antwort von vorhin.
///
/// Der Termin selbst traegt die Notizen nicht; dafuer gibt es eine eigene
/// Route.
async fn notiz_laden(probe: &Probe, event_id: &str, note_id: &str, token: &str) -> Value {
    let (status, geladen) = probe
        .call(
            "GET",
            &format!("/api/v1/calendar/events/{event_id}/notes"),
            Some(token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{geladen}");
    geladen["items"]
        .as_array()
        .and_then(|liste| liste.iter().find(|n| n["id"] == json!(note_id)))
        .unwrap_or_else(|| panic!("Notiz fehlt in {geladen}"))
        .clone()
}

/// Die Kennung eines Punktes holen.
async fn punkt_von(
    probe: &Probe,
    event_id: &str,
    note_id: &str,
    token: &str,
    text: &str,
) -> String {
    let notiz = notiz_laden(probe, event_id, note_id, token).await;
    punkt(&notiz, text)["id"].as_str().unwrap().to_string()
}
