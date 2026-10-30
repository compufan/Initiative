//! Registrierung, Login und Token-Rotation.

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::password::{
    hash_password, hash_password_async, random_token, sha256_hex, verify_password_async,
};
use crate::auth::{erneuerungskeks, jwt, medienkeks, AuthUser};
use crate::config::{Config, RegistrationMode};
use crate::db::UserRow;
use crate::drossel::{regeln, Absender};
use crate::dto::AuthSession;
use crate::error::{AppError, AppResult};
use crate::services::users::{load_user, to_self_user_dto};
use crate::state::AppState;
use crate::validate::{check_password, normalise_username, Validator};

/**
 * Ein echter Argon2-Hash, gegen den geprüft wird, wenn es das Konto nicht gibt.
 *
 * Hier stand vorher ein von Hand geschriebener Hash mit dem Kommentar, er sorge
 * für gleiche Antwortzeiten. Er war **ungültig**: Der Hashteil ist nicht
 * kanonisch base64-kodiert, `PasswordHash::new` scheiterte am Einlesen, und
 * `verify_password` gab sofort `false` zurück, ohne Argon2 auch nur
 * anzuwerfen.
 *
 * Gemessen: 8 µs für einen unbekannten Namen, 505 ms für einen bekannten. Ein
 * einziges `curl -w %{time_total}` genügte, um die Mitgliederliste
 * abzuklappern. Die Schutzmassnahme stand nur im Kommentar.
 *
 * Jetzt wird der Hash beim ersten Gebrauch wirklich erzeugt – damit rechnet
 * der Vergleich genauso lange wie ein echter.
 */
static DUMMY_HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    hash_password("kein-konto-mit-diesem-namen")
        .unwrap_or_else(|_| String::from("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$c29tZXNhbHQ"))
});

/// Immer derselbe Satz – er darf nicht verraten, welche Grenze gegriffen hat.
fn zu_schnell() -> AppError {
    AppError::too_many("Zu viele Versuche. Warte einen Moment und versuch es dann noch einmal.")
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        // `DELETE` auf derselben Adresse meldet über den Keks ab: Der Keks
        // gilt nur für diesen einen Pfad (siehe `erneuerungskeks`).
        .route("/auth/refresh", post(refresh).delete(abmelden_keks))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/password", post(change_password))
        .route("/auth/calendar-token/rotate", post(rotate_calendar_token))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterInput {
    username: String,
    password: String,
    display_name: String,
    invite_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginInput {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshInput {
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordInput {
    current_password: String,
    new_password: String,
}

pub(crate) async fn issue_session(state: &AppState, user: &UserRow) -> AppResult<AuthSession> {
    let refresh_token = random_token(48);
    refresh_speichern(&state.pool, &state.config, user.id, &refresh_token).await?;
    Ok(sitzung_mit(state, user, refresh_token))
}

/// Ein Erneuerungs-Token ablegen – nur als Hash. `false`, wenn es ihn schon
/// gibt (zwei gleichzeitige Rotationen desselben Vorgängers).
async fn refresh_speichern<'e, E>(
    executor: E,
    config: &Config,
    user_id: Uuid,
    token: &str,
) -> AppResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let expires_at =
        chrono::Utc::now() + chrono::Duration::seconds(config.refresh_token_ttl.as_secs() as i64);
    let neu = sqlx::query(
        "insert into refresh_tokens (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)
         on conflict (token_hash) do nothing",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(sha256_hex(token))
    .bind(expires_at)
    .execute(executor)
    .await?;
    Ok(neu.rows_affected() > 0)
}

/// Die Antwort einer Sitzung: frisches Zugriffstoken zum gegebenen
/// Erneuerungs-Token.
fn sitzung_mit(state: &AppState, user: &UserRow, refresh_token: String) -> AuthSession {
    let access_token = jwt::encode(
        &user.id.to_string(),
        "access",
        &state.config.jwt_secret,
        state.config.access_token_ttl.as_secs() as i64,
    );
    AuthSession {
        access_token,
        expires_in: state.config.access_token_ttl.as_secs() as i64,
        refresh_token: Some(refresh_token),
        user: to_self_user_dto(user, &state.config),
    }
}

/**
 * Wie lange ein gerade rotierter Erneuerungs-Token noch einmal gilt.
 *
 * Ohne Frist war jede zweite Vorlage eines verbrannten Tokens „Diebstahl“ und
 * beendete alle Sitzungen des Kontos – auch wenn nur die Antwort der ersten
 * Erneuerung unterwegs verloren ging (Funkloch, Tab geschlossen, App im
 * Hintergrund eingefroren). Das Gerät hatte dann den alten Token und nichts
 * sonst, und der Mensch war überall abgemeldet.
 */
const NACHFRIST_SEKUNDEN: i64 = 30;

/**
 * Der Nachfolger eines Erneuerungs-Tokens: aus ihm und dem Server-Geheimnis
 * abgeleitet statt zufällig.
 *
 * Dadurch lässt sich in der Nachfrist **dieselbe** neue Sitzung noch einmal
 * ausliefern, ohne den Klartext irgendwo aufzuheben – gespeichert bleibt nur
 * der Hash. Und es entsteht keine zweite, unabhängige Kette: Wer den alten
 * Token in der Frist vorlegt, bekommt denselben Nachfolger wie das Gerät. Legt
 * später einer der beiden ein verbranntes Stück vor, greift die
 * Wiederverwendungserkennung wie zuvor. Vorhersagen kann den Nachfolger nur,
 * wer den Vorgänger UND das Geheimnis kennt.
 */
fn nachfolger(geheimnis: &str, token: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(geheimnis.as_bytes()).expect("HMAC nimmt jede Länge");
    mac.update(b"refresh-nachfolger:");
    mac.update(token.as_bytes());
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// In der Nachfrist: der lebende Nachfolger dieses Tokens, falls es einen
/// gibt. Folgt der Kette, solange jedes Glied selbst erst in der Frist
/// rotiert wurde – zwei Tabs, die kurz nacheinander erneuern, sind keine
/// Ausnahme. Ein Glied, das durch Abmelden oder Passwortwechsel widerrufen
/// wurde, hat keinen lebenden Nachfolger; dann gibt es auch hier keinen.
async fn nachfolger_in_frist(
    state: &AppState,
    token: &str,
    user_id: Uuid,
) -> AppResult<Option<String>> {
    let mut aktuell = token.to_string();
    // Mehr Glieder in dreissig Sekunden erzeugt kein Gerät; die Grenze hält
    // die Schleife endlich.
    for _ in 0..8 {
        let naechster = nachfolger(&state.config.jwt_secret, &aktuell);
        let zeile = sqlx::query_as::<_, (Uuid, bool, Option<bool>, bool)>(
            "select user_id,
                    revoked_at is null,
                    revoked_at > now() - make_interval(secs => $2),
                    expires_at > now()
               from refresh_tokens where token_hash = $1",
        )
        .bind(sha256_hex(&naechster))
        .bind(NACHFRIST_SEKUNDEN as f64)
        .fetch_optional(&state.pool)
        .await?;
        match zeile {
            Some((besitzer, _, _, _)) if besitzer != user_id => return Ok(None),
            Some((_, true, _, true)) => return Ok(Some(naechster)),
            Some((_, false, Some(true), true)) => aktuell = naechster,
            _ => return Ok(None),
        }
    }
    Ok(None)
}

/**
 * Die Sitzung samt Medien-Keks und Erneuerungs-Keks ausliefern.
 *
 * Der Medien-Keks geht bei JEDER Sitzungsantwort mit – beim Anmelden, beim
 * Registrieren und bei jeder Erneuerung. Das ist zugleich der Übergang für
 * Sitzungen, die es schon gibt: Sie bekommen ihn bei der nächsten Erneuerung,
 * ohne dass sich jemand neu anmelden müsste.
 *
 * Ebenso der Erneuerungs-Keks (`erneuerungskeks`): Auch ein Client, der den
 * Token noch im Rumpf schickt, bekommt ihn gesetzt – so zieht eine bestehende
 * Sitzung beim nächsten Erneuern von selbst in den Keks um. Den Token im
 * Rumpf gibt es nur noch für Clients, die nicht ausdrücklich den Keks wollen,
 * oder wenn sich kein Keks setzen lässt (fremde Stelle über http).
 *
 * Bekommt ein Keks kein Beiwerk (App und API auf fremden Stellen ohne TLS),
 * bleibt seine Kopfzeile weg. Ein Keks, den der Browser ohnehin verwirft,
 * wäre nur Rauschen in der Antwort.
 */
pub(crate) fn ausliefern(
    config: &Config,
    kopf: &HeaderMap,
    user_id: Uuid,
    mut sitzung: AuthSession,
) -> Response {
    let mut kekse: Vec<String> = Vec::new();
    if let Some(keks) = medienkeks::setzen(config, user_id) {
        kekse.push(keks);
    }
    if let Some(token) = sitzung.refresh_token.as_deref() {
        if let Some(keks) = erneuerungskeks::setzen(config, token) {
            kekse.push(keks);
            if erneuerungskeks::will_keks(kopf) {
                sitzung.refresh_token = None;
            }
        }
    }
    let mut antwort = Json(sitzung).into_response();
    for keks in kekse {
        if let Ok(wert) = header::HeaderValue::from_str(&keks) {
            antwort.headers_mut().append(header::SET_COOKIE, wert);
        }
    }
    antwort
}

async fn register(
    State(state): State<AppState>,
    absender: Absender,
    kopf: HeaderMap,
    Json(input): Json<RegisterInput>,
) -> AppResult<(StatusCode, Response)> {
    // Ohne Bremse liesse sich ein Einladungscode durchprobieren – und mit ihm
    // steht die Tuer zur ganzen App offen.
    if !state
        .drossel
        .erlaubt(&format!("register:{absender}"), regeln::REGISTRIEREN)
    {
        return Err(zu_schnell());
    }

    match state.config.registration_mode {
        RegistrationMode::Closed => {
            return Err(AppError::forbidden("Registrierung ist deaktiviert"))
        }
        RegistrationMode::Invite => {
            let provided = input.invite_code.clone().unwrap_or_default();
            let from_env = state
                .config
                .invite_codes
                .iter()
                .any(|code| code == &provided);
            // Von Admins angelegte Codes stehen in der Datenbank; INVITE_CODES
            // bleibt als Notnagel bestehen, falls niemand mehr hineinkommt.
            if !from_env && !invite_code_is_valid(&state, &provided).await? {
                return Err(AppError::forbidden("Ungültiger Einladungscode"));
            }
        }
        RegistrationMode::Open => {}
    }

    let username = normalise_username(&input.username)?;
    check_password(&input.password)?;
    let display_name = input.display_name.trim().to_string();
    Validator::new()
        .length(
            "displayName",
            &display_name,
            1,
            crate::constants::DISPLAY_NAME_MAX,
        )
        .finish()?;

    let existing: Option<(Uuid,)> = sqlx::query_as("select id from users where username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await?;
    if existing.is_some() {
        return Err(AppError::conflict("Benutzername ist bereits vergeben"));
    }

    let password_hash = hash_password_async(input.password).await?;
    let user = sqlx::query_as::<_, UserRow>(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         values ($1, $2, $3, $4, $5)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(&username)
    .bind(&display_name)
    .bind(password_hash)
    .bind(random_token(24))
    .fetch_one(&state.pool)
    .await?;

    if state.config.registration_mode == RegistrationMode::Invite {
        redeem_invite_code(&state, &input.invite_code.unwrap_or_default(), user.id).await?;
    }

    let sitzung = issue_session(&state, &user).await?;
    Ok((
        StatusCode::CREATED,
        ausliefern(&state.config, &kopf, user.id, sitzung),
    ))
}

/// Prüft, ob ein von einem Admin angelegter Code noch eingelöst werden darf.
async fn invite_code_is_valid(state: &AppState, code: &str) -> AppResult<bool> {
    if code.is_empty() {
        return Ok(false);
    }
    let usable: Option<bool> = sqlx::query_scalar(
        "select true from invite_codes
          where code = $1
            and revoked_at is null
            and (expires_at is null or expires_at > now())
            and (max_uses is null or uses < max_uses)",
    )
    .bind(code)
    .fetch_optional(&state.pool)
    .await?;
    Ok(usable.unwrap_or(false))
}

/// Zählt die Einlösung. Das `where` wiederholt die Bedingungen, damit zwei
/// gleichzeitige Registrierungen ein Limit nicht gemeinsam überschreiten.
async fn redeem_invite_code(state: &AppState, code: &str, user_id: Uuid) -> AppResult<()> {
    if code.is_empty() {
        return Ok(());
    }
    let consumed = sqlx::query(
        "update invite_codes
            set uses = uses + 1
          where code = $1
            and revoked_at is null
            and (expires_at is null or expires_at > now())
            and (max_uses is null or uses < max_uses)",
    )
    .bind(code)
    .execute(&state.pool)
    .await?;

    // Kein Treffer heißt: der Code kam aus INVITE_CODES, nicht aus der Tabelle.
    if consumed.rows_affected() > 0 {
        sqlx::query("insert into invite_redemptions (code, user_id) values ($1, $2)")
            .bind(code)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

async fn login(
    State(state): State<AppState>,
    absender: Absender,
    kopf: HeaderMap,
    Json(input): Json<LoginInput>,
) -> AppResult<Response> {
    let username = input.username.trim().to_lowercase();

    // Zwei Schlüssel, weil es zwei Angriffe gibt: von einer Adresse aus viele
    // Konten durchprobieren, und von vielen Adressen aus ein Konto. Beide
    // Zähler laufen, beide bremsen.
    let von = format!("login:ip:{absender}");
    let konto = format!("login:konto:{username}");
    if !state.drossel.erlaubt(&von, regeln::ANMELDEN_ADRESSE)
        || !state.drossel.erlaubt(&konto, regeln::ANMELDEN)
    {
        return Err(zu_schnell());
    }

    let user = sqlx::query_as::<_, UserRow>("select * from users where username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await?;

    // Auch ohne Konto einmal richtig rechnen, damit die Antwortzeit nicht
    // verraet, ob es den Namen gibt.
    let valid = match &user {
        Some(user) => {
            verify_password_async(input.password.clone(), user.password_hash.clone()).await
        }
        None => {
            let _ = verify_password_async(input.password, DUMMY_HASH.clone()).await;
            false
        }
    };

    let Some(user) = user.filter(|_| valid) else {
        return Err(AppError::unauthorized(
            "Benutzername oder Passwort ist falsch",
        ));
    };

    // Wer sich zweimal vertippt und dann richtig liegt, faengt bei null an.
    // Sonst zaehlt die Bremse die Fehlversuche eines ganzen Tages zusammen.
    state.drossel.zuruecksetzen(&von);
    state.drossel.zuruecksetzen(&konto);

    let _ = sqlx::query("update users set last_seen_at = now() where id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("delete from refresh_tokens where expires_at < now() - interval '7 days'")
        .execute(&state.pool)
        .await;

    let sitzung = issue_session(&state, &user).await?;
    Ok(ausliefern(&state.config, &kopf, user.id, sitzung))
}

/**
 * Woher der Erneuerungs-Token kommt: aus dem Rumpf (ältere Clients, native
 * Werkzeuge) oder aus dem Keks.
 *
 * Der Rumpf gewinnt: Ein Client, der ihn schickt, meint ihn – das ist auch der
 * Weg, auf dem der Web-Client einen alten Token aus `localStorage` ein letztes
 * Mal vorlegt und dafür den Keks bekommt. Der Rumpf braucht keine
 * CSRF-Prüfung, denn der Token darin IST der Nachweis; der Keks dagegen kommt
 * von selbst mit und gilt nur zusammen mit dem eigenen Kopf und einer
 * bekannten Herkunft (`erneuerungskeks::anfrage_vertrauenswuerdig`).
 */
fn vorgelegter_token(
    config: &Config,
    kopf: &HeaderMap,
    rumpf: Option<RefreshInput>,
) -> AppResult<String> {
    if let Some(token) = rumpf.and_then(|rumpf| rumpf.refresh_token) {
        return Ok(token);
    }
    let token = erneuerungskeks::aus_kopfzeilen(kopf)
        .ok_or_else(|| AppError::unauthorized("Kein Refresh-Token"))?;
    if !erneuerungskeks::anfrage_vertrauenswuerdig(config, kopf) {
        return Err(AppError::forbidden(
            "Diese Anfrage darf die Sitzung nicht erneuern",
        ));
    }
    Ok(token)
}

async fn refresh(
    State(state): State<AppState>,
    absender: Absender,
    kopf: HeaderMap,
    rumpf: Option<Json<RefreshInput>>,
) -> AppResult<Response> {
    if !state
        .drossel
        .erlaubt(&format!("refresh:{absender}"), regeln::ERNEUERN)
    {
        return Err(zu_schnell());
    }
    let token = vorgelegter_token(&state.config, &kopf, rumpf.map(|Json(rumpf)| rumpf))?;
    let hash = sha256_hex(&token);

    let row = sqlx::query_as::<_, crate::db::RefreshTokenRow>(
        "select id, user_id, token_hash, expires_at, revoked_at
         from refresh_tokens where token_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::unauthorized(
            "Sitzung abgelaufen, bitte neu anmelden",
        ));
    };
    if row.expires_at <= chrono::Utc::now() {
        return Err(AppError::unauthorized(
            "Sitzung abgelaufen, bitte neu anmelden",
        ));
    }

    // Rotation: Der vorgelegte Token wird verbrannt, bevor es einen neuen
    // gibt. Nur wer ihn hier wirklich verbrennt, rotiert – ein zweiter,
    // gleichzeitiger Aufruf mit demselben Token geht in die Nachfrist unten.
    //
    // Verbrennen und Nachfolger anlegen in EINER Transaktion: Ein
    // gleichzeitiger Aufruf wartet an der Zeilensperre, bis beides steht, und
    // findet danach den Nachfolger. Getrennt sah er den Token verbrannt, aber
    // noch keinen Nachfolger – und hielt das für Diebstahl.
    let naechster = nachfolger(&state.config.jwt_secret, &token);
    let verbrannt = if row.revoked_at.is_none() {
        let mut tx = state.pool.begin().await?;
        let verbrannt = sqlx::query(
            "update refresh_tokens set revoked_at = now() where id = $1 and revoked_at is null",
        )
        .bind(row.id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        if verbrannt {
            refresh_speichern(&mut *tx, &state.config, row.user_id, &naechster).await?;
        }
        tx.commit().await?;
        verbrannt
    } else {
        false
    };

    if !verbrannt {
        // In der Nachfrist: dieselbe neue Sitzung noch einmal – siehe
        // `NACHFRIST_SEKUNDEN` und `nachfolger`. War der Token beim Lesen
        // noch nicht verbrannt, hat ihn gerade eben ein gleichzeitiger Aufruf
        // rotiert – das liegt sicher in der Frist.
        let in_frist = row.revoked_at.is_none_or(|wann| {
            wann > chrono::Utc::now() - chrono::Duration::seconds(NACHFRIST_SEKUNDEN)
        });
        let naechster = if in_frist {
            nachfolger_in_frist(&state, &token, row.user_id).await?
        } else {
            None
        };
        if let Some(naechster) = naechster {
            let user = load_user(&state.pool, row.user_id).await?;
            let sitzung = sitzung_mit(&state, &user, naechster);
            return Ok(ausliefern(&state.config, &kopf, user.id, sitzung));
        }

        // Ein schon eingeloester, aber noch nicht abgelaufener Token, der
        // erneut vorgelegt wird – ausserhalb der Nachfrist –, ist der Beweis,
        // dass zwei Parteien dieselbe Kette benutzen: Wer ihn abgegriffen hat,
        // hat ihn eingeloest, und das echte Geraet kommt mit dem alten Stueck
        // hinterher (oder umgekehrt).
        //
        // Bisher gab es dafuer nur ein 401. Das Geraet meldete sich neu an,
        // merkte nichts - und der Dieb behielt seine rotierende Kette sechzig
        // Tage lang. Jetzt endet die ganze Sitzung, fuer beide.
        tracing::warn!(
            user_id = %row.user_id,
            "wiederverwendeter Refresh-Token - alle Sitzungen dieses Kontos werden beendet"
        );
        sqlx::query(
            "update refresh_tokens set revoked_at = now()
              where user_id = $1 and revoked_at is null",
        )
        .bind(row.user_id)
        .execute(&state.pool)
        .await?;
        return Err(AppError::unauthorized(
            "Sitzung abgelaufen, bitte neu anmelden",
        ));
    }

    // Aufraeumen auch hier, nicht nur beim Anmelden: Bei sechzig Tagen
    // Laufzeit und Erneuerung alle Viertelstunde sammelt jedes aktive Geraet
    // Tausende Zeilen an, bevor die erste ueberhaupt loeschfaehig waere.
    // Widerrufene braucht nach zwei Tagen niemand mehr - die
    // Wiederverwendungserkennung oben greift lange davor.
    let _ = sqlx::query(
        "delete from refresh_tokens
          where expires_at < now() - interval '7 days'
             or (revoked_at is not null and revoked_at < now() - interval '2 days')",
    )
    .execute(&state.pool)
    .await;

    let user = load_user(&state.pool, row.user_id).await?;
    let sitzung = sitzung_mit(&state, &user, naechster);
    Ok(ausliefern(&state.config, &kopf, user.id, sitzung))
}

async fn logout(
    State(state): State<AppState>,
    Json(input): Json<RefreshInput>,
) -> AppResult<Response> {
    if let Some(token) = input.refresh_token {
        sqlx::query("update refresh_tokens set revoked_at = now() where token_hash = $1")
            .bind(sha256_hex(&token))
            .execute(&state.pool)
            .await?;
    }
    Ok(kekse_weg(&state.config))
}

/// Abmelden über den Keks: `DELETE /auth/refresh`.
///
/// Auf dem Pfad des Kekses, weil er nur dorthin mitgeschickt wird. Mit
/// derselben CSRF-Prüfung wie das Erneuern – sonst könnte eine fremde Seite
/// jeden abmelden, der sie besucht. Ohne Keks gibt es nichts zu widerrufen;
/// geräumt wird trotzdem.
async fn abmelden_keks(State(state): State<AppState>, kopf: HeaderMap) -> AppResult<Response> {
    if let Some(token) = erneuerungskeks::aus_kopfzeilen(&kopf) {
        if !erneuerungskeks::anfrage_vertrauenswuerdig(&state.config, &kopf) {
            return Err(AppError::forbidden("Diese Anfrage darf nicht abmelden"));
        }
        sqlx::query("update refresh_tokens set revoked_at = now() where token_hash = $1")
            .bind(sha256_hex(&token))
            .execute(&state.pool)
            .await?;
    }
    Ok(kekse_weg(&state.config))
}

/// Beide Kekse gehen mit. Sonst bliebe auf einem geteilten Gerät ein Ausweis
/// liegen, der noch Wochen gilt – ausgerechnet beim Abmelden.
fn kekse_weg(config: &Config) -> Response {
    let mut antwort = StatusCode::NO_CONTENT.into_response();
    for keks in [
        medienkeks::loeschen(config),
        erneuerungskeks::loeschen(config),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(wert) = header::HeaderValue::from_str(&keks) {
            antwort.headers_mut().append(header::SET_COOKIE, wert);
        }
    }
    antwort
}

async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<crate::dto::SelfUserDto>> {
    // Gibt es das Konto nicht mehr, ist der Token wertlos – und das muss auch
    // so heissen. „Nicht gefunden“ liest der Client als Stoerung und bleibt
    // angemeldet; nach einer Kontoloeschung auf einem anderen Geraet stuende
    // hier weiter eine Oberflaeche voller Daten, die es nicht mehr gibt.
    let row = load_user(&state.pool, user.id())
        .await
        .map_err(|_| AppError::unauthorized("Dieses Konto gibt es nicht mehr."))?;
    Ok(Json(to_self_user_dto(&row, &state.config)))
}

async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<ChangePasswordInput>,
) -> AppResult<StatusCode> {
    // Angemeldet, aber ein bequemer Weg, das alte Passwort zu erraten – etwa
    // an einem Geraet, das jemand kurz unbeaufsichtigt liess.
    if !state
        .drossel
        .erlaubt(&format!("pw:{}", user.id()), regeln::PASSWORT)
    {
        return Err(zu_schnell());
    }
    let row = load_user(&state.pool, user.id()).await?;
    if !verify_password_async(input.current_password, row.password_hash.clone()).await {
        return Err(AppError::unauthorized("Aktuelles Passwort ist falsch"));
    }
    check_password(&input.new_password)?;

    let password_hash = hash_password_async(input.new_password).await?;
    sqlx::query("update users set password_hash = $1, updated_at = now() where id = $2")
        .bind(password_hash)
        .bind(row.id)
        .execute(&state.pool)
        .await?;
    // Every other device has to sign in again.
    sqlx::query(
        "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
    )
    .bind(row.id)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn rotate_calendar_token(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let token = random_token(24);
    sqlx::query("update users set calendar_token = $1 where id = $2")
        .bind(&token)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "calendarToken": token })))
}
