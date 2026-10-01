# Entwurf: Weichzeichnen und Bokeh an der Maske (Foto und Video)

Stand: Arbeitsbaum `wt-blur`, Zweig `v-blur`, Ausgangspunkt `d786eab`. Nur Entwurf – im Repo wurde nichts geändert.
Alle Zahlen stammen aus dem Messgerüst unter `ergebnis-wt-blur/` (Abschnitt 1); alle Bilder liegen in `ergebnis-wt-blur/bilder/`.

## 0. Kurzfassung

1. **Der Anwender hat recht, und zwar auf beiden Wegen.** Heute verändert das Weichzeichnen 67–96 % aller Bildpunkte mit Maske ≤ 15/255 *ausserhalb* einer Netzmaske (Staub 0…12 in der Maske), holt Farbe aus dem Saum und von draussen herein (Fremdfarbe 0,26–0,53 direkt an der Kante) und macht die Kante 1,3–2× so breit wie die Maske. Der Prozessorweg (`bokehRgba`) ist zusätzlich kaputt: doppelter Radius, unbedeckte Bildpunkte (Streifen), schwarze Ringe bei gebrochenem Radius.
2. **Bokeh ist heute nicht sichtbar**, weil der Schattierer 48 Zufallstupfen je Bildpunkt nimmt: Ein Lichtpunkt wird eine körnige Scheibe (Streuung 0,61), auf dem Prozessor Streifen.
3. **Entwurf in drei Sätzen:** Zwei Regler je Bereich: „Weichzeichnen“ (Feld `unschaerfe`, Gauss, Überblendung nach Maskenstärke) und „Bokeh“ (neues Feld `bokeh`, Sechseck-Blende, Radius wächst mit der Maske). Beide rechnen in **einer eigenen Vorstufe** vor der Tonkette, über **normalisierte Faltung mit Kerngewichten** (Bildpunkte aus dem Maskenkern zählen, Saum und Staub nicht), mit Rückfall aufs Original, wo nichts Gültiges in der Nähe liegt. Die Blende ist ein **flaches Sechseck aus drei Rauten** (fünf Strecken), kein Zufall, dazu **Verstärkung heller Stellen** im linearen Licht.
4. **Gemessen am Prototyp** (GPU- und Prozessorfassung, 1200 × 900, Netzmaske mit Staub und 11 px Saum): ausserhalb der Maske 0 von 214 313 Bildpunkten verändert (heute 92 %), Fremdfarbe ≤ 0,02 ausser direkt an der Kante, Kantenbreite 1,9 px statt 14 px, Kantenkontrast 0,98 statt 0,47, Lichtpunkt-Scheibe Streuung 0,09 statt 0,61, GPU gegen CPU höchstens 1 Stufe Unterschied (heute sind beide Wege sichtbar verschieden: Hof, Streifen, doppelter Radius). Kosten unter SwiftShader: Faktor 2–5 günstiger als der heutige Schattierer.
5. **Der Regler-Zug wird flüssig:** Die Unschärfe rechnet nicht mehr im Hauptschattierer, sondern wird als Zwischenbild gemerkt – ein Zug an „Belichtung“ kostet nichts mehr für sie.

## 1. Messgerüst

Dateien in `ergebnis-wt-blur/mess/` (Playwright gegen den Dev-Server 5191, Chromium mit SwiftShader; die Module der App werden per `import('/src/…')` geladen, die *echten* Funktionen `bildRechnen`, `teileFalten`, `rasterFuer`, `maskeUmrastern`, `rleKodieren`, `bokehRgba` laufen):

| Datei | Inhalt |
|---|---|
| `lib.js` | Szenen, Masken, Abstandstransformation, Masse A–E, Montagen |
| `fall.js` | Fall durch den heutigen Renderer (GPU und Prozessor), Tiefe-Masken |
| `proto.js` | Referenzrechnung des Entwurfs (Gleitkomma, brute force) |
| `gpu.js` | Entwurf als Mehrdurchlauf-Schattierer (WebGL2, RGBA16F) – nur zum Messen |
| `cpu.js` | dieselbe Rechnung auf dem Prozessor (Float32Array) |
| `final.spec.ts`, `misch.spec.ts`, `reihe.spec.ts`, `zeit.spec.ts`, `rand.spec.ts`, … | Läufe; Tabellen mit `tabelle3.py` |

**Szenen** (Seitenverhältnis 4 : 3, Geometrie skaliert mit Breite/1200): (A) rotes, kariert texturiertes Motiv (Kopf, Hals, Rumpf, Arm, 9 px dünne Stange) auf grün gestreiftem Grund; (B) dunkler Grund (12) mit Lichtpunkten (Radius 2,6 px, 255) einzeln und als Kette hinter dem Kopf; (C) eine Reihe Lichtpunkte unter einem waagerechten Masken-Verlauf.
**Masken** (alle über `teileFalten` auf das echte Raster, wie die App): `hart`; `weich6/20`; `netz` (Saum ±8 px, Dunst aussen 0…12, Zuversichtsrauschen innen 235…255, dann `kanteWeichzeichnen` Radius 1 – 10–90-%-Breite **11 px**); `netzbreit` (±27 px wie „U²-Net“, Breite **29 px**); `video` (zwei gegeneinander versetzte, leicht gewachsene Netzmasken, bei t = 0,5 überblendet wie `ueberblenden`, dann `rleKodieren`/`rleDekodieren`); `hverlauf`; „Motiv + Tiefe“ (Tiefenteil `dazu` + Netzteil `weg` wie `kombiAnlegen`).
**Fälle:** Bereich = Motiv („Motiv“) und Bereich = Umkehrung („Grund“, Porträtmodus); Regler 1 → Radius 24 px bei 1200 px Kantenlänge.

**Masse** (Abstände zur 0,5-Isolinie der Maske, in Bildpunkten bei 1200 px):

* **A – ausserhalb:** (A1) Anteil der Bildpunkte mit Maske ≤ 15/255, die sich überhaupt ändern (Soll 0, „bit-gleich“); (A2) Reichweite = grösster Abstand ausserhalb der Isolinie, in dem mehr als 1 % der Bildpunkte um mehr als 2 Stufen abweichen; mittlere Abweichung je Abstandsfach.
* **B – Fremdfarbe innen:** Anteil der Farbe des Gegenstücks (aus der Chromazität entmischt, abzüglich des Wertes tief im Bereich) je Abstand zur Kante.
* **C – Kantenbreite:** 10–90-%-Breite des über 51 Randpunkte des Kopfes gemittelten Profils quer zur Kante (Original 1,6 px).
* **D – Randschärfe:** Kontrast bei ±4 px (Original 1,0), grösste Steigung relativ zum Original, Lage der 50-%-Kreuzung (Kantenversatz), Überschwinger.
* **E – Lichter:** Spitzenwert, mittlere Helligkeit im Inneren (r 0,15–0,75), Rand/Innen (r 0,85–0,97), Aussen/Innen (r 1,15–1,45), Streuung im Inneren (Variationskoeffizient).

Vorbehalte: synthetische Szenen (keine echten Fotos), SwiftShader ist ein Software-Rasterizer (nur Verhältnisse zählen, nicht Millisekunden), die Maschine war mit anderen Läufen geteilt (Zeiten schwanken um ± 30 %; Verhältnisse in einem Lauf sind belastbarer).

## 2. Befund heute (1200 × 900, Regler 1)

„Bereich“ = Maske greift; Fremdfarbe bei 0–2 / 2–4 / 4–8 px Abstand *in* den Bereich; Breite der Kante (Maske); Kontrast bei ±4 px; Kantenversatz.

| Fall | Weg | A1: Maske ≤ 15 verändert | A2 Reichweite px | B Fremdfarbe | C Kantenbreite px | D Kontrast | Versatz px |
|---|---|---|---|---|---|---|---|
| Bokeh, Grund, Netz | heute GPU | 92 % (max 34) | ≥ 64 | 0,40 / 0,34 / 0,20 | 14,0 (11) | 0,47 | −1,5 |
| | heute CPU | 95 % (max 19) | ≥ 64 | 0,52 / 0,51 / 0,49 | 17,4 (11) | 0,20 | −4,2 |
| | **neu** (GPU = CPU) | **0 %** | **2** | 0,03 / 0,00 / 0,00 | **1,9** | **0,98** | −0,4 |
| Bokeh, **Motiv**, Netz | heute GPU | 84 % (max 39) | ≥ 64 | 0,26 / 0,22 / 0,10 | 11,4 (11) | 0,42 | **+3,4** |
| | heute CPU | 67 % | ≥ 64 | 0,40 / 0,40 / 0,37 | 13,8 | 0,19 | +4,4 |
| | **neu** | **0 %** | **2** | 0,01 / 0,00 / 0,00 | **1,9** | **0,97** | +0,4 |
| Bokeh, Grund, Video | heute GPU | 88 % | ≥ 64 | 0,39 / 0,31 / 0,17 | 12,0 (11) | 0,58 | −1,3 |
| | heute CPU | 91 % | ≥ 64 | 0,52 / 0,51 / 0,49 | 16,3 | 0,24 | −3,5 |
| | **neu** | **0 %** | **2** | 0,10 / 0,03 / 0,02 | **1,5** | **0,98** | −0,1 |
| Bokeh, Grund, Netz breit (29) | heute GPU | 92 % | ≥ 64 | 0,48 / 0,45 / 0,38 | 18,4 | 0,16 | +0,6 |
| | heute CPU | 96 % | ≥ 64 | 0,53 / 0,51 / 0,49 | 23,8 | 0,07 | −9,2 |
| | **neu** | **0 %** | **4** | 0,11 / 0,00 / 0,00 | **3,9** | **0,96** | −0,8 |
| Weichz., Grund, Netz | **neu** (Gauss) | 0 % | 4 | 0,04 / 0,00 / 0,00 | 2,9 | 0,98 | −0,2 |
| Weichz., Motiv, Netz | **neu** | 0 % | 4 | 0,01 / 0,00 / 0,00 | 3,1 | 0,96 | +0,4 |
| Weichz., Grund, Video | **neu** | 0 % | 4 | 0,14 / 0,01 / 0,01 | 2,2 | 0,99 | −0,2 |

Weitere Messungen:

* **Staub** (600 × 450): Eine *gleichmässige* Maske von 3 / 6 / 10 / 20 (von 255) verändert heute auf der GPU 6 / 20 / 31 / 46 % der Farbwerte um mehr als 1 Stufe (max 14 / 31 / 53 / 111). Maske 0 ist byte-gleich (der Durchlauf des Renderers selbst ist in Ordnung).
* **Motiv + Tiefe:** heute liegt um das Motiv ein scharfer Ring: Schärfe des Grundes bei gleicher Tiefenunschärfe 19,6 (4–8 px) gegen 1,9 weiter weg; 91 % der Bildpunkte mit Maske ≤ 15 ändern sich (max 130). Neu: 1,2 gegen 0,6, 0 % verändert.
* **Lichter** (Netzmaske, Grund): heute GPU Spitze 167, Inneres 94, Streuung **0,58**; heute CPU Inneres 80, Aussen/Innen 0,73 (Fleck statt Scheibe) und Streifen; neu Spitze 188, Inneres **172**, Rand/Innen 0,98, Aussen/Innen 0,17, Streuung **0,09** (Hintergrundrauschen mitgerechnet).
* **Radius auf dem Prozessor:** ein Lichtpunkt reicht bei nominal 16 px auf der GPU **17 px**, mit `bokehRgba` **35 px** (Messung `reich.spec.ts`).
* **Bilder:** `H-bokeh-netz-grund-ausschnitt.png`, `H-bokeh-netz-motiv-gesamt.png`, `H-licht-netz-gesamt.png`, `misch-motivtiefe-kante.png`, `misch-verlauf.png`, `faktor.png`, `reihe-g3.png`, `A-netz-grund-u1-1200-ausschnitt.png` (Original / heute GPU / heute CPU / neu GPU / neu CPU). Kurz: heute GPU ein gelb-brauner körniger Saum und Körnung, heute CPU ein breiter gelber Hof, schwarze Ränder und Streifen; neu GPU und CPU sind nicht zu unterscheiden und haben keinen Saum.

## 3. Ursachen (mit Beleg)

Geprüft wurden alle Kandidaten aus der Aufgabe; Ergebnis je Kandidat:

1. **Staub und Rauschen in der Maske** – *bestätigt, grösster Einzelposten.* `tonGpu.ts:500` ersetzt jeden Bildpunkt mit `bokeh > 0.002` durch `zerstreuen(...)`, und `bokehAn` (Z. 274–282) macht den Radius proportional zur Maske. Eine Maske von 3/255 (Staub) gibt einen Radius von 0,14 px bei 600 px Kantenlänge (0,28 px bei 1200 px) – genug, um 6 % der Werte um über 1 Stufe zu verändern. Bei Netzmasken liegt der Dunst bei 0…12 und wird von `quantisieren` (`rle.ts:37`: nur ≤ 5 → 0) im Video nicht einmal entfernt. Folge: 92 % der Bildpunkte mit Maske ≤ 15 ändern sich, Reichweite ≥ 64 px.
2. **Gewichtung nach Maskenwert statt Kern** – *bestätigt.* `zerstreuen` (Z. 359–362): `g = wp >= r·weite ? wp : 0`. Saum-Tupfen mit Maske 0,2–0,6 zählen mit, obwohl ihre Farbe aus Motiv und Grund gemischt ist. Fremdfarbe 0,40 / 0,34 / 0,20 bei 0–8 px (netz, Grund), 0,26 / 0,22 / 0,10 (Motiv: Grün im Rot).
3. **Der Saum selbst:** Die Netzmasken haben 11 px (Person) bis 29 px (U²-Net-Art) Kantenbreite; die Wirkung beginnt dort schon beim Fuss (Maske > 0,002) und ist **kein Überblenden**, sondern *Ersetzen* durch eine Zerstreuung mit Radius ∝ Maske. Bei Maske 0,3 weicht der Bildpunkt im Mittel um 100–140 Stufen vom Original ab. Folge: Kante 14 statt 11 px, Kontrast 0,47, Silhouette **3,4 px grösser** (Motivfall). Die Maske ist dabei nicht verkehrt – die Behandlung des Saums ist es.
4. **Zufallsrauschen des Schattierers:** 48 Tupfen mit je Bildpunkt gedrehter Spirale (`dreh`, Z. 335). Bei kleinen hellen Quellen trifft im Mittel nur ein Tupfen (0,56 Treffer je Bildpunkt bei 2,6-px-Licht und Radius 24) – Poisson-Körnung, die Scheibe ist ein Fleck (Streuung 0,61–0,82), die Kante fransig.
5. **Prozessorweg** – *bestätigt, vier eigene Fehler:*
   a) `bokehRgba` läuft über das *ganze* Bild (Z. 1173) und wird danach nur mit dem Gewicht gemischt: Farbe von draussen kommt herein (Fremdfarbe 0,46–0,52 bis 16 px, Hof).
   b) **Kern doppelt so gross:** `richtungsMittel` faltet drei *mittige* Strecken der Länge 2r+1 – die Stützweite ist die Summe der Halbprojektionen, nicht r. Gemessen: Reichweite 35 px bei r = 16 (GPU 17).
   c) **Schräge Richtungen decken das Bild nicht ab:** die Linien laufen nur von `j ≥ 0` (`bokeh.ts:130`), Startpunkte ausserhalb der Kante fehlen. Messung (`abd.spec.ts`, 800 × 600, r = 10): ein Lichtpunkt in der Mitte oder oben ergibt 1 489–1 509 helle Bildpunkte (Sechseck 47 × 43), bei (130, 560) **89** (15 × 23), bei (700, 560) **69** (23 × 3) – Lichter als Striche (Bild `H-licht-netz-gesamt.png`).
   d) **Gebrochener Radius:** `tonGpu.ts:1173` ruft `bokehRgba` mit `vollerRadius·k/3` (z. B. 5,33). `richtungsMittel` indiziert `stellen[i]` mit gebrochenem `i` (Z. 147 ff.) → `undefined`, die Fenstersumme wird nie fortgeschrieben; Ergebnis bei r = 5,33: **266 422 von 270 000 Bildpunkten schwarz**. Die Teilstufen (g < 255) – also jede Maskenkante – sind damit Müll: der schwarze Ring um das Motiv.
   e) Drei Stufen linear überblendet statt Grösse ∝ Maske (Z. 1176–1191), grober Kantenversatz (−4,2 px).
6. **Tiefenkarten:** Der Grund neben dem Motiv bekommt wegen der Regel Radius ∝ Maske im Saum einen kleineren Radius → scharfer Ring (Schärfe 19,6 gegen 1,9). Mit der Kernregel unten verschwindet er (1,2 gegen 0,6).
7. **Verfolgungsmasken:** Überblendung und RLE erzeugen einen breiteren Saum (Bild `H-bokeh-video-*`) und behalten den Dunst 6…12 (nur ≤ 5 wird 0). Kein eigener Mangel – sie verschärfen 1–3.
8. **„Wirkt das Weichzeichnen auf das Motiv nur in der Silhouette?“ – Nein.** Motivfall: Fremdfarbe 0,26 / 0,22 / 0,10, die Silhouette wächst um 3,4 px (GPU) bzw. 4,4 px (CPU), bis zu 59 % Motivfarbe auf der Grundseite.
9. **Bokeh nicht sichtbar:** Körnung (4), auf dem Prozessor ein anderes, kaputtes Bild (5); die Potenzspreizung (`SPREIZUNG` 4) gibt einem 2,6-px-Licht nur ein Inneres von 90–94 (CPU 80). Wirbel oder Zwiebelringe kamen in keiner Messung vor – das Problem ist Körnung, Saum und Fehler des Prozessorwegs, nicht die Form.

## 4. Entwurf

### 4.1 Felder, Alt-Dokumente, Schlüssel (Punkt a)

**Neues Feld** `bokeh` in `Bereichston` (`doc.ts:294`): Zahl 0 … 1, **Neutralwert 0**; `BEREICH_NEUTRAL = { …FARB_NEUTRAL, unschaerfe: 0, bokeh: 0 }`. Das bestehende `unschaerfe` behält Namen und Bereich, **bedeutet aber ab jetzt „Weichzeichnen“ (Gauss)** – kein Umbenennen, damit Rezepte, Entwürfe und Tests nicht stolpern.
Bedeutung der Werte (relativ zur längeren Kante `L` der Arbeitsgrösse, damit Vorschau und Ausgabe gleich aussehen – dieselbe Regel wie `bokehRadius`, `weich.ts:135`):

* Bokeh: Kreisradius des Sechsecks `R = bokeh · 0,02 · L` (1200 px → 24 px; 2560 px → 51 px). Obergrenze der Ausgabe 96 px.
* Weichzeichnen: `σ = unschaerfe · 0,012 · L` (1200 px → 14,4 px; Kern bis 3σ).
* Nicht endlich oder ausserhalb 0…1 → geklemmt/0 **an einer Stelle** (`szeneBauen`), damit weder GPU noch CPU je NaN sehen.

**Alt-Dokumente** (`rezept.ts`, `bereichAusRoh` Z. 698–723): Fehlt im rohen Bereich der Schlüssel `bokeh`, **wandert `unschaerfe` nach `bokeh`** (`bokeh = unschaerfe`, `unschaerfe = 0`). Grund: Das alte „Weichzeichnen“ *war* eine Zerstreuungsscheibe mit Radius ∝ Maske – die neue Bokeh-Stufe ist dessen saubere Fassung bei gleichem Radius, also dem alten Bild am nächsten. Steht `bokeh` in der Datei (auch mit 0), bleibt alles, wie es ist. `bereichNachRoh` schreibt immer beide Schlüssel. Kein Format-Zähler nötig; unbekannte Felder werden ohnehin ignoriert (ältere App liest `unschaerfe` weiter). Klemmen wie bisher: `zahl(v, 0, 1, 0)`.

| Stelle | Änderung |
|---|---|
| `doc.ts` | Feld, Neutralwert; `docKopie` kopiert `anpassung` per Spread – keine Änderung nötig (Test, dass `bokeh` durchkommt) |
| `maskenSpeicher.ts:182` `bereichWirkt` | `… \|\| unschaerfe !== 0 \|\| bokeh !== 0`; ein Bereich nur mit Bokeh ist **nicht neutral** (Kurzschluss in `bildRechnen`, `szeneNeutral`) |
| `maskenSpeicher.ts:243` `szeneSchluessel` | `…,u:${unschaerfe},b:${bokeh}` – ohne das zeigt der Merkzettel beim Zug am neuen Regler das alte Bild (dieselbe Fehlerklasse wie das eingefrorene Video) |
| `rezept.ts:685–723` | `bokeh` schreiben/lesen/klemmen; Migration (oben) |
| `rezept.ts:837` `rezeptHindernis` | `unschaerfe > 0 \|\| bokeh > 0` („weichgezeichneter oder unscharfer Bereich“) – Bokeh ist dieselbe Anonymisierung |
| `doc.ts docUnberuehrt` / `BildEditor haengtAmBild` | **keine Änderung:** beide prüfen auf vorhandene Bereiche/Teile, nicht auf Regler |
| `entwurf.ts` | keine Änderung (läuft über `docNachRoh`/`docAusRoh`; Test: Entwurf mit Alt-Regler wird migriert) |
| Rückgängig | `bereichRegler` bündelt je `bereich-<id>-<feld>` – `bokeh` bekommt von selbst einen eigenen Bündel-Schlüssel; Test: zwei Bereiche, zwei Regler, vier Schritte |
| Vorher/Nachher | `docOhneBearbeitung` lässt Bereiche weg – Test, dass der „Vorher“-Zug auch die Unschärfe ausschaltet |
| Tiefe / „Motiv + Tiefe“ | `teilEinsetzen([tiefe], 'Tiefe', 0.6)` (BildEditor Z. 2502/2585/2593) setzt künftig **`bokeh: 0.6`** (Linse: Radius folgt der Tiefe) und `unschaerfe: 0` – Parameter `unschaerfe` → `{ bokeh }` |
| `video/masken.ts` | siehe 4.9 |

### 4.2 Zusammenspiel der beiden Regler

* **Reihenfolge je Bereich:** erst **Bokeh**, dann **Weichzeichnen**; beides in einer Vorstufe *vor* Schärfe, globaler Kette und Bereichsfarben (wie heute die Tiefenschärfe „ganz am Anfang“). Mehrere Bereiche mit Unschärfe laufen **nacheinander auf dem Ergebnis des vorigen** (wie die Farbketten) – nicht mehr als Maximum wie `bokehAn`.
* **Begründung optisch:** Eine Linse streut Licht in der Blendenebene; ein Weichzeichner danach ist eine Mattscheibe/Streuscheibe *vor dem Sensor*. So bekommt die Bokeh-Scheibe bei Weichzeichnen > 0 einen weichen Rand und bleibt bei 0 scharf berandet. Umgekehrt (erst Gauss, dann Scheibe) verwischte der Gauss die Lichter vor der Verstärkung und nähme ihnen die Spitze.
* **Radien:** unabhängig voneinander (`R` für die Scheibe, `σ` für den Gauss, beide aus den eigenen Reglern); das Ergebnis ist der Gauss über der Scheibe. Kein gemeinsamer Radius, keine Kopplung der Werte.
* **Gewichte:** beide benutzen *dieselbe* Maske, aber verschieden: Bokeh: **Grösse ∝ Stärke** (Linse), Weichzeichnen: **Überblendung ∝ Stärke** (gewöhnlicher Weichzeichner). Gemessen: Gauss mit Überblendung hält Kanten nur ≈ 3 px breit, Bokeh mit Überblendung und festem Radius (verworfene Variante) 3,7–5,4 px und Kontrast 0,75–0,97; mit Grösse ∝ Maske 1,4–2,8 px.
* Nur einer der beiden > 0: nur dessen Stufe läuft (Kosten sparen, Verhalten bit-gleich zum Einzelregler).

### 4.3 „An der Maske begrenzt“ (Punkt b)

**Bausteine** (Konstanten stehen einmal in `unscharf.ts` und werden per `${…}` in den GLSL-Text gesetzt, wie `KURVE_STUETZEN`):

```
m     Maske 0…1 (bilinear aus dem Raster, wie heute)
rein  Kernwert:  Reinheit 0 → m   · 1 → 1   · 2 → eigenes Kernfeld
s     Stärke   = rampe(m, 0,03, 0,97) · (Reinheit==1 ? 1 : rampe(rein, 0,25, 0,75))
g     Kerngewicht = Reinheit==1 ? 1 : rampe(rein, 0,5, 0,9)
```

* **Staubgrenze und Saumstraffung in der Stärke** (nicht in der Maske!): Bei Silhouettenmasken wirkt die Unschärfe erst ab Maske 0,25 und voll ab 0,75. Der Dunst (≤ 12/255) und das Zuversichtsrauschen fallen weg, die Wirkung endet an der Isolinie statt am Fuss des Saums, der Saum wird auf ≈ 40 % gestrafft. Die Maske selbst bleibt unverändert – Farbregler im Bereich sehen dieselbe weiche Kante wie bisher (Gegenprobe: dieselbe Straffung in der Maske gemessen, `G-St-*`, noch mit den alten Rampen 0,06 / 0,92: Kantenbreite 2,0 statt 3,7 px – aber sie änderte dann auch alle Farbregler).
* **Reinheit nach Art der Maskenteile** (deterministisch, in `maskenSpeicher.ts`): *Silhouetten* sind `netz`, `tipp`, `pinsel` (Maske = Zugehörigkeit, Saum enthält Mischfarben); *glatt* sind `verlauf`, `radial`, `tiefe` (Maske = Betrag, jeder Bildpunkt ist ein reiner Bildpunkt). Nur Silhouetten → Reinheit 0; nur glatt → Reinheit 1; gemischt („Motiv + Tiefe“: Tiefe `dazu`, Netz `weg`) → Reinheit 2 mit **Kernfeld** = Faltung nur der Silhouettenteile, glatte `dazu`-Teile zählen als 255, glatte `weg`/`nur`-Teile werden übersprungen (Beispiel: `[tiefe dazu, netz weg]` → 255 − Silhouette). Gebraucht, weil der Kern bei einem Verlauf sonst die untere Hälfte des Verlaufs „ungültig“ machte (Messung: r25 der Scheiben bleibt dort 1,6 px – die Wirkung fehlte).
* **Normalisierte Faltung über Gewichte:** Quelle je Bildpunkt `(c·g, g)` (Bokeh: `(c·b·g, b·g)`, `b` = Verstärkung, 4.4), gefaltet, dann `B = Σ(c·g)/Σ(g)`. Farben ohne Kerngewicht fliessen nie ein; am Kern-Rand fehlen Abtastungen, die Normierung holt sie aus dem Inneren nach (**Randfortsetzung**).
* **Rückfall:** Deckung `d = glatt(0,02, 0,2, Σ(b·g)/Fläche)`; `X = S + (B − S)·d·Einblendung`. Wo die Scheibe fast keine gültigen Quellen sieht (dünne Stange, Saum, Inselchen), bleibt das Original. Sichtbar im Bild `H-bokeh-netz-motiv-gesamt.png`: die 9-px-Stange bleibt rein rot, heute orange.
* **Bildrand:** Klemmen auf den Randpunkt samt Gewicht (beide Wege); Randblöcke des Arbeitsmassstabs ebenfalls klemmen, nicht mit fehlenden Quellpunkten mitteln (Messung `rand.spec.ts`: 7 × 5 bis 1201 × 899 ohne NaN, ausserhalb byte-gleich; nur Extremfall 33 × 17 mit Radius 13 bis 9 Stufen GPU/CPU-Unterschied).
* **Bit-gleich ausserhalb:** Bildpunkte ohne Wirkung (`s = 0` in allen Stufen) bekommen im Endschritt das **Original-Byte** (Alpha-Kanal des Zwischenbildes = „berührt“), nicht den Umweg über Gleitkomma. Damit ist Kriterium A1 (bei neutraler Tonkette) konstruktiv erfüllt, nicht nur statistisch (gemessen: 0 von 214 313 bis 1 022 231).
* **Kante nicht breiter / Rand scharf / kein Halo:** folgt aus drei Dingen zugleich – Stärke-Saum, Kern (keine Mischfarben im Mittel), Bokeh-Radius ∝ Stärke (am Saum schrumpft die Scheibe, keine Überblendung von scharf und unscharf). Messwerte siehe Abschnitt 2 und 5.
* **Verhalten bei Sonderfällen:** `R < 0,75 px` bzw. `σ < 0,4 px` → Stufe entfällt (kein Durchgang, Bild bleibt bytegleich); NaN/±∞/negativ → 0; Bild kleiner als 4 Bildpunkte je Achse → Arbeitsgrösse 1, Stufe läuft normal (Messung 1 × 1 bis 7 × 5: kein NaN); Radius grösser als das Bild → Klemmen, Ergebnis ≈ Mittel des Kerns.

**Kosten der Wahl** (1200 × 900, Abtastungen je Ausgabepunkt, vgl. 4.7): heute ≈ 96 Abtastungen + 48 × (sin, cos, sqrt, 3 pow); neu 8–41 (Stufe 0,25–0,75), keine Transzendenten in den Schleifen.

### 4.4 „Bokeh sichtbar“ (Punkt c)

* **Blende:** flaches regelmässiges Sechseck (Blendenlamellen, Ecken links/rechts), Umkreisradius `r`. Gebaut aus **drei Rauten** = Summe der Faltungen je zweier Strecken `e0 = (0,−1)`, `e1 = (−√3/2, ½)`, `e2 = (√3/2, ½)` (Länge `r`, einseitig): `T0 = L_e0(Q)`, `T1 = L_e1(Q)`, `H = (L_e1(T0) + L_e2(T0) + L_e2(T1)) / 3`; fünf Strecken, je `n = ⌈r·Dichte⌉` Abtastungen mit linearer Filterung. Flache Mitte, scharfe Kante (Bilder `faktor.png`, `misch-verlauf.png`); heute CPU ist dagegen eine Glocke mit doppeltem Radius.
* **Verstärkung heller Stellen:** Gewicht `b = 1 + 100 · glatt(0,6, 0,98, max(R,G,B)_linear)` auf die linearen Werte vor dem Mitteln, danach *normiert* (`Σ(c·b·g)/Σ(b·g)`) – ein gewichtetes, kein energieaddierendes Mittel, damit gleichmässig helle Flächen nicht aufblühen. Gemessen (Licht 2,6 px, Radius 24): Inneres der Scheibe **172** (heute 90; ohne Verstärkung 31), Spitze 188, Aussen/Innen 0,17, Streuung 0,09. `LICHT_K = 100`, `LICHT_VON = 0,6`, `LICHT_BIS = 0,98` sind feste Konstanten (K = 20/60/120/240 gab Inneres 70/105/132/160 bei der Referenz – 100 ist der Kompromiss zwischen „erkennbar“ und „Himmel blüht auf“). Offen: Prüfung an echten Fotos (Risiko 2); bei Bedarf `K = 24 + 96·bokeh` koppeln – nicht jetzt.
* **Keine Wirbel/Zwiebelringe:** keine Zufallsdrehung, keine Potenzspreizung, keine Ringgewichte; die Scheibe ist eine Faltung. Ausdrücklich nicht behauptet: Katzenauge, Randabschattung.
* **Radius-Obergrenzen:** `R ≤ 0,02·L`, absolut ≤ 96 px; Arbeitsradius (Bildpunkte im Zwischenbild) ≤ 12 (hoch), 8 (mittel), 4 (niedrig) – darüber wird der Arbeitsmassstab `f` (Zweierpotenz, ≤ 8) verdoppelt.
* **Tupfenzahl:** entfällt. Was auf dem Telefon zählt, sind Abtastungen je Ausgabepunkt (4.7): 8–15 in den Güten „niedrig/mittel“ gegen 96 heute.
* **Radius folgt der Tiefe / dem Verlauf:** Grösse ∝ Stärke mit **Stufen** `k = ⌊s·K + ½⌋`; jede Quelle gehört *genau einer* Stufe (Radius `R·k/K`), das Ergebnis ist die **Summe über alle Stufen** (`Σ rgb_k / Σ a_k`). K = 3 bei Silhouetten (Saum), 4/6/8 bei Verlauf/Tiefe je Güte. Gemessen mit Lichtreihe unter einem Maskenverlauf: Scheibenradius folgt dem Bandradius (Abweichung ≤ 0,25·R, Bild `misch-verlauf.png`), Streuung im Inneren 0,004–0,022 (heute 0,09–0,51). **Warum nicht „Stufe des Empfängers wählen“:** ergab Halbscheiben an Stufengrenzen (K = 8: sichtbarer Sprung im Scheibeninneren); lineares Überblenden der Stufen ergab Doppelscheiben (Bild `reihe-g2.png`). Die Summe über Quellstufen ist physikalisch das Streuen je Quelle und hat beides nicht.

### 4.5 Ablauf, Güte, Zwischenspeicher

1. **Stufe** `unscharfStufe(quelle, szene, güte) → Zwischenbild` (RGBA16F, Anzeige-sRGB, Alpha = Einfluss 0…1). GPU: `unscharfGpu.ts`; CPU: `unscharf.ts` (Float32Array); **gleiche Konstanten, gleiche Durchgänge.** Der Hauptschattierer bekommt `uUnscharf` (Einheit 3) statt `uBokeh`/`uUnschaerfeB[]`/`zerstreuen`: `c = u.a > 0 ? u.rgb : scharf;` die Schärfe dämpft mit `(1 − u.a)` wie heute mit `(1 − bokeh)`. Entfällt: `bokehAn`, `zerstreuen`, `TUPFEN`, `uBokeh`, `uUnschaerfeB` (Z. 147–149, 273–368, 494–500, 925, 940–942) sowie auf dem Prozessor der Block Z. 1084–1205 (`bokehGewicht`, `STUFEN`, `bokehRgba`).
2. **Durchgänge je Bereich und Stufe:**
   *Bokeh:* Vorbereitung je Stufe k (Bild + Maske + Kernfeld → `(c·b·g, b·g)` im Arbeitsmassstab `f`, Quellpunkte der Stufe `k` mit Mittelung über `f × f`) → 2 Strecken → 3 Rauten → Stufenbild. Zusammensetzen: Summe über die Stufenbilder, Rückfall, Einblendung `t = rampe(s, 0, 0,5)`.
   *Weichzeichnen:* Vorbereitung → Gauss waagerecht → Gauss senkrecht (Arbeitsmassstab so, dass `3σ/f ≤ Grenze`) → Zusammensetzen mit Überblendung `s`.
3. **Güte** (dieselbe Tabelle für GPU und CPU):

   | Güte | Einsatz | Arbeitsradius ≤ | Stufen Silhouette / Verlauf·Tiefe | Dichte der Abtastung |
   |---|---|---|---|---|
   | hoch | Ausgabe/Export, Standbild in Ruhe | 12 | 3 / 8 | 1 |
   | mittel | Standbild am Bildschirm, Film angehalten | 8 | 3 / 6 | 0,5 |
   | niedrig | Film beim Wischen/Abspielen, Telefon unter Last | 4 | 2 / 4 | 0,5 |

   Dichte 0,5 = eine Abtastung je 2 Arbeitspunkte mit linearer Filterung; Abweichung gegen Dichte 1 gemessen: Mittel 0,03–0,18, nur an Lichtkanten bis 100 Stufen (Spitze), Lichtmasse unverändert. `vorschau.ts` bildet seine drei Gütestufen ab: 0 → mittel, 1 → niedrig, 2 → rohes Video (unverändert).
4. **Zwischenspeicher:** Zettel für das Stufenergebnis mit Schlüssel `Quellstand | je Bereich id@Maskenstand | unschaerfe | bokeh | Güte | Grösse`. Ein Zug an Belichtung/Kontrast/… trifft den Zettel → **die Unschärfe kostet dann nichts** (heute läuft der Bokeh-Teil bei jedem Reglerzug im Hauptschattierer, 1,2 s unter SwiftShader). Im **Flüchtigmodus** (Film) kein Zettel, aber die Texturen kommen aus einem **Vorrat nach Grösse** (kein `createTexture` je Bild; Zähler `texturenLebend` als Prüfpunkt; Vorrat wird beim Kontextverlust zusammen mit `quellzettel`/`atlasZettel` verworfen).
5. **Speicher:** Zwischentexturen (RGBA16F): `P`, `T0`, `T1` plus eine je Stufe; bei 1200 × 900, `f = 2`, K = 6 etwa 20 MB, `f = 4` etwa 5 MB. Grenze 40 MB: darüber `f` verdoppeln. Fehlen float-renderbare Ziele (`EXT_color_buffer_float`), läuft **die Stufe auf dem Prozessor** und wird als `uUnscharf` hochgeladen (Hybrid, ~0,5–1 s); die Stufe ist austauschbar, der Rest bleibt auf der GPU.

### 4.6 GPU und Prozessor gleich (Punkt d)

* **Gleiche Rechnung, nicht „ähnliche“:** beide Fassungen bauen dieselben Strecken mit demselben Abtastmuster (`x + ½ + e·r·(j+½)/n`, Klemmen, Mittelpunktkonvention), dieselbe Stärke/Kern/Deckung, dieselben Stufen. Die Prozessorfassung ist *nicht* schneller gerechnet durch andere Mathematik, sondern durch Arbeitsmassstab.
* **Toleranz:** je Kanal höchstens **2 Stufen**, Mittel **≤ 0,05**, bei gleicher Güte und gleicher Arbeitsgrösse. Gemessen am Prototyp: **max 1, Mittel 0,001–0,005** über mehr als 60 Läufe (Bokeh, Weichzeichnen, beide, Silhouette, Verlauf, gemischt, 600–2560 px). Ausnahme Extremfall (Bild < 64 px mit Radius > Bild): ≤ 10. Ab Bokeh/Weichzeichnen ist der Ausschluss in `aufLeinwand` (Z. 1113–1117: „der Vergleichstest nimmt Bereiche mit Unschärfe AUS“) zu streichen.
* **Zu beachten:** Der Prozessor darf eine Güte **tiefer** als die GPU wählen (Kosten), dann sind Kanten weicher (Aussen/Innen 0,17 → 0,31) – der Paritätstest rechnet deshalb beide Wege **auf derselben Güte** (Prüfhaken `guete` in `bildRechnen`).
* **Tests erweitern:** `bereich.spec.ts` bekommt zu „GLSL und TypeScript“/„Grafikeinheit und Prozessor“ je einen Fall mit Bokeh, Weichzeichnen, beiden, Verlauf, gemischter Maske (Szenen von Hand gebaut, mit `reinheit`); die neue `unscharf.test.ts` prüft die Prozessorrechnung rein (Abschnitt 5).

### 4.7 Leistungsbudget (Punkt e)

**Abtastungen je Ausgabepunkt** (Rechnung nach 4.5; Bokeh Silhouette K = 3, `R = 24`):

| Güte | Arbeitsmassstab f | Abtastungen/Punkt | Bokeh Verlauf/Tiefe | Weichzeichnen σ 14,4 |
|---|---|---|---|---|
| heute | – | ≈ 96 (+ 48× Transzendenten) | dasselbe | dasselbe |
| hoch (Dichte 1) | 2 | ≈ 41 | K = 8: ≈ 96 | f = 4: ≈ 8 |
| mittel (Dichte 0,5) | 4 | ≈ 15 | K = 6: ≈ 27 | ≈ 6 |
| niedrig | 8 | ≈ 8 | K = 4: ≈ 15 | ≈ 6 |

**Gemessen** (SwiftShader, Medianwerte aus drei Läufen, GPU; in Klammern Prozessor; „heute“ = derselbe Lauf, derselbe Bereich):

| Grösse | heute | hoch Sil. | mittel Sil. | niedrig Sil. | mittel Tiefe K6 | Weichzeichnen |
|---|---|---|---|---|---|---|
| 1200 × 900 | 1260–2080 (1100–1340) | 560–800 (1940) | **190–460** (630) | 230 (410) | 370–710 (860) | **105–215** (240–420) |
| 1920 × 1080 | 2390–2950 | 550 (1320) | 430 (840) | 270 (730) | 590 (1060) | 160 (570) |
| 2560 × 1920 (Export) | 6570 (Bokeh) – 16 190 | 1510 (2430) | 850 | – | 1410 (Tiefe) | 550 (1190) |

Verhältnisse **neu/heute** auf der GPU: mittel Silhouette **0,15–0,3**, hoch 0,45, Tiefe mittel 0,3–0,4, Weichzeichnen 0,07–0,12; Prozessor mittel 0,5 (hoch schlechter als heute: daher nimmt die CPU im Bildschirm „mittel“). Die absoluten Millisekunden von SwiftShader taugen nicht für Telefone; **Budgets auf dem Referenzgerät** (bei der Umsetzung zu messen, hier Zielwerte): Standbild-Zug ≤ 16 ms (wegen Zettel: null), Film-Vorschau ≤ 0,8 × Bildabstand (vorhandene Stufenleiter 120 ms/Bild beim Wischen), Export je Bild ≤ 400 ms.
Ein Telefon schafft ein Drittel der Rechnerleistung: darum sind **Dichte 0,5 und Arbeitsmassstab ≥ 4 der Regelfall** (mittel), „hoch“ nur für die Ausgabe. Werden mehr als zwei Bereiche mit Unschärfe gezeigt, fällt die Film-Vorschau um eine Güte.

### 4.8 Oberfläche (Punkt f)

* `BEREICHSREGLER` (`BildEditor.tsx:123`): nach „Dynamik“ `{ key: 'unschaerfe', label: 'Weichzeichnen' }`, danach **`{ key: 'bokeh', label: 'Bokeh', min: 0, max: 1 }`**; Schritt 0,01; Anzeige ohne Vorzeichen („60“, nicht „+60“ – die heutige Anzeige `+${Math.round(w*100)}` ist für einen 0…1-Regler falsch); Doppeltipp/Doppelklick setzt auf 0 (`onDoubleClick={() => bereichRegler(regler.key, 0)}` gilt unverändert, Neutralwert 0).
* `REGLER_TIPP` (Z. 243) hat heute **keinen** Eintrag für `unschaerfe`. Neu:
  * `unschaerfe`: „Macht den Bereich gleichmässig weich wie eine Mattscheibe. Wirkt nur innerhalb der Maske – nichts von draussen wird hereingemischt.“
  * `bokeh`: „Unschärfe wie von einer Linse: Lichter werden zu hellen Scheiben, weiter hinten grösser. Bleibt in der Maske und holt keine Farbe von draussen herein.“
* Text Z. 3881 (Tiefe): „… stellst du unten am Regler „Bokeh“ ein.“; ebenso Z. 3691/3677 (Modell-Beschreibung) bleibt sinngemäss.
* Hinweis unter den Reglern: Satz „Der Bereich wirkt nur dort, wo seine Maske greift …“ bleibt; kein zusätzlicher Text.
* **Video-Editor:** zeigt dieselbe Liste (`SchnittEditor` bettet `BildEditor` ein, `RuhigerEditor`). Je Maske in der Zeitleiste ein eigener Wert; der Regler gilt für den *ganzen* Lauf der Maske, nicht je Anker.

### 4.9 Video (Punkt a, Routing)

* `Maske.anpassung: Bereichston` (`masken.ts:205`) nimmt das neue Feld auf; `bildDocAn` kopiert sie per Spread ins Bilddokument (Z. 1899); `editorAenderung` (Z. 2473) gibt sie an `maskeFortschreiben` (Z. 2680), das mit `anpassungGleich`/`gleich` über die Vereinigung der Schlüssel vergleicht (Z. 2397) und `{ ...bereich.anpassung }` übernimmt (Z. 2705–2720; neue Masken Z. 2547, Übernahme aus Abschnitts-Dokumenten Z. 2880). Ein Wert in `bokeh` ist **keine Änderung eines Teilfeldes**: `FELDER`/`feldArt` (Z. 2292–2319) bleiben **unverändert**; die Regler eines Bereichs hängen an der Maske, nicht an den Ankern. **Es entsteht kein neuer Anker, kein `neuRechnen`, und die Kette ist nicht betroffen.**
* `Zusammensetzung.doc.bereiche[i].anpassung` trägt `bokeh`; `szeneBauen` (pro Bild) liest daraus.
* Die Reinheit (Kernfeld) wird je Bild aus den gebauten Teilen abgeleitet (Teilart), nicht gespeichert – sie hängt also nicht an Ankern.
* Filmbau und Vorschau rufen denselben Renderer (`zeichneAusgabe`/`zeichneAnsicht` → `bildRechnen`); neu: Option `guete` (hoch beim Bau, mittel/niedrig in `vorschau.ts` nach `gueteRef`).
* **Flackern:** Die Stufenwahl der Quelle hängt am Maskenwert (RLE-quantisiert ≥ 250 → 255 beruhigt den Kern); Risiko 6.

## 5. Abnahmekriterien (Punkt g)

Alle Schwellen in Bildpunkten für 1200 px Kantenlänge (Abstände skalieren mit `L/1200`); Messwerte des Prototyps in Klammern; „G“ = Grafikeinheit, „P“ = Prozessor. Messkern aus `mess/lib.js` wird in `e2e/hilfen/unscharfMessen.ts` übernommen (Szenen + Masse, ~300 Zeilen), damit der Test nicht vom Sandkasten abhängt. Standardgrösse der Browser-Tests 600 × 450 (Laufzeit), Stichprobe bei 1200 × 900.

| Nr. | Kriterium (Schwelle) | Gemessen | Test |
|---|---|---|---|
| K1 | **A1 bit-gleich:** Bildpunkte mit Maske ≤ 15/255 (Netz mit Staub 0…12, `video`, `hart`, `weich`): **0** verändert – G und P, Bokeh, Weichzeichnen, beide | 0 von 214 313 … 1 022 231 | Browser `e2e/unscharf.spec.ts` „ausserhalb der Maske bleibt bit-gleich“ + Einheit `unscharf.test.ts` (P) |
| K2 | **A2 Reichweite** (Saum ≤ 12 px: ≤ 6 px; Saum ≤ 30 px: Bokeh ≤ 8 px, Weichzeichnen ≤ 16 px); mittlere Abweichung ab 8 px Abstand ausserhalb: 0 | 2–4 (Bokeh), 4 (Weich), 8/16 (breiter Saum) | Browser, Netz/Netzbreit/Video |
| K3 | **B Fremdfarbe** (ohne Basiswert): ≤ 0,20 bei 0–2 px, ≤ 0,05 bei 2–4 px, ≤ 0,03 ab 4 px; Motiv- und Grundfall, G und P | 0,00–0,14 / ≤ 0,03 / ≤ 0,02 | Browser |
| K4 | **C Kantenbreite** ≤ 4,5 px bei Maske ≤ 12 px; ≤ 0,3 × Maskenbreite bei Maske ≤ 30 px | 1,4–3,1 (11 px); 3,1–3,9 Bokeh / 7,7 Weich (29 px) | Browser |
| K5 | **D Randschärfe:** Kontrast ±4 px ≥ 0,90 (Maske ≤ 12 px), ≥ 0,70 (≤ 30 px); Steilheit ≥ 0,5 × Original; \|Kantenversatz\| ≤ 1,5 px; Ring um Motiv bei Tiefe: Schärfe 4–8 px ≤ 2,5 × Schärfe 32–64 px | 0,95–0,99; 0,73–0,98; 0,53–1,1; ≤ 1,3; 2,1× (heute 10×) | Browser, Fälle Netz, Video, „Motiv + Tiefe“ |
| K6 | **E Lichter** (Licht 2,6 px, Radius 24, Güte hoch): Inneres ≥ 140/255 (heute 90), Rand/Innen ≥ 0,90, Aussen/Innen ≤ 0,25 (mittel ≤ 0,35, niedrig ≤ 0,55), Streuung ≤ 0,15 (heute 0,61), Scheibe statt Glocke (Mitte < 2 × Scheibenrand, Schwelle des heutigen Tests) | 172 / 0,98 / 0,17 (0,31 / 0,53) / 0,09 | Browser; ersetzt „Scheibe und keine Glocke“ |
| K7 | **Tiefe/Verlauf:** Lichtreihe unter Verlauf: Scheibenradius r25 wächst monoton mit der Maske, Abweichung vom Bandradius `R·k/K` ≤ 0,25·R, Streuung im Inneren ≤ 0,05 für Scheiben ≥ 8 px | alle erfüllt (Abw. ≤ 4, Streuung ≤ 0,022) | Browser (ersetzt „Grösse, nicht Durchsichtigkeit“) |
| K8 | **Parität G = P** auf gleicher Güte: je Kanal max ≤ 2, Mittel ≤ 0,05; Fälle: Bokeh (hart, netz, video), Weichzeichnen, beide, Verlauf, gemischt; Bild < 64 px: ≤ 10 | max 1, Mittel ≤ 0,005 | Browser (erweitert „Grafikeinheit und Prozessor kommen zum selben Bild“); Einheit gegen `proto` |
| K9 | **Alt-Dokument:** Rohdokument mit `anpassung.unschaerfe = 0,6` ohne `bokeh` → `bokeh = 0,6`, `unschaerfe = 0`; mit beiden Schlüsseln unverändert; Runde `docNachRoh → docAusRoh` identisch; NaN/∞/2/−1 → geklemmt; `rezeptHindernis` ≠ null bei `bokeh > 0`; Entwurf mit Alt-Regler wird migriert | – | Einheit `rezept.test.ts`, `entwurf.test.ts` |
| K10 | **Schlüssel/Zettel:** Änderung von `bokeh` oder `unschaerfe` ändert `szeneSchluessel`; Bereich nur mit `bokeh` wirkt (`bereichWirkt`); nur `belichtung` geändert → Zähler `stufenGerechnet` bleibt stehen | – | Einheit `maskenSpeicher.test.ts`; Browser Zähler |
| K11 | **Video-Routing:** `editorAenderung` mit nur geändertem `bokeh`: `teile` identisch (`===`), keine neuen Anker/Kennungen, `neu` leer, `masken[i].anpassung.bokeh` neu, andere Masken `===`; vier Bereiche mit vier Werten halten sie getrennt; Rückgängig im Editor holt den alten Wert | – | Einheit `masken.test.ts` |
| K12 | **Reinheit:** nur Netz/Tipp/Pinsel → 0; nur Verlauf/Ellipse/Tiefe → 1; `[tiefe dazu, netz weg]` → 2 mit Kernfeld = 255 − Silhouette; leere Teile → kein Bereich | – | Einheit |
| K13 | **Leistung (relativ, SwiftShader, gleiches Bild, gleicher Lauf):** Bokeh mittel ≤ 0,35 × heute-Schattierer, hoch ≤ 0,6 ×, Weichzeichnen ≤ 0,2 ×, Prozessor mittel ≤ 0,7 × heute-Prozessor; Abtastungen je Punkt (Rechenfunktion `abtastungenJeBildpunkt`) ≤ 45 hoch, ≤ 20 mittel, ≤ 12 niedrig bei Silhouette K = 3 | 0,15–0,3 / 0,45 / 0,07–0,12 / 0,5 | Browser (Zeitverhältnis; nur als Warnschwelle, weil schwankend) + Einheit (Zahl) |
| K14 | **Sonderfälle:** Radius 0, NaN, ∞, negativ → Bild byte-gleich, kein Schattierer-Lauf; 1 × 1, 3 × 2, 7 × 5: kein NaN, ausserhalb byte-gleich; gleichmässiges Feld bleibt gleichmässig (±1) an allen Rändern auch mit Radius > Bild | kein NaN, 0 verändert | Einheit + Browser |
| K15 | **Ressourcen:** nach 50 Bildern im Flüchtigmodus gleich viele lebende Texturen wie nach 5; Kontextverlust setzt Vorrat und Zettel zurück; fehlt `EXT_color_buffer_float` → Hybrid-Weg, Ergebnis wie K8 | – | Browser (Zähler `texturenLebend`, `gpuAbschalten`, Erweiterung sperren) |
| K16 | **Bokeh-Regler im Editor:** Regler „Bokeh“ und „Weichzeichnen“ sichtbar mit Tooltip, Doppelklick setzt 0, Zug ändert das Bild (Bytes), Rückgängig stellt her; im Video-Editor dasselbe je Maske | – | Browser (Bedienung, wie `ton.spec.ts`) |

Bestehende Tests, die sich ändern (nicht wegwerfen): `e2e/bokeh.spec.ts` (Regler `bokeh` statt `unschaerfe`, Spitze ≥ 140 auf beiden Wegen statt „hell“), `e2e/bereich.spec.ts` („blutet nicht heraus“ – Schwellen bleiben, Reichweite kommt dazu; „Scheibe/Glocke“, „Grösse, nicht Durchsichtigkeit“, „scharfer Punkt streut nicht“ auf die neuen Masse K6/K7; Szenen brauchen `reinheit`, Vorgabe 1), `bild/bokeh.test.ts` (wird durch `unscharf.test.ts` ersetzt), `bild/weich.test.ts` (`kastenWeichRgba` ist nirgends ausser in Tests benutzt → streichen; `bokehRadius` bleibt), `bild/rezept.test.ts`, `bild/maskenSpeicher.test.ts`, `video/schnitt.test.ts`, `video/videoBauen.test.ts` (Literale `unschaerfe: 0` ohne `bokeh`).

## 6. Verworfen, und warum

1. **Nur Staubgrenze im alten Schattierer** (Schwelle statt `0.002`): beseitigt die Änderung ausserhalb, aber nicht die Fremdfarbe im Saum (0,26–0,48) und nicht die Körnung.
2. **Tupfen mit Kerngewicht, mehr Tupfen:** gerechnet, nicht gebaut: 128 Tupfen kosten das 2,7-Fache, bei einem 2,6-px-Licht treffen im Mittel 1,5 Tupfen je Punkt – der Variationskoeffizient einer Poisson-Zählung liegt dann bei ≈ 0,8. Das Problem ist der Zufall, nicht die Zahl.
3. **Zerstreuen nach Masken-Gewicht des Empfängers mit Überblenden der Stufen:** Doppelscheiben (Bild `reihe-g2.png`); **nächste Stufe des Empfängers:** Halbscheiben an Stufengrenzen bei Tiefe. Gewählt: Summe über Quellstufen.
4. **Bokeh mit festem Radius und Überblendung** (`konst`): Kante 3,7–5,4 px, Kontrast 0,75–0,97 (gegen 1,4–2,8 / 0,97–1,0). Grösse ∝ Stärke bleibt für Bokeh; Überblendung für den gewöhnlichen Weichzeichner.
5. **Variable Radien auch für Weichzeichnen (Gauss-Stufen):** kein messbarer Gewinn, dreifache Kosten; „gewöhnlich“ heisst Überblendung.
6. **Kern nur hart (Maske ≥ 0,5):** bei breitem Saum Kantenversatz bis 2,6 px und Kontrast 0,88 (`S-kern05-*`); die Rampe 0,5 → 0,9 ist besser.
7. **Kern für alle Masken gleich:** Verläufe verlieren die untere Hälfte (Scheiben bleiben 1,6 px). Darum Reinheit nach Teilart; **Steilheitsschätzung je Bildpunkt** als Alternative verworfen (Heuristik, 9 Abtastungen je Punkt, unberechenbar bei mittelweichen Ellipsen).
8. **Mattierung/Farbdekontamination (F̂, B̂ nach Germer u. a.) und geführter Filter:** nicht gebaut (Begründung gerechnet): hält Kanten nur scharf, wenn die Maske den Rand trifft – bei 55-px-Saum ist eine Führung nach `BildEditor.tsx:2546` schon früher als schlechter nachgemessen worden; für glatte Masken fügt die Mischformel einen ungewollten Kleinradius-Weichzeichner mit Gewicht `m(1−m)` hinzu; nach Stärke-Saum und Kern sind die Masse ohnehin erreicht.
9. **Maske beim Erzeugen straffen** (`kanteWeichzeichnen` weglassen/steiler): ändert auch alle Farbregler und Tests; die Stärke-Saumstraffung nur für die Unschärfe trennt das sauber.
10. **Radiusfortsetzung `r̂`** (Radius aus dem Kern in den Saum fortsetzen): Ring bleibt 2× gegen 10× heute – Aufwand (weiterer Durchgang) nicht gerechtfertigt.
11. **Runde Scheibe / Zwölfeck** (zweites, gedrehtes Sechseck): doppelte Kosten; **getrennte komplexe Kerne** (Garcia u. a.): vier Durchgänge, Überschwinger; **Sprites/Streuen der Lichter:** Zahl und Speicher der Quellen unbeschränkt.
12. **Ausgabe der Vorstufe als RGBA8:** Verstärkung bis 101 nicht darstellbar, Bänder; nur als Rückfall für die Sicherung (Hybrid lädt 8 Bit hoch, die Berechnung selbst läuft in Float).
13. **Vorbereitung für alle Stufen in einem Durchgang (MRT):** identisches Bild, nur 5–10 % schneller (SwiftShader) – nicht für die erste Fassung.
14. **Immer 8 Stufen, auch bei Silhouetten:** kostet ein Mehrfaches ohne Gewinn – K = 2, 3, 4 und 6 gaben bei Silhouetten dieselben Masse (`V-n2…n6-*`).
15. **`unschaerfe` umbenennen:** Rezepte, Entwürfe, Tests, Video-Literale; der Nutzen ist null.
16. **Verstärkung an den Bokeh-Regler koppeln:** ohne Bild-Erfahrung geraten; als Konstanten lassen, Abnahme an echten Fotos.
17. **Mip-Pyramiden-Weichzeichnen:** billig, aber kastig/ringend bei kleinen Radien.
18. **Die Maske als Gewicht ohne Kern im Hintergrund lassen** (nur Bokeh-Reach-Regel `wp ≥ r·weite`): Regel bleibt als Bandzugehörigkeit erhalten, genügt aber allein nicht (Fremdfarbe 0,40).

## 7. Umsetzungsplan

1. **Datenmodell** (`doc.ts`, `rezept.ts`, `maskenSpeicher.ts` Schlüssel/Wirkt, Tests K9/K10) – ohne Renderer.
2. **`unscharf.ts`** (rein, node-prüfbar): Konstanten, `staerke`, `kernGewicht`, `arbeitsFaktor(R, güte)`, `abtastungenJeBildpunkt`, Prozessorstufe (Strecken, Rauten, Gauss, Stufen-Summe, Rückfall). Dazu `unscharf.test.ts` (Impuls → Sechseck mit Fläche 2,598 r², flaches Feld bleibt flach an den Rändern, Gewicht 0 → Original, Kern schliesst Saum aus, Radius 0/NaN).
3. **Prozessorweg** in `aufLeinwand` anbinden, `bokehRgba`/`kastenWeichRgba` entfernen, Dämpfung der Schärfe über `einfluss`.
4. **Reinheit/Kernfeld** in `maskenSpeicher.ts` (`reinheitFuer`), `Maskenfeld.kern`, `GerechneterBereich.reinheit` (Vorgabe 1).
5. **`unscharfGpu.ts`:** Programme, Vorrat, Zettel; `tonGpu.ts` anbinden (Hauptschattierer schlanker); Hybrid bei fehlenden Float-Zielen.
6. **Güte-Durchreichung** (`zeichnen.ts`, `vorschau.ts`, `videoBauen`).
7. **Oberfläche** (Regler, Tooltips, Tiefe-Vorgabe `bokeh: 0.6`, Texte).
8. **Browser-Tests** (K1–K8, K13–K16) mit übernommenem Messkern; Kopfkommentar von `unscharf.ts` (Warum: Kern, Saumstraffung, Summe über Stufen – wie in diesem Entwurf, knapp).

Je Schritt ein Commit; Reihenfolge so, dass nach Schritt 3 der Prozessorweg schon richtig ist, nach 5 die Grafikeinheit.

## 8. Risiken und offene Punkte

1. **Float-Renderziele** fehlen auf einzelnen Geräten (`EXT_color_buffer_float`): Hybrid-Weg (CPU-Stufe + Hochladen) kostet 0,5–1 s je Stufenänderung – nur beim Ändern, dank Zettel nicht je Zug an anderen Reglern. Vor Schritt 5 auf 2–3 echten Geräten prüfen.
2. **Verstärkung nur synthetisch geprüft.** Echte Fotos: heller Himmel neben dunklem Laub kann „ausbluten“ (Verstärkung bis 101 für fast weisse Bildpunkte). Gegenmittel: die Konstanten `LICHT_*`; Sichtprüfung an sechs Fotos als Teil der Abnahme; Rückfall: `K = 60` (Inneres ≈ 105 statt 172 in der Referenz).
3. **SwiftShader taugt nicht für absolute Zeiten.** Güte-Grenzen 12/8/4 und Budgets sind Startwerte; Referenzmessung auf Telefon nötig. Die Kosten sind Abtastungs-gebunden (Zeit ∝ Abtastungen), die Zählung stimmt.
4. **Rand der Scheibe wird mit dem Arbeitsmassstab weicher** (Aussen/Innen 0,17 → 0,31 → 0,53 für f = 2/4/8): in „niedrig“ sichtbar, bewusst.
5. **Stufenquantisierung bei Tiefe:** Radius auf `R/K` gerundet (Schritte 3–4 px bei K = 6/8 und R = 24); bei fein verlaufender Tiefenkarte sind Bänder im Radius denkbar, nicht gesehen.
6. **Flackern im Film:** ändert sich der Maskenwert eines Lichts zwischen Bildern um eine Stufe, springt der Scheibenradius um `R/K`. Durch RLE-Quantisierung und Verfolgung kaum; in einem Filmtest mit wanderndem Licht und Tiefe zu prüfen (Abnahme).
7. **Reinheit nach Teilart ist eine Setzung:** `netz dazu` + `verlauf dazu` (Motiv und Himmel zusammen) hat Kern 255 – die Netzkante ist dann ungeschützt (Fremdfarbe wie heute im Saum, aber mit Stärke-Saum nicht schlimmer). Dokumentiert, nicht gelöst.
8. **Breite Säume (≥ 30 px) bleiben weich.** Weichzeichnen 7,7 px bei Maske 29 px. Eine kantenführende Verfeinerung der Netzmaske wäre der nächste Schritt (verworfen für jetzt, Punkt 6.8); der Anwender kann über „Pinsel“ nachziehen.
9. **Verhalten ändert sich für alte Bilder:** Lichter heller, Sechseck statt Kreis, kein Hof. Das ist gewollt, aber sichtbar; der Text beim Laden eines Entwurfs braucht keine Warnung, der Änderungsvermerk gehört in die Notiz der Version.
10. **Mehrere Bereiche mit Unschärfe:** Kosten ∝ Anzahl (bis 4), Ergebnis nacheinander statt Maximum – überlappende unscharfe Bereiche sehen anders aus als heute.
11. **Speicher der Zwischentexturen** (bis 40 MB) auf 2-GB-Telefonen: Grenze mit Rückfall auf höheres `f`; Wirkung auf den Grafikspeicher bei Film-Vorschau beobachten (bekannter Engpass, siehe Kommentar in `bildRechnen`).
12. **Parität bei ungeradem Arbeitsraster:** Randblöcke klemmen (beide Wege) – durch K8/K14 abgesichert; Extremfall < 64 px mit Toleranz 10.
13. **Offen für den Anwender:** Soll „Bokeh“ bei „Tiefe“ den Vorgabewert 0,6 behalten (bisher „Weichzeichnen 0,6“)? Entwurf: ja.
