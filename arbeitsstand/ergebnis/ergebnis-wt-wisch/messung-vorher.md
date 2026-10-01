# Messung vorher: Wischen durch die Zeitleiste des Video-Editors

Stand: 30.09.2026, Arbeitsbaum `wt-wisch` (Zweig `v-wisch`, Ausgangspunkt d786eab), kein Produktivcode verändert.
Alles hier ist mit dem Messgerüst unter `ergebnis-wt-wisch/mess/` erzeugt und wiederholbar (siehe „Wie man es startet").

## 1. Aufbau der Messung

**Video.** 1280 × 720, 25 Bilder/s, 12 s = 300 Bilder, geschrieben mit der App-eigenen `videoSchreiben` (VP9 im WebM-Behälter).
Jedes Bild trägt seine Nummer als Strichcode (10 Felder zu 64 × 64 Punkten links oben, Schwarz = 0, Weiss = 1; dazu die Zahl gross im Bild),
damit sich aus jeder Leinwand nachlesen lässt, WELCHES Bild wirklich zu sehen ist – unabhängig davon, was die App über sich meldet.
Zwei Fassungen: Schlüsselbild alle 25 Bilder (1 s) und alle 100 Bilder (4 s, „langer GOP", wie eine lange Kameraaufnahme).

**Editor.** Über `e2e/buehne.ts` geöffnet. Bearbeitung: Ton → Schwarz-Weiss am ersten Abschnitt, danach viermal „Abschnitt hinzufügen"
(5 + 2 + 2 + 2 + 1 s = 12 s, fünf Abschnitte, alle mit derselben Bearbeitung). So liegt die bearbeitete Vorschau über dem Video,
und die Leiste überstreicht den ganzen Film (er nimmt 80 % ihrer Breite ein, `umfang = gesamt · 1,25`).

**Finger.** ECHTE Zeigerereignisse über das Protokoll des Browsers (`Input.dispatchMouseEvent`), 60 Hz, ohne auf die Antwort
jedes Ereignisses zu warten (wie ein Finger; der Browser fasst Ereignisse je Anzeigetakt zusammen, deshalb kommen je nach Last 45–60 je Sekunde an).
Der Zug beginnt dort, wo kein Griff des gewählten Abschnitts liegt (ein Tipp auf einen Griff kürzt den Abschnitt, statt die Wiedergabestelle zu ziehen –
beim ersten Versuch des Messgeräts hat genau das den Film von 12 s auf 7 s gekürzt).

Vier Bewegungen:

| Name | Bewegung |
|---|---|
| `schnell` | 1 s über den ganzen Film, danach sofort loslassen (300 Bilder/s Fingergeschwindigkeit) |
| `langsam` | 6 s über 93 % des Films, sofort loslassen (46 Bilder/s) |
| `hinher` | 0 → 1 → 0,3 → 0,9 → 0,5 in 3,2 s |
| `stopp` | 0,6 s bis 60 %, dann 2 s stillhalten (Finger liegt), dann loslassen |

**Was erfasst wird.** Je Zeigerereignis Zeit und Stelle. Je Anzeigetakt – gelesen NACH den Rückrufen des Takts, damit die Reihenfolge der Anmeldung nichts verfälscht –
`window.__vorschau` (`gezeichnet`, `letzteMs`), ob die bearbeitete Leinwand sichtbar ist, `currentTime`/`seeking` des Videos und die Stellung der Leiste.
Je Bild, das das Video wirklich anzeigt: `requestVideoFrameCallback` (`mediaTime`, `readyState`, `seeking`). Je `currentTime`-Zuweisung, `seeking` und `seeked`: ein Protokoll.
Am Ende: der Strichcode des Standbilds im Editor.

**Telefonähnlich.** Headless Chromium springt in einem kleinen Video viel schneller als ein Telefon. Ein Schalter NUR IM TESTCODE (`window.__sprung.ms`,
eingesetzt mit `addInitScript`) verzögert jede Zuweisung an `currentTime` um 0 / 120 / 250 ms: Das Video springt erst danach wirklich,
`seeking` ist bis dahin `true`, `currentTime` liefert das Ziel, und `readyState` fällt auf `HAVE_METADATA` – wie bei einem Sprung, der so lange dauert.
Das gilt für alle Videoelemente der Seite, also auch für den Leser (`leserDienst`). Ausserdem der lange GOP als zweite Stellschraube.
Der Schalter ist in der App nicht vorhanden.

**Kenngrössen** (alle über den Zug, vom Aufsetzen bis zum Loslassen):

- *Bilder/s (Anzeige)*: wie oft wechselt das SICHTBARE Bild (bearbeitete Leinwand, wenn sie zu sehen ist, sonst das rohe Video). Zum Vergleich: *Video-Bilder/s* (vom Video gemeldete Bilder) und *Sprünge/s* (`seeked`).
- *Verspätung in Filmbildern*: Abstand zwischen dem angezeigten Bild und dem Bild unter dem Finger bei dessen zuletzt gelieferten Ereignis, je Anzeigetakt (Ø / 95 % / grösster).
- *Bildalter in ms*: wie lange ist her, dass der Finger dort war (± 1 Bild), wo das angezeigte Bild herkommt. Unabhängig von der Fingergeschwindigkeit: Bei 300 Bildern/s sind zwei Bilder nur 7 ms.
- *Zeichn./s*: Zähler `gezeichnet` der Vorschau je Sekunde. *bearb. %*: Anteil der Takte, in denen die bearbeitete Leinwand zu sehen war.
- *1. Bild ms*: vom Aufsetzen bis zum ersten anderen Bild.
- *Stillstand→richtig ms*: vom letzten Ereignis bis das Bild der Fingerstelle da ist (nur bei `stopp` aussagekräftig; sonst „–", weil losgelassen wird).
- *Loslassen→Editor ms*: vom Loslassen bis die Überlagerung weg ist und der Editor sein genaues Standbild zeigt; *Standbild ok*: der Strichcode des Standbilds ist das Bild der Loslassstelle.

## 2. Ergebnis: Tabelle (Lauf „vorher")

Chromium 151 headless (Software-Grafik), 4 Kerne, mit anderen Arbeiten geteilt (Last zwischen 1 und 4). Die Zahlen schwanken dadurch um bis zu den Faktor 1,5
(Vergleich zweier Läufe weiter unten) – die Grössenordnungen nicht.

| GOP | Sprung | Szene | Dauer s | Zeiger/s | Bilder/s (Anzeige) | Video-Bilder/s | Sprünge/s | Sprung ms Ø/max | Verspät. Bilder Ø | p95 | max | Bildalter ms Ø | p95 | max | Zeichn./s | bearb. % | Maske sichtbar % | 1. Bild ms | Stillstand→richtig ms | Loslassen→Editor ms | Standbild ok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 | 0 | schnell | 1,0 | 58 | 9,0 | 10,0 | 10,0 | 101 / 148 | 37,3 | 56 | 60 | 134 | 198 | 215 | 0,0 | 0 | – | 153 | – | 219 | ja |
| 25 | 0 | langsam | 6,0 | 58 | 11,2 | 11,3 | 11,3 | 87 / 199 | 6,3 | 11 | 15 | 123 | 238 | 320 | 0,0 | 0 | – | 120 | 70 | 120 | ja |
| 25 | 0 | hinher | 3,2 | 59 | 9,4 | 9,7 | 9,7 | 105 / 232 | 29,8 | 51 | 56 | 135 | 233 | 299 | 0,0 | 0 | – | 125 | – | 240 | ja |
| 25 | 0 | stopp | 2,6 | 14 | 3,1 | 3,1 | 3,1 | 88 / 125 | 8,8 | 42 | 61 | 33 | 175 | 227 | 0,4 | 72 | – | 110 | 114 | 243 | ja |
| 100 | 0 | schnell | 1,0 | 58 | 6,0 | 6,0 | 6,0 | 210 / 385 | 65,9 | 107 | 111 | 242 | 384 | 401 | 0,0 | 0 | – | 72 | – | 522 | ja |
| 100 | 0 | langsam | 6,0 | 60 | 6,3 | 6,3 | 6,3 | 165 / 584 | 12,0 | 22 | 28 | 258 | 490 | 623 | 0,0 | 0 | – | 74 | 555 | 588 | ja |
| 100 | 0 | hinher | 3,2 | 57 | 4,4 | 4,7 | 4,7 | 233 / 544 | 64,5 | 149 | 163 | 329 | 650 | 782 | 0,0 | 0 | – | 86 | – | 369 | ja |
| 100 | 0 | stopp | 2,6 | 14 | 1,5 | 1,9 | 1,9 | 231 / 355 | 24,1 | 83 | 102 | 150 | 536 | 653 | 0,4 | 54 | – | 108 | 555 | 557 | ja |
| 25 | 120 | schnell | 1,0 | 59 | 4,0 | 5,0 | 4,0 | 88 / 160 | 78,2 | 107 | 121 | 281 | 399 | 433 | 0,0 | 0 | – | 187 | – | 387 | nein (275 statt 299) |
| 25 | 120 | langsam | 6,0 | 60 | 5,5 | 5,5 | 5,5 | 58 / 109 | 12,0 | 16 | 27 | 254 | 345 | 395 | 0,0 | 0 | – | 195 | – | 210 | ja |
| 25 | 120 | hinher | 3,2 | 55 | 5,3 | 5,6 | 5,6 | 57 / 102 | 53,4 | 84 | 94 | 259 | 379 | 428 | 0,0 | 0 | – | 183 | – | 248 | ja |
| 25 | 120 | stopp | 2,6 | 14 | 1,5 | 1,9 | 1,9 | 64 / 98 | 18,3 | 88 | 107 | 86 | 335 | 384 | 0,4 | 69 | – | 189 | 321 | 304 | ja |
| 25 | 250 | schnell | 1,0 | 59 | 2,0 | 2,0 | 2,0 | 124 / 183 | 122,2 | 195 | 204 | 537 | 723 | 740 | 0,0 | 0 | – | 378 | – | 478 | ja |
| 25 | 250 | langsam | 6,0 | 56 | 2,5 | 2,7 | 2,7 | 111 / 191 | 23,1 | 31 | 36 | 509 | 700 | 800 | 0,0 | 0 | – | 402 | – | 384 | ja |
| 25 | 250 | hinher | 3,2 | 58 | 2,5 | 2,5 | 2,5 | 109 / 163 | 88,8 | 174 | 191 | 468 | 687 | 744 | 0,0 | 0 | – | 360 | – | 373 | ja |
| 25 | 250 | stopp | 2,6 | 14 | 1,2 | 1,2 | 1,2 | 94 / 101 | 38,3 | 153 | 167 | 164 | 625 | 675 | 0,4 | 58 | – | 346 | 428 | 440 | ja |
| 100 | 250 | schnell | 1,0 | 59 | 2,0 | 3,0 | 3,0 | 157 / 321 | 125,8 | 172 | 177 | 451 | 616 | 632 | 0,0 | 0 | – | 337 | – | 687 | ja |
| 100 | 250 | langsam | 6,0 | 60 | 2,3 | 2,5 | 2,5 | 164 / 332 | 25,8 | 37 | 43 | 580 | 843 | 991 | 0,0 | 0 | – | 343 | – | 642 | ja |
| 100 | 250 | hinher | 3,2 | 60 | 1,9 | 2,2 | 2,2 | 169 / 356 | 93,1 | 172 | 191 | 497 | 820 | 887 | 0,0 | 0 | – | 342 | 574 | 674 | ja |
| 100 | 250 | stopp | 2,6 | 14 | 1,5 | 1,5 | 1,5 | 121 / 219 | 36,8 | 125 | 158 | 294 | 788 | 888 | 0,4 | 42 | – | 325 | 892 | 608 | ja |


Spalten wie oben erklärt; „GOP" = Bilder zwischen zwei Schlüsselbildern des Prüfvideos, „Sprung" = künstliche Verzögerung je Sprung in ms.
Die Rohdaten je Lauf liegen in `mess/roh/vorher-*.json`; die Auswertung `node mess/auswerten.mjs vorher`.

Zum Vergleich ein zweiter, stärker belasteter Lauf (Rechner zeitweise bei Last 4, siehe `mess/auswertung-belastet.txt`): dieselben Grössenordnungen
(GOP 25, nativ, `schnell`: 9,0 Bilder/s, Ø 39 Bilder Verspätung, Bildalter Ø 143 ms), aber ein Einfrieren bei `hinher` (Befund 4).

## 3. Befunde

**1. Die bearbeitete Vorschau zeichnet während eines durchgehenden Zugs nie – also auch keine Masken.**
`Zeichn./s` ist bei `schnell`, `langsam` und `hinher` in allen fünf Bedingungen 0,0; die bearbeitete Leinwand ist in 0 % der Takte zu sehen.
Der Grund lässt sich messen: An jedem Bildrückruf des Videos während des Zugs stand `readyState` auf 1 (HAVE_METADATA) und `seeking` auf `true`
(alle 275 Bildrückrufe des Videos in den 15 Zügen ohne Stillstand, nativ 168 von 168; auch die kurzen `schnell`-Züge: 10 von 10, 6 von 6), und `zeichnen()` in `vorschau.ts` bricht bei `readyState < 2` ab.
Die Sprungkette (`springenZu`) setzt im `seeked`-Rückruf sofort den nächsten Sprung; bis der Bildrückruf einen bis zwei Anzeigetakte später läuft, ist das Video schon wieder im Sprung.
Was der Anwender beim Wischen sieht, ist das ROHE Video: ohne Bearbeitung, ohne Masken.
Erst bei Stillstand erscheint die Bearbeitung: bei `stopp` zeichnet die Vorschau 0,4-mal je Sekunde, und die Leinwand ist in 42–72 % der Takte sichtbar, und zwar in der Haltezeit.
(Der bestehende Test „beim Wischen im Editor zeigt die Vorschau das bearbeitete Bild" besteht nur, weil `page.mouse.move` auf jede Antwort wartet und 30 ms Pause lässt – dann hat die Kette Lücken.)

**2. Das rohe Video hinkt weit hinter dem Finger her.**
Bilder/s 2–11 (nativ, GOP 25: 9–11; GOP 100: 4–6; 120 ms: 4–5,5; 250 ms: 2–2,5). Verspätung im Mittel 6–38 Bilder (nativ GOP 25), 12–66 (GOP 100), 12–78 (120 ms), 23–126 (250 ms), grösste 204 Bilder (8 s Film).
Bildalter im Mittel 120–135 ms (nativ GOP 25), 240–330 ms (GOP 100), 250–280 ms (120 ms), 470–540 ms (250 ms), bis 580 ms (GOP 100 + 250 ms), 95 % bis 843 ms.
Ein Sprung dauert hier schon ohne Schalter Ø 87–105 ms (GOP 25) und 165–233 ms (GOP 100), grösste 584 ms – Software-Dekodierung bei 720p ist telefonähnlich.
Bei `langsam` ist die Verspätung in Bildern klein (6–26), weil der Finger nur 46 Bilder/s zurücklegt; das Bildalter (ms) ist aber dasselbe wie bei `schnell`.

**3. Das erste Bild kommt spät.** 72–200 ms nativ/120 ms, 325–402 ms bei 250 ms: Der Finger setzt auf, und zehntel Sekunden lang tut sich nichts.

**4. Die Vorschau kann einfrieren.** In einem Lauf (`hinher`, GOP 25, nativ, belasteter Lauf) gelang die Zeichnung beim Aufsetzen (Die Vorschau zeichnet „das Bild, das gerade steht, sofort"),
danach nie wieder (Befund 1). Die bearbeitete Leinwand deckt das Video ab (`ist-verdeckt`) und zeigte in 93 % der Takte DIESES eine Bild, während der Finger 3 s über den Film zog:
Bilder/s 0,9, Verspätung Ø 118 Bilder, Bildalter Ø 1571 ms (95 % 2957 ms). Es hängt daran, ob beim Aufsetzen `readyState ≥ 2` ist – also vom Zufall. Im ruhigeren Lauf trat es nicht auf.

**5. Beim Loslassen arbeiten zwei Dekodierer gleichzeitig.** In 9 von 20 Läufen beginnt der Sprung des Lesers für das Standbild (`leserDienst`, Vorfahrt `'vorn'`),
während der Sprung des sichtbaren Videos noch läuft (Sprungprotokoll). Loslassen→Editor: Ø 120–247 ms (GOP 25, nativ), 369–588 (GOP 100), 210–387 (120 ms), 373–478 (250 ms), 608–687 (GOP 100 + 250 ms).
In 1 von 20 Läufen (120 ms, `schnell`) zeigte der Editor danach das FALSCHE Standbild (Strichcode 275 statt 299: das Stellbild vom Anfang des letzten Abschnitts) –
ein Wettlauf beim Umschalten von Überlagerung und Standbild, unabhängig von dem, was hier entworfen wird, aber nach dem Umbau mitzuprüfen.

**6. Mit Masken: nichts zu sehen, bis der Finger ruht.** Tipp-Maske auf einem wandernden grünen Quadrat (Sättigung −1), 300 Bilder in fünf Abschnitten, Rechengrösse 960 × 540: überall verfolgt nach 27–33 s.
Beim Wischen (`schnell`, `langsam`, nativ und 250 ms) ist die Maske in 0 % der Takte zu sehen; in der Haltezeit von `stopp` in 100 % der gezeichneten Takte (72–73 % aller).
Die Verfolgung liest während des Zugs nichts (`window.__verfolger.lesen` bleibt gleich) – sie ruht, wie beabsichtigt.

**7. Den Wächter in `vorschau.ts` einfach zu lockern, taugt nicht.** Versuch (nur im Messgerät, `readyState` 1 als 2 gemeldet): Die Vorschau zeichnet dann 8–68 Bilder je Zug,
aber die Leinwand zeigt häufig ein ANDERES Bild, als die Vorschau meldet – also ein altes Bild mit der Maske des neuen: Bei 38 % (`schnell`, nativ) bis 66 % (`schnell`, 250 ms) der Takte stimmte der Strichcode
der Leinwand nicht mit `letzteMs` überein (Ø Abstand 8–64 Bilder, grösster 112). `drawImage` eines Videos im Sprung liefert das Bild VOR dem Sprung.

**8. Dekodierer.** Während des Zugs springt genau ein Videoelement (das sichtbare); der Leser (Stellbild, Verfolgung) kommt beim Loslassen dazu (Befund 5). Mehr als diese zwei Dekodierer gibt es heute nicht, und der Wischspeicher darf keinen dritten öffnen.

**9. Das Zeichnen selbst ist in dieser Umgebung teuer** (Zusatzmessung unten): 36–230 ms je Bild in Software-Grafik. Auf einem Telefon mit Grafikeinheit deutlich weniger; Abnahmezahlen für die bearbeitete Vorschau müssen deshalb relativ zur gemessenen Zeichenzeit formuliert werden.

## 4. Zusatzmessungen

### 4.1 Was der Browser mitbringt (Chromium 151.0.7922.34, headless)

`VideoEncoder`, `VideoDecoder`, `ImageDecoder`, `OffscreenCanvas`, `createImageBitmap`, `requestVideoFrameCallback`: vorhanden. Anzeigetakt 16,7 ms. `hardwareConcurrency` 4, `deviceMemory` 8. Grafik: Software (SwiftShader).

### 4.2 Kleine, komprimierte Bilder: Grösse und Zeit (`mess/probe.spec.ts`, `mess/rauschen.spec.ts`)

| Bild (1280 × 720, verkleinert auf) | Format | Bytes |
|---|---|---|
| 480, einfach (40 bunte Rechtecke) | WebP 0,6 / 0,8 | 2,9 KB / 3,6 KB |
| 480, einfach | JPEG 0,7 / 0,85 | 5,2 KB / 6,9 KB |
| 480, feine Textur | WebP 0,6 / 0,8 | 8,1 KB / 17,2 KB |
| 480, feine Textur | JPEG 0,7 / 0,85 | 13,8 KB / 23,9 KB |
| 640, feine Textur | WebP 0,6 / 0,8 | 27 KB / 45 KB |
| 320, feine Textur | WebP 0,6 | 3,7 KB |
| 480, Bild des Prüfvideos (Textur + Rechtecke + Zahl) | WebP 0,75 | **10,5 KB** (300 Bilder: 3,15 MB) |
| 480, reines Rauschen (1280 → 480 verkleinert) | WebP 0,75 / JPEG 0,8 | 44 KB / 45 KB |
| 480, reines Rauschen unmittelbar in 480 (schlimmster Fall) | WebP 0,75 / JPEG 0,8 | 81 KB / 83 KB |

Zeiten: `canvas.toBlob` 46–80 ms Verzögerung, unabhängig von der Grösse (läuft neben der Hauptschleife; nebenher statt abwarten spart im Füllversuch 10 ms je Bild).
`createImageBitmap(blob)` 1,2–5 ms (unter Grafiklast bis 16 ms). `drawImage(bitmap, …)` auf 960 × 540 hochskalieren 0,2–2 ms. Ein entpacktes Bild 480 × 270 wiegt 0,52 MB.
WebP und JPEG kamen beide als das angeforderte Format zurück (`blob.type` geprüft).

### 4.3 Was kostet ein Bild der Vorschau? (`mess/zeichnen.spec.ts`)

`zeichneAnsicht(…, { fluechtig: true })` mit dem App-eigenen Zeichenweg (Ton: Belichtung + Sättigung; dazu 0 / 1 / 4 weiche Netzmasken), Quelle 960 × 540, Software-Grafik; Mittel je Zeichnung in ms
(mit „frisch": jedes Bild neue Masken, wie im Film; ohne: dieselben). Die Zielgrösse folgt der Leinwand – im Editor bei 412 Punkten Breite und Pixeldichte 1 sind es 512, bei Pixeldichte 2,6 bis zu 960 Punkte.

| Ziel | 0 Masken | 1 Maske | 4 Masken | 4 Masken frisch |
|---|---|---|---|---|
| 384 × 216 | 36 | 52 | 75 | 83 |
| 512 × 288 | 51 | 64 | 72 | 90 |
| 640 × 360 | 54 | 75 | 114 | 159 |
| 840 × 473 | 92 | 113 | 166 | 184 |
| 960 × 540 | 142 | 181 | 221 | 227 |

Die Kosten sind nur zum Teil Fläche: ein fester Anteil von rund 30 ms (Hochladen der Quelle, Verkleinern). Die erste Maske kostet 13–39 ms, jede weitere 8–30 ms (das Dekodieren einer Maske aus dem Vorrat nur 0,14 ms; 960 × 540 kodiert 5 KB).
Mit Grafikeinheit sind das erfahrungsgemäss einstellige Millisekunden – hier nicht messbar.

### 4.4 Wie schnell füllt sich ein Wischspeicher? (`mess/fuellen.spec.ts`)

Eigenes `<video>` (wie der Leser), je Bild `currentTime` setzen, auf `seeked` warten, in 480 × 270 zeichnen, `toBlob` WebP 0,75. Nativ, ohne künstliche Verzögerung, 300 Bilder.

| GOP | Weg | Gesamt | ms je Bild | Sprung Median / 95 % | fertig nach 19 / 38 / 75 / 150 / 300 Bildern (s) |
|---|---|---|---|---|---|
| 25 | Stufen 16, 8, 4, 2, 1 (toBlob abwarten) | 18,0 s | 60 | 37 / 66 ms | 1,1 / 2,2 / 4,3 / 8,7 / 17,9 |
| 25 | Stufen (toBlob nebenher) | 15,1 s | 50 | 44 / 71 ms | 1,0 / 1,9 / 3,8 / 7,6 / 15,0 |
| 25 | ein Durchlauf, jedes Bild der Reihe nach | 17,9 s | 60 | 50 / 96 ms | 0,8 / 1,6 / 3,8 / 9,2 / 17,8 |
| 100 | Stufen (abwarten) | 42,2 s | 141 | 109 / 269 ms | 2,4 / 4,6 / 10,5 / 21,2 / 42,0 |
| 100 | Stufen (nebenher) | 43,8 s | 146 | 119 / 332 ms | 2,0 / 4,2 / 8,4 / 20,3 / 43,4 |
| 100 | ein Durchlauf der Reihe nach | 57,3 s | 191 | 174 / 347 ms | 1,1 / 3,6 / 12,3 / 26,7 / 57,1 |

Die Stufen kosten keinen einzigen Sprung mehr als ein Durchlauf (jedes Bild wird genau einmal gelesen), bei langem GOP sind sie sogar schneller.
Zum Vergleich die Wiedergabe mit erhöhter Rate und Mitschnitt jedes vom Video gemeldeten Bildes (`requestVideoFrameCallback`): 1×: 12,0 s, 299 von 300 Bildern; 2×: 6,0 s, 240; 4×: 3,1 s, 172; 8×: 1,5 s, 89 (GOP 100: 300 / 236 / 179 / 87).

### 4.5 Zeichenweg aus dem Speicher, roh (`mess/prototyp.spec.ts`)

300 WebP-Bilder (6,9 KB im Mittel) im Speicher, Zeigerereignisse aus einem 60-Hz-Zeitgeber, gezeichnet wird `drawImage` in 640 × 360 ohne Bearbeitung.
Verglichen: A entpacken IM Anzeigetakt; B entpacken beim Zeigerereignis (kleiner Vorrat entpackter Bilder, 8), zeichnen im Anzeigetakt; C = B mit zwei Bildern voraus.

| Zug | Weg | Bilder/s | Verspätung Ø / 95 % (Bilder) | Bildalter Ø / 95 % / grösster (ms) |
|---|---|---|---|---|
| 1 s | A | 46 | 11,1 / 49 | 46 / 165 / 200 |
| 1 s | B | 59 | 0,3 / 5 | 14 / 17 / 19 |
| 1 s | C | 59 | 2,5 / 5 | 16 / 17 / 17 |
| 3 s | A | 38 | 7,9 / 41 | 79 / 400 / 533 |
| 3 s | B | 58 | 0,1 / 0 | 9 / 12 / 26 |
| 6 s | A | 35 | 1,5 / 4 | 19 / 66 / 100 |
| 6 s | B | 49 | 0,3 / 1 | 9 / 17 / 32 |

(„Bilder/s" bei 6 s ist durch die Fingergeschwindigkeit begrenzt: 46 Bilder/s.) Entpacken im Takt (A) ist wegen der Wartezeit des Entpackens zu langsam und zu unregelmässig; B liegt beim Anzeigetakt.
Das Vorausladen (C) bringt nichts Messbares.

### 4.6 Masken-Lauf (Tipp-Maske, `WISCH_MASKE=1`)

Wie oben, nur mit grünem Quadrat und Maske (Sättigung −1) statt Schwarz-Weiss. Die Probe liest die Sättigung in der Mitte des Quadrats an dem Bild, das die Vorschau meldet (entsättigt = Maske sichtbar).

| GOP | Sprung | Szene | Dauer s | Zeiger/s | Bilder/s (Anzeige) | Video-Bilder/s | Sprünge/s | Sprung ms Ø/max | Verspät. Bilder Ø | p95 | max | Bildalter ms Ø | p95 | max | Zeichn./s | bearb. % | Maske sichtbar % | 1. Bild ms | Stillstand→richtig ms | Loslassen→Editor ms | Standbild ok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 | 0 | schnell | 1,0 | 59 | 13,0 | 14,0 | 13,0 | 76 / 132 | 30,0 | 47 | 51 | 112 | 171 | 184 | 0,0 | 0 | 0 | 93 | – | 342 | ja |
| 25 | 0 | langsam | 6,0 | 60 | 16,2 | 16,3 | 16,3 | 62 / 227 | 4,2 | 7 | 10 | 74 | 155 | 205 | 0,0 | 0 | 0 | 72 | – | 285 | ja |
| 25 | 0 | stopp | 2,6 | 14 | 3,8 | 3,8 | 3,8 | 69 / 103 | 7,8 | 42 | 51 | 29 | 160 | 194 | 0,4 | 73 | 73 | 114 | 113 | 180 | ja |
| 25 | 250 | schnell | 1,0 | 59 | 3,0 | 3,0 | 3,0 | 66 / 85 | 110,1 | 172 | 177 | 478 | 626 | 642 | 0,0 | 0 | 0 | 347 | – | 30 | ja |
| 25 | 250 | langsam | 6,0 | 60 | 2,8 | 3,0 | 3,0 | 72 / 121 | 20,6 | 27 | 30 | 456 | 606 | 672 | 0,0 | 0 | 0 | 373 | – | 38 | ja |
| 25 | 250 | stopp | 2,6 | 13 | 0,8 | 1,2 | 1,2 | 57 / 78 | 27,1 | 139 | 167 | 118 | 547 | 599 | 0,4 | 72 | 72 | 337 | 319 | 35 | ja |


(Die Zeile „Loslassen→Editor" bei 250 ms ist hier durch den Zwischenspeicher der Standbilder verfälscht: Dieselben Bilder waren im selben Lauf schon einmal geladen.)

## 5. Grenzen dieser Messung

- **Streuung.** Rechner mit 4 Kernen, geteilt mit anderen Arbeiten (Last 1–4 während der Läufe). Zwei Läufe derselben Bedingung weichen bis zum Faktor 1,5 voneinander ab; einzelne Ausreisser (Befund 4) treten nur manchmal auf.
  Abnahmezahlen brauchen deshalb Abstand zu den Messwerten und mehrere Läufe.
- **Software-Grafik.** Jede Zeichnung der bearbeiteten Vorschau kostet hier 36–230 ms (Abschnitt 4.3); ein Telefon ist dort schneller. Die Sprünge des Videos sind dagegen in Chromium ohne Schalter schon telefonähnlich (Ø 87–233 ms).
- **Die künstliche Verzögerung** verzögert `currentTime` (alle Videoelemente), nicht die Dekodierung selbst. Sie bildet „ein Sprung dauert N ms" nach; wie lange ein echter Sprung bei welchem Abstand zum Schlüsselbild braucht, ist damit nicht gemessen.
- **Eingabe** über das Protokoll des Browsers: Der Browser fasst Ereignisse je Anzeigetakt zusammen, bei Last kommen 45–60 je Sekunde an. Berührungen auf einem echten Gerät (Berührungs- statt Mausereignisse, `touch-action`) sind nicht gemessen.
- **Ein Film, ein Gerät.** 720p, 25 Bilder/s, 12 s, fünf Abschnitte; Kameraaufnahmen mit veränderlicher Bildrate und B-Bildern sind nicht dabei.

## 6. Wie man es startet

```
# Dev-Server auf 5192 (wie in der Aufgabe beschrieben), dann:
cd ergebnis-wt-wisch/mess                      # node_modules ist ein Verweis auf den Arbeitsbaum
bash alle.sh vorher 25:0 100:0 25:120 25:250 100:250     # Bedingung = GOP:Sprung-ms; Ergebnis nach roh/vorher-*.json
node auswerten.mjs vorher                       # Tabelle; mit "json" als drittem Argument die Zahlen
WISCH_MASKE=1 WISCH_MARKE=maske WISCH_SZENEN=schnell,langsam,stopp WISCH_SPRUNG=0,250 \
  npx playwright test -c pw.config.ts wischen.spec.ts      # mit Maske
npx playwright test -c pw.config.ts probe.spec.ts           # Fähigkeiten, Kosten kleiner Bilder
npx playwright test -c pw.config.ts zeichnen.spec.ts        # Zeichenkosten (ZB/ZH/ZKANTEN/ZMASKEN einstellbar)
npx playwright test -c pw.config.ts fuellen.spec.ts         # Füllgeschwindigkeit
npx playwright test -c pw.config.ts prototyp.spec.ts        # Zeichenweg roh aus dem Speicher
```

Umgebungsvariablen von `wischen.spec.ts`: `WISCH_MARKE` (Dateipräfix), `WISCH_GOP`, `WISCH_SPRUNG` (kommagetrennt, ms), `WISCH_SZENEN`, `WISCH_CPU` (Drosselfaktor), `WISCH_MASKE=1`, `WISCH_STRICHCODE=1` (Strichcode je Takt lesen), `WISCH_LOCKER=1` (Versuch aus Befund 7).
Nach der Umsetzung: dieselbe Reihe mit `WISCH_MARKE=nachher` und `node auswerten.mjs nachher` – die Spalten sind dieselben.
