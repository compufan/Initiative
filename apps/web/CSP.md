# Content-Security-Policy

Die Richtlinie steht in `vercel.json` unter `headers`. Sie ist die zweite
Verteidigungslinie: Falls doch einmal fremder Code in die Seite gelangt – über
eine Bibliothek, eine Nachricht, einen Dateinamen –, soll er nichts nachladen
und nichts hinausschicken können.

## Warum welche Zeile

| Angabe                                                       | Grund                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com` | **Die wichtigste Zeile.** Kein fremdes Skript, kein `eval`. Das `wasm-unsafe-eval` ist unvermeidlich: MediaPipe und die ONNX-Laufzeit für das Freistellen sind WebAssembly, und ohne diese Angabe startet keines von beiden. Es erlaubt ausdrücklich **nur** WebAssembly, nicht `eval` für JavaScript.                                                                                                                                     |
| `style-src 'self' 'unsafe-inline'`                           | React setzt an vielen Stellen `style={{ … }}`, und das sind Stil-Attribute. Ohne `unsafe-inline` fällt die halbe Oberfläche auseinander. Stile sind kein Ausführungspfad; der Verlust ist gering.                                                                                                                                                                                                                                          |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | Drei alte Einfallstore, die nichts kosten: eingebettete Plugins, ein untergeschobenes `<base>`, ein Formular, das woandershin sendet.                                                                                                                                                                                                                                                                                                      |
| `frame-ancestors 'none'`                                     | Niemand kann die App in einen fremden Rahmen setzen und Klicks abfangen.                                                                                                                                                                                                                                                                                                                                                                   |
| `img-src`/`media-src`/`connect-src` mit `https:`             | Hier ist die Richtlinie bewusst weit, und das soll man wissen: Die API-Adresse steht erst beim Bauen fest, und ein Medienabruf wird von der API auf eine signierte Adresse bei Cloudflare R2 umgeleitet. Eine feste Aufzählung wäre entweder falsch oder müsste bei jedem Umzug nachgezogen werden – und eine Richtlinie, die man ständig lockern muss, schützt am Ende gar nicht. `https:` schliesst immerhin unverschlüsselte Ziele aus. |

## Die eine Ausnahme: `www.gstatic.com` für Google Cast

Hier stand einmal, das Google-Cast-SDK sei abgelehnt. Die Ablehnung stützte
sich auf eine Annahme über die Lizenz, die bei der Nachprüfung nicht hielt:
Die *Google Cast SDK Additional Developer Terms* gewähren in §2.1
ausdrücklich eine „limited, worldwide, **royalty-free** … license". Es gibt
keine Gebühr, keine Umsatzschwelle und keine Nicht-kommerziell-Klausel. Die
einzige Zahlung im ganzen Umfeld sind einmalig fünf Dollar für ein
Entwicklerkonto, und die braucht nur, wer einen EIGENEN Empfänger
veröffentlicht; mit dem Standard-Empfänger (`CC1AD845`) entfällt auch das.

Also steht `https://www.gstatic.com` jetzt in `script-src` – und das ist
weiterhin eine Aufweichung der wichtigsten Zeile. Was sie erträglich macht:

* **Geladen wird erst nach Zustimmung.** Die Richtlinie ERLAUBT das Skript,
  die App HOLT es nicht. `cast_sender.js` kommt erst, wenn jemand das
  Streamen einmal ausdrücklich einschaltet (`modules/fernseher/cast.ts`). Wer
  den Knopf nie drückt, hat eine App, die nichts von fremden Servern lädt –
  genau wie vorher.
* **Nur `script-src`.** Alle drei Cast-Skripte wurden heruntergeladen und
  durchgesehen: Sie machen selbst keine Anfragen. Der Steuerkanal zum Gerät
  läuft im Browser (Media Router, mDNS im eigenen Netz), nicht auf der Seite.
  `connect-src` bleibt deshalb unberührt.
* **Es gibt weiter einen Weg ohne Google.** Siehe unten.

Was die Bedingungen dafür VERLANGEN, steht im Kopf von `cast.ts` – vor allem
§5.1: Es muss der offizielle `<google-cast-launcher>` sein, auf oberster
Ebene, nicht in einem Klappmenü. Ein nachgebautes Symbol wäre ein Verstoss.

## Die Wege, die ohne fremden Code auskommen

Sie bleiben, und zwar nicht aus Nostalgie. Cast läuft nur in Chromium-Browsern
und auf dem iPhone **gar nicht** – auch nicht in Chrome für iOS, weil Apple
dort die WebKit-Engine vorschreibt. Es zeigt Bilder höchstens mit 1280 × 720,
und eine Bild-Diashow muss vom Telefon getaktet werden und endet, wenn die App
zugeht.

Auf der Empfängerseite ist die Lücke kleiner geworden – Samsung hat Google Cast
im April 2026 nachgeliefert (Modelljahre ab 2023), LG ab Modelljahr 2024 –,
aber ein Fernseher steht sieben bis zehn Jahre im Haushalt. Fire TV und Roku
können es gar nicht. Die Aufstellung steht in
[docs/FEATURES.md](../../docs/FEATURES.md#funktioniert-chromecast-mit-allen-fernsehern).



- **Videos** über die eingebauten Schnittstellen des Browsers – Remote Playback
  (Chrome, Edge) und AirPlay (Safari). Ein Fingertipp, keine Einrichtung.
  Siehe `src/modules/fernseher/streamen.ts`.
- **Fotos, Videos und Diashows** über ein eigenes Blatt unter `/tv`, das der
  Browser des Fernsehers öffnet. Das ist der weitestreichende Weg überhaupt:
  Einen Browser hat jeder Fernseher der letzten zehn Jahre, ein Cast-Gerät
  nicht. Siehe `apps/api/src/modules/fernsehen.rs`.

## Enger machen, wenn die Adressen feststehen

Wer API- und R2-Adresse fest kennt, ersetzt in `connect-src`, `img-src` und
`media-src` das `https:` durch genau diese beiden Ursprünge. Das ist die einzige
sinnvolle Verschärfung – an `script-src` ist nichts mehr zu holen.

Zum Nachmessen: <https://csp-evaluator.withgoogle.com/>
