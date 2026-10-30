//! Der echte SFTP-Treiber gegen einen echten (in-process) SFTP-Server.
//!
//! # Warum ein eigener Server
//!
//! Auf dieser Maschine gibt es weder `sshd` noch `sftp-server`, und ohne
//! Gegenstelle bliebe der Treiber (`storage/sftp.rs`) ungeprüft – genau der
//! Teil, an dem Gigabyte-Dateien scheitern können: Abbruch mitten im Strom,
//! Fortsetzen, Umbenennen, Bereichslesen. `russh` bringt eine Serverseite
//! mit, `russh-sftp` einen SFTP-Handler; beides sind ohnehin Abhängigkeiten.
//! Der Server hier schreibt in ein Verzeichnis und kann auf Wunsch nach einer
//! bestimmten Zahl geschriebener Bytes Fehler melden.
//!
//! Was das NICHT beweist: wie sich die Hetzner-Box verhält (Fristen, Limits,
//! `statvfs`, Umbenennen auf ein vorhandenes Ziel). Das bleibt der
//! Admin-Probe `/admin/storage-check/kalt` auf der echten Box vorbehalten.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use russh::keys::PrivateKey;
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};

use initiative_api::config::SftpEinstellungen;
use initiative_api::storage::sftp::SftpSpeicher;
use initiative_api::storage::{ByteRange, Storage};

const MIB: usize = 1024 * 1024;

/// Was die Gegenstelle gesehen hat und wie sie sich verhalten soll.
#[derive(Default)]
struct Zustand {
    wurzel: PathBuf,
    /// Nach so vielen weiteren geschriebenen Bytes antwortet der Server auf
    /// jede Schreibanfrage mit einem Fehler. Negativ: nie.
    schreib_budget: AtomicI64,
    /// Wie viele Bytes die Gegenstelle insgesamt angenommen hat.
    geschrieben: std::sync::atomic::AtomicU64,
    /// Wie viele Bytes die Gegenstelle insgesamt ausgeliefert hat.
    gelesen: Mutex<u64>,
    /// Künstliche Pause je Schreibpaket in Millisekunden. Der Server arbeitet
    /// je Verbindung seine Anfragen der Reihe nach ab (wie ein echter SFTP-
    /// Server mit begrenzter Bandbreite): Ein langsamer Umzug hält damit
    /// alles auf, was auf DERSELBEN Verbindung wartet – und nur das.
    schreib_pause_ms: std::sync::atomic::AtomicU64,
    /// Wie viele SFTP-Sitzungen (= SSH-Verbindungen des Treibers) je aufgebaut wurden.
    verbindungen: std::sync::atomic::AtomicUsize,
    /// Handles aller laufenden Sitzungen – zum gewaltsamen Trennen.
    laufende: Mutex<Vec<russh::server::Handle>>,
}

#[derive(Clone)]
struct Server(Arc<Zustand>);

impl russh::server::Server for Server {
    type Handler = Ssh;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self::Handler {
        Ssh {
            z: self.0.clone(),
            kanaele: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

struct Ssh {
    z: Arc<Zustand>,
    kanaele: Arc<tokio::sync::Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl russh::server::Handler for Ssh {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.kanaele.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let kanal = self.kanaele.lock().await.remove(&channel_id).unwrap();
            session.channel_success(channel_id)?;
            self.z.verbindungen.fetch_add(1, Ordering::SeqCst);
            self.z.laufende.lock().unwrap().push(session.handle());
            russh_sftp::server::run(
                kanal.into_stream(),
                Sftp {
                    z: self.z.clone(),
                    handles: HashMap::new(),
                    zaehler: 0,
                },
            )
            .await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

enum Griff {
    Datei(std::fs::File),
    Ordner(Option<Vec<File>>),
}

struct Sftp {
    z: Arc<Zustand>,
    handles: HashMap<String, Griff>,
    zaehler: u32,
}

impl Sftp {
    fn pfad(&self, p: &str) -> PathBuf {
        self.z.wurzel.join(p.trim_start_matches('/'))
    }
    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en".into(),
        }
    }
    fn attrs(m: &std::fs::Metadata) -> FileAttributes {
        let mut a = FileAttributes {
            size: Some(m.len()),
            mtime: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32),
            ..Default::default()
        };
        if m.is_dir() {
            a.set_dir(true);
        } else {
            a.set_regular(true);
        }
        a
    }
    fn fehler(e: std::io::Error) -> StatusCode {
        match e.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
            _ => StatusCode::Failure,
        }
    }
}

impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _ext: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let p = if path == "." { "/".to_string() } else { path };
        Ok(Name {
            id,
            files: vec![File::dummy(p)],
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut o = std::fs::OpenOptions::new();
        o.read(pflags.contains(OpenFlags::READ));
        let schreibt = pflags.contains(OpenFlags::WRITE);
        o.write(schreibt);
        o.create(pflags.contains(OpenFlags::CREATE));
        o.truncate(pflags.contains(OpenFlags::TRUNCATE));
        let f = o.open(self.pfad(&filename)).map_err(Self::fehler)?;
        self.zaehler += 1;
        let h = format!("h{}", self.zaehler);
        self.handles.insert(h.clone(), Griff::Datei(f));
        Ok(Handle { id, handle: h })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(Self::ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let Some(Griff::Datei(f)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        f.seek(SeekFrom::Start(offset)).map_err(Self::fehler)?;
        let mut puffer = vec![0u8; len as usize];
        let n = f.read(&mut puffer).map_err(Self::fehler)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        puffer.truncate(n);
        *self.z.gelesen.lock().unwrap() += n as u64;
        Ok(Data { id, data: puffer })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let pause = self.z.schreib_pause_ms.load(Ordering::SeqCst);
        if pause > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(pause)).await;
        }
        let rest = self.z.schreib_budget.load(Ordering::SeqCst);
        if rest >= 0 {
            if rest < data.len() as i64 {
                // Von da an lehnt die Gegenstelle ALLES ab. Eine, die nur die
                // grossen Pakete ablehnt und die kleinen weiter annimmt, gibt
                // es nicht – so entstünden Lücken, die kein Server hinterlässt.
                self.z.schreib_budget.store(0, Ordering::SeqCst);
                return Err(StatusCode::Failure);
            }
            self.z
                .schreib_budget
                .fetch_sub(data.len() as i64, Ordering::SeqCst);
        }
        let Some(Griff::Datei(f)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        f.seek(SeekFrom::Start(offset)).map_err(Self::fehler)?;
        f.write_all(&data).map_err(Self::fehler)?;
        self.z
            .geschrieben
            .fetch_add(data.len() as u64, Ordering::SeqCst);
        Ok(Self::ok(id))
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let Some(Griff::Datei(f)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let m = f.metadata().map_err(Self::fehler)?;
        Ok(Attrs {
            id,
            attrs: Self::attrs(&m),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let m = std::fs::metadata(self.pfad(&path)).map_err(Self::fehler)?;
        Ok(Attrs {
            id,
            attrs: Self::attrs(&m),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.pfad(&filename)).map_err(Self::fehler)?;
        Ok(Self::ok(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.pfad(&path)).map_err(Self::fehler)?;
        Ok(Self::ok(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        // Wie OpenSSH-SFTP v3: ein vorhandenes Ziel ist ein Fehler.
        if self.pfad(&newpath).exists() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(self.pfad(&oldpath), self.pfad(&newpath)).map_err(Self::fehler)?;
        Ok(Self::ok(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let mut eintraege = Vec::new();
        for e in std::fs::read_dir(self.pfad(&path)).map_err(Self::fehler)? {
            let e = e.map_err(Self::fehler)?;
            let m = e.metadata().map_err(Self::fehler)?;
            eintraege.push(File::new(
                e.file_name().to_string_lossy().to_string(),
                Self::attrs(&m),
            ));
        }
        self.zaehler += 1;
        let h = format!("d{}", self.zaehler);
        self.handles
            .insert(h.clone(), Griff::Ordner(Some(eintraege)));
        Ok(Handle { id, handle: h })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.handles.get_mut(&handle) {
            Some(Griff::Ordner(inhalt)) => match inhalt.take() {
                Some(files) => Ok(Name { id, files }),
                None => Err(StatusCode::Eof),
            },
            _ => Err(StatusCode::Failure),
        }
    }
}

/// Die Gegenstelle und ein Treiber, der mit ihr spricht.
struct Probe {
    treiber: SftpSpeicher,
    z: Arc<Zustand>,
    wurzel: PathBuf,
}

impl Probe {
    /// Wo ein Schlüssel auf der „Box" liegt.
    fn drueben(&self, schluessel: &str) -> PathBuf {
        self.z.wurzel.join("initiative").join(schluessel)
    }
}

/// Ein fester Schlüssel aus einem Startwert: `russh` verlangt für zufällige
/// Schlüssel eine andere `rand`-Fassung als die dieses Crates, und für einen
/// Test, der nur eine Gegenstelle braucht, ist ein fester Schlüssel richtig.
fn schluessel(startwert: u8) -> PrivateKey {
    PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
        &[startwert; 32],
    ))
}

async fn probe() -> Probe {
    probe_mit(1, 2).await
}

async fn probe_mit(bulk: usize, lese: usize) -> Probe {
    let wurzel = std::env::temp_dir().join(format!("sftp-gross-{}", uuid::Uuid::now_v7().simple()));
    let box_dir = wurzel.join("box");
    std::fs::create_dir_all(&box_dir).unwrap();
    let z = Arc::new(Zustand {
        wurzel: box_dir,
        schreib_budget: AtomicI64::new(-1),
        ..Default::default()
    });
    std::fs::create_dir_all(z.wurzel.join("initiative")).unwrap();

    let config = russh::server::Config {
        keys: vec![schluessel(1)],
        ..Default::default()
    };
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hafen = socket.local_addr().unwrap().port();
    let mut server = Server(z.clone());
    tokio::spawn(async move {
        let _ = server.run_on_socket(Arc::new(config), &socket).await;
    });

    let client_key = schluessel(2);
    let schluesseldatei = wurzel.join("schluessel");
    std::fs::write(
        &schluesseldatei,
        client_key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap(),
    )
    .unwrap();

    let treiber = SftpSpeicher::neu(SftpEinstellungen {
        wirt: "127.0.0.1".into(),
        hafen,
        benutzer: "test".into(),
        schluesseldatei: schluesseldatei.to_string_lossy().to_string(),
        fingerabdruck: None,
        pfad: "initiative".into(),
        bulk_verbindungen: bulk,
        lese_verbindungen: lese,
    });
    Probe { treiber, z, wurzel }
}

impl Probe {
    /**
     * Neues Schreibbudget – aber erst, wenn die Gegenstelle ihren Rückstau
     * abgearbeitet hat.
     *
     * Ein Client, der nach einem Fehler aufgibt, hat bis zu 64 Schreibpakete
     * schon unterwegs; ein echter Server verwirft sie mit der Verbindung. Der
     * Server hier arbeitet sie noch ab, und wer das Budget in diesem Moment
     * hochsetzt, lässt sie durch – dann stünde im Teilstück mehr, als der
     * Test glaubt.
     */
    async fn budget_setzen(&self, neu: i64) {
        let mut vorher = u64::MAX;
        for _ in 0..50 {
            let jetzt = self.z.geschrieben.load(Ordering::SeqCst);
            if jetzt == vorher {
                break;
            }
            vorher = jetzt;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        self.z.schreib_budget.store(neu, Ordering::SeqCst);
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.wurzel);
    }
}

fn muster(laenge: usize) -> Vec<u8> {
    (0..laenge as u64)
        .map(|i| (i.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8)
        .collect()
}

async fn einsammeln(o: initiative_api::storage::ObjectStream) -> Vec<u8> {
    let mut roh = Vec::new();
    let mut s = o.stream;
    while let Some(t) = s.next().await {
        roh.extend_from_slice(&t.unwrap());
    }
    roh
}

fn quelle(probe: &Probe, name: &str, inhalt: &[u8]) -> PathBuf {
    let p = probe.wurzel.join(name);
    std::fs::write(&p, inhalt).unwrap();
    p
}

#[tokio::test]
async fn eine_grosse_datei_geht_hinueber_und_ein_bereich_kommt_von_der_richtigen_stelle() {
    let p = probe().await;
    let inhalt = muster(24 * MIB + 123);
    let q = quelle(&p, "gross.bin", &inhalt);

    p.treiber
        .put_datei("video/2026/10/u/a.mp4", &q, "video/mp4")
        .await
        .expect("hinüber");

    // Es liegt unter dem Endnamen, vollständig – und kein Teilstück mehr.
    let ziel = p.drueben("video/2026/10/u/a.mp4");
    assert_eq!(std::fs::metadata(&ziel).unwrap().len(), inhalt.len() as u64);
    assert!(!ziel.with_file_name("a.mp4.teil").exists());

    // Ein Bereich mitten im Video: nicht von vorn gelesen, sondern angesprungen.
    *p.z.gelesen.lock().unwrap() = 0;
    let ab = 20 * MIB as u64 + 7;
    let o = p
        .treiber
        .read(
            "video/2026/10/u/a.mp4",
            Some(ByteRange {
                start: ab,
                end: Some(ab + 99_999),
            }),
        )
        .await
        .unwrap()
        .expect("da");
    assert_eq!(o.total_size, Some(inhalt.len() as u64));
    assert_eq!(o.size, Some(100_000));
    let bytes = einsammeln(o).await;
    assert_eq!(bytes, inhalt[ab as usize..ab as usize + 100_000]);
    let gelesen = *p.z.gelesen.lock().unwrap();
    assert!(
        gelesen < 4 * MIB as u64,
        "für 100 kB am Ende der Datei wurden {gelesen} Bytes gelesen – es wurde nicht gesprungen"
    );

    // Offenes Ende bis zum Schluss.
    let o = p
        .treiber
        .read(
            "video/2026/10/u/a.mp4",
            Some(ByteRange {
                start: inhalt.len() as u64 - 5,
                end: None,
            }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(einsammeln(o).await, inhalt[inhalt.len() - 5..]);

    // Ganz lesen.
    let o = p
        .treiber
        .read("video/2026/10/u/a.mp4", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(einsammeln(o).await, inhalt);
}

#[tokio::test]
async fn ein_abbruch_mitten_in_der_uebertragung_laesst_keine_halbe_datei_unter_dem_endnamen() {
    let p = probe().await;
    let inhalt = muster(30 * MIB);
    let q = quelle(&p, "gross.bin", &inhalt);

    // Nach 12 MiB beginnt die Gegenstelle, Schreibanfragen abzulehnen.
    p.z.schreib_budget.store(12 * MIB as i64, Ordering::SeqCst);
    let fehler = p.treiber.put_datei("file/x/halb.bin", &q, "x/y").await;
    assert!(fehler.is_err(), "der Abbruch wurde verschluckt");

    let ziel = p.drueben("file/x/halb.bin");
    assert!(
        !ziel.exists(),
        "unter dem Endnamen liegt eine halbe Datei, die wie eine ganze aussieht"
    );
    // Und für den Leser ist sie schlicht nicht da.
    assert!(p
        .treiber
        .read("file/x/halb.bin", None)
        .await
        .unwrap()
        .is_none());
    let teil = ziel.with_file_name("halb.bin.teil");
    let da = std::fs::metadata(&teil).map(|m| m.len()).unwrap_or(0);
    assert!(da > 0 && da < inhalt.len() as u64, "Teilstück: {da}");
}

#[tokio::test]
async fn nach_einem_abbruch_wird_fortgesetzt_statt_von_vorn_geschrieben() {
    let p = probe().await;
    let inhalt = muster(40 * MIB + 5);
    let q = quelle(&p, "gross.bin", &inhalt);

    p.z.schreib_budget.store(25 * MIB as i64, Ordering::SeqCst);
    assert!(p
        .treiber
        .put_datei("file/x/fort.bin", &q, "x/y")
        .await
        .is_err());
    let teil = p.drueben("file/x/fort.bin.teil");
    let schon = std::fs::metadata(&teil).unwrap().len();
    assert!(schon >= 8 * MIB as u64, "zu wenig angekommen: {schon}");

    // Die Gegenstelle ist wieder gesund. Diesmal darf sie nur noch den REST
    // annehmen – müsste von vorn geschrieben werden, reichte das Budget nicht.
    let rest = inhalt.len() as i64 - schon as i64 + 4 * MIB as i64;
    p.budget_setzen(rest).await;
    p.treiber
        .put_datei("file/x/fort.bin", &q, "x/y")
        .await
        .expect("fortgesetzt");

    let ziel = p.drueben("file/x/fort.bin");
    assert_eq!(
        std::fs::read(&ziel).unwrap(),
        inhalt,
        "Inhalt nach Fortsetzen"
    );
    assert!(!teil.exists(), "das Teilstück blieb liegen");
}

#[tokio::test]
async fn ein_fremdes_teilstueck_wird_nicht_fortgesetzt() {
    // Ein Tresor verschlüsselt bei jedem Versuch mit neuem Salz neu: Das
    // Teilstück des ersten Versuchs passt dann nicht zur Quelle des zweiten.
    // Weiterschreiben ergäbe eine Datei aus zwei Hälften – gleich lang, falsch.
    let p = probe().await;
    let alt = muster(20 * MIB);
    let mut neu = alt.clone();
    for b in neu.iter_mut().take(100) {
        *b = b.wrapping_add(1);
    }
    let q_alt = quelle(&p, "alt.bin", &alt);
    let q_neu = quelle(&p, "neu.bin", &neu);

    p.z.schreib_budget.store(15 * MIB as i64, Ordering::SeqCst);
    assert!(p
        .treiber
        .put_datei("file/x/f.bin", &q_alt, "x/y")
        .await
        .is_err());
    p.budget_setzen(-1).await;
    p.treiber
        .put_datei("file/x/f.bin", &q_neu, "x/y")
        .await
        .expect("von vorn");
    assert_eq!(std::fs::read(p.drueben("file/x/f.bin")).unwrap(), neu);
}

#[tokio::test]
async fn eine_vorhandene_fassung_wird_beim_erneuten_umzug_ersetzt() {
    let p = probe().await;
    let q1 = quelle(&p, "1.bin", &muster(MIB));
    let q2 = quelle(&p, "2.bin", &muster(2 * MIB));
    p.treiber
        .put_datei("file/x/e.bin", &q1, "x/y")
        .await
        .unwrap();
    p.treiber
        .put_datei("file/x/e.bin", &q2, "x/y")
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(p.drueben("file/x/e.bin")).unwrap().len(),
        2 * MIB as u64
    );
}

#[tokio::test]
async fn loeschen_nimmt_datei_und_teilstueck_mit_und_fehlende_sind_kein_fehler() {
    let p = probe().await;
    let inhalt = muster(20 * MIB);
    let q = quelle(&p, "gross.bin", &inhalt);
    p.z.schreib_budget.store(10 * MIB as i64, Ordering::SeqCst);
    assert!(p
        .treiber
        .put_datei("file/x/l.bin", &q, "x/y")
        .await
        .is_err());
    p.budget_setzen(-1).await;
    p.treiber
        .put_datei("file/x/l2.bin", &q, "x/y")
        .await
        .unwrap();

    // Teilstück ohne Endnamen (Umzug abgebrochen, Nachricht gelöscht).
    assert!(p.drueben("file/x/l.bin.teil").exists());
    p.treiber.delete("file/x/l.bin").await.expect("löschen");
    assert!(
        !p.drueben("file/x/l.bin.teil").exists(),
        "Teilstück blieb auf der Box"
    );
    // Fertige Datei.
    p.treiber.delete("file/x/l2.bin").await.unwrap();
    assert!(!p.drueben("file/x/l2.bin").exists());
    // Nochmal: gibt es nicht – ist Erfolg.
    p.treiber.delete("file/x/l2.bin").await.unwrap();
}

#[tokio::test]
async fn alte_teilstuecke_werden_aufgeraeumt_frische_nicht() {
    let p = probe().await;
    let q = quelle(&p, "gross.bin", &muster(20 * MIB));
    for name in ["alt", "frisch"] {
        p.z.schreib_budget.store(10 * MIB as i64, Ordering::SeqCst);
        let _ = p
            .treiber
            .put_datei(&format!("file/x/{name}.bin"), &q, "x/y")
            .await;
    }
    let alt = p.drueben("file/x/alt.bin.teil");
    let datei = std::fs::OpenOptions::new().write(true).open(&alt).unwrap();
    datei
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400))
        .unwrap();
    drop(datei);

    let weg = p
        .treiber
        .teilreste_raeumen(std::time::Duration::from_secs(3 * 86_400))
        .await
        .unwrap();
    assert_eq!(weg, 1);
    assert!(!alt.exists());
    assert!(p.drueben("file/x/frisch.bin.teil").exists());
}

#[tokio::test]
async fn kleine_dateien_gehen_ueber_put_und_fehlende_lesen_sich_als_nichts() {
    let p = probe().await;
    p.treiber
        .put(
            "image/x/k.webp",
            axum::body::Bytes::from_static(b"klein"),
            "image/webp",
        )
        .await
        .unwrap();
    let o = p
        .treiber
        .read("image/x/k.webp", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(einsammeln(o).await, b"klein");
    assert!(p
        .treiber
        .read("image/x/gibt-es-nicht", None)
        .await
        .unwrap()
        .is_none());
}

/* ==========================================================================
 * Der Verbindungsvorrat
 * ========================================================================== */

/// Misst die Wartezeit kleiner Lesezugriffe, während ein grosser Umzug läuft.
/// Gibt die einzelnen Laufzeiten zurück.
async fn lesezeiten_waehrend_umzug(p: &Probe, runden: usize) -> Vec<std::time::Duration> {
    let klein = muster(64 * 1024);
    let q = quelle(p, "klein.bin", &klein);
    p.treiber.put_datei("file/x/klein.bin", &q, "x/y").await.unwrap();
    // Aufwärmen: die Lese-Verbindung(en) stehen, bevor gemessen wird.
    let o = p.treiber.read("file/x/klein.bin", None).await.unwrap().unwrap();
    einsammeln(o).await;

    // Jedes Schreibpaket (32 KiB) hält die Gegenstelle 150 ms auf: 1 MiB sind
    // 32 Pakete, also fast fünf Sekunden – lang genug, um mitten hineinzulesen.
    // Wer auf DERSELBEN Verbindung wartet, steht hinter dem laufenden Paket.
    p.z.schreib_pause_ms.store(150, Ordering::SeqCst);
    let gross = muster(MIB);
    let qg = quelle(p, "gross.bin", &gross);
    let treiber = &p.treiber;
    let umzug = async {
        let t = std::time::Instant::now();
        treiber
            .put_datei("file/x/gross.bin", &qg, "x/y")
            .await
            .unwrap();
        eprintln!("Umzug dauerte {:?}", t.elapsed());
    };
    let messen = async {
        // Dem Umzug einen Vorsprung lassen, damit die Schreibpakete wirklich in der Leitung sind.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let mut zeiten = Vec::new();
        for i in 0..runden {
            let t = std::time::Instant::now();
            let o = treiber
                .read(
                    "file/x/klein.bin",
                    Some(ByteRange {
                        start: 100,
                        end: Some(4195),
                    }),
                )
                .await
                .unwrap()
                .unwrap();
            let roh = einsammeln(o).await;
            assert_eq!(roh, klein[100..4196]);
            zeiten.push(t.elapsed());
            // Ungleiche Abstände, damit die Messung nicht im Takt der
            // 150-ms-Pakete des Umzugs läuft (sie träfe sonst immer dieselbe
            // Stelle im Paket und sähe immer dieselbe Wartezeit).
            tokio::time::sleep(std::time::Duration::from_millis(37 + 41 * (i as u64 % 5))).await;
        }
        zeiten
    };
    let (_, zeiten) = tokio::join!(umzug, messen);
    p.z.schreib_pause_ms.store(0, Ordering::SeqCst);
    zeiten
}

#[tokio::test(flavor = "multi_thread")]
async fn last_auf_der_bulk_verbindung_haelt_das_lesen_nicht_auf() {
    // Mit Vorrat (1 Bulk + 2 Lesen): Lesen läuft auf eigenen Verbindungen.
    let mit = probe_mit(1, 2).await;
    let mut zeiten_mit = lesezeiten_waehrend_umzug(&mit, 9).await;
    zeiten_mit.sort();
    let schlimmste_mit = *zeiten_mit.last().unwrap();

    // Alte Betriebsart (Lesen = 0): alles teilt sich EINE Verbindung.
    let ohne = probe_mit(1, 0).await;
    let mut zeiten_ohne = lesezeiten_waehrend_umzug(&ohne, 9).await;
    zeiten_ohne.sort();
    let schlimmste_ohne = *zeiten_ohne.last().unwrap();

    // Der Median taugt hier nicht: Ein Leser auf der geteilten Verbindung
    // wartet, bis der GANZE Umzug durch ist (die Schreibanfragen stehen in
    // der Leitung davor), und alle späteren Messungen laufen danach ohne
    // Last. Aussagekräftig ist der schlimmste Fall.
    eprintln!(
        "Lesen während eines Umzugs: schlimmster Lesezugriff mit Vorrat {schlimmste_mit:?}, \
         mit einer geteilten Verbindung {schlimmste_ohne:?}"
    );
    assert!(
        schlimmste_mit < std::time::Duration::from_millis(250),
        "mit eigener Lese-Verbindung wartete ein Lesezugriff {schlimmste_mit:?}"
    );
    assert!(
        schlimmste_ohne > std::time::Duration::from_secs(1) && schlimmste_ohne > schlimmste_mit * 10,
        "die Messung unterscheidet die Betriebsarten nicht: mit {schlimmste_mit:?}, ohne {schlimmste_ohne:?}"
    );
    // Und es waren nie mehr als 1 + 2 Verbindungen.
    assert!(mit.z.verbindungen.load(Ordering::SeqCst) <= 3);
    assert_eq!(ohne.z.verbindungen.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn der_vorrat_bleibt_klein_verteilt_leser_und_baut_tote_verbindungen_neu_auf() {
    let p = probe_mit(1, 2).await;
    let inhalt = muster(3 * MIB);
    let q = quelle(&p, "v.bin", &inhalt);
    p.treiber.put_datei("file/x/v.bin", &q, "x/y").await.unwrap();
    assert_eq!(p.z.verbindungen.load(Ordering::SeqCst), 1, "nur Bulk bisher");

    // Fünf Leser gleichzeitig, Ströme offen gehalten: Sie verteilen sich auf
    // die zwei Lese-Verbindungen – insgesamt 3, nicht 6.
    let mut offene = Vec::new();
    for _ in 0..5 {
        offene.push(p.treiber.read("file/x/v.bin", None).await.unwrap().unwrap());
    }
    assert_eq!(
        p.z.verbindungen.load(Ordering::SeqCst),
        3,
        "1 Bulk + 2 Lesen, nicht mehr"
    );
    for o in offene {
        assert_eq!(einsammeln(o).await, inhalt);
    }
    let befunde = p.treiber.gesundheit().await;
    assert_eq!(befunde.len(), 3);
    assert!(befunde.iter().all(|b| b.verbunden && b.gesund), "{befunde:?}");
    assert!(befunde.iter().all(|b| b.aktive_leser == 0), "Leser zählen sich nicht ab: {befunde:?}");

    // Alle Verbindungen sterben (Box neu gestartet): Der nächste Zugriff
    // baut neu auf – ohne Fehler, auch wenn die tote Verbindung noch als
    // „frisch" galt.
    let handles: Vec<_> = p.z.laufende.lock().unwrap().drain(..).collect();
    for h in handles {
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "Neustart".into(), "de".into())
            .await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let o = p
        .treiber
        .read("file/x/v.bin", Some(ByteRange { start: 10, end: Some(99) }))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(einsammeln(o).await, inhalt[10..100]);
    p.treiber.delete("file/x/v.bin").await.unwrap();
    assert!(p.z.verbindungen.load(Ordering::SeqCst) > 3, "es wurde neu verbunden");
    assert!(p.z.verbindungen.load(Ordering::SeqCst) <= 6);

    // Aufräumen beim Beenden: danach steht keine Verbindung mehr.
    p.treiber.beenden().await;
    let befunde = p.treiber.gesundheit().await;
    assert!(befunde.iter().all(|b| !b.verbunden), "{befunde:?}");
    // Und der Treiber bleibt benutzbar (baut bei Bedarf neu auf).
    assert!(p.treiber.read("file/x/v.bin", None).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_tote_lese_verbindung_trifft_die_andere_nicht() {
    let p = probe_mit(1, 2).await;
    let inhalt = muster(MIB);
    let q = quelle(&p, "w.bin", &inhalt);
    p.treiber.put_datei("file/x/w.bin", &q, "x/y").await.unwrap();
    // Zwei Leser öffnen beide Lese-Verbindungen.
    let a = p.treiber.read("file/x/w.bin", None).await.unwrap().unwrap();
    let b = p.treiber.read("file/x/w.bin", None).await.unwrap().unwrap();
    assert_eq!(p.z.verbindungen.load(Ordering::SeqCst), 3);
    // Genau die ERSTE Sitzung (Bulk) wird getrennt: Die Leser merken nichts.
    let erste = p.z.laufende.lock().unwrap().remove(0);
    let _ = erste
        .disconnect(russh::Disconnect::ByApplication, "x".into(), "de".into())
        .await;
    assert_eq!(einsammeln(a).await, inhalt);
    assert_eq!(einsammeln(b).await, inhalt);
    // Bulk baut sich beim nächsten Schreiben neu auf.
    let q2 = quelle(&p, "w2.bin", &inhalt);
    p.treiber.put_datei("file/x/w2.bin", &q2, "x/y").await.unwrap();
}

#[tokio::test]
async fn auflisten_liefert_alle_objekte_mit_groesse_ohne_inhalte_zu_lesen() {
    let p = probe().await;
    // Noch nichts ausgelagert: die Wurzel gibt es nicht oder ist leer – kein Fehler.
    assert!(p.treiber.auflisten().await.unwrap().unwrap().is_empty());

    for (name, n) in [
        ("file/2026/10/u1/a.bin", 1000usize),
        ("file/2026/10/u2/b.bin", 2 * MIB),
        ("video/2026/09/u1/c.mp4", 5),
    ] {
        let q = quelle(&p, "q.bin", &muster(n));
        p.treiber.put_datei(name, &q, "x/y").await.unwrap();
    }
    let gelesen_vorher = *p.z.gelesen.lock().unwrap();
    let mut liste = p.treiber.auflisten().await.unwrap().unwrap();
    liste.sort_by(|a, b| a.key.cmp(&b.key));
    let paare: Vec<(String, u64)> = liste.into_iter().map(|o| (o.key, o.size)).collect();
    assert_eq!(
        paare,
        vec![
            ("file/2026/10/u1/a.bin".to_string(), 1000),
            ("file/2026/10/u2/b.bin".to_string(), (2 * MIB) as u64),
            ("video/2026/09/u1/c.mp4".to_string(), 5),
        ]
    );
    assert_eq!(
        *p.z.gelesen.lock().unwrap(),
        gelesen_vorher,
        "beim Auflisten wurde Dateiinhalt gelesen"
    );
}
