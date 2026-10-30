//! Web Push delivery.
//!
//! Works on Android/Chrome/Firefox out of the box and on iOS 16.4+ once the PWA
//! has been added to the home screen.

pub mod ece;
pub mod vapid;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::db::PushSubscriptionRow;
use crate::dto::PushPayload;

/// Was ein Mitschnitt festhält: an wen welche Mitteilung gegangen wäre.
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
}

impl PushService {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        Self {
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
        }
    }

    pub fn enabled(&self) -> bool {
        self.mitschnitt.get().is_some() || self.config.push_enabled()
    }

    /// Schaltet den Mitschnitt ein (nur für Tests) und liefert die Liste,
    /// in die geschrieben wird. Ab jetzt sendet dieser Dienst nichts mehr.
    pub fn mitschneiden(&self) -> Mitschnitt {
        self.mitschnitt
            .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
            .clone()
    }

    pub fn public_key(&self) -> Option<&str> {
        self.config
            .vapid
            .as_ref()
            .map(|vapid| vapid.public_key.as_str())
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
        let Some(vapid) = self.config.vapid.as_ref() else {
            return 0;
        };
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

        for subscription in subscriptions {
            match self.send_one(vapid, &subscription, &body).await {
                Ok(true) => delivered += 1,
                Ok(false) => dead.push(subscription.id),
                Err(error) => tracing::debug!(%error, "push delivery failed"),
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
            _ => Err(format!("push service antwortete mit {status}")),
        }
    }
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
            let erstes = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Eindeutig lokal (fc00::/7) und verbindungslokal (fe80::/10).
                || (erstes & 0xfe00) == 0xfc00
                || (erstes & 0xffc0) == 0xfe80
                // Dokumentation (2001:db8::/32) und NAT64 (64:ff9b::/96).
                || (erstes == 0x2001 && v6.segments()[1] == 0x0db8)
                || (erstes == 0x0064 && v6.segments()[1] == 0xff9b))
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

    #[test]
    fn echte_push_dienste_gehen_durch() {
        for adresse in [
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
            "https://web.push.apple.com/QGx1",
            "https://wns2-par02p.notify.windows.com/w/?token=AwYAAA",
        ] {
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
        for oeffentlich in ["142.250.185.74", "2a00:1450:4001:82b::200a"] {
            assert!(
                ist_oeffentlich(oeffentlich.parse().unwrap()),
                "{oeffentlich}"
            );
        }
    }
}
