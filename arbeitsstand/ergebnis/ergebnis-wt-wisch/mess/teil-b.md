
Spalten wie oben erklärt; „GOP" = Bilder zwischen zwei Schlüsselbildern des Prüfvideos, „Sprung" = künstliche Verzögerung je Sprung in ms.
Die Rohdaten je Lauf liegen in `mess/roh/vorher-*.json`; die Auswertung `node mess/auswerten.mjs vorher`.

Zum Vergleich ein zweiter, stärker belasteter Lauf (Rechner zeitweise bei Last 4, siehe `mess/auswertung-belastet.txt`): dieselben Grössenordnungen
(GOP 25, nativ, `schnell`: 9,0 Bilder/s, Ø 39 Bilder Verspätung, Bildalter Ø 143 ms), aber ein Einfrieren bei `hinher` (Befund 4).

## 3. Befunde

**1. Die bearbeitete Vorschau zeichnet während eines durchgehenden Zugs nie – also auch keine Masken.**
`Zeichn./s` ist bei `schnell`, `langsam` und `hinher` in allen fünf Bedingungen 0,0; die bearbeitete Leinwand ist in 0 % der Takte zu sehen.
Der Grund lässt sich messen: An jedem Bildrückruf des Videos während des Zugs stand `readyState` auf 1 (HAVE_METADATA) und `seeking` auf `true`
(15 von 15 Rückrufen bei `schnell`, 111 von 111 bei `langsam`, GOP 25, nativ), und `zeichnen()` in `vorschau.ts` bricht bei `readyState < 2` ab.
Die Sprungkette (`springenZu`) setzt im `seeked`-Rückruf sofort den nächsten Sprung; bis der Bildrückruf einen bis zwei Anzeigetakte später läuft, ist das Video schon wieder im Sprung.
Was der Anwender beim Wischen sieht, ist das ROHE Video: ohne Bearbeitung, ohne Masken.
Erst bei Stillstand erscheint die Bearbeitung: bei `stopp` zeichnet die Vorschau 0,4-mal je Sekunde, und die Leinwand ist in 42–72 % der Takte sichtbar, und zwar in der Haltezeit.
(Der bestehende Test „beim Wischen im Editor zeigt die Vorschau das bearbeitete Bild" besteht nur, weil `page.mouse.move` auf jede Antwort wartet und 30 ms Pause lässt – dann hat die Kette Lücken.)

**2. Das rohe Video hinkt weit hinter dem Finger her.**
Bilder/s 2–11 (nativ, GOP 25: 9–11; GOP 100: 4–6; 120 ms: 4–5,5; 250 ms: 2–2,7). Verspätung im Mittel 6–38 Bilder (nativ GOP 25), 12–66 (GOP 100), 12–78 (120 ms), 23–126 (250 ms), grösste 204 Bilder (8 s Film).
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

