//! Regressionstests zu sieben bestätigten Prüfpunkten.
//!
//! 1. Rundruf eines Chats/einer Umfrage: einmal laden, je Person nur das
//!    Eigene – gleiches Ergebnis, Abfragezahl unabhängig von der Mitgliederzahl.
//! 2. Nachrichtenliste eines Neuzugangs: Indexgrenze statt Durchsicht des
//!    ganzen Verlaufs.
//! 3. Fremdschlüssel auf `users` haben einen Index.
//! 4. Geht der Besitzer, übernimmt jemand.
//! 5. Einladen nur von Kontakten; Verbergen einer Ausgabe nur vor Personen
//!    aus ihrem Zusammenhang.
//! 6. Erneuerungs-Token im `HttpOnly`-Keks.
//! 7. Echtzeit-Leitung mit Einmal-Ticket statt Zugriffstoken in der Adresse.

// Das Gerüst teilen sich mehrere Testdateien; nicht jede braucht jeden Griff.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::services::conversations::{
    broadcast_conversation, load_conversation_dto, load_conversation_fuer_mitglieder,
};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

#[derive(Clone)]
struct Probe {
    router: Router,
    state: AppState,
}

struct Antwort {
    status: StatusCode,
    kopf: HeaderMap,
    rumpf: Value,
}

impl Probe {
    async fn anfrage(
        &self,
        method: &str,
        uri: &str,
        kopfzeilen: &[(&str, String)],
        body: Option<Value>,
    ) -> Antwort {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, wert) in kopfzeilen {
            builder = builder.header(*name, wert);
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
        let kopf = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Antwort {
            status,
            kopf,
            rumpf: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let kopf: Vec<(&str, String)> = token
            .map(|token| vec![("authorization", format!("Bearer {token}"))])
            .unwrap_or_default();
        let antwort = self.anfrage(method, uri, &kopf, body).await;
        (antwort.status, antwort.rumpf)
    }

    async fn konto(&self, name: &str) -> (String, String) {
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
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    /// Konten ohne Argon2 – für Gruppen mit vielen Mitgliedern, die sich
    /// nie anmelden müssen.
    async fn stumme_konten(&self, anzahl: usize) -> Vec<Uuid> {
        let n = kurz();
        let ids: Vec<Uuid> = (0..anzahl).map(|_| Uuid::now_v7()).collect();
        let namen: Vec<String> = (0..anzahl).map(|i| format!("stumm{n}{i}")).collect();
        sqlx::query(
            "insert into users (id, username, display_name, password_hash, calendar_token)
             select id, name, name, 'x', md5(random()::text)
               from unnest($1::uuid[], $2::text[]) as t(id, name)",
        )
        .bind(&ids)
        .bind(&namen)
        .execute(&self.state.pool)
        .await
        .unwrap();
        ids
    }

    async fn senden(&self, token: &str, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn gruppe(&self, token: &str, mitglieder: &[&str]) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(token),
                Some(json!({ "type": "group", "title": "Runde", "memberIds": mitglieder })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn hinzufuegen(&self, token: &str, chat: &str, wer: &[&str]) {
        let (status, body) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/members"),
                Some(token),
                Some(json!({ "memberIds": wer })),
            )
            .await;
        assert!(status.is_success(), "{status} {body}");
    }

    async fn rolle(&self, chat: &str, wer: &str) -> Option<String> {
        sqlx::query_scalar(
            "select role from conversation_members where conversation_id = $1 and user_id = $2",
        )
        .bind(Uuid::parse_str(chat).unwrap())
        .bind(Uuid::parse_str(wer).unwrap())
        .fetch_optional(&self.state.pool)
        .await
        .unwrap()
    }
}

fn umgebung(name: &str) -> Option<()> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "4");
    std::env::set_var("RATE_LIMIT", "false");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/{name}-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    Some(())
}

async fn aufbauen(name: &str) -> Option<Probe> {
    umgebung(name)?;
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

macro_rules! probe {
    ($name:expr) => {
        match aufbauen($name).await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
                return;
            }
        }
    };
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

fn uuid(text: &str) -> Uuid {
    Uuid::parse_str(text).unwrap()
}

/* ---------- 1. Rundruf ---------- */

/// Zählt die Datenbankabfragen, die sqlx auf diesem Faden protokolliert.
///
/// sqlx meldet jede ausgeführte Anweisung als `tracing`-Ereignis mit dem Ziel
/// `sqlx::query`. Ein einmal für den ganzen Testlauf gesetzter Abonnent zählt
/// sie – aber nur auf einem Faden, der gerade misst (`MESSUNG`). Darum laufen
/// die Messungen auf einem Laufzeit-Faden (`current_thread`), auf dem auch die
/// Abfragen selbst ausgeführt werden.
///
/// Global und nicht je Messung (`set_default`): `tracing` merkt sich je
/// Protokollstelle, ob überhaupt jemand zuhört. Liefen andere Tests ohne
/// Abonnent nebenher, blieb eine Stelle als „hört keiner“ gespeichert, und
/// eine Messung zählte gelegentlich null.
struct Abfragezaehler;

thread_local! {
    static MESSUNG: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

impl tracing::Subscriber for Abfragezaehler {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        if event.metadata().target().starts_with("sqlx::query") {
            MESSUNG.with(|stand| {
                if let Some(zahl) = stand.get() {
                    stand.set(Some(zahl + 1));
                }
            });
        }
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

async fn abfragen_bei<F: std::future::Future>(arbeit: F) -> usize {
    static EINMAL: std::sync::Once = std::sync::Once::new();
    EINMAL.call_once(|| {
        tracing::subscriber::set_global_default(Abfragezaehler)
            .expect("kein anderer globaler Abonnent im Testlauf");
    });
    MESSUNG.with(|stand| stand.set(Some(0)));
    arbeit.await;
    MESSUNG.with(|stand| stand.take()).unwrap_or(0)
}

/// Jede Person bekommt dieselbe Fassung wie aus `load_conversation_dto` –
/// mit Grenze, Lesezeichen, Archiv, Stummschaltung, Antworten und Umfrage als
/// letzter Nachricht.
#[tokio::test(flavor = "multi_thread")]
async fn rundruf_gleichwertig() {
    let probe = probe!("rundruf");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;
    let (_dora, dora_id) = probe.konto(&format!("dora{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id, &cleo_id]).await;

    let alt = probe.senden(&bodo, &chat, "vor dem Beitritt").await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/read"),
            Some(&anna),
            Some(json!({ "messageId": alt })),
        )
        .await;
    assert!(status.is_success());
    // Archiv und Stumm sind je Person.
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}"),
            Some(&cleo),
            Some(json!({ "archived": true, "mutedUntil": "2099-01-01T00:00:00Z" })),
        )
        .await;
    assert!(status.is_success());
    // Dora kommt später: Grenze, verdeckter Verlauf, Annas Lesezeichen liegt
    // davor.
    probe.hinzufuegen(&anna, &chat, &[&dora_id]).await;

    let alle: Vec<Uuid> = [&anna_id, &bodo_id, &cleo_id, &dora_id]
        .iter()
        .map(|id| uuid(id))
        .collect();
    let vergleichen = |wann: &'static str| {
        let probe = probe.clone();
        let alle = alle.clone();
        let chat = uuid(&chat);
        async move {
            let fassungen = load_conversation_fuer_mitglieder(&probe.state, chat, &alle)
                .await
                .unwrap();
            assert_eq!(fassungen.len(), alle.len(), "{wann}");
            for person in &alle {
                let einzeln = load_conversation_dto(&probe.state, *person, chat)
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&fassungen[person]).unwrap(),
                    serde_json::to_value(&einzeln).unwrap(),
                    "{wann}: Fassung für {person} weicht ab"
                );
            }
        }
    };

    // Letzte Nachricht: Systemzeile des Beitritts (für alle dieselbe).
    vergleichen("nach dem Beitritt").await;

    // Eine Antwort auf die alte Nachricht: Das Zitat hängt an der Grenze.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&bodo),
            Some(json!({ "type": "text", "body": "darauf", "replyToId": alt })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    vergleichen("mit Antwort").await;

    // Eine Umfrage mit eigenen Stimmen als letzte Nachricht.
    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat,
                "question": "Pizza?",
                "options": [{ "label": "ja" }, { "label": "nein" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let option = umfrage["options"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{}/vote", umfrage["id"].as_str().unwrap()),
            Some(&bodo),
            Some(json!({ "votes": [{ "optionId": option, "value": "yes" }] })),
        )
        .await;
    assert!(status.is_success());
    vergleichen("mit Umfrage").await;

    // Wer nicht (mehr) Mitglied ist, fehlt – wie bisher.
    let fremd = load_conversation_fuer_mitglieder(&probe.state, uuid(&chat), &[Uuid::now_v7()])
        .await
        .unwrap();
    assert!(fremd.is_empty());
}

/// Gruppe mit `anzahl` Mitgliedern plus Anna (Besitzerin); eine Nachricht.
async fn grosse_gruppe(probe: &Probe, anna: &str, anzahl: usize) -> (Uuid, Vec<Uuid>) {
    let mitglieder = probe.stumme_konten(anzahl).await;
    let texte: Vec<String> = mitglieder.iter().map(Uuid::to_string).collect();
    let refs: Vec<&str> = texte.iter().map(String::as_str).collect();
    let chat = probe.gruppe(anna, &refs).await;
    probe.senden(anna, &chat, "hallo").await;
    (uuid(&chat), mitglieder)
}

/// Die Abfragezahl eines Rundrufs hängt nicht mehr an der Mitgliederzahl.
#[tokio::test]
async fn rundruf_abfragen_unabhaengig_von_mitgliedern() {
    let probe = probe!("rundruf-zahl");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (klein, _) = grosse_gruppe(&probe, &anna, 4).await;
    let (gross, mitglieder) = grosse_gruppe(&probe, &anna, 40).await;

    let bei_klein = abfragen_bei(broadcast_conversation(&probe.state, klein, None)).await;
    let bei_gross = abfragen_bei(broadcast_conversation(&probe.state, gross, None)).await;
    // Zum Vergleich der bisherige Weg: je Mitglied die Einzelfassung.
    let bisher = abfragen_bei(async {
        for person in mitglieder.iter().chain(std::iter::once(&mitglieder[0])) {
            let _ = load_conversation_dto(&probe.state, *person, gross).await;
        }
    })
    .await;
    eprintln!("Rundruf: 5 Mitglieder {bei_klein}, 41 Mitglieder {bei_gross}, bisher {bisher}");
    assert!(bei_klein > 0, "der Zähler zählt nichts – Messung kaputt");
    assert_eq!(bei_klein, bei_gross, "Abfragen wachsen mit den Mitgliedern");
    assert!(bei_gross <= 15, "zu viele Abfragen: {bei_gross}");
    assert!(bisher >= 8 * 41, "Vergleichswert unplausibel: {bisher}");
}

/// Ebenso der Rundruf einer Umfrage.
#[tokio::test]
async fn umfrage_rundruf_abfragen_unabhaengig_vom_publikum() {
    let probe = probe!("umfrage-zahl");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let mut messungen = Vec::new();
    for anzahl in [4, 40] {
        let (chat, _) = grosse_gruppe(&probe, &anna, anzahl).await;
        let (status, umfrage) = probe
            .call(
                "POST",
                "/api/v1/polls",
                Some(&anna),
                Some(json!({
                    "conversationId": chat,
                    "question": "Wann?",
                    "options": [{ "label": "heute" }, { "label": "morgen" }],
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{umfrage}");
        let dto = initiative_api::services::polls::load_poll_dto(
            &probe.state,
            uuid(umfrage["id"].as_str().unwrap()),
            Uuid::nil(),
        )
        .await
        .unwrap();
        messungen.push(
            abfragen_bei(initiative_api::services::polls::broadcast_poll(
                &probe.state,
                &dto,
            ))
            .await,
        );
    }
    eprintln!("Umfrage-Rundruf: {messungen:?}");
    assert!(messungen[0] > 0, "der Zähler zählt nichts – Messung kaputt");
    assert_eq!(
        messungen[0], messungen[1],
        "Abfragen wachsen mit dem Publikum"
    );
}

/* ---------- 2. Nachrichtenliste eines Neuzugangs ---------- */

/// Die beiden Abfragen der dünnen Seite laufen über den Zeitindex und hören
/// nach einer Seite auf. `enable_seqscan = off` zwingt den Planer zu zeigen,
/// ob ein passender Index da ist – wie in `tests/chatliste.rs`.
#[tokio::test(flavor = "multi_thread")]
async fn neuzugang_seite_hat_eine_indexgrenze() {
    let probe = probe!("neuzugang-index");
    let mut verbindung = probe.state.pool.acquire().await.expect("Verbindung");
    for satz in ["set enable_seqscan = off", "set enable_bitmapscan = off"] {
        sqlx::query(satz).execute(&mut *verbindung).await.unwrap();
    }
    for (name, sql, binden) in [
        (
            "zählen",
            initiative_api::modules::messages::HINTER_DER_GRENZE_SQL,
            3,
        ),
        (
            "seite",
            initiative_api::modules::messages::DUENNE_SEITE_SQL,
            6,
        ),
    ] {
        let mut abfrage =
            sqlx::query_scalar::<_, String>(Box::leak(format!("explain {sql}").into_boxed_str()))
                .bind(Uuid::now_v7())
                .bind(chrono::Utc::now())
                .bind(51_i64);
        if binden == 6 {
            abfrage = abfrage.bind(None::<Uuid>).bind(Uuid::now_v7()).bind(50_i64);
        }
        let plan = abfrage
            .fetch_all(&mut *verbindung)
            .await
            .unwrap()
            .join("\n");
        assert!(
            plan.contains("messages_conversation_created_idx")
                && plan.contains("created_at >=")
                && plan.contains("Limit"),
            "{name}: keine begrenzte Indexsuche über (conversation_id, created_at):\n{plan}"
        );
    }
    sqlx::query("reset all")
        .execute(&mut *verbindung)
        .await
        .unwrap();
}

/// Und das Ergebnis stimmt: Der Neuzugang sieht nur, was nach seiner Grenze
/// kam; wer seit der Gründung dabei ist, blättert wie gewohnt.
#[tokio::test(flavor = "multi_thread")]
async fn neuzugang_seite_stimmt() {
    let probe = probe!("neuzugang");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let stumm = probe.stumme_konten(1).await[0].to_string();
    let chat = probe.gruppe(&anna, &[&stumm]).await;
    let mut alte = Vec::new();
    for i in 0..30 {
        alte.push(probe.senden(&anna, &chat, &format!("alt {i}")).await);
    }
    probe.hinzufuegen(&anna, &chat, &[&bodo_id]).await;

    let liste = |token: String, abfrage: String| {
        let probe = probe.clone();
        let chat = chat.clone();
        async move {
            let (status, seite) = probe
                .call(
                    "GET",
                    &format!("/api/v1/conversations/{chat}/messages{abfrage}"),
                    Some(&token),
                    None,
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{seite}");
            seite
        }
    };

    let seite = liste(bodo.clone(), String::new()).await;
    let items = seite["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "nur die eigene Beitrittszeile: {seite}");
    assert_eq!(items[0]["type"], "system");

    let neu: Vec<String> = {
        let mut neu = Vec::new();
        for i in 0..3 {
            neu.push(probe.senden(&anna, &chat, &format!("neu {i}")).await);
        }
        neu
    };
    let seite = liste(bodo.clone(), "?limit=2".into()).await;
    let ids: Vec<&str> = seite["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|eintrag| eintrag["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![neu[1].as_str(), neu[2].as_str()], "{seite}");
    let weiter = seite["next_cursor"]
        .as_str()
        .expect("volle Seite hat einen Zeiger");
    let seite = liste(bodo.clone(), format!("?limit=2&before={weiter}")).await;
    let items = seite["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{seite}");
    assert_eq!(items[0]["type"], "system");
    assert_eq!(items[1]["id"], neu[0].as_str());

    // Die Gründerin (Grenze = Gründung) blättert durch alles.
    let seite = liste(anna.clone(), "?limit=5".into()).await;
    assert_eq!(seite["items"].as_array().unwrap().len(), 5);
    let mut gesehen = 0;
    let mut zeiger: Option<String> = None;
    loop {
        let abfrage = match &zeiger {
            Some(z) => format!("?limit=7&before={z}"),
            None => "?limit=7".into(),
        };
        let seite = liste(anna.clone(), abfrage).await;
        gesehen += seite["items"].as_array().unwrap().len();
        match seite["next_cursor"].as_str() {
            Some(z) => zeiger = Some(z.to_string()),
            None => break,
        }
    }
    // 30 alte + 3 neue + Gründung + Beitritt.
    assert_eq!(gesehen, 35);
    let _ = alte;
}

/* ---------- 3. Fremdschlüssel-Indizes ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn fremdschluessel_auf_konten_haben_einen_index() {
    let probe = probe!("fk-index");
    let fehlend: Vec<(String, String)> = sqlx::query_as(
        "select c.conrelid::regclass::text, a.attname::text
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
          where c.contype = 'f' and c.confrelid = 'users'::regclass
            and (c.conrelid::regclass::text, a.attname::text) in (
              ('messages', 'sender_id'), ('reactions', 'user_id'), ('poll_votes', 'user_id'),
              ('conversations', 'created_by'), ('polls', 'created_by'),
              ('poll_options', 'created_by'), ('event_placements', 'user_id'),
              ('event_placements', 'created_by'), ('expenses', 'created_by'),
              ('expense_shares', 'settled_by'), ('expense_shares', 'confirmed_by'),
              ('expense_viewers', 'user_id'), ('expense_hidden_from', 'user_id'),
              ('collection_items', 'added_by'), ('game_sessions', 'created_by'))
            and not exists (
              select 1 from pg_index i
               where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])",
    )
    .fetch_all(&probe.state.pool)
    .await
    .unwrap();
    assert!(fehlend.is_empty(), "ohne Index: {fehlend:?}");

    // Und Postgres nimmt ihn für die Suche des Fremdschlüssels.
    let mut verbindung = probe.state.pool.acquire().await.unwrap();
    sqlx::query("set enable_seqscan = off")
        .execute(&mut *verbindung)
        .await
        .unwrap();
    let plan: Vec<String> =
        sqlx::query_scalar("explain update messages set sender_id = null where sender_id = $1")
            .bind(Uuid::now_v7())
            .fetch_all(&mut *verbindung)
            .await
            .unwrap();
    sqlx::query("reset all")
        .execute(&mut *verbindung)
        .await
        .unwrap();
    assert!(
        plan.join("\n").contains("messages_sender_idx"),
        "{}",
        plan.join("\n")
    );
}

/* ---------- 4. Besitz einer Gruppe ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn geht_der_besitzer_uebernimmt_der_dienstaelteste_admin() {
    let probe = probe!("besitz");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;
    let (_dora, dora_id) = probe.konto(&format!("dora{n}")).await;
    // Bodo ist am längsten dabei, aber nur Mitglied; Cleo kommt später, wird
    // Admin; Dora noch später, ebenfalls Admin.
    let chat = probe.gruppe(&anna, &[&bodo_id]).await;
    probe.hinzufuegen(&anna, &chat, &[&cleo_id]).await;
    probe.hinzufuegen(&anna, &chat, &[&dora_id]).await;
    for wer in [&cleo_id, &dora_id] {
        let (status, body) = probe
            .call(
                "PATCH",
                &format!("/api/v1/conversations/{chat}/members/{wer}"),
                Some(&anna),
                Some(json!({ "role": "admin" })),
            )
            .await;
        assert!(status.is_success(), "{body}");
    }

    // Der Besitzer kann sich nicht selbst herabstufen.
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}/members/{anna_id}"),
            Some(&anna),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(probe.rolle(&chat, &anna_id).await.as_deref(), Some("owner"));

    // Echtzeit: Cleo hört mit.
    let (_, ausgang, _) = probe.state.hub.register(uuid(&cleo_id));
    let mut empfang = ausgang.empfang;

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/conversations/{chat}/members/{anna_id}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(probe.rolle(&chat, &cleo_id).await.as_deref(), Some("owner"));
    assert_eq!(probe.rolle(&chat, &dora_id).await.as_deref(), Some("admin"));
    assert_eq!(
        probe.rolle(&chat, &bodo_id).await.as_deref(),
        Some("member")
    );

    let mut gemeldet = false;
    let mut systemzeile = false;
    // Der Bus stellt nebenläufig zu – kurz warten statt nur abzuholen.
    let ende = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while !(gemeldet && systemzeile) {
        let Ok(Some(rahmen)) = tokio::time::timeout_at(ende, empfang.recv()).await else {
            break;
        };
        let rahmen: Value = serde_json::from_str(&rahmen).unwrap();
        if rahmen["type"] == "conversation.updated" {
            let cleo_rolle = rahmen["payload"]["conversation"]["members"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| m["userId"] == cleo_id.as_str())
                .map(|m| m["role"].clone());
            gemeldet |= cleo_rolle == Some(json!("owner"));
        }
        if rahmen["type"] == "message.new"
            && rahmen["payload"]["message"]["metadata"]["system"]["kind"] == "owner.changed"
        {
            systemzeile = true;
        }
    }
    assert!(
        gemeldet,
        "Cleo erfährt per Echtzeit, dass sie Besitzerin ist"
    );
    assert!(systemzeile, "Systemzeile „ist jetzt Besitzer“");

    // Geht auch Cleo (Kontolöschung), ist Dora als Admin vor Bodo dran,
    // obwohl Bodo länger dabei ist.
    let _ = bodo;
    let (status, body) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&cleo),
            Some(json!({ "password": "richtigespasswort" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(probe.rolle(&chat, &dora_id).await.as_deref(), Some("owner"));
}

#[tokio::test(flavor = "multi_thread")]
async fn ohne_admin_uebernimmt_das_dienstaelteste_mitglied() {
    let probe = probe!("besitz-mitglied");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (_cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id]).await;
    probe.hinzufuegen(&anna, &chat, &[&cleo_id]).await;
    let (status, _) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&anna),
            Some(json!({ "password": "richtigespasswort" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(probe.rolle(&chat, &bodo_id).await.as_deref(), Some("owner"));
    assert_eq!(
        probe.rolle(&chat, &cleo_id).await.as_deref(),
        Some("member")
    );
    let _ = anna_id;
}

/* ---------- 5. Einladen nur von Kontakten; Verbergen im Zusammenhang ---------- */

#[tokio::test(flavor = "multi_thread")]
async fn einladen_nur_wer_einen_chat_teilt() {
    let probe = probe!("kontakte");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (_erik, erik_id) = probe.konto(&format!("erik{n}")).await;
    let gruppe = probe.gruppe(&anna, &[&bodo_id]).await;
    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let termin = |personen: Vec<&str>| {
        json!({
            "title": "Grillen",
            "startsAt": beginn,
            "endsAt": beginn + chrono::Duration::hours(2),
            "attendeeIds": personen,
            "zustellung": { "senden": true, "einzelchats": true, "gruppenChatIds": [] },
        })
    };

    // Erik teilt keinen Chat mit Anna: abgelehnt, und es entsteht kein Chat.
    for personen in [
        vec![erik_id.as_str()],
        vec![bodo_id.as_str(), erik_id.as_str()],
    ] {
        let (status, body) = probe
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&anna),
                Some(termin(personen)),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["error"]["message"],
            "Einladen lassen sich nur Personen, mit denen du einen Chat teilst."
        );
    }
    let gemeinsam: i64 = sqlx::query_scalar(
        "select count(*) from conversation_members a
           join conversation_members b on b.conversation_id = a.conversation_id
          where a.user_id = $1 and b.user_id = $2",
    )
    .bind(uuid(&anna_id))
    .bind(uuid(&erik_id))
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(gemeinsam, 0, "die Einladung darf keinen Chat stiften");

    // Bodo aus der Gruppe: geht, samt neuem Einzelchat.
    let (status, angelegt) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&anna),
            Some(termin(vec![&bodo_id])),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{angelegt}");

    // Nachträglich hinzufügen: dieselbe Regel.
    let (status, body) = probe
        .call(
            "PATCH",
            &format!(
                "/api/v1/calendar/events/{}",
                angelegt["id"].as_str().unwrap()
            ),
            Some(&anna),
            Some(json!({ "attendeeIds": [bodo_id, erik_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // Wer ausdrücklich einen Chat beginnt, ist danach Kontakt.
    let (status, _) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "direct", "memberIds": [erik_id] })),
        )
        .await;
    assert!(status.is_success());
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&anna),
            Some(termin(vec![&erik_id])),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let _ = gruppe;
}

#[tokio::test(flavor = "multi_thread")]
async fn verbergen_nur_vor_personen_aus_dem_zusammenhang() {
    let probe = probe!("verbergen");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (_cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;
    let (_erik, erik_id) = probe.konto(&format!("erik{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id, &cleo_id]).await;
    let (status, ausgabe) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&anna),
            Some(json!({
                "title": "Geschenk",
                "amountCents": 2000,
                "currency": "EUR",
                "conversationId": chat,
                "shares": [{ "userId": anna_id }, { "userId": bodo_id }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{ausgabe}");
    let id = ausgabe["id"].as_str().unwrap();

    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/hidden/{erik_id}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/hidden/{}", Uuid::now_v7()),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unbekannte Kennung: {body}"
    );
    let zeilen: i64 =
        sqlx::query_scalar("select count(*) from expense_hidden_from where expense_id = $1")
            .bind(uuid(id))
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(zeilen, 0);

    // Cleo gehört zum Chat und trägt keinen Anteil: geht.
    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/hidden/{cleo_id}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/* ---------- 6. Erneuerungs-Keks ---------- */

const KOPF: &str = "x-initiative-sitzung";
const APP: &str = "http://localhost:5173";

fn erneuerungskeks(kopf: &HeaderMap) -> Option<String> {
    kopf.get_all("set-cookie")
        .iter()
        .filter_map(|wert| wert.to_str().ok())
        .find(|wert| wert.starts_with("initiative_erneuern="))
        .map(str::to_string)
}

fn keks_wert(set_cookie: &str) -> String {
    set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("initiative_erneuern=")
        .to_string()
}

async fn anmelden(probe: &Probe, name: &str, mit_kopf: bool) -> Antwort {
    let mut kopf = vec![("origin", APP.to_string())];
    if mit_kopf {
        kopf.push((KOPF, "keks".to_string()));
    }
    probe
        .anfrage(
            "POST",
            "/api/v1/auth/login",
            &kopf,
            Some(json!({ "username": name, "password": "richtigespasswort" })),
        )
        .await
}

async fn erneuern_mit_keks(probe: &Probe, keks: &str, kopf: &[(&str, String)]) -> Antwort {
    let mut alle = vec![("cookie", format!("initiative_erneuern={keks}"))];
    alle.extend(kopf.iter().cloned());
    probe
        .anfrage("POST", "/api/v1/auth/refresh", &alle, Some(json!({})))
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn erneuerung_ueber_den_keks() {
    let probe = probe!("keks");
    let name = format!("keks{}", kurz());
    probe.konto(&name).await;

    // Mit dem Kopf: Keks gesetzt, Token NICHT im Rumpf.
    let antwort = anmelden(&probe, &name, true).await;
    assert_eq!(antwort.status, StatusCode::OK, "{}", antwort.rumpf);
    assert!(
        antwort.rumpf.get("refreshToken").is_none(),
        "{}",
        antwort.rumpf
    );
    assert!(antwort.rumpf["accessToken"].is_string());
    let keks = erneuerungskeks(&antwort.kopf).expect("Erneuerungs-Keks");
    for teil in ["HttpOnly", "SameSite=Strict", "Path=/api/v1/auth/refresh"] {
        assert!(keks.contains(teil), "{teil} fehlt: {keks}");
    }
    assert!(!keks.contains("Domain"), "{keks}");
    let erster = keks_wert(&keks);

    // Erneuern mit Keks, Kopf und bekannter Herkunft.
    let gut = [(KOPF, "keks".to_string()), ("origin", APP.to_string())];
    let antwort = erneuern_mit_keks(&probe, &erster, &gut).await;
    assert_eq!(antwort.status, StatusCode::OK, "{}", antwort.rumpf);
    assert!(antwort.rumpf.get("refreshToken").is_none());
    let zweiter = keks_wert(&erneuerungskeks(&antwort.kopf).expect("neuer Keks"));
    assert_ne!(erster, zweiter, "rotiert");

    // Die Nachfrist bleibt: Der eben verbrannte Keks liefert in 30 s
    // denselben Nachfolger, statt alles zu beenden.
    let antwort = erneuern_mit_keks(&probe, &erster, &gut).await;
    assert_eq!(antwort.status, StatusCode::OK, "{}", antwort.rumpf);
    assert_eq!(keks_wert(&erneuerungskeks(&antwort.kopf).unwrap()), zweiter);

    // CSRF: ohne eigenen Kopf, oder von fremder Herkunft – nein.
    let antwort = erneuern_mit_keks(&probe, &zweiter, &[("origin", APP.to_string())]).await;
    assert_eq!(antwort.status, StatusCode::FORBIDDEN);
    let antwort = erneuern_mit_keks(
        &probe,
        &zweiter,
        &[
            (KOPF, "keks".to_string()),
            ("origin", "https://boese.example".to_string()),
        ],
    )
    .await;
    assert_eq!(antwort.status, StatusCode::FORBIDDEN);

    // CORS: Der Vorabcheck erlaubt den Kopf samt Anmeldedaten.
    let antwort = probe
        .anfrage(
            "OPTIONS",
            "/api/v1/auth/refresh",
            &[
                ("origin", APP.to_string()),
                ("access-control-request-method", "POST".to_string()),
                ("access-control-request-headers", KOPF.to_string()),
            ],
            None,
        )
        .await;
    let erlaubt = |name: &str| {
        antwort
            .kopf
            .get(name)
            .and_then(|wert| wert.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    assert_eq!(erlaubt("access-control-allow-origin"), APP);
    assert_eq!(erlaubt("access-control-allow-credentials"), "true");
    assert!(erlaubt("access-control-allow-headers").contains(KOPF));

    // Abmelden über den Keks: widerruft und räumt beide Kekse.
    let antwort = probe
        .anfrage(
            "DELETE",
            "/api/v1/auth/refresh",
            &[
                ("cookie", format!("initiative_erneuern={zweiter}")),
                (KOPF, "keks".to_string()),
                ("origin", APP.to_string()),
            ],
            None,
        )
        .await;
    assert_eq!(antwort.status, StatusCode::NO_CONTENT);
    assert!(erneuerungskeks(&antwort.kopf)
        .unwrap()
        .contains("Max-Age=0"));
    let antwort = erneuern_mit_keks(&probe, &zweiter, &gut).await;
    assert_eq!(antwort.status, StatusCode::UNAUTHORIZED);
}

/// Ältere Clients schicken den Token im Rumpf – das geht weiter, und sie
/// bekommen dabei den Keks gesetzt.
#[tokio::test(flavor = "multi_thread")]
async fn erneuerung_mit_token_im_rumpf_geht_weiter() {
    let probe = probe!("keks-alt");
    let name = format!("altkeks{}", kurz());
    probe.konto(&name).await;
    let antwort = anmelden(&probe, &name, false).await;
    assert_eq!(antwort.status, StatusCode::OK);
    let token = antwort.rumpf["refreshToken"]
        .as_str()
        .expect("ohne Kopf weiter im Rumpf")
        .to_string();

    let antwort = probe
        .anfrage(
            "POST",
            "/api/v1/auth/refresh",
            &[],
            Some(json!({ "refreshToken": token })),
        )
        .await;
    assert_eq!(antwort.status, StatusCode::OK, "{}", antwort.rumpf);
    assert!(antwort.rumpf["refreshToken"].is_string());
    let keks = keks_wert(&erneuerungskeks(&antwort.kopf).expect("Keks für den Umzug"));
    assert_eq!(keks, antwort.rumpf["refreshToken"].as_str().unwrap());

    // Der Umzug: alter Token im Rumpf, MIT Kopf – danach steht er nur noch im
    // Keks.
    let antwort = probe
        .anfrage(
            "POST",
            "/api/v1/auth/refresh",
            &[(KOPF, "keks".to_string())],
            Some(json!({ "refreshToken": keks })),
        )
        .await;
    assert_eq!(antwort.status, StatusCode::OK, "{}", antwort.rumpf);
    assert!(antwort.rumpf.get("refreshToken").is_none());
    assert!(erneuerungskeks(&antwort.kopf).is_some());

    // Der alte Abmeldeweg mit Rumpf bleibt.
    let (status, _) = probe
        .call(
            "POST",
            "/api/v1/auth/logout",
            None,
            Some(json!({ "refreshToken": "gibt-es-nicht-mehr" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

/* ---------- 7. Echtzeit mit Einmal-Ticket ---------- */

/// Öffnet eine Websocket-Leitung von Hand und liefert das erste Datenpaket.
async fn erstes_paket(adresse: std::net::SocketAddr, abfrage: &str) -> (u8, Vec<u8>) {
    let mut leitung = tokio::net::TcpStream::connect(adresse).await.unwrap();
    let anfrage = format!(
        "GET /ws?{abfrage} HTTP/1.1\r\nHost: {adresse}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    leitung.write_all(anfrage.as_bytes()).await.unwrap();
    let mut kopf = Vec::new();
    let mut byte = [0u8; 1];
    while !kopf.ends_with(b"\r\n\r\n") {
        leitung.read_exact(&mut byte).await.unwrap();
        kopf.push(byte[0]);
    }
    assert!(String::from_utf8_lossy(&kopf).starts_with("HTTP/1.1 101"));
    let mut anfang = [0u8; 2];
    leitung.read_exact(&mut anfang).await.unwrap();
    let laenge = match anfang[1] & 0x7f {
        126 => {
            let mut zwei = [0u8; 2];
            leitung.read_exact(&mut zwei).await.unwrap();
            usize::from(u16::from_be_bytes(zwei))
        }
        127 => panic!("unerwartet langes Paket"),
        kurz => usize::from(kurz),
    };
    let mut nutzlast = vec![0u8; laenge];
    leitung.read_exact(&mut nutzlast).await.unwrap();
    (anfang[0] & 0x0f, nutzlast)
}

#[tokio::test(flavor = "multi_thread")]
async fn echtzeit_mit_einmal_ticket() {
    let probe = probe!("ticket");
    let (token, _) = probe.konto(&format!("ticket{}", kurz())).await;
    let lauscher = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adresse = lauscher.local_addr().unwrap();
    let router = probe.router.clone();
    tokio::spawn(async move {
        axum::serve(lauscher, router).await.unwrap();
    });

    // Ohne Anmeldung kein Ticket.
    let (status, _) = probe
        .call("POST", "/api/v1/realtime/ticket", None, None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let ticket = |probe: Probe, token: String| async move {
        let (status, body) = probe
            .call("POST", "/api/v1/realtime/ticket", Some(&token), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["expiresIn"], 30);
        let ticket = body["ticket"].as_str().unwrap().to_string();
        assert!(!ticket.contains('.'), "ein Ticket ist kein JWT");
        ticket
    };

    // Ein Ticket verbindet – genau einmal.
    let erstes = ticket(probe.clone(), token.clone()).await;
    let (opcode, nutzlast) = erstes_paket(adresse, &format!("ticket={erstes}")).await;
    assert_eq!(opcode, 0x1, "Textpaket erwartet");
    assert!(String::from_utf8_lossy(&nutzlast).contains("hello"));
    let (opcode, nutzlast) = erstes_paket(adresse, &format!("ticket={erstes}")).await;
    assert_eq!(opcode, 0x8, "verbraucht: Schliessen");
    assert_eq!(&nutzlast[..2], &4401u16.to_be_bytes());

    // Auch im alten Feld (`token=`) wird ein Ticket erkannt.
    let zweites = ticket(probe.clone(), token.clone()).await;
    let (opcode, _) = erstes_paket(adresse, &format!("token={zweites}")).await;
    assert_eq!(opcode, 0x1);

    // Abgelaufen: nein.
    let drittes = ticket(probe.clone(), token.clone()).await;
    sqlx::query("update echtzeit_tickets set gueltig_bis = now() - interval '1 second'")
        .execute(&probe.state.pool)
        .await
        .unwrap();
    let (opcode, _) = erstes_paket(adresse, &format!("ticket={drittes}")).await;
    assert_eq!(opcode, 0x8);

    // Übergangsweise geht das Zugriffstoken in der Adresse weiter.
    let (opcode, _) = erstes_paket(adresse, &format!("token={token}")).await;
    assert_eq!(opcode, 0x1);
}
