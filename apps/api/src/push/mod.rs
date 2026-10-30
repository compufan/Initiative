//! Web Push delivery.
//!
//! Works on Android/Chrome/Firefox out of the box and on iOS 16.4+ once the PWA
//! has been added to the home screen.

pub mod ece;
pub mod vapid;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::{Config, VapidConfig};
use crate::db::PushSubscriptionRow;
use crate::dto::PushPayload;

/// Wie viele Push-Anfragen gleichzeitig unterwegs sein dürfen.
const PUSH_PARALLEL: usize = 8;

/// Was ein Mitschnitt festhält: an wen welche Mitteilung gegangen wäre.
/// Wie lange eine Mitteilung zu einer neuen Nachricht wartet.
///
/// Wer den Chat offen hat, liest die Nachricht Sekundenbruchteile nach dem
/// Eintreffen und meldet es (`POST …/read`). Ohne die Frist ging der Push
/// gleichzeitig mit der Nachricht ab und kam als Mitteilung für etwas, das
/// längst gelesen war. Unmittelbar vor dem Versand wird deshalb noch einmal
/// geprüft (`notify::noch_ungelesen`).
pub const VERZOEGERUNG_MS: u64 = 2_500;

pub type Mitschnitt = Arc<Mutex<Vec<(Uuid, PushPayload)>>>;

pub struct PushService {
    config: std::sync::Arc<Config>,
    http: reqwest::Client,
    /// Nur für Tests: Ist er gesetzt, wird nicht gesendet, sondern
    /// mitgeschrieben.
    ///
    /// Im Entwicklungsbetrieb fehlen die VAPID-Schlüssel, `enabled()` ist also
    /// falsch, und niemand sähe, WER eine Mitteilung bekäme. Die Naht erlaubt,
    /// die Zielbestimmung (eine Mitteilung je Person, Stummschaltung) am
    /// Ausgang zu prüfen statt am Bildschirm eines Geräts.
    mitschnitt: OnceLock<Mitschnitt>,
    /// Wie lange eine Nachrichten-Mitteilung wartet, bevor sie abgeht
    /// (Millisekunden). Siehe [`VERZOEGERUNG_MS`].
    verzoegerung_ms: AtomicU64,
    /// Das Paar, mit dem gerade signiert wird: aus der Umgebung, sonst aus
    /// der Datenbank (siehe [`PushService::bereit`]). Leer, bis eines da ist.
    schluessel: RwLock<Option<Arc<VapidConfig>>>,
    /// Damit gleichzeitige Anfragen nicht jede für sich ein Paar anlegen.
    laden: tokio::sync::Mutex<()>,
}

impl PushService {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        let aus_umgebung = config.vapid.clone().filter(|vapid| {
            match vapid::paar_pruefen(&vapid.public_key, &vapid.private_key) {
                Ok(()) => true,
                Err(grund) => {
                    // Lieber ein eigenes, funktionierendes Paar aus der
                    // Datenbank als ein kaputtes, mit dem jeder Versand an
                    // einer 403 scheitert.
                    tracing::error!("{grund} – das Paar aus der Umgebung wird nicht benutzt");
                    false
                }
            }
        });
        if config.vapid_unvollstaendig {
            tracing::error!(
                "Nur einer von VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ist gesetzt – \
                 beide setzen oder beide weglassen (dann erzeugt der Server ein Paar)"
            );
        }
        Self {
            schluessel: RwLock::new(aus_umgebung.map(Arc::new)),
            laden: tokio::sync::Mutex::new(()),
            config,
            // Kein `unwrap_or_default`: Ein Standard-Client hätte weder die
            // Namensauflösung mit Filter noch das Umleitungsverbot – und beides
            // ist hier der Schutz, nicht Beiwerk.
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(NurOeffentlich)
                .build()
                .expect("HTTP-Client für Push lässt sich bauen"),
            mitschnitt: OnceLock::new(),
            verzoegerung_ms: AtomicU64::new(VERZOEGERUNG_MS),
        }
    }

    pub fn enabled(&self) -> bool {
        self.mitschnitt.get().is_some() || self.schluessel().is_some()
    }

    fn schluessel(&self) -> Option<Arc<VapidConfig>> {
        self.schluessel.read().ok().and_then(|slot| slot.clone())
    }

    /**
     * Sorgt dafür, dass ein Schlüsselpaar da ist, und sagt, ob Push an ist.
     *
     * WARUM: Ohne `VAPID_*` in der Umgebung war Push bisher aus, und jedes
     * Gerät hörte „Dieser Server verschickt gerade keine Benachrichtigungen“ –
     * obwohl der Browser längst erlaubt hatte. Ein Paar von Hand zu erzeugen
     * und zu hinterlegen ist ein Schritt, den man beim Einrichten leicht
     * übersieht. Jetzt nimmt der Server das Paar aus der Datenbank oder legt
     * es dort an. Die Umgebung hat Vorrang, wenn sie eines vorgibt.
     *
     * Scheitert die Datenbank (sie ist beim Start noch nicht da), bleibt Push
     * aus und der nächste Aufruf versucht es wieder.
     */
    pub async fn bereit(&self, pool: &PgPool) -> bool {
        if self.enabled() {
            return true;
        }
        let _sperre = self.laden.lock().await;
        if self.enabled() {
            return true;
        }
        match schluessel_aus_datenbank(pool).await {
            Ok((public_key, private_key)) => {
                if let Err(grund) = vapid::paar_pruefen(&public_key, &private_key) {
                    tracing::error!("VAPID-Paar in der Datenbank ist kaputt: {grund}");
                    return false;
                }
                if let Ok(mut slot) = self.schluessel.write() {
                    *slot = Some(Arc::new(VapidConfig {
                        public_key,
                        private_key,
                        subject: self.config.vapid_subject.clone(),
                    }));
                }
                tracing::info!("Push: VAPID-Paar aus der Datenbank geladen");
                true
            }
            Err(error) => {
                tracing::warn!(%error, "VAPID-Paar konnte nicht geladen werden");
                false
            }
        }
    }

    /// Wie [`Self::bereit`], im Hintergrund und so lange, bis es klappt.
    ///
    /// Beim Start, nach den Migrationen: Die vielen Stellen, die vor dem
    /// Versand `enabled()` fragen, sollen nicht auf den ersten Aufruf von
    /// `/push/public-key` warten müssen. Ist die Datenbank gerade weg, wird
    /// alle dreissig Sekunden wieder versucht.
    pub fn vorbereiten(self: &Arc<Self>, pool: PgPool) {
        let dienst = self.clone();
        tokio::spawn(async move {
            while !dienst.bereit(&pool).await {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }

    /// Schaltet den Mitschnitt ein (nur für Tests) und liefert die Liste,
    /// in die geschrieben wird. Ab jetzt sendet dieser Dienst nichts mehr.
    pub fn mitschneiden(&self) -> Mitschnitt {
        // Tests lesen den Mitschnitt gleich nach der Anfrage; die Frist vor
        // Nachrichten-Mitteilungen (`VERZOEGERUNG_MS`) gilt dort nicht, es sei
        // denn, ein Test setzt sie mit `verzoegerung_setzen` ausdrücklich.
        self.verzoegerung_setzen(Duration::ZERO);
        self.mitschnitt
            .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
            .clone()
    }

    /// Wartezeit vor Nachrichten-Mitteilungen. Für Tests kürzer (oder null).
    pub fn verzoegerung(&self) -> Duration {
        Duration::from_millis(self.verzoegerung_ms.load(Ordering::Relaxed))
    }

    pub fn verzoegerung_setzen(&self, dauer: Duration) {
        self.verzoegerung_ms
            .store(dauer.as_millis() as u64, Ordering::Relaxed);
    }

    pub fn public_key(&self) -> Option<String> {
        self.schluessel().map(|vapid| vapid.public_key.clone())
    }

    /// Sendet mehrere Mitteilungen, ohne die Anfrage warten zu lassen.
    ///
    /// Jede Person kann eine eigene Nutzlast haben (der Chat, in dem sie
    /// angesprochen wird, unterscheidet sich). Bei einem Mitschnitt wird sofort
    /// geschrieben: Es gibt nichts zu warten, und ein Test soll danach lesen
    /// können, ohne zu raten, wann der Hintergrund fertig ist.
    pub fn im_hintergrund(self: &Arc<Self>, pool: PgPool, ziele: Vec<(Vec<Uuid>, PushPayload)>) {
        if let Some(mitschnitt) = self.mitschnitt.get() {
            if let Ok(mut liste) = mitschnitt.lock() {
                for (personen, payload) in &ziele {
                    liste.extend(personen.iter().map(|id| (*id, payload.clone())));
                }
            }
            return;
        }
        let dienst = self.clone();
        tokio::spawn(async move {
            for (personen, payload) in ziele {
                dienst.send_to_users(&pool, &personen, &payload).await;
            }
        });
    }

    /// Sends to every device of the given users. Dead subscriptions (404/410)
    /// are removed so the table does not grow stale.
    pub async fn send_to_users(
        &self,
        pool: &PgPool,
        user_ids: &[Uuid],
        payload: &PushPayload,
    ) -> usize {
        if let Some(mitschnitt) = self.mitschnitt.get() {
            if let Ok(mut liste) = mitschnitt.lock() {
                liste.extend(user_ids.iter().map(|id| (*id, payload.clone())));
            }
            return user_ids.len();
        }
        if !self.bereit(pool).await {
            return 0;
        }
        let Some(vapid) = self.schluessel() else {
            return 0;
        };
        let vapid = vapid.as_ref();
        if user_ids.is_empty() {
            return 0;
        }

        let subscriptions = match sqlx::query_as::<_, PushSubscriptionRow>(
            "select id, user_id, endpoint, p256dh, auth from push_subscriptions where user_id = any($1)",
        )
        .bind(user_ids)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(%error, "loading push subscriptions failed");
                return 0;
            }
        };
        if subscriptions.is_empty() {
            return 0;
        }

        let body = match serde_json::to_vec(payload) {
            Ok(body) => body,
            Err(error) => {
                tracing::warn!(%error, "push payload not serialisable");
                return 0;
            }
        };

        let mut delivered = 0usize;
        let mut dead: Vec<Uuid> = Vec::new();

        // Begrenzt parallel statt nacheinander: Jeder Versand ist eine eigene
        // HTTP-Anfrage mit bis zu fünfzehn Sekunden Frist. Nacheinander
        // brauchte eine Gruppe mit hundert Geräten im schlechtesten Fall
        // 25 Minuten, und ein einziger hängender Dienst hielt alle dahinter
        // auf. Die Grenze schont den Rechner (Verschlüsseln, Signieren) und
        // die Push-Dienste.
        use futures_util::stream::{self, StreamExt};
        let body = &body;
        let mut ergebnisse = stream::iter(subscriptions)
            .map(|subscription| async move {
                let ausgang = self.send_one(vapid, &subscription, body).await;
                (subscription.id, ausgang)
            })
            .buffer_unordered(PUSH_PARALLEL);
        while let Some((id, ausgang)) = ergebnisse.next().await {
            match ausgang {
                Ok(true) => delivered += 1,
                Ok(false) => dead.push(id),
                // `warn` statt `debug`: Eine 403 (falscher Schlüssel, Apple
                // lehnt `sub` ab) oder ein gesperrter Name war bisher
                // unsichtbar – und genau das sind die Fälle, in denen auf
                // einem Gerät „nichts ankommt“.
                Err(error) => tracing::warn!(%error, "push delivery failed"),
            }
        }

        if !dead.is_empty() {
            let _ = sqlx::query("delete from push_subscriptions where id = any($1)")
                .bind(&dead)
                .execute(pool)
                .await;
        }
        delivered
    }

    /// `Ok(false)` means the subscription is gone and should be deleted.
    ///
    /// Eine Adresse, die die Prüfung nicht (mehr) besteht, gilt als fort –
    /// so verschwinden auch Zeilen, die vor der Prüfung angelegt wurden.
    async fn send_one(
        &self,
        vapid: &crate::config::VapidConfig,
        subscription: &PushSubscriptionRow,
        payload: &[u8],
    ) -> Result<bool, String> {
        if endpunkt_pruefen(&subscription.endpoint).is_err() {
            return Ok(false);
        }
        let encrypted = ece::encrypt(&subscription.p256dh, &subscription.auth, payload)
            .map_err(|error| error.to_string())?;
        let authorization = vapid::authorization_header(
            &subscription.endpoint,
            &vapid.subject,
            &vapid.public_key,
            &vapid.private_key,
        )
        .map_err(|error| error.to_string())?;

        let response = self
            .http
            .post(&subscription.endpoint)
            .header("authorization", authorization)
            .header("content-encoding", "aes128gcm")
            .header("content-type", "application/octet-stream")
            .header("ttl", "43200")
            .header("urgency", "high")
            .body(encrypted)
            .send()
            .await
            .map_err(|error| error.to_string())?;

        let status = response.status().as_u16();
        match status {
            200..=299 => Ok(true),
            404 | 410 => Ok(false),
            _ => {
                // Der Grund steht im Körper (Apple: `{"reason":"BadJwtToken"}`,
                // FCM: Klartext). Ohne ihn ist eine 403 nicht zu deuten.
                let grund: String = response
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect();
                let dienst = vapid::audience_of(&subscription.endpoint).unwrap_or_default();
                Err(format!("{dienst} antwortete mit {status}: {grund}"))
            }
        }
    }
}

/**
 * Das gespeicherte Paar lesen – oder eines anlegen, wenn noch keines da ist.
 *
 * Erst anlegen mit `on conflict do nothing`, dann lesen: Starten zwei
 * Instanzen zugleich, gewinnt die erste Zeile, und beide lesen dieselbe.
 * Ein Paar je Instanz hiesse, dass jedes zweite Gerät seine Mitteilungen von
 * einem Absender bekäme, an den sein Abo nicht gebunden ist.
 */
pub async fn schluessel_aus_datenbank(pool: &PgPool) -> Result<(String, String), sqlx::Error> {
    let vorhanden: Option<(String, String)> =
        sqlx::query_as("select public_key, private_key from vapid_schluessel where id = 1")
            .fetch_optional(pool)
            .await?;
    if let Some(paar) = vorhanden {
        return Ok(paar);
    }
    let neu = vapid::generate_keys();
    sqlx::query(
        "insert into vapid_schluessel (id, public_key, private_key) values (1, $1, $2)
         on conflict (id) do nothing",
    )
    .bind(&neu.public_key)
    .bind(&neu.private_key)
    .execute(pool)
    .await?;
    let paar: (String, String) =
        sqlx::query_as("select public_key, private_key from vapid_schluessel where id = 1")
            .fetch_one(pool)
            .await?;
    if paar.0 == neu.public_key {
        tracing::info!("Push: neues VAPID-Paar erzeugt und in der Datenbank abgelegt");
    }
    Ok(paar)
}

/* ---------- Wohin eine Mitteilung gehen darf ---------- */

/// Wie lang die Adresse eines Push-Dienstes höchstens ist. Echte Adressen
/// (FCM, Mozilla, Apple, Microsoft) liegen weit darunter.
pub const ENDPUNKT_MAX: usize = 2048;

/**
 * Darf an diese Adresse eine Mitteilung gehen?
 *
 * Die Adresse schreibt der Client, und der Server schickt danach von sich aus
 * POST-Anfragen dorthin – bei jeder Nachricht, und auf Knopfdruck über
 * `/push/test`, dessen Antwort (`delivered`) verrät, ob das Ziel mit 2xx
 * geantwortet hat. Ohne Prüfung war das ein Fenster ins interne Netz: die
 * Datenbank, der Metadatendienst des Anbieters, jede Verwaltungsoberfläche
 * hinter der Firewall liessen sich ansprechen und abtasten.
 *
 * Echte Push-Dienste sind öffentliche Namen über HTTPS auf dem Standardport.
 * Genau das wird verlangt. Dass der NAME nicht auf etwas Internes zeigt,
 * prüft danach [`NurOeffentlich`] bei jeder Verbindung – ein Name lässt sich
 * jederzeit umbiegen, eine Prüfung beim Anlegen allein reichte nicht.
 */
pub fn endpunkt_pruefen(endpoint: &str) -> Result<(), &'static str> {
    if endpoint.len() > ENDPUNKT_MAX {
        return Err("Push-Endpunkt ist zu lang");
    }
    let url = url::Url::parse(endpoint).map_err(|_| "Push-Endpunkt ist keine gültige URL")?;
    if url.scheme() != "https" {
        return Err("Push-Endpunkt muss HTTPS sein");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Push-Endpunkt darf keine Zugangsdaten enthalten");
    }
    if url.port().is_some_and(|port| port != 443) {
        return Err("Push-Endpunkt muss den Standardport benutzen");
    }
    // Eine IP-Adresse wird nie aufgelöst und liefe am Filter vorbei.
    let Some(url::Host::Domain(name)) = url.host() else {
        return Err("Push-Endpunkt braucht einen Namen, keine IP-Adresse");
    };
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    let intern = !name.contains('.')
        || name == "localhost"
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
            .iter()
            .any(|endung| name.ends_with(endung));
    if intern {
        return Err("Push-Endpunkt muss ein öffentlicher Name sein");
    }
    Ok(())
}

/// Liegt diese Adresse im öffentlichen Netz?
pub fn ist_oeffentlich(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                // Carrier-grade NAT, IETF-Protokolle, Lasttests.
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ist_oeffentlich(IpAddr::V4(v4));
            }
            /*
             * NAT64 (64:ff9b::/96): Die IPv4-Adresse steckt in den letzten
             * 32 Bit, und nur DIE entscheidet. Pauschal gesperrt, ging auf
             * einem Server, der nur IPv6 hat und IPv4-Ziele über DNS64
             * erreicht, gar keine Mitteilung mehr hinaus – auch nicht an
             * FCM oder Apple.
             */
            let teile = v6.segments();
            if teile[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
                let [.., hoch, tief] = teile;
                let v4 = std::net::Ipv4Addr::from((u32::from(hoch) << 16) | u32::from(tief));
                return ist_oeffentlich(IpAddr::V4(v4));
            }
            let erstes = teile[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Eindeutig lokal (fc00::/7) und verbindungslokal (fe80::/10).
                || (erstes & 0xfe00) == 0xfc00
                || (erstes & 0xffc0) == 0xfe80
                // Dokumentation (2001:db8::/32).
                || (erstes == 0x2001 && v6.segments()[1] == 0x0db8))
        }
    }
}

/**
 * Namensauflösung, die nur öffentliche Adressen herausgibt.
 *
 * Die Prüfung beim Anlegen sieht nur den Namen. Zeigt der später (oder von
 * Anfang an) auf `127.0.0.1` oder `10.0.0.5`, ginge die Anfrage trotzdem
 * dorthin. Hier fällt die Entscheidung bei jeder Verbindung, an der Stelle,
 * an der aus dem Namen eine Adresse wird.
 */
struct NurOeffentlich;

impl reqwest::dns::Resolve for NurOeffentlich {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_string();
        Box::pin(async move {
            let adressen: Vec<std::net::SocketAddr> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|adresse| ist_oeffentlich(adresse.ip()))
                .collect();
            if adressen.is_empty() {
                return Err("Push-Endpunkt zeigt auf keine öffentliche Adresse".into());
            }
            Ok(Box::new(adressen.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod endpunkt_tests {
    use super::*;

    /// Adressen in der Form, in der Browser sie tatsächlich liefern (Länge,
    /// Zeichen, Pfade und Abfrageteile wie im Feld beobachtet).
    #[test]
    fn echte_push_dienste_gehen_durch() {
        let fcm_token = format!("dQw4w9WgXcQ:APA91b{}", "H-_x".repeat(36));
        let fcm = format!("https://fcm.googleapis.com/fcm/send/{fcm_token}");
        let fcm_neu = format!("https://fcm.googleapis.com/wp/{fcm_token}");
        let mozilla = format!(
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl{}",
            "Zk3_-a".repeat(40)
        );
        let apple = format!("https://web.push.apple.com/QGx1{}", "Yz-_9".repeat(30));
        for adresse in [
            "https://fcm.googleapis.com/fcm/send/abc:def",
            fcm.as_str(),
            fcm_neu.as_str(),
            "https://android.googleapis.com/gcm/send/abc:def",
            "https://jmt17.google.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
            "https://updates.push.services.mozilla.com/wpush/v1/gAAAA",
            mozilla.as_str(),
            "https://web.push.apple.com/QGx1",
            apple.as_str(),
            "https://web.push.apple.com:443/QGx1",
            "https://api.push.apple.com/3/device/abc",
            "https://wns2-par02p.notify.windows.com/w/?token=AwYAAA%2bb%3d",
            "https://db5p.notify.windows.com/w/?token=BQYAAA",
            "https://web.pushmessaging.samsungosp.com/wpush/v1/abc",
            "https://FCM.GoogleAPIs.com./fcm/send/abc",
        ] {
            assert!(adresse.len() <= ENDPUNKT_MAX, "{adresse}");
            assert_eq!(endpunkt_pruefen(adresse), Ok(()), "{adresse}");
        }
    }

    #[test]
    fn interne_ziele_werden_abgelehnt() {
        for adresse in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/x",
            "https://postgres/x",
            "https://api.internal/x",
            "https://fcm.googleapis.com:8443/x",
            "https://nutzer:geheim@fcm.googleapis.com/x",
            "file:///etc/passwd",
            "kein url",
        ] {
            assert!(endpunkt_pruefen(adresse).is_err(), "{adresse}");
        }
        assert!(endpunkt_pruefen(&format!("https://a.de/{}", "x".repeat(ENDPUNKT_MAX))).is_err());
    }

    #[test]
    fn nur_oeffentliche_adressen() {
        for privat in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!ist_oeffentlich(privat.parse().unwrap()), "{privat}");
        }
        assert!(
            !ist_oeffentlich("64:ff9b::a00:1".parse().unwrap()),
            "NAT64 → 10.0.0.1"
        );
        for oeffentlich in [
            // FCM, Apple (17.0.0.0/8), Mozilla (Fastly), Microsoft – v4 und v6.
            "142.250.185.74",
            "2a00:1450:4001:82b::200a",
            "17.188.172.33",
            "2620:149:a44::10",
            "151.101.193.91",
            "2a04:4e42::347",
            "20.42.65.85",
            // NAT64 auf eine öffentliche Adresse (DNS64 auf reinen v6-Servern).
            "64:ff9b::8efa:b94a",
        ] {
            assert!(
                ist_oeffentlich(oeffentlich.parse().unwrap()),
                "{oeffentlich}"
            );
        }
    }

    /// Die echten Namen über den echten Filter auflösen. Ohne Netz (oder in
    /// einer Umgebung, die nach aussen nichts auflöst) gibt es nichts zu
    /// prüfen – dann wird übersprungen statt rot.
    #[tokio::test]
    async fn echte_namen_loesen_oeffentlich_auf() {
        use reqwest::dns::Resolve;
        for name in [
            "fcm.googleapis.com",
            "updates.push.services.mozilla.com",
            "web.push.apple.com",
        ] {
            if tokio::net::lookup_host((name, 443)).await.is_err() {
                eprintln!("{name}: keine Namensauflösung hier – übersprungen");
                continue;
            }
            let adressen = NurOeffentlich
                .resolve(name.parse().unwrap())
                .await
                .unwrap_or_else(|fehler| panic!("{name}: {fehler}"));
            assert!(adressen.count() > 0, "{name}");
        }
    }
}
