//! Gruppenverwaltung, Einladungslinks, Sperren, Privatsphäre, Chat leeren,
//! Sitzungen und Mitteilungen je Chat – geprüft am Server, nicht an der
//! Oberfläche: Was der Server hinausgibt, ist das, was jemand sehen kann.
//!
//! Ohne `TEST_DATABASE_URL`/`DATABASE_URL` überspringen sich die Tests wie die
//! übrigen Integrationstests.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::Receiver;
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

impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

#[derive(Clone)]
struct Konto {
    token: String,
    refresh: String,
    id: Uuid,
}

impl Probe {
    async fn roh(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        self.roh(request).await
    }

    async fn konto(&self, name: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .header(
                "user-agent",
                "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0",
            )
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                }))
                .unwrap(),
            ))
            .unwrap();
        let (status, body) = self.roh(request).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            refresh: body["refreshToken"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            id: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        }
    }

    async fn anmelden(&self, name: &str, geraet: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header("content-type", "application/json")
            .header("user-agent", geraet)
            .body(Body::from(
                serde_json::to_vec(&json!({ "username": name, "password": "richtigespasswort" }))
                    .unwrap(),
            ))
            .unwrap();
        let (status, body) = self.roh(request).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            refresh: body["refreshToken"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            id: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        }
    }

    async fn gruppe(&self, a: &Konto, andere: &[&Konto]) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                &a.token,
                Some(json!({
                    "type": "group",
                    "title": "Runde",
                    "memberIds": andere.iter().map(|k| k.id).collect::<Vec<_>>(),
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn direkt(&self, a: &Konto, b: &Konto) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                &a.token,
                Some(json!({ "type": "direct", "memberIds": [b.id] })),
            )
            .await;
        assert!(status.is_success(), "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn senden_status(&self, von: &Konto, chat: &str, text: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("/api/v1/conversations/{chat}/messages"),
            &von.token,
            Some(json!({ "type": "text", "body": text })),
        )
        .await
    }

    async fn senden(&self, von: &Konto, chat: &str, text: &str) -> String {
        let (status, nachricht) = self.senden_status(von, chat, text).await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn chat(&self, wer: &Konto, chat: &str) -> Value {
        let (status, dto) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}"),
                &wer.token,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{dto}");
        dto
    }

    async fn aendern(&self, wer: &Konto, chat: &str, body: Value) -> (StatusCode, Value) {
        self.call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}"),
            &wer.token,
            Some(body),
        )
        .await
    }

    async fn texte(&self, wer: &Konto, chat: &str) -> Vec<String> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                &wer.token,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["type"] == "text")
            .map(|m| m["body"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    async fn systemarten(&self, wer: &Konto, chat: &str) -> Vec<String> {
        let (_, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                &wer.token,
                None,
            )
            .await;
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["type"] == "system")
            .map(|m| {
                m["metadata"]["system"]["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn horchen(&self, wer: &Konto) -> Receiver<String> {
        let (_id, ausgang, _) = self.state.hub.register(wer.id);
        ausgang.empfang
    }

    fn push_an(&self) -> Vec<Uuid> {
        self.push
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| *id)
            .collect()
    }
}

fn eingang(empfang: &mut Receiver<String>, typ: &str) -> Vec<Value> {
    let mut alles = Vec::new();
    while let Ok(rahmen) = empfang.try_recv() {
        if let Ok(wert) = serde_json::from_str::<Value>(&rahmen) {
            if wert["type"] == typ {
                alles.push(wert);
            }
        }
    }
    alles
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "4");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/gruppen-{}", Uuid::now_v7().simple()),
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

async fn drei(p: &Probe) -> (Konto, Konto, Konto) {
    let n = kurz();
    (
        p.konto(&format!("ga{n}")).await,
        p.konto(&format!("gb{n}")).await,
        p.konto(&format!("gc{n}")).await,
    )
}

fn mitglied<'a>(chat: &'a Value, id: Uuid) -> &'a Value {
    chat["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["userId"] == id.to_string())
        .expect("Mitglied")
}

/* ---------- 1. Rechte und Rangordnung ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn rangordnung_wie_der_server_sie_vorgibt_samt_systemzeilen() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let n = kurz();
    let d = p.konto(&format!("gd{n}")).await;
    let chat = p.gruppe(&a, &[&b, &c, &d]).await;
    let mitglieder = |k: &Konto| format!("/api/v1/conversations/{chat}/members/{}", k.id);

    // A macht B zum Admin – mit Systemzeile.
    let (s, _) = p
        .call(
            "PATCH",
            &mitglieder(&b),
            &a.token,
            Some(json!({"role": "admin"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    // Admins nicht nach oben: B darf weder A herabstufen noch jemanden zum Besitzer machen.
    let (s, _) = p
        .call(
            "PATCH",
            &mitglieder(&a),
            &b.token,
            Some(json!({"role": "member"})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = p
        .call(
            "PATCH",
            &mitglieder(&c),
            &b.token,
            Some(json!({"role": "owner"})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Ein Mitglied moderiert nicht.
    let (s, _) = p.call("DELETE", &mitglieder(&d), &c.token, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // B (Admin) entfernt D (Mitglied).
    let (s, _) = p.call("DELETE", &mitglieder(&d), &b.token, None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    // Spitzname durch einen Admin.
    let (s, dto) = p
        .call(
            "PATCH",
            &mitglieder(&c),
            &b.token,
            Some(json!({"nickname": "Cäsar"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(mitglied(&dto, c.id)["nickname"], "Cäsar");
    // Admin entziehen: A stuft B herab.
    let (s, _) = p
        .call(
            "PATCH",
            &mitglieder(&b),
            &a.token,
            Some(json!({"role": "member"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    // Besitz übergeben: A → C, A wird Admin.
    let (s, dto) = p
        .call(
            "PATCH",
            &mitglieder(&c),
            &a.token,
            Some(json!({"role": "owner"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(mitglied(&dto, c.id)["role"], "owner");
    assert_eq!(mitglied(&dto, a.id)["role"], "admin");

    let arten = p.systemarten(&c, &chat).await;
    for art in [
        "member.promoted",
        "member.removed",
        "member.demoted",
        "owner.transferred",
    ] {
        assert!(arten.contains(&art.to_string()), "{art} fehlt in {arten:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn gruppeninfo_titel_beschreibung_und_schalter() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;

    // Voreinstellung: nur Admins ändern die Info.
    let (s, _) = p.aendern(&b, &chat, json!({"title": "Neu"})).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, dto) = p
        .aendern(
            &a,
            &chat,
            json!({"title": "Grillrunde", "description": "Samstags."}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{dto}");
    assert_eq!(dto["title"], "Grillrunde");
    assert_eq!(dto["description"], "Samstags.");
    assert_eq!(dto["settings"]["nurAdminsInfo"], true);
    // Länge begrenzt.
    let (s, _) = p
        .aendern(&a, &chat, json!({"description": "x".repeat(513)}))
        .await;
    assert!(s.is_client_error(), "{s}");
    // Schalter nur für Admins, auch wenn Mitglieder die Info ändern dürfen.
    let (s, _) = p
        .aendern(&a, &chat, json!({"settings": {"nurAdminsInfo": false}}))
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, dto) = p.aendern(&b, &chat, json!({"title": "Von B"})).await;
    assert_eq!(s, StatusCode::OK, "{dto}");
    let (s, _) = p
        .aendern(&b, &chat, json!({"settings": {"nurAdminsSenden": true}}))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let arten = p.systemarten(&a, &chat).await;
    assert!(
        arten.contains(&"conversation.renamed".to_string()),
        "{arten:?}"
    );
    assert!(arten.contains(&"conversation.description".to_string()));
    assert!(arten.contains(&"conversation.settings".to_string()));

    // Ein Direktchat hat keine Gruppeninfo.
    let direkt = p.direkt(&a, &b).await;
    let (s, _) = p.aendern(&a, &direkt, json!({"description": "x"})).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

/* ---------- 2. Nur Admins senden, langsamer Modus ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn nur_admins_senden_gilt_fuer_nachrichten_und_umfragen() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    let (s, _) = p
        .aendern(&a, &chat, json!({"settings": {"nurAdminsSenden": true}}))
        .await;
    assert_eq!(s, StatusCode::OK);

    let (s, _) = p.senden_status(&b, &chat, "darf ich?").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = p
        .call(
            "POST",
            "/api/v1/polls",
            &b.token,
            Some(json!({
                "conversationId": chat, "kind": "choice", "question": "Pizza?",
                "options": [{"label": "Ja"}, {"label": "Nein"}]
            })),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::FORBIDDEN,
        "auch eine Umfrage ist eine Nachricht"
    );
    p.senden(&a, &chat, "Admins dürfen").await;

    let (s, _) = p
        .aendern(&a, &chat, json!({"settings": {"nurAdminsSenden": false}}))
        .await;
    assert_eq!(s, StatusCode::OK);
    p.senden(&b, &chat, "jetzt wieder").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn langsamer_modus_bremst_mitglieder_nicht_admins_und_nicht_wiederholungen() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    let (s, _) = p
        .aendern(&a, &chat, json!({"settings": {"langsamerModus": 7}}))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "nur feste Stufen");
    let (s, dto) = p
        .aendern(&a, &chat, json!({"settings": {"langsamerModus": 30}}))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(dto["settings"]["langsamerModus"], 30);

    let erste = |text: &str| json!({ "type": "text", "body": text, "clientId": "langsam-1" });
    let url = format!("/api/v1/conversations/{chat}/messages");
    let (s, original) = p.call("POST", &url, &b.token, Some(erste("eins"))).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, fehler) = p.senden_status(&b, &chat, "zwei").await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "{fehler}");
    // Die Wiederholung (gleicher clientId) bekommt das Original, nicht 429.
    let (s, wieder) = p.call("POST", &url, &b.token, Some(erste("eins"))).await;
    assert!(s.is_success(), "{wieder}");
    assert_eq!(wieder["id"], original["id"]);
    // Admins sind ausgenommen.
    p.senden(&a, &chat, "a1").await;
    p.senden(&a, &chat, "a2").await;
    // Ist die Zeit um, geht es wieder.
    sqlx::query(
        "update conversation_members set zuletzt_gesendet = now() - interval '31 seconds'
          where conversation_id = $1::uuid and user_id = $2",
    )
    .bind(&chat)
    .bind(b.id)
    .execute(&p.state.pool)
    .await
    .unwrap();
    p.senden(&b, &chat, "drei").await;
}

/* ---------- 3. Einladungslinks ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn einladungslink_vorschau_ohne_inhalt_beitritt_ab_jetzt() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    p.senden(&a, &chat, "geheimer Plan vor dem Beitritt").await;

    let links = format!("/api/v1/conversations/{chat}/einladungen");
    let (s, _) = p.call("POST", &links, &b.token, Some(json!({}))).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "nur Admins");
    let (s, link) = p
        .call("POST", &links, &a.token, Some(json!({"maxUses": 2})))
        .await;
    assert_eq!(s, StatusCode::CREATED, "{link}");
    let token = link["token"].as_str().unwrap().to_string();

    let (s, vorschau) = p
        .call("GET", &format!("/api/v1/beitritt/{token}"), &c.token, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(vorschau["title"], "Runde");
    assert_eq!(vorschau["memberCount"], 2);
    // Kein Inhalt: weder Mitglieder noch Nachrichten noch die Kennung.
    let text = vorschau.to_string();
    assert!(!text.contains("geheimer"));
    assert!(vorschau.get("members").is_none());
    assert!(vorschau["conversationId"].is_null());
    // Vor dem Beitritt: kein Zugang.
    let (s, _) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/messages"),
            &c.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (s, ergebnis) = p
        .call("POST", &format!("/api/v1/beitritt/{token}"), &c.token, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(ergebnis["status"], "beigetreten");
    // Verlaufsgrenze: nichts von vorher.
    assert!(p.texte(&c, &chat).await.is_empty());
    let dto = p.chat(&c, &chat).await;
    assert_eq!(
        dto["lastMessage"]["metadata"]["system"]["kind"],
        "member.joined"
    );

    // Ausgeschöpft (2 Nutzungen: C und D), abgelaufen, zurückgezogen: dieselbe Antwort.
    let n = kurz();
    let d = p.konto(&format!("gd{n}")).await;
    let e = p.konto(&format!("ge{n}")).await;
    let (s, _) = p
        .call("POST", &format!("/api/v1/beitritt/{token}"), &d.token, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, voll) = p
        .call("GET", &format!("/api/v1/beitritt/{token}"), &e.token, None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (_, zweiter) = p.call("POST", &links, &a.token, Some(json!({}))).await;
    let zweiter_token = zweiter["token"].as_str().unwrap().to_string();
    sqlx::query("update conversation_invites set expires_at = now() - interval '1 minute' where id = $1::uuid")
        .bind(zweiter["id"].as_str().unwrap())
        .execute(&p.state.pool)
        .await
        .unwrap();
    let (s, abgelaufen) = p
        .call(
            "GET",
            &format!("/api/v1/beitritt/{zweiter_token}"),
            &e.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(abgelaufen, voll, "keine Auskunft, woran es lag");
    let (_, dritter) = p.call("POST", &links, &a.token, Some(json!({}))).await;
    let (s, _) = p
        .call(
            "DELETE",
            &format!("{links}/{}", dritter["id"].as_str().unwrap()),
            &a.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/beitritt/{}", dritter["token"].as_str().unwrap()),
            &e.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn beitritt_nach_freigabe_und_bremse_gegen_raten() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    let (_, link) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/einladungen"),
            &a.token,
            Some(json!({"freigabe": true, "gueltigStunden": 24})),
        )
        .await;
    let token = link["token"].as_str().unwrap();
    let (s, ergebnis) = p
        .call("POST", &format!("/api/v1/beitritt/{token}"), &c.token, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(ergebnis["status"], "angefragt");
    // Doppelt getippt: keine zweite Anfrage.
    p.call("POST", &format!("/api/v1/beitritt/{token}"), &c.token, None)
        .await;
    let (s, _) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}"),
            &c.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "noch nicht drin");

    let anfragen = format!("/api/v1/conversations/{chat}/anfragen");
    let (s, _) = p.call("GET", &anfragen, &b.token, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, liste) = p.call("GET", &anfragen, &a.token, None).await;
    assert_eq!(s, StatusCode::OK);
    let items = liste["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["user"]["id"], c.id.to_string());
    let anfrage = items[0]["id"].as_str().unwrap();
    let (s, _) = p
        .call(
            "POST",
            &format!("{anfragen}/{anfrage}"),
            &a.token,
            Some(json!({"annehmen": true})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let dto = p.chat(&c, &chat).await;
    assert_eq!(
        dto["lastMessage"]["metadata"]["system"]["kind"],
        "member.approved"
    );
    // Schon entschieden.
    let (s, _) = p
        .call(
            "POST",
            &format!("{anfragen}/{anfrage}"),
            &a.token,
            Some(json!({"annehmen": false})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Raten: nach zwanzig Versuchen ist Schluss.
    let mut gebremst = false;
    for i in 0..25 {
        let (s, _) = p
            .call(
                "GET",
                &format!("/api/v1/beitritt/geraten{i}"),
                &b.token,
                None,
            )
            .await;
        if s == StatusCode::TOO_MANY_REQUESTS {
            gebremst = true;
            break;
        }
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
    assert!(gebremst, "Raten muss gebremst werden");
}

/* ---------- 4. Liste: anheften, ungelesen, Ordner, stumm ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn anheften_hoechstens_fuenf_und_ungelesen_faellt_beim_lesen() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let mut chats = Vec::new();
    for _ in 0..6 {
        chats.push(p.gruppe(&a, &[&b]).await);
    }
    for chat in &chats[..5] {
        let (s, dto) = p.aendern(&a, chat, json!({"pinned": true})).await;
        assert_eq!(s, StatusCode::OK, "{dto}");
        assert!(dto["pinnedAt"].is_string());
    }
    let (s, _) = p.aendern(&a, &chats[5], json!({"pinned": true})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    // Reihenfolge: der zuerst genannte oben.
    let (s, _) = p
        .call(
            "PUT",
            "/api/v1/conversations/angeheftet",
            &a.token,
            Some(json!({"ids": [chats[4], chats[0]]})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, liste) = p.call("GET", "/api/v1/conversations", &a.token, None).await;
    let ids: Vec<&str> = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids[0], chats[4]);
    assert_eq!(ids[1], chats[0]);

    // Als ungelesen markieren – und Lesen setzt es zurück.
    let id = p.senden(&b, &chats[0], "hallo").await;
    let (_, dto) = p
        .aendern(&a, &chats[0], json!({"markedUnread": true}))
        .await;
    assert_eq!(dto["markedUnread"], true);
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{}/read", chats[0]),
            &a.token,
            Some(json!({"messageId": id})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(p.chat(&a, &chats[0]).await["markedUnread"], false);

    // Stumm „für immer“ – fernes Datum; Vergangenheit heisst nicht stumm.
    let (_, dto) = p
        .aendern(&a, &chats[1], json!({"mutedUntil": "9999-12-31T00:00:00Z"}))
        .await;
    assert!(dto["mutedUntil"].as_str().unwrap().starts_with("9999"));
    let (_, dto) = p
        .aendern(&a, &chats[1], json!({"mutedUntil": "2000-01-01T00:00:00Z"}))
        .await;
    assert!(dto["mutedUntil"].is_null());

    // Ordner: fremde Chats fallen heraus.
    let fremd = p
        .gruppe(&b, &[&p.konto(&format!("gx{}", kurz())).await])
        .await;
    let (s, ordner) = p
        .call(
            "POST",
            "/api/v1/chat-ordner",
            &a.token,
            Some(json!({"name": "Arbeit", "chats": [chats[0], fremd]})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{ordner}");
    assert_eq!(ordner["chats"], json!([chats[0]]));
    let (_, liste) = p.call("GET", "/api/v1/chat-ordner", &b.token, None).await;
    assert!(
        liste["items"].as_array().unwrap().is_empty(),
        "Ordner sind privat"
    );

    // Hintergrund nur aus der Auswahl, je Person.
    let (s, _) = p
        .aendern(&a, &chats[0], json!({"hintergrund": "url(evil)"}))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (_, dto) = p
        .aendern(&a, &chats[0], json!({"hintergrund": "salbei"}))
        .await;
    assert_eq!(dto["hintergrund"], "salbei");
    assert!(p.chat(&b, &chats[0]).await["hintergrund"].is_null());
}

/* ---------- 5. Chat leeren, Direktchat löschen ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn leeren_gilt_in_jedem_lesepfad() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    p.senden(&b, &chat, "Zitronenkuchen alt").await;
    let alt = p.senden(&b, &chat, "zweite alte").await;

    let (s, dto) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/leeren"),
            &a.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{dto}");
    assert!(dto["clearedUntil"].is_string());
    assert!(dto["lastMessage"].is_null(), "Vorschau leer");
    assert_eq!(dto["unreadCount"], 0);
    assert_eq!(dto["verdeckterVerlauf"], false, "nichts zu beantragen");
    // Die anderen sehen meine Grenze von vorher, nicht wann ich geleert habe.
    let bei_b = p.chat(&b, &chat).await;
    assert_eq!(
        mitglied(&bei_b, a.id)["siehtAb"],
        mitglied(&p.chat(&a, &chat).await, a.id)["siehtAb"]
    );
    assert_ne!(mitglied(&bei_b, a.id)["siehtAb"], dto["clearedUntil"]);

    // Verlauf, Suche, Einzelabruf, Zitat.
    assert!(p.texte(&a, &chat).await.is_empty());
    assert_eq!(p.texte(&b, &chat).await.len(), 2, "B behält alles");
    let (_, suche) = p
        .call(
            "GET",
            "/api/v1/search/messages?q=Zitronenkuchen",
            &a.token,
            None,
        )
        .await;
    assert!(suche["items"].as_array().unwrap().is_empty());
    let (s, _) = p
        .call("GET", &format!("/api/v1/messages/{alt}"), &a.token, None)
        .await;
    assert!(
        s == StatusCode::FORBIDDEN || s == StatusCode::NOT_FOUND,
        "{s}"
    );
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/verlauf"),
            &a.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "kein Antrag auf Geleertes");

    // Neues kommt an.
    p.senden(&b, &chat, "neu").await;
    assert_eq!(p.texte(&a, &chat).await, vec!["neu".to_string()]);
    assert_eq!(p.chat(&a, &chat).await["unreadCount"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_datei_von_vor_dem_leeren_bleibt_zu() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b]).await;
    // Ein fertiger Anhang an einer Nachricht von B – direkt in der Datenbank,
    // die Prüfung `zugriff::anhang` liest nur die Zeilen.
    let nachricht = p.senden(&b, &chat, "mit Bild").await;
    let anhang = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, message_id, kind, mime, size, storage_key, status)
         values ($1, $2, $3::uuid, 'image', 'image/png', 1, $4, 'ready')",
    )
    .bind(anhang)
    .bind(b.id)
    .bind(&nachricht)
    .bind(format!("test/{anhang}"))
    .execute(&p.state.pool)
    .await
    .expect("Anhang anlegen");
    let vorher = initiative_api::services::zugriff::anhang(&p.state.pool, anhang, a.id)
        .await
        .unwrap();
    assert!(!matches!(
        vorher.grund,
        initiative_api::services::zugriff::Grund::Keins
    ));
    p.call(
        "POST",
        &format!("/api/v1/conversations/{chat}/leeren"),
        &a.token,
        None,
    )
    .await;
    let nachher = initiative_api::services::zugriff::anhang(&p.state.pool, anhang, a.id)
        .await
        .unwrap();
    assert!(matches!(
        nachher.grund,
        initiative_api::services::zugriff::Grund::Keins
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn direktchat_fuer_mich_loeschen_bis_neues_kommt() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, _) = drei(&p).await;
    let chat = p.direkt(&a, &b).await;
    p.senden(&b, &chat, "alt").await;
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/ausblenden"),
            &a.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let in_liste = |liste: &Value| {
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == chat)
    };
    let (_, liste) = p.call("GET", "/api/v1/conversations", &a.token, None).await;
    assert!(!in_liste(&liste));
    let (_, liste) = p.call("GET", "/api/v1/conversations", &b.token, None).await;
    assert!(in_liste(&liste), "B behält ihn");
    p.senden(&b, &chat, "wieder da").await;
    let (_, liste) = p.call("GET", "/api/v1/conversations", &a.token, None).await;
    assert!(in_liste(&liste));
    assert_eq!(p.texte(&a, &chat).await, vec!["wieder da".to_string()]);
    // Gruppen löscht man nicht, man verlässt sie.
    let gruppe = p.gruppe(&a, &[&b]).await;
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{gruppe}/ausblenden"),
            &a.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

/* ---------- 6. Blockieren und Melden ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn blockieren_sperrt_schreiben_suche_profil_und_hinzufuegen() {
    let Some(p) = aufbauen().await else { return };
    let n = kurz();
    let a = p.konto(&format!("ba{n}")).await;
    let b = p.konto(&format!("bb{n}")).await;
    let chat = p.direkt(&a, &b).await;
    p.senden(&a, &chat, "vorher").await;
    sqlx::query("update users set last_seen_at = now(), bio = 'über mich' where id = $1")
        .bind(b.id)
        .execute(&p.state.pool)
        .await
        .unwrap();

    let (s, _) = p
        .call(
            "PUT",
            &format!("/api/v1/users/{}/block", a.id),
            &b.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = p.senden_status(&a, &chat, "geht nicht").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = p.senden_status(&b, &chat, "erst freigeben").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Suche in beide Richtungen leer.
    let (_, suche) = p
        .call("GET", &format!("/api/v1/users?q=bb{n}"), &a.token, None)
        .await;
    assert!(suche["items"].as_array().unwrap().is_empty());
    let (_, suche) = p
        .call("GET", &format!("/api/v1/users?q=ba{n}"), &b.token, None)
        .await;
    assert!(suche["items"].as_array().unwrap().is_empty());
    // Profil ohne zuletzt online und ohne Angaben – auch im Chat.
    let (_, profil) = p
        .call("GET", &format!("/api/v1/users/{}", b.id), &a.token, None)
        .await;
    assert!(profil["lastSeenAt"].is_null());
    assert!(profil["bio"].is_null());
    let dto = p.chat(&a, &chat).await;
    assert!(mitglied(&dto, b.id)["user"]["lastSeenAt"].is_null());
    // B selbst sieht sich unverändert.
    let dto_b = p.chat(&b, &chat).await;
    assert!(mitglied(&dto_b, b.id)["user"]["lastSeenAt"].is_string());
    // A holt B nicht in eine Gruppe.
    let c = p.konto(&format!("bc{n}")).await;
    let gruppe = p.gruppe(&a, &[&c]).await;
    let (s, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{gruppe}/members"),
            &a.token,
            Some(json!({"memberIds": [b.id]})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Blockliste.
    let (_, liste) = p.call("GET", "/api/v1/blockiert", &b.token, None).await;
    assert_eq!(liste["items"][0]["id"], a.id.to_string());

    // Freigeben – und es geht wieder.
    let (s, _) = p
        .call(
            "DELETE",
            &format!("/api/v1/users/{}/block", a.id),
            &b.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    p.senden(&a, &chat, "wieder").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn melden_nur_was_man_sieht_und_die_verwaltung_bearbeitet() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let chat = p.direkt(&a, &b).await;
    let nachricht = p.senden(&a, &chat, "unfreundlich").await;
    let fremd_chat = p.direkt(&a, &c).await;
    let fremd = p.senden(&a, &fremd_chat, "privat").await;

    let (s, _) = p
        .call("POST", "/api/v1/meldungen", &b.token, Some(json!({"messageId": nachricht, "grund": "belaestigung", "freitext": "bitte prüfen"})))
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = p
        .call(
            "POST",
            "/api/v1/meldungen",
            &b.token,
            Some(json!({"messageId": fremd, "grund": "spam"})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "nicht sichtbar, nicht meldbar");
    let (s, _) = p
        .call(
            "POST",
            "/api/v1/meldungen",
            &b.token,
            Some(json!({"userId": a.id, "grund": "quatsch"})),
        )
        .await;
    assert!(
        s == StatusCode::BAD_REQUEST || s == StatusCode::UNPROCESSABLE_ENTITY,
        "{s}"
    );

    let (s, _) = p
        .call("GET", "/api/v1/admin/meldungen", &b.token, None)
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    sqlx::query("update users set is_admin = true where id = $1")
        .bind(c.id)
        .execute(&p.state.pool)
        .await
        .unwrap();
    let (s, liste) = p
        .call(
            "GET",
            "/api/v1/admin/meldungen?status=offen",
            &c.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let meldung = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["messageId"] == nachricht)
        .expect("Meldung")
        .clone();
    assert_eq!(meldung["nachrichtAuszug"], "unfreundlich");
    assert_eq!(meldung["targetUserId"], a.id.to_string());
    let (s, neu) = p
        .call(
            "PATCH",
            &format!(
                "/api/v1/admin/meldungen/{}",
                meldung["id"].as_str().unwrap()
            ),
            &c.token,
            Some(json!({"status": "erledigt", "notiz": "verwarnt"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(neu["status"], "erledigt");
    sqlx::query("update users set is_admin = false where id = $1")
        .bind(c.id)
        .execute(&p.state.pool)
        .await
        .unwrap();
}

/* ---------- 7. Privatsphäre ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn zuletzt_online_und_lesebestaetigungen_werden_gefiltert() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let direkt = p.direkt(&a, &b).await;
    let gruppe = p.gruppe(&a, &[&b, &c]).await;
    sqlx::query("update users set last_seen_at = now() where id = $1")
        .bind(b.id)
        .execute(&p.state.pool)
        .await
        .unwrap();

    let (s, _) = p
        .call(
            "PATCH",
            "/api/v1/users/me",
            &b.token,
            Some(json!({"settings": {"privacy": {"lastSeen": "unsinn"}}})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, ich) = p
        .call(
            "PATCH",
            "/api/v1/users/me",
            &b.token,
            Some(json!({"settings": {"privacy": {"lastSeen": "niemand", "readReceipts": false}}})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(ich["settings"]["privacy"]["lastSeen"], "niemand");
    assert_eq!(
        ich["settings"]["privacy"]["typing"], true,
        "Unberührtes bleibt"
    );

    let (_, profil) = p
        .call("GET", &format!("/api/v1/users/{}", b.id), &a.token, None)
        .await;
    assert!(profil["lastSeenAt"].is_null());
    assert!(mitglied(&p.chat(&a, &direkt).await, b.id)["user"]["lastSeenAt"].is_null());

    // B liest im Direktchat: A erfährt es nicht (weder Ereignis noch Liste).
    let mut horcher_a = p.horchen(&a);
    let id = p.senden(&a, &direkt, "gelesen?").await;
    p.call(
        "POST",
        &format!("/api/v1/conversations/{direkt}/read"),
        &b.token,
        Some(json!({"messageId": id})),
    )
    .await;
    assert!(eingang(&mut horcher_a, "read.updated").is_empty());
    assert!(mitglied(&p.chat(&a, &direkt).await, b.id)["lastReadMessageId"].is_null());
    // Gegenseitig: B sieht auch die von A nicht.
    p.call(
        "POST",
        &format!("/api/v1/conversations/{direkt}/read"),
        &a.token,
        Some(json!({"messageId": id})),
    )
    .await;
    assert!(mitglied(&p.chat(&b, &direkt).await, a.id)["lastReadMessageId"].is_null());
    // In Gruppen bleiben sie sichtbar.
    eingang(&mut horcher_a, "read.updated");
    let gid = p.senden(&a, &gruppe, "in der Gruppe").await;
    p.call(
        "POST",
        &format!("/api/v1/conversations/{gruppe}/read"),
        &b.token,
        Some(json!({"messageId": gid})),
    )
    .await;
    assert_eq!(eingang(&mut horcher_a, "read.updated").len(), 1);
    assert_eq!(
        mitglied(&p.chat(&a, &gruppe).await, b.id)["lastReadMessageId"],
        gid
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tippen_und_praesenz_folgen_der_privatsphaere() {
    use initiative_api::services::privatsphaere::{praesenz_melden, tipp_empfaenger};
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    p.gruppe(&a, &[&b, &c]).await;

    // Alles an: alle bekommen.
    let mut alle = tipp_empfaenger(&p.state.pool, a.id, vec![b.id, c.id])
        .await
        .unwrap();
    alle.sort();
    let mut erwartet = vec![b.id, c.id];
    erwartet.sort();
    assert_eq!(alle, erwartet);
    // C hat die Anzeige aus: bekommt keine (gegenseitig).
    p.call(
        "PATCH",
        "/api/v1/users/me",
        &c.token,
        Some(json!({"settings": {"privacy": {"typing": false}}})),
    )
    .await;
    assert_eq!(
        tipp_empfaenger(&p.state.pool, a.id, vec![b.id, c.id])
            .await
            .unwrap(),
        vec![b.id]
    );
    assert!(tipp_empfaenger(&p.state.pool, c.id, vec![a.id, b.id])
        .await
        .unwrap()
        .is_empty());
    // Sperre: B hat A blockiert.
    p.call(
        "PUT",
        &format!("/api/v1/users/{}/block", a.id),
        &b.token,
        None,
    )
    .await;
    assert!(tipp_empfaenger(&p.state.pool, a.id, vec![b.id])
        .await
        .unwrap()
        .is_empty());

    // Präsenz: A verbirgt „online“ – C bekommt das Kommen nicht, das Gehen
    // (mit „zuletzt online“) schon; B (Sperre) gar nichts.
    p.call(
        "PATCH",
        "/api/v1/users/me",
        &a.token,
        Some(json!({"settings": {"privacy": {"online": "niemand"}}})),
    )
    .await;
    let mut horcher_b = p.horchen(&b);
    let mut horcher_c = p.horchen(&c);
    praesenz_melden(&p.state, a.id, true, vec![b.id, c.id])
        .await
        .unwrap();
    assert!(eingang(&mut horcher_c, "presence").is_empty());
    praesenz_melden(&p.state, a.id, false, vec![b.id, c.id])
        .await
        .unwrap();
    let gehen = eingang(&mut horcher_c, "presence");
    assert_eq!(gehen.len(), 1);
    assert_eq!(gehen[0]["payload"]["online"], false);
    assert!(gehen[0]["payload"]["lastSeenAt"].is_string());
    assert!(eingang(&mut horcher_b, "presence").is_empty());
}

/* ---------- 8. Sitzungen ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn geraete_liste_einzeln_und_alle_anderen_abmelden() {
    let Some(p) = aufbauen().await else { return };
    let name = format!("sa{}", kurz());
    let erstes = p.konto(&name).await;
    let zweites = p
        .anmelden(
            &name,
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
        )
        .await;
    let drittes = p
        .anmelden(&name, "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0")
        .await;

    let (s, liste) = p
        .call("GET", "/api/v1/auth/sitzungen", &zweites.token, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let items = liste["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["aktuell"], true, "das aktuelle Gerät zuerst");
    assert!(items[0]["userAgent"].as_str().unwrap().contains("iPhone"));

    // Erneuern bleibt in derselben Sitzung.
    let (s, neu) = p
        .call(
            "POST",
            "/api/v1/auth/refresh",
            "",
            Some(json!({"refreshToken": drittes.refresh})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{neu}");
    let (_, liste) = p
        .call("GET", "/api/v1/auth/sitzungen", &zweites.token, None)
        .await;
    assert_eq!(liste["items"].as_array().unwrap().len(), 3);

    // Das dritte einzeln abmelden: Token sofort tot, Erneuern scheitert.
    let dritte_id = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| {
            s["userAgent"]
                .as_str()
                .unwrap_or_default()
                .contains("Windows")
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (s, _) = p
        .call(
            "DELETE",
            &format!("/api/v1/auth/sitzungen/{dritte_id}"),
            &zweites.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = p
        .call(
            "GET",
            "/api/v1/auth/me",
            neu["accessToken"].as_str().unwrap(),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = p
        .call(
            "POST",
            "/api/v1/auth/refresh",
            "",
            Some(json!({"refreshToken": neu["refreshToken"]})),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Alle anderen: Nur das zweite bleibt.
    // Das abgemeldete Gerät versucht es weiter – das reisst niemanden mit.
    let (s, _) = p.call("GET", "/api/v1/auth/me", &zweites.token, None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, antwort) = p
        .call(
            "POST",
            "/api/v1/auth/sitzungen/andere",
            &zweites.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(antwort["beendet"], 1);
    let (s, _) = p.call("GET", "/api/v1/auth/me", &erstes.token, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = p.call("GET", "/api/v1/auth/me", &zweites.token, None).await;
    assert_eq!(s, StatusCode::OK);
    let (_, liste) = p
        .call("GET", "/api/v1/auth/sitzungen", &zweites.token, None)
        .await;
    assert_eq!(liste["items"].as_array().unwrap().len(), 1);
    // Fremde Sitzungen trifft man nicht.
    let anderer = p.konto(&format!("sb{}", kurz())).await;
    let (s, _) = p
        .call(
            "DELETE",
            &format!(
                "/api/v1/auth/sitzungen/{}",
                liste["items"][0]["id"].as_str().unwrap()
            ),
            &anderer.token,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

/* ---------- 9. Mitteilungen je Chat ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn mitteilungen_je_chat_alle_erwaehnungen_aus_und_vorschau() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = drei(&p).await;
    let chat = p.gruppe(&a, &[&b, &c]).await;
    let (s, _) = p.aendern(&b, &chat, json!({"notifyLevel": "laut"})).await;
    assert!(s.is_client_error(), "{s}");
    p.aendern(&b, &chat, json!({"notifyLevel": "aus"})).await;
    p.aendern(&c, &chat, json!({"notifyLevel": "erwaehnungen"}))
        .await;
    p.push.lock().unwrap().clear();
    p.senden(&a, &chat, "an alle").await;
    assert!(p.push_an().is_empty(), "B aus, C nur bei Erwähnung");

    // Eine Erwähnung (metadata.mentions, ab Welle 2) erreicht C.
    initiative_api::services::messages::create_message(
        &p.state,
        initiative_api::services::messages::NewMessage {
            metadata: json!({ "mentions": [c.id.to_string()] }),
            ..initiative_api::services::messages::NewMessage::text(
                chat.parse().unwrap(),
                a.id,
                "@C schau",
            )
        },
    )
    .await
    .unwrap();
    assert_eq!(p.push_an(), vec![c.id]);

    // Vorschau je Chat aus: Mitteilung ja, Text nein.
    p.aendern(
        &b,
        &chat,
        json!({"notifyLevel": "alle", "notifyPreview": false}),
    )
    .await;
    p.push.lock().unwrap().clear();
    p.senden(&a, &chat, "streng geheim").await;
    let mitschnitt = p.push.lock().unwrap().clone();
    let an_b: Vec<_> = mitschnitt.iter().filter(|(id, _)| *id == b.id).collect();
    assert_eq!(an_b.len(), 1);
    assert!(!serde_json::to_string(&an_b[0].1)
        .unwrap()
        .contains("streng geheim"));
}
