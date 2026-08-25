# Content-Security-Policy

Die Richtlinie steht in `vercel.json` unter `headers`. Sie ist die zweite
Verteidigungslinie: Falls doch einmal fremder Code in die Seite gelangt – über
eine Bibliothek, eine Nachricht, einen Dateinamen –, soll er nichts nachladen
und nichts hinausschicken können.

## Warum welche Zeile

| Angabe | Grund |
| --- | --- |
| `script-src 'self' 'wasm-unsafe-eval'` | **Die wichtigste Zeile.** Kein fremdes Skript, kein `eval`. Das `wasm-unsafe-eval` ist unvermeidlich: MediaPipe und die ONNX-Laufzeit für das Freistellen sind WebAssembly, und ohne diese Angabe startet keines von beiden. Es erlaubt ausdrücklich **nur** WebAssembly, nicht `eval` für JavaScript. |
| `style-src 'self' 'unsafe-inline'` | React setzt an vielen Stellen `style={{ … }}`, und das sind Stil-Attribute. Ohne `unsafe-inline` fällt die halbe Oberfläche auseinander. Stile sind kein Ausführungspfad; der Verlust ist gering. |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | Drei alte Einfallstore, die nichts kosten: eingebettete Plugins, ein untergeschobenes `<base>`, ein Formular, das woandershin sendet. |
| `frame-ancestors 'none'` | Niemand kann die App in einen fremden Rahmen setzen und Klicks abfangen. |
| `img-src`/`media-src`/`connect-src` mit `https:` | Hier ist die Richtlinie bewusst weit, und das soll man wissen: Die API-Adresse steht erst beim Bauen fest, und ein Medienabruf wird von der API auf eine signierte Adresse bei Cloudflare R2 umgeleitet. Eine feste Aufzählung wäre entweder falsch oder müsste bei jedem Umzug nachgezogen werden – und eine Richtlinie, die man ständig lockern muss, schützt am Ende gar nicht. `https:` schliesst immerhin unverschlüsselte Ziele aus. |

## Enger machen, wenn die Adressen feststehen

Wer API- und R2-Adresse fest kennt, ersetzt in `connect-src`, `img-src` und
`media-src` das `https:` durch genau diese beiden Ursprünge. Das ist die einzige
sinnvolle Verschärfung – an `script-src` ist nichts mehr zu holen.

Zum Nachmessen: <https://csp-evaluator.withgoogle.com/>
