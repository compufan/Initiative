//! Lesehäkchen, Weiterleiten, Sternchen, Entwürfe, Suche, Datumssprung und
//! „Ohne Ton senden“ – jeweils mit den Rechten, die das Sehen verlangt.

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
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

struct Konto {
    token: String,
    id: String,
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{uri}"))
            .header("authorization", format!("Bearer {token}"));
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

    async fn konto(&self, name: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                }))
                .unwrap(),
            ))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().to_string(),
        }
    }

    async fn chat(&self, von: &Konto, art: &str, andere: &[&Konto]) -> String {
        let ids: Vec<&str> = andere.iter().map(|k| k.id.as_str()).collect();
        let mut body = json!({ "type": art, "memberIds": ids });
        if art == "group" {
            body["title"] = json!("Runde");
        }
        let (status, chat) = self
            .call("POST", "/conversations", &von.token, Some(body))
            .await;
        assert!(status.is_success(), "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn senden(&self, von: &Konto, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/conversations/{chat}/messages"),
                &von.token,
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn lesen(&self, wer: &Konto, chat: &str, bis: &str) {
        let (status, antwort) = self
            .call(
                "POST",
                &format!("/conversations/{chat}/read"),
                &wer.token,
                Some(json!({ "messageId": bis })),
            )
            .await;
        assert!(status.is_success(), "{antwort}");
    }

    async fn zustellen(&self, wer: &Konto, chat: &str, bis: &str) -> Value {
        let (status, antwort) = self
            .call(
                "POST",
                "/messages/zugestellt",
                &wer.token,
                Some(json!({ "eintraege": [{ "conversationId": chat, "messageId": bis }] })),
            )
            .await;
        assert!(status.is_success(), "{antwort}");
        antwort
    }

    async fn suche(&self, token: &str, abfrage: String) -> Vec<String> {
        let (status, liste) = self
            .call("GET", &format!("/search/messages?{abfrage}"), token, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn info(&self, wer: &Konto, nachricht: &str) -> (StatusCode, Value) {
        self.call(
            "GET",
            &format!("/messages/{nachricht}/info"),
            &wer.token,
            None,
        )
        .await
    }
}

async fn aufbauen(name: &str) -> Option<Probe> {
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
        format!("./.data/{name}-{}", Uuid::now_v7().simple()),
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

fn ids(liste: &Value, feld: &str) -> Vec<String> {
    liste[feld]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            e["userId"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| e.as_str().unwrap().to_string())
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn zugestellt_und_gelesen_in_der_gruppe_mit_zeiten() {
    let Some(p) = aufbauen("haken").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ha{n}")).await;
    let bodo = p.konto(&format!("hb{n}")).await;
    let cleo = p.konto(&format!("hc{n}")).await;
    let chat = p.chat(&anna, "group", &[&bodo, &cleo]).await;
    let m1 = p.senden(&anna, &chat, "erste").await;
    let m2 = p.senden(&anna, &chat, "zweite").await;

    let (status, info) = p.info(&anna, &m1).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(ids(&info, "ausstehend").len(), 2, "{info}");

    // Fremde Nachrichten haben keine Info für mich.
    assert_eq!(p.info(&bodo, &m1).await.0, StatusCode::FORBIDDEN);

    // Bodo empfängt bis m2: beide Nachrichten zugestellt an Bodo.
    let antwort = p.zustellen(&bodo, &chat, &m2).await;
    assert_eq!(antwort["vorgerueckt"], 1);
    // Wiederholt: nichts mehr vorzurücken.
    assert_eq!(p.zustellen(&bodo, &chat, &m2).await["vorgerueckt"], 0);
    // Ein älterer Stand rückt nicht zurück.
    assert_eq!(p.zustellen(&bodo, &chat, &m1).await["vorgerueckt"], 0);
    let (_, info) = p.info(&anna, &m1).await;
    assert_eq!(ids(&info, "zugestellt"), vec![bodo.id.clone()]);
    assert!(
        info["zugestellt"][0]["am"].is_string(),
        "Zeit erfasst: {info}"
    );
    assert_eq!(ids(&info, "ausstehend"), vec![cleo.id.clone()]);

    // Cleo liest bis m1 (ohne vorher Zustellung zu melden): gelesen heisst
    // zugestellt. m2 ist für Cleo noch offen.
    p.lesen(&cleo, &chat, &m1).await;
    let (_, info) = p.info(&anna, &m1).await;
    assert_eq!(ids(&info, "gelesen"), vec![cleo.id.clone()]);
    assert!(info["gelesen"][0]["am"].is_string());
    let (_, info2) = p.info(&anna, &m2).await;
    assert_eq!(ids(&info2, "ausstehend"), vec![cleo.id.clone()]);

    // Die Stände für die Häkchen.
    let (status, staende) = p
        .call(
            "GET",
            &format!("/conversations/{chat}/staende"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let von = |id: &str| {
        staende["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["userId"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(von(&bodo.id)["zugestellt"], m2.as_str());
    assert_eq!(von(&cleo.id)["gelesen"], m1.as_str());
    assert_eq!(
        von(&cleo.id)["zugestellt"],
        m1.as_str(),
        "gelesen schliesst zugestellt ein"
    );

    // Wer nicht Mitglied ist, meldet nichts.
    let fremd = p.konto(&format!("hf{n}")).await;
    assert_eq!(p.zustellen(&fremd, &chat, &m2).await["vorgerueckt"], 0);
    assert_eq!(
        p.call(
            "GET",
            &format!("/conversations/{chat}/staende"),
            &fremd.token,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn lesebestaetigungen_aus_gilt_gegenseitig_im_einzelchat() {
    let Some(p) = aufbauen("lesebest").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("la{n}")).await;
    let bodo = p.konto(&format!("lb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let m = p.senden(&anna, &chat, "hallo").await;
    p.lesen(&bodo, &chat, &m).await;
    let (_, info) = p.info(&anna, &m).await;
    assert_eq!(ids(&info, "gelesen"), vec![bodo.id.clone()]);

    // Bodo schaltet aus: Anna sieht nur noch „zugestellt“.
    sqlx::query(
        "update users set settings = jsonb_set(settings, '{privacy}', '{\"readReceipts\": false}')
          where id = $1::uuid",
    )
    .bind(&bodo.id)
    .execute(&p.state.pool)
    .await
    .unwrap();
    let (_, info) = p.info(&anna, &m).await;
    assert!(ids(&info, "gelesen").is_empty(), "{info}");
    assert_eq!(ids(&info, "zugestellt"), vec![bodo.id.clone()]);
    let (_, staende) = p
        .call(
            "GET",
            &format!("/conversations/{chat}/staende"),
            &anna.token,
            None,
        )
        .await;
    let b = staende["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["userId"] == bodo.id.as_str())
        .unwrap();
    assert!(b["gelesen"].is_null(), "{staende}");
    assert_eq!(b["zugestellt"], m.as_str());

    // Und Bodo sieht Annas Lesen auch nicht mehr.
    let antwort = p.senden(&bodo, &chat, "zurück").await;
    p.lesen(&anna, &chat, &antwort).await;
    let (_, info) = p.info(&bodo, &antwort).await;
    assert!(ids(&info, "gelesen").is_empty(), "{info}");
}

#[tokio::test(flavor = "multi_thread")]
async fn weiterleiten_nur_was_man_sehen_darf_und_atomar() {
    let Some(p) = aufbauen("weiterleiten").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("wa{n}")).await;
    let bodo = p.konto(&format!("wb{n}")).await;
    let cleo = p.konto(&format!("wc{n}")).await;
    let quelle = p.chat(&anna, "group", &[&bodo]).await;
    let ziel = p.chat(&bodo, "direct", &[&cleo]).await;
    let ziel2 = p.chat(&bodo, "group", &[&cleo]).await;

    // Ein Foto mit Anhang in der Quelle.
    let anhang = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2::uuid, 'image', 'image/png', 10, $3, 'ready')",
    )
    .bind(anhang)
    .bind(&anna.id)
    .bind(format!("test/{anhang}"))
    .execute(&p.state.pool)
    .await
    .unwrap();
    let (status, foto) = p
        .call(
            "POST",
            &format!("/conversations/{quelle}/messages"),
            &anna.token,
            Some(json!({ "type": "image", "body": "*Urlaub*", "attachmentIds": [anhang] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{foto}");
    let foto_id = foto["id"].as_str().unwrap();

    // Bodo leitet an zwei Chats weiter – mit Herkunft.
    let (status, ergebnis) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [ziel, ziel2], "herkunft": true, "clientId": "w1" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{ergebnis}");
    let items = ergebnis["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for item in items {
        assert_eq!(item["type"], "image");
        assert_eq!(item["body"], "*Urlaub*");
        assert_eq!(item["senderId"], bodo.id.as_str());
        assert_eq!(item["metadata"]["weitergeleitet"]["von"], format!("wa{n}"));
        let kopie = item["attachments"][0]["id"].as_str().unwrap();
        assert_ne!(
            kopie,
            anhang.to_string(),
            "eine eigene Zeile, dieselbe Datei"
        );
    }
    // Neuversuch mit demselben Schlüssel: dieselben Nachrichten, keine neuen Kopien.
    let vorher: i64 = sqlx::query_scalar("select count(*) from attachments where quelle_id = $1")
        .bind(anhang)
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    let (_, nochmal) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [ziel, ziel2], "herkunft": true, "clientId": "w1" })),
        )
        .await;
    let nachher: i64 = sqlx::query_scalar("select count(*) from attachments where quelle_id = $1")
        .bind(anhang)
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    assert_eq!(vorher, nachher);
    assert_eq!(nochmal["items"][0]["id"], items[0]["id"]);

    // Ohne Herkunft: nur das Kennzeichen. Und eine Kette ohne Herkunft
    // bekommt keine nachträglich.
    let (_, ohne) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [ziel], "herkunft": false })),
        )
        .await;
    let ohne_id = ohne["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(ohne["items"][0]["metadata"]["weitergeleitet"], json!({}));
    let (_, kette) = p
        .call(
            "POST",
            &format!("/messages/{ohne_id}/weiterleiten"),
            &cleo.token,
            Some(json!({ "conversationIds": [ziel2], "herkunft": true })),
        )
        .await;
    assert_eq!(
        kette["items"][0]["metadata"]["weitergeleitet"],
        json!({}),
        "{kette}"
    );

    // Cleo ist nicht in der Quelle: darf das Original nicht weiterleiten.
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &cleo.token,
            Some(json!({ "conversationIds": [ziel] })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Bodo darf nicht in einen Chat weiterleiten, in dem er nicht ist –
    // und dann kommt auch in den erlaubten nichts an (atomar).
    let fremd = p.chat(&anna, "direct", &[&cleo]).await;
    let zaehlen = |chat: String| {
        let pool = p.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "select count(*) from messages where conversation_id = $1::uuid",
            )
            .bind(chat)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let vorher = zaehlen(ziel.clone()).await;
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [ziel, fremd] })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(zaehlen(ziel.clone()).await, vorher);

    // Gelöschtes und Verborgenes lässt sich nicht weiterleiten.
    let text = p.senden(&anna, &quelle, "gleich weg").await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{text}?scope=me"),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{text}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [ziel] })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "für mich gelöscht");
    p.call(
        "DELETE",
        &format!("/messages/{text}?scope=all"),
        &anna.token,
        None,
    )
    .await;
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{text}/weiterleiten"),
            &anna.token,
            Some(json!({ "conversationIds": [fremd] })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "für alle gelöscht");

    // Eine Systemzeile (Gruppe angelegt) ist nicht weiterleitbar.
    let system: Uuid = sqlx::query_scalar(
        "select id from messages where conversation_id = $1::uuid and type = 'system' limit 1",
    )
    .bind(&quelle)
    .fetch_one(&p.state.pool)
    .await
    .unwrap();
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{system}/weiterleiten"),
            &anna.token,
            Some(json!({ "conversationIds": [fremd] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Vor der eigenen Grenze: Dora kommt später dazu und sieht das Foto nicht.
    let dora = p.konto(&format!("wd{n}")).await;
    let (status, _) = p
        .call(
            "POST",
            &format!("/conversations/{quelle}/members"),
            &anna.token,
            Some(json!({ "memberIds": [dora.id] })),
        )
        .await;
    assert!(status.is_success());
    let eigen = p.chat(&dora, "direct", &[&anna]).await;
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{foto_id}/weiterleiten"),
            &dora.token,
            Some(json!({ "conversationIds": [eigen] })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "vor dem Beitritt");

    // Den Kennzeichen-Schlüssel darf ein Client nicht selbst setzen.
    let (status, _) = p
        .call(
            "POST",
            &format!("/conversations/{ziel}/messages"),
            &bodo.token,
            Some(json!({ "type": "text", "body": "x", "metadata": { "weitergeleitet": { "von": "Kanzler" } } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn sterne_nur_fuer_sichtbares_und_nur_fuer_mich() {
    let Some(p) = aufbauen("sterne").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("sa{n}")).await;
    let bodo = p.konto(&format!("sb{n}")).await;
    let fremd = p.konto(&format!("sf{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let a = p.senden(&anna, &chat, "merken").await;
    let b = p.senden(&bodo, &chat, "auch merken").await;

    for id in [&a, &b] {
        let (status, _) = p
            .call("PUT", &format!("/messages/{id}/stern"), &anna.token, None)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    // Zweimal ist einmal.
    p.call("PUT", &format!("/messages/{a}/stern"), &anna.token, None)
        .await;
    let (_, liste) = p.call("GET", "/sterne", &anna.token, None).await;
    let gespeichert: Vec<&str> = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        gespeichert,
        vec![b.as_str(), a.as_str()],
        "zuletzt gespeichert zuerst"
    );
    // Bodo hat keine Sterne.
    let (_, leer) = p.call("GET", "/sterne", &bodo.token, None).await;
    assert!(leer["items"].as_array().unwrap().is_empty());
    // Ein Fremder kann eine fremde Nachricht nicht speichern.
    let (status, _) = p
        .call("PUT", &format!("/messages/{a}/stern"), &fremd.token, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Für alle gelöscht: fällt aus der Liste.
    p.call(
        "DELETE",
        &format!("/messages/{b}?scope=all"),
        &bodo.token,
        None,
    )
    .await;
    let (_, kennungen) = p.call("GET", "/sterne/kennungen", &anna.token, None).await;
    assert_eq!(kennungen["items"], json!([a]));

    // Blättern: Seite für Seite.
    for i in 0..3 {
        let id = p.senden(&anna, &chat, &format!("seite {i}")).await;
        p.call("PUT", &format!("/messages/{id}/stern"), &anna.token, None)
            .await;
    }
    let (_, seite) = p.call("GET", "/sterne?limit=2", &anna.token, None).await;
    assert_eq!(seite["items"].as_array().unwrap().len(), 2);
    let weiter = seite["nextCursor"].as_str().unwrap().to_string();
    let (_, rest) = p
        .call(
            "GET",
            &format!("/sterne?limit=2&before={weiter}"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(rest["items"].as_array().unwrap().len(), 2);
    assert_eq!(rest["items"][1]["id"], a.as_str());

    // Stern entfernen.
    p.call("DELETE", &format!("/messages/{a}/stern"), &anna.token, None)
        .await;
    let (_, kennungen) = p.call("GET", "/sterne/kennungen", &anna.token, None).await;
    assert!(!kennungen["items"].as_array().unwrap().contains(&json!(a)));
}

#[tokio::test(flavor = "multi_thread")]
async fn entwuerfe_neuester_gewinnt_und_senden_leert() {
    let Some(p) = aufbauen("entwuerfe").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ea{n}")).await;
    let bodo = p.konto(&format!("eb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let zitat = p.senden(&bodo, &chat, "frage").await;
    let jetzt = chrono::Utc::now();

    let setzen = |text: &str, stand: chrono::DateTime<chrono::Utc>, antwort: Option<&str>| json!({ "text": text, "stand": stand.to_rfc3339(), "replyToId": antwort });
    let (status, a) = p
        .call(
            "PUT",
            &format!("/conversations/{chat}/entwurf"),
            &anna.token,
            Some(setzen(
                "Gerät A",
                jetzt - chrono::Duration::seconds(5),
                Some(&zitat),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{a}");
    assert_eq!(a["uebernommen"], true);
    assert_eq!(a["entwurf"]["replyToId"], zitat.as_str());

    // Ein älterer Stand (Gerät B war offline) verliert und bekommt den neueren.
    let (_, b) = p
        .call(
            "PUT",
            &format!("/conversations/{chat}/entwurf"),
            &anna.token,
            Some(setzen(
                "Gerät B alt",
                jetzt - chrono::Duration::seconds(30),
                None,
            )),
        )
        .await;
    assert_eq!(b["uebernommen"], false);
    assert_eq!(b["entwurf"]["text"], "Gerät A");

    // Ein neuerer gewinnt; eine vorgehende Uhr wird auf die Serverzeit gekappt.
    let (_, c) = p
        .call(
            "PUT",
            &format!("/conversations/{chat}/entwurf"),
            &anna.token,
            Some(setzen("Zukunft", jetzt + chrono::Duration::hours(5), None)),
        )
        .await;
    assert_eq!(c["uebernommen"], true);
    let gespeichert =
        chrono::DateTime::parse_from_rfc3339(c["entwurf"]["updatedAt"].as_str().unwrap()).unwrap();
    assert!(
        gespeichert < jetzt + chrono::Duration::minutes(1),
        "gekappt: {c}"
    );

    let (_, liste) = p.call("GET", "/entwuerfe", &anna.token, None).await;
    assert_eq!(liste["items"].as_array().unwrap().len(), 1);
    // Bodo sieht Annas Entwurf nicht.
    let (_, fremd) = p.call("GET", "/entwuerfe", &bodo.token, None).await;
    assert!(fremd["items"].as_array().unwrap().is_empty());

    // Ein Antwortbezug auf etwas Fremdes wird verworfen.
    let cleo = p.konto(&format!("ec{n}")).await;
    let anderer = p.chat(&bodo, "direct", &[&cleo]).await;
    let fremde = p.senden(&bodo, &anderer, "geheim").await;
    let (_, d) = p
        .call(
            "PUT",
            &format!("/conversations/{chat}/entwurf"),
            &anna.token,
            Some(setzen(
                "mit Bezug",
                chrono::Utc::now() + chrono::Duration::seconds(1),
                Some(&fremde),
            )),
        )
        .await;
    assert!(d["entwurf"]["replyToId"].is_null(), "{d}");

    // Senden leert den Entwurf.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    p.senden(&anna, &chat, "abgeschickt").await;
    let (_, liste) = p.call("GET", "/entwuerfe", &anna.token, None).await;
    assert!(liste["items"].as_array().unwrap().is_empty(), "{liste}");
}

#[tokio::test(flavor = "multi_thread")]
async fn suche_mit_filtern_und_sprung_zum_datum() {
    let Some(p) = aufbauen("suchfilter").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("qa{n}")).await;
    let bodo = p.konto(&format!("qb{n}")).await;
    let chat = p.chat(&anna, "group", &[&bodo]).await;
    let link = p.senden(&anna, &chat, "schau https://example.com/x").await;
    let von_bodo = p.senden(&bodo, &chat, "Treffen morgen").await;
    let datei = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2::uuid, 'file', 'application/pdf', 10, $3, 'ready')",
    )
    .bind(datei)
    .bind(&anna.id)
    .bind(format!("test/{datei}"))
    .execute(&p.state.pool)
    .await
    .unwrap();
    let (_, pdf) = p
        .call(
            "POST",
            &format!("/conversations/{chat}/messages"),
            &anna.token,
            Some(json!({ "type": "file", "attachmentIds": [datei] })),
        )
        .await;
    let pdf = pdf["id"].as_str().unwrap().to_string();

    assert_eq!(
        p.suche(&anna.token, format!("conversationId={chat}&art=links"))
            .await,
        vec![link.clone()]
    );
    assert_eq!(
        p.suche(&anna.token, format!("conversationId={chat}&art=dateien"))
            .await,
        vec![pdf.clone()]
    );
    assert_eq!(
        p.suche(
            &anna.token,
            format!("conversationId={chat}&senderId={}", bodo.id)
        )
        .await,
        vec![von_bodo.clone()]
    );
    assert_eq!(
        p.suche(&anna.token, format!("conversationId={chat}&q=Treffen"))
            .await,
        vec![von_bodo.clone()]
    );
    assert!(p
        .suche(
            &anna.token,
            format!("conversationId={chat}&q=Treffen&senderId={}", anna.id)
        )
        .await
        .is_empty());
    let (status, _) = p
        .call("GET", "/search/messages?art=unsinn", &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Für mich gelöscht: nicht mehr zu finden.
    p.call(
        "DELETE",
        &format!("/messages/{von_bodo}?scope=me"),
        &anna.token,
        None,
    )
    .await;
    assert!(p
        .suche(&anna.token, format!("conversationId={chat}&q=Treffen"))
        .await
        .is_empty());

    // Datumssprung: die Nachrichten bekommen feste Zeiten.
    sqlx::query("update messages set created_at = '2025-03-01T10:00:00Z' where id = $1::uuid")
        .bind(&link)
        .execute(&p.state.pool)
        .await
        .unwrap();
    sqlx::query("update messages set created_at = '2025-03-05T10:00:00Z' where id = $1::uuid")
        .bind(&pdf)
        .execute(&p.state.pool)
        .await
        .unwrap();
    // Die Grenze „sieht ab Beitritt“ läge sonst hinter den zurückdatierten
    // Nachrichten.
    sqlx::query("update conversation_members set sieht_ab = null where conversation_id = $1::uuid")
        .bind(&chat)
        .execute(&p.state.pool)
        .await
        .unwrap();
    // Die Systemzeile („Gruppe angelegt“) liegt vor allem.
    sqlx::query(
        "update messages set created_at = '2025-02-01T10:00:00Z'
          where conversation_id = $1::uuid and type = 'system'",
    )
    .bind(&chat)
    .execute(&p.state.pool)
    .await
    .unwrap();
    let (status, ab) = p
        .call(
            "GET",
            &format!("/conversations/{chat}/messages?ab=2025-03-02T00:00:00Z&limit=1"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ab}");
    assert_eq!(ab["items"][0]["id"], pdf.as_str());

    // `bis`: alles von einer alten Nachricht bis zur neuesten in einem Zug.
    let (_, fenster) = p
        .call(
            "GET",
            &format!("/conversations/{chat}/messages?bis={link}"),
            &anna.token,
            None,
        )
        .await;
    let geholt: Vec<&str> = fenster["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(geholt.first(), Some(&link.as_str()));
    assert!(geholt.contains(&pdf.as_str()));
    assert!(
        !geholt.contains(&von_bodo.as_str()),
        "verborgen bleibt verborgen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ohne_ton_senden_meldet_leise_und_zaehlt_ungelesen() {
    let Some(p) = aufbauen("ohneton").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ta{n}")).await;
    let bodo = p.konto(&format!("tb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    p.push.lock().unwrap().clear();
    let (status, _) = p
        .call(
            "POST",
            &format!("/conversations/{chat}/messages"),
            &anna.token,
            Some(json!({ "type": "text", "body": "*leise*", "silent": true })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let mut gesehen = Vec::new();
    for _ in 0..50 {
        gesehen = p.push.lock().unwrap().clone();
        if !gesehen.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(gesehen.len(), 1, "eine Mitteilung, nur an Bodo");
    assert_eq!(gesehen[0].0.to_string(), bodo.id);
    assert_eq!(gesehen[0].1.kind, "message-leise");
    // Die Vorschau ohne Formatierungsmarken.
    assert_eq!(gesehen[0].1.body, "leise");

    let (_, liste) = p.call("GET", "/conversations", &bodo.token, None).await;
    let eintrag = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == chat.as_str())
        .unwrap();
    assert_eq!(eintrag["unreadCount"], 1, "leise heisst nicht gelesen");

    // Normal gesendet: gewöhnliche Mitteilung.
    p.push.lock().unwrap().clear();
    p.senden(&anna, &chat, "laut").await;
    for _ in 0..50 {
        if !p.push.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(p.push.lock().unwrap()[0].1.kind, "message");
}

#[tokio::test(flavor = "multi_thread")]
async fn reaktionen_nur_als_emoji() {
    let Some(p) = aufbauen("reaktion").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ra{n}")).await;
    let bodo = p.konto(&format!("rb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let m = p.senden(&anna, &chat, "hi").await;
    for (emoji, ok) in [("👨‍👩‍👧‍👦", true), ("👩🏻‍❤️‍💋‍👩🏼", true), ("hallo", false), ("1", false)]
    {
        let (status, _) = p
            .call(
                "PUT",
                &format!("/messages/{m}/reactions"),
                &bodo.token,
                Some(json!({ "emoji": emoji })),
            )
            .await;
        assert_eq!(status.is_success(), ok, "{emoji}: {status}");
    }
}
