# Mehrere Bereiche im Video-Editor – Prüfung und Entwurf

Stand: Zweig `v-bereiche` (Ausgangspunkt `d786eab`), geprüft im Arbeitsbaum, ohne Produktivcode zu ändern.
Alle Bilder liegen in `shots/`, die Messprotokolle in `protokoll.log`, die Prüfskripte in `pruef/`, die
synthetischen Messtests in `messung/` (siehe Anhang C).

---

## 1. Kurzfassung

**Der Mechanismus „mehrere Bereiche, jeder mit eigener, getrennt verfolgter Maske" ist da und rechnet
richtig – solange jeder Bereich genau EINEN Gegenstand trägt und die Wege der Gegenstände einander nicht
verdecken.** Gemessen am fertigen Film trägt jeder Gegenstand seine eigene Bearbeitung und keiner die des
anderen (Abschnitt 3). Daran liegt es also nicht.

Belegt sind vier Stellen, an denen der Anwender mit zwei oder mehr Gegenständen auf etwas stösst, das sich
anders verhält als beim Foto oder schlicht nicht stimmt:

| # | Befund | Schwere |
|---|--------|---------|
| L1 | Bereich im Editor wählen und Maske in der Zeitleiste wählen sind zwei getrennte Auswahlen | hoch |
| L2 | Tippt man den zweiten Gegenstand in DENSELBEN Bereich (der natürliche Handgriff), wird nur einer verfolgt – ohne Warnung | hoch |
| L3 | Verdeckt der eine Gegenstand den anderen, nimmt der Verdecker die Maske mit; die Bahn zeigt weiter „sichtbar" | hoch (eigener Strang: Verfolgung) |
| L4 | Ist der gewählte Bereich an diesem Bild nicht gültig, steht im Editor ein leerer Zustand statt einer Erklärung; ein Tipp legt stillschweigend einen neuen Bereich an | mittel |

Dazu Bedienbarkeit (L5 bis L9), ein fehlender Nachweistest (L10) und kleinere Befunde (L11, L12).

**Warum der Anwender es „vermisst" hat, lässt sich nicht beweisen.** Belegt ist: Wer nacheinander zwei
Gegenstände antippt, ohne dazwischen „＋ Bereich" zu drücken, bekommt EINEN Bereich, und im fertigen Film
trägt davon nur der eine die Bearbeitung (L2, Bild `b1-einBereich-hell-bogen.png`). Wer „＋ Bereich" fand,
hat danach zwei nicht abgestimmte Auswahlen (L1), Bahnen ohne Namen (L6) und eine Einstellungszeile, in der
„Löschen", „Hier trennen" und „Fertig" erst nach seitlichem Wischen auftauchen (L5). Beides erklärt den
Eindruck „das gibt es bei Videos nicht" besser als ein fehlender Mechanismus. Das ist eine Deutung, kein
Befund.

Empfohlene Reihenfolge: Paket A (L1, L4, L5, L7, L8, L6a) und Paket B (L2) zuerst – klein, im Editor,
ohne Eingriff in die Verfolgung. L3 ist ein eigenes Vorhaben in `objektFolge.ts` mit Regressionsrisiko und
gehört nicht in dieselbe Runde. L5 MUSS zusammen mit L1 kommen (siehe 7).

---

## 2. Wie geprüft wurde

- **Dev-Server** `http://localhost:5193`, Playwright mit der Konfiguration unter `pruef/pw.config.ts`
  (Chromium, 412×880 und 375×667), die Oberfläche wie ein Anwender bedient: Blatt → „Bearbeiten und
  schneiden" → Reiter „Bereiche" → „Antippen" → „＋ Bereich" → Regler → Zeitleiste → „Film bauen".
- **Testfilm** (`pruef/gemeinsam.ts`, `blattMitZweiGegenstaenden`): 320×240, 10 Bilder je Sekunde, 50 Bilder
  (5 s), im Editor auf 25 Bilder je Sekunde gerastert. Zwei Quadrate (40×40) auf blauem Grund:
  - **A** (grün) wandert nach rechts: `x = 10 + 8n`, `y = 60`; ab `n = 39` (3,9 s) ganz draussen.
  - **B** (orange) wandert nach unten: `x = 150` (kreuzend) bzw. `230` (getrennt), `y = 10 + 4n`; B liegt oben.
  - Bei `x = 150` kreuzen sie sich bei `n = 13 … 22`; bei `x = 230` berühren sie sich nie.
  - Zwei Farbpaare: „kräftig" (`#20c040` / `#e08020`, fast gleich hell) und „hell" (`#107030` / `#f0b040`,
    deutlich verschieden hell). Grund einfarbig; für Formen zusätzlich gemustert.
- **Nachmessen**: der gebaute Film wird in `<video>` geladen, an festen Zeiten wird je Gegenstand der Kern
  und eine Ecke abgetastet (`filmAbtasten`). Wahrheit: A hat Mitte `(30+8n, 80)`, B `(bx+20, 30+4n)`.
  Erwartung: A (Bereich 1, Sättigung −1) grau, B (Bereich 2, Belichtung +1,5 EV) heller, Grund unverändert.
- **Verfahren ohne Modell**: Antippen ohne Netz (Farbflutung) und Ellipse (Radial); Verlauf und Pinsel wurden nicht eigens
  nachgemessen (Formen gehen denselben Weg, `formTeilZiehen`). **Mit Modell**:
  `public/models` hat NanoSAM (Antippen „mit Netz"), U²-Net, BiRefNet, Tiefe, Gesicht/Selfie. „Mit Netz" läuft
  hier (WASM, Verfolgung A 30–38 s, B 68–83 s). BiRefNet („Hohe Qualität") und Tiefe brauchen eine Grafikeinheit
  („Es war keine Grafikeinheit zu bekommen.") und liefen NICHT; „Person"/„Motiv" wurden nicht benutzt.
- **Ausgangslage** `e2e/maskenSpuren.spec.ts`: 8 von 9 grün. `im fertigen Film sitzt die Maske an jedem Bild auf
  dem Gegenstand` fiel einmal unter Last (`Grund, Probe 0: 0,0,0` – das erste Bild nach `onseeked` war noch
  schwarz) und ist einzeln wieder grün: eine Wackelstelle im Test selbst, nicht im Produkt (siehe 8).

---

## 3. Was schon richtig funktioniert (mit Beleg)

| Was | Beleg |
|-----|-------|
| Zwei Bereiche, zwei Gegenstände, getrennte Wege: jeder Gegenstand trägt seine eigene Bearbeitung, keiner die des anderen | `protokoll.log` `B1 zwei-hell-getrennt`: A `93,93,93` (grau) von 0,05 bis 3,45 s, B `253,255,142` (nur belichtet) durchgehend, Grund unverändert. Mit Netz ebenso (erster Netzlauf `D1`, `bx = 230`: A `93`, B `253,255,142`). |
| Bereich 1 im ganzen Film, Bereich 2 nur ein Zeitraum (1,6 bis 3,6 s per „Ab hier"/„Bis hier") | `a3` (dort B mit 5 statt 4 Punkten je Bild, Berührung nur 5 Punkte hoch): B `207,133,57` (unverändert) bis 1,45 s, `253,213,96` von 1,65 bis 3,45 s, wieder `207,133,57` ab 3,65 s; A `161` (grau) von 0,05 bis 3,45 s. Bild `a3-04-vor-fertig.png` zeigt die Griffe. |
| Je Bereich eigene Regler (Sättigung −1 an A, Belichtung +1,5 an B) | dieselben Messungen; Regler stehen je Bereich (`BildEditor.tsx:3975-3990`), `editorAenderung` verteilt sie an die Maske (`masken.ts:2473`). |
| Zwei Bereiche auf DEMSELBEN Gegenstand stapeln ihre Wirkung | `B1 gleich-hell`: A `152` (grau UND heller) gegenüber `93` (nur grau). |
| Anlegen, Löschen (Editor und Zeitleiste), ↺, Ein/Aus, „Nur Abschnitt n", „Hier trennen", Sammelbahn ab drei Masken, Bühne ≥ 180 px bei 375×667 mit vier Masken | bestehende Tests (8 von 9 grün) und `c2`/`c1`: nach 🗑 fehlt die Maske im Editor, nach ↺ ist sie wieder da. |
| Grenze 4 je Bild / 8 im Film inkl. Maske ausserhalb des Zeitraums | `masken.ts:658` (`bereichePlatz`), `masken.test.ts:1569`. |
| Mehrere TEILE in einem Bereich werden je Teil mit eigenen Ankern verfolgt | `D2`: ein Bereich, Teil „Farbe 1" (A, ohne Netz) und „Getippt 2" (B, mit Netz): A `93`, B `184` (beide grau) den ganzen Film. Synthetisch: zwei Teile → beide Deckung 0,83 (Höchstwert) in jedem Bild. |
| Bei einem Wort: der Mechanismus „getrennt verfolgt" ist im Kern sauber, solange jede Spur EINEN Gegenstand hat | alle drei Zeilen oben. |

---

## 4. Vergleich mit dem Foto (Reiter „Bereiche", `bild/BildEditor.tsx`)

| Fähigkeit | Foto | Video | Unterschied / Lücke |
|-----------|------|-------|---------------------|
| Bereich anlegen („＋ Bereich", oder erste Maske legt einen an) | ja (`bereichAnlegen`, :2648) | ja, derselbe Knopf; zusätzlich eine Bahn je Bereich | im Video kein Weg direkt an der Zeitleiste (L7) |
| Bereich wählen | Chips (:3354-3365), eine Auswahl | Chips ODER Bahn antippen/◐ – zwei Auswahlen | **L1** |
| Bereich umbenennen | **nein** (`name` nur beim Anlegen, :2222, :2520) | nein | gleich; in beiden fehlt es (L6) |
| Bereich löschen | „🗑 Bereich" (:3975) | derselbe Knopf plus 🗑 in der Zeitleiste, beides gleichgeschaltet | richtig |
| Reihenfolge ändern | nein (Reihenfolge = Anlegen) | nein (Reihenfolge der Bahnen = Wirkreihenfolge; „Hier trennen" setzt die Hälfte direkt dahinter) | gleich, kein Befund |
| Teile je Bereich | Chips „Masken des Bereichs" (:3699) | derselbe Block; je Teil eigene Anker | gleich |
| Mehrere Gegenstände in einem Bereich (zwei Tipps) | ja, Punkte desselben Tippteils | Punkte desselben Teils werden als EIN starrer Körper verfolgt – nur einer wird gefunden | **L2** (Foto geht, Video nicht) |
| Person + Antippen in einem Bereich | ja | ja, je Teil verfolgt (`D2`) | gleich |
| Regler je Bereich | `BEREICHSREGLER` (:123), `bereichRegler` mit Bereichskennung im Bündel (:2713) | derselbe Block | gleich |
| Ein/Aus je Bereich | „An"/„Aus", Chip mit „✗" | dazu 👁 in der Zeitleiste, beides gleichgeschaltet | richtig |
| Gültigkeit | – | „Ganzer Film"/„Zeitraum"/„Nur Abschnitt n", Griffe | nur in der Zeitleiste, im Reiter nicht sichtbar (L4) |
| Maximalzahl | 4 (`BEREICHE_MAX`, doc.ts:94) | 4 je Bild, 8 im Film | beim Erreichen der Grenze verschwindet „＋ Bereich" wortlos: **L8** (Foto gleich) |
| Hinweise | Leerzustand „Ein Bereich ist eine Anpassung…" (:4012) | derselbe, dazu `maskenLage` über der Zeitleiste | im Video ist der Leerzustand auch dann zu sehen, wenn der Bereich nur an diesem Bild fehlt: **L4**; Formen: kein Hinweis, dass sie der Kamera und nicht dem Gegenstand folgen: **L9** |
| Rückgängig/Wiederholen | Kopf ↺/↻, ein Zug ein Schritt | Kopf ↺/↻ (Verlauf wird bei Bildwechsel mit den Masken des neuen Bildes belegt, `verlaufMitMasken`) UND ein eigenes ↺ der Zeitleiste für Bahnänderungen (10 s) | zwei Rückgänge, bewusst getrennt (`leisteZurueck`, `schnittZustand.ts:608`), kein Befund |
| Farbe/Name zur Unterscheidung | nur der gewählte Bereich ist rot eingefärbt | Bahnen tragen je eine Farbe (`--maske-0…7`), Chips nicht | **L6** |

Der Gleichklang zwischen `bereichId`/`teilId` im Editor (`BildEditor.tsx:526`, `:595`) und `schnitt.gewaehlt`
(`schnittZustand.ts:154`) besteht NICHT. Der einzige Weg von innen nach aussen ist `setGewaehlt(erg.neu…)` beim
Anlegen (`schnittZustand.ts:453`, `:596`) – und der einzige von aussen nach innen ist: keiner. Der Editor setzt
`bereichId` nur zurück, wenn die Sitzung wechselt (`BildEditor.tsx:1011-1016`).

---

## 5. Die Lücken

### L1 – Zwei getrennte Auswahlen (hoch)

**Beleg.** `protokoll.log`, Läufe `a2`/`a4`:

- Nach „＋ Bereich" und Tipp auf B: Chip „Bereich 2" gedrückt, Leiste „Bereich 2 · fertig verfolgt" – in Ordnung.
- Klick auf den Chip „Antippen" im Editor: Chip „Antippen" gedrückt, **Leiste unverändert „Bereich 2"**, Bahn 2
  `ist-gewaehlt` (Bild `a2-04-bereich1-im-editor-gewaehlt.png`).
- Tipp auf Bahn 1 in der Zeitleiste: Leiste „Antippen", **Chip „Bereich 2" bleibt gedrückt**, im Bild liegt die rote
  „Maske zeigen"-Fläche auf B (Bild `a4-412-02-bahn1-gewaehlt.png`).
- „Hier trennen" (`c2`): Leiste „Bereich 2 2", **kein Chip gedrückt** (die alte Kennung ist an diesem Bild nicht mehr da).

Folge: „Zeitraum", „Hier trennen", 🗑 der Zeitleiste und die Regler/Griffe des Editors wirken auf verschiedene
Bereiche, ohne dass die Oberfläche das sagt. Beim Foto gibt es nur die eine Auswahl.

**Abhilfe (kleinste sinnvolle Änderung).** Auswahl in BEIDE Richtungen weiterreichen, der Editor behält seinen
lokalen Zustand (`bereichRef` wird synchron gelesen, wenn ein Tipp einen Bereich anlegt – ein reiner
Prop-Zustand käme dafür zu spät):

- `BildEditorProps`: `bereichGewaehlt?: string | null` und `onBereichGewaehlt?: (id: string) => void`.
- Chip-`onClick` (`BildEditor.tsx:3358-3363`) ruft zusätzlich `onBereichGewaehlt?.(bereich.id)`.
- Ein Effekt gleicht von aussen ab: ist `bereichGewaehlt` gesetzt und ungleich `bereichRef.current`, dann
  `setBereichId(bereichGewaehlt)` und `setTeilId(erstes Teil des Bereichs oder null)`; `null` von aussen
  („Fertig" in der Zeitleiste) lässt die Wahl im Editor stehen. Der Effekt hängt auch an `doc`, damit er nach dem
  Neuladen (nach „Hier trennen", Sitzungswechsel `:1014`) greift.
- `SchnittEditor.tsx` (Editor-Props `:700-715`): `bereichGewaehlt={schnitt.gewaehlt}`,
  `onBereichGewaehlt={schnitt.waehlen}` – beide stabil, der `memo`-Editor rechnet nur bei einem Wechsel der Wahl.
- Keine Änderung in `schnittZustand.ts` (`waehlen` gibt es, `:643`).
- **Folge, die mitgemeint ist:** Wer im Editor einen Chip antippt, wählt damit die Maske, und die Zeitleiste zeigt
  ihre Einstellungszeile STATT der Schnittknöpfe (`Zeitleiste.tsx:218-257`). Das macht L5 dringlich (7).

**Abnahme.** e2e `maskenBereiche.spec.ts` – „Auswahl im Gleichklang": (a) zwei Bereiche, Tipp auf Bahn 1 →
Chip 1 `aria-pressed=true`, Chip 2 `false`, Leistenname = Chipname, und der Sättigungsregler zeigt −100 (Bereich 1),
nach Tipp auf Bahn 2 `0`; (b) Klick auf Chip 1 → `.mb-zeile.ist-gewaehlt` ist die erste, Leistenname = Chipname;
(c) nach „Hier trennen" ist der neue Bereich im Editor gedrückt; (d) „Fertig" in der Zeitleiste hebt die Wahl im
Editor NICHT auf.

---

### L2 – Zwei Gegenstände in einem Bereich: nur einer wird verfolgt (hoch)

**Beleg.** Ein Tipp geht in den GEWÄHLTEN Bereich (`BildEditor.tsx:2383-2420`, `tippTeilFinden` sucht „das"
Tippteil nach Vorzeichen und Verfahren, `tippTeilSetzen` hängt den Punkt an dessen Liste). Nach dem ersten Tipp
ist der neue Bereich gewählt, also landet der zweite Tipp – ohne „＋ Bereich" – im selben Teil. Im Foto ist das
richtig. Im Video wird die Maske eines Teils als EIN Körper verfolgt (`objektFolge.ts`, Kopfkommentar: „die MASKE
SELBST gesucht"), zwei verschieden bewegte Gegenstände passen nicht in einen Körper.

- e2e `B1 einBereich-hell` (Wege getrennt, Farbflutung): A grau (`93`) nur bis 0,25 s, ab 0,45 s unverändert
  (`51,110,56`); B grau (`184`) durchgehend. Bild `b1-einBereich-hell-bogen.png`: die graue Fläche, die A decken sollte, bleibt links stehen und rutscht mit B nach
  unten (die Maske wird als ein Körper mit B's Bewegung geführt), A läuft unbearbeitet davon, B wird sauber verfolgt. Die Bahn sagt
  „sichtbar 0,0 s bis 5,0 s".
- Dasselbe **mit Netz** (`D1-150-ein`): A grau bis 0,45 s, ab 0,65 s unverändert, B grau durchgehend.
- Synthetisch (`messung/zzBereicheMessung.test.ts.txt`, echte `folgeTeile` + Farbflutung): ein Teil mit zwei Punkten –
  Anteil von A gedeckt 1,00 bis Bild 4, **0,00 ab Bild 15**, Anteil von B durchgehend 1,00.
- **Gegenprobe** (der Beleg für die Abhilfe): zwei Teile desselben Bereichs (`D2`; synthetisch „zwei Teile") – beide
  Gegenstände den ganzen Film über richtig.

Nichts in der Oberfläche warnt; der Editor zeigt am Ankerbild beide Gegenstände rot, der Film nur einen.

**Abhilfe (kleinste sinnvolle Änderung).** Im VIDEO bekommt jeder angetippte, nicht zusammenhängende Gegenstand
ein EIGENES Tippteil im selben Bereich. Die Verfolgung rechnet je Teil eigene Anker und Ketten (`masken.ts`,
`SpurTeil`), das Zusammensetzen vereinigt `dazu`-Teile wie bisher – der Pfad ist durch `D2` belegt. Das Foto bleibt
unverändert.

- Neue reine Funktion in `bild/tippMaske.ts`: `tippGehoertDazu(teil: TippTeil, stelle): boolean` – `alpha` der
  Vorlage an der Stelle (mit einem Punkt Nachbarschaft) ≥ 128.
- `BildEditor`: neue Eigenschaft `teilJeGegenstand?: boolean` (der Videoeditor setzt sie). In `tippAnwenden`
  (`:2415`) wählt `tippTeilFinden` mit der Stelle: nur ein passendes Teil, in dessen Maske der Tipp liegt, bekommt
  den Punkt; sonst `null` → `tippTeilSetzen` legt über `teilEinsetzen` ein neues Teil im gewählten Bereich an.
  Nur für `dazu`-Tipps; „Wegnehmen" bleibt beim bisherigen Teil.
- „Letzten Tipp zurück" (`tippZurueck`, `:2459`) und `tippTeilJetzt` (`:2136`, die Zahl „N Stellen") müssen auf das
  ZULETZT angelegte passende Teil zeigen, nicht auf das erste.
- Ein Satz im Antipp-Block, nur im Video: „Jeder Gegenstand, den du antippst, wird für sich verfolgt – auch mehrere
  in einem Bereich."
- Nicht nötig: Änderungen in `masken.ts` (`teilRouten` legt für eine neue Teilkennung ein Spurteil mit Anker an),
  im Verfolger, im Filmbau.

**Abnahme.**
- vitest `bild/tippTeil.test.ts`: `tippGehoertDazu` – Tipp in der Maske: ja; ausserhalb: nein; am Rand ±1 Punkt.
- vitest `video/masken.test.ts`: `editorAenderung` mit einem Bereich, der zwei Tippteile mit verschiedenen
  Kennungen trägt → zwei `SpurTeil`, je ein Anker an `k`, getrennte Kettenschlüssel (Schutz vor Rückschritt; die
  Router-Seite besteht heute schon).
- e2e `maskenBereiche.spec.ts` – „ein Bereich, zwei Gegenstände": zwei Tipps (A, dann B) OHNE „＋ Bereich"; die Teile-
  Zeile zeigt zwei Chips; im fertigen Film sind A UND B in jedem Bild bis zum Austritt von A grau (Wege getrennt, wie
  `D2`); Bahnen: eine.

---

### L3 – Verdeckung: der Verdecker nimmt die Maske mit (hoch, eigener Strang)

**Beleg.** Kreuzen sich die Wege (`x = 150`) und B liegt über A:

- e2e `B1 zwei-hell`: nach der Kreuzung (Kern ab 2,05 s, die Ecke schon ab 1,65 s) ist A **unverändert** (`51,110,54`), die graue
  Fläche von A sitzt als Geist links von B und wandert mit B nach unten (Bild `b1-zwei-hell-bogen.png`). Mit dem kräftigen
  Farbpaar (`B1 zwei`) trägt B die Bearbeitung BEIDER Bereiche (`229,229,229`: grau und heller), A keine.
- **Dasselbe mit nur EINEM Bereich** (`B1 nurA`, `nurA-hell`): A ab 1,85 s (hell) bzw. 2,05 s (kräftig) unverändert. Es liegt also nicht an der
  Zahl der Bereiche, sondern an der Verfolgung.
- **Dasselbe mit Netz** (`D1-150`): A ab 2,05 s unverändert.
- Die Bahn lügt: `a5` meldet für A „sichtbar 0,0 s bis 5,0 s", obwohl A bei 3,9 s aus dem Bild ist – die Maske
  sitzt irgendwo und gilt als „gefunden".
- Synthetisch (`messung/zzDiag.test.ts.txt`, `folgeTeile`, Farbflutung): Deckung von A 0,83 (Höchstwert) bis Bild 20,
  danach 0,80 0,77 0,78 0,77 0,68 0,51 0,37 … **0,00 ab Bild 35**; die Fläche der Maske bleibt bei 1420 Punkten
  stehen. Schwerpunkt der Maske `x` ≈ 131 bleibt stehen, `y` steigt um 2 Punkte je Bild – das ist die Geschwindigkeit
  von B, nicht von A (A läuft mit `x` 134 → 236). Liegt A dagegen ÜBER B, bleibt die Deckung durchgehend 0,83. Auch das
  verdeckte B (A oben, B wird verfolgt) geht verloren (≤ 0,05 ab Bild 28, 0,00 ab Bild 39).

**Ursache (Befund, aus dem Code gelesen, nicht gemessen).** `maskeSuchen` (`objektFolge.ts:1262-1372`) bewertet alle
Maskenpunkte gleich (mittlere Abweichung). Sobald der Verdecker einen Teil der Maske überlagert, enthält die Vorlage
seine Bildpunkte, und der beste Versatz folgt dem Verdecker.

**Abhilfe – ein Ansatz, ungeprüft.** Eine robuste Suche: nur die besten 60 bis 70 Prozent der Stellen zählen
(getrimmte Summe) oder Stellen, die im neuen Bild gegenüber dem alten springen, ausschliessen; zusätzlich die Vorlage
vom letzten unverdeckten Schlüsselbild nehmen. **Nicht empfohlen:** die Masken einander ausschliessen zu lassen
(„Pixel von Bereich 2 gehören nicht zu Bereich 1") – `kettenSchluessel` (`masken.ts:723`) hat bewusst keine
Maskenkennung, damit „Hier trennen" und Rückgängig gerechnete Ketten teilen; eine Abhängigkeit zwischen Masken
machte jede Kette von der anderen abhängig.

Bis dahin hilft dem Anwender ein zweiter Tipp nach der Kreuzung (mehrere Anker je Teil, „Anwesenheit gewinnt",
`masken.ts:1473`) – aber die Bilder zwischen dem Ende der Überdeckung und der Mitte zum zweiten Anker bleiben falsch
(der nähere Anker gewinnt), und nichts in der Bahn zeigt, dass dort etwas falsch ist.

**Abnahme.**
- vitest `video/objektFolge.test.ts`: neuer Fall „Verdeckung" mit der Szene aus `messung/` (Gegenstand von einem
  anderen überquert, verdeckter Gegenstand wird verfolgt): Deckung ≥ 0,7 ab vier Bildern nach Ende der Überdeckung
  und in den Bildern DAVOR unverändert ≥ 0,8; heute 0,00. Dazu der Gegenfall „Verdecker wird verfolgt": ≥ 0,8
  (heute schon).
- Bestehende Fälle in `objektFolge.test.ts` und `verfolger.test.ts` bleiben grün (Mittel > 0,95, kleinste > 0,85,
  keine Ablehnung).
- e2e (langsam, ein Lauf): `maskenBereiche.spec.ts` – „kreuzen": A grau und B heller, jeder an der RICHTIGEN Stelle,
  ab 2,5 s bis zum Austritt von A. Gilt als bestanden, wenn der vitest-Fall grün ist; der e2e-Lauf ist die
  Gegenprobe am echten Film.

---

### L4 – Der gewählte Bereich gilt an diesem Bild nicht (mittel)

**Beleg.** `c2`: Bereich 2 gilt nur 1,6 bis 3,6 s und ist in der Zeitleiste gewählt; Wiedergabestelle bei 0,4 s: Editor-Chips
„Antippen", „＋ Bereich" – **kein „Bereich 2"**, keine Regler, der Leerzustand „Ein Bereich ist eine Anpassung, die nur an
einer Stelle wirkt …" (Bild `c2-01-ausserhalb-zeitraum.png`), Leiste der Zeitleiste „Bereich 2". Legt man jetzt per Tipp
etwas an, entsteht ein NEUER Bereich (`teilEinsetzen`, `BildEditor.tsx:2505`: die gewählte Kennung ist nicht im Dokument),
nicht ein Zusatz zu Bereich 2 – nachgespielt in `c3` (Bild `c3-01-tipp-ausserhalb.png`): aus zwei Masken werden drei, der neue Bereich heisst
„Antippen 2" (mit Zähler, weil „Antippen" schon vergeben ist), die Leiste springt auf ihn, nichts sagt, warum.

**Abhilfe.** `SchnittEditor.tsx` kennt es schon (`gezeigt.stand.z.enthalten`, `:556`): ist `schnitt.gewaehlt` gesetzt,
aber nicht in `z.enthalten`, steht in `maskenLage` ein Satz („„Bereich 2" gilt an diesem Bild nicht – er ist von 1,6 s
bis 3,6 s zu sehen. [Zur Maske]"; „Zur Maske" gibt es in `MaskenChips`). `BildEditor` bekommt `bereichFehlt?: string`
und zeigt ihn statt des Leerzustands (`:4012`). Ein Tipp/Formgriff, solange `bereichFehlt` gilt, legt NICHTS an,
sondern zeigt denselben Satz als Hinweis (`toast`).

**Abnahme.** e2e: Bereich 2 mit Zeitraum, Wiedergabestelle davor → der Satz mit dem Namen ist sichtbar, der
Leerzustand nicht; ein Tipp ins Bild ändert die Zahl der Bahnen nicht; „Zur Maske" bringt die Wiedergabestelle in den
Zeitraum, der Chip erscheint und ist gedrückt.

---

### L5 – Die Einstellungszeile passt nicht auf das Telefon (mittel)

**Beleg.** `e1`: die Zeile ist 808 px (375 px Breite) bzw. 848 px (412 px) breit in 351 bzw. 388 px; ganz sichtbar sind
„Abspielen", „Ganzer Film", „Zeitraum" (teilweise abgeschnitten); **erst nach seitlichem Wischen** „Ab hier", „Bis
hier", „Zur Maske", „wirkt" (👁), „Hier trennen", „löschen", „Maske fertig". Der Stil sagt es mit Absicht (`styles.css:703-717`:
„sie lassen sich seitlich schieben, statt die Bühne um eine zweite Zeile zu kürzen"), die Leiste ist nicht
ausgeblendet, und ein Wischen verrät kein Rand-Zeichen ausser dem abgeschnittenen Knopf. Bilder
`e1-375-leiste.png`, `a3-04-vor-fertig.png`. Mit L1 wird diese Zeile öfter und ohne Absicht des Anwenders
ausgelöst (7).

**Abhilfe.** Keine zweite Zeile (die Bühne soll ≥ 180 px bleiben, bestehender Test), sondern:
(1) „Fertig" `position: sticky; right: 0` mit Hintergrund, damit der Rückweg zu den Schnittknöpfen immer da ist;
(2) Reihenfolge: ▶ · ● Name · Ganzer Film|Zeitraum · 👁 · 🗑 · dann Ab hier · Bis hier · Zur Maske · Hier trennen · ↺;
(3) ein weicher Rand-Verlauf rechts (CSS `mask-image`), solange es etwas zu schieben gibt; (4) ≤ 400 px: den Stand
(„· fertig verfolgt") aus dem Namen in die `mb-lage`-Zeile verlegen (spart rund 100 px).

**Abnahme.** e2e bei 375×667 UND 412×880: Name, „Ganzer Film", „Zeitraum", 👁, 🗑 und „Fertig" liegen mit `getBoundingClientRect`
VOLLSTÄNDIG im Fenster, ohne zu scrollen; „Fertig" bleibt nach `scrollLeft = scrollWidth` sichtbar; die Bühne bleibt
≥ 180 px (bestehender Test mit vier Masken); alle Knöpfe bleiben per Tastatur erreichbar.

---

### L6 – Bereiche sind in der Zeitleiste nicht auseinanderzuhalten, nicht benennbar (mittel)

**Beleg.** `a2-04`, `c1-03-vier-375.png`: bis zu zwei Bahnen tragen nur eine Farbe; der Name steht nur in der Zeile des
GEWÄHLTEN Bereichs; ab drei Masken sind es farbige Streifen (`Maskenbahnen.tsx:95` `EINZELN_BIS = 2`) ohne Namen – erst ein
Tipp auf die Sammelbahn zeigt sie. Die Chips im Reiter „Bereiche" tragen keine Farbe. Namen: der erste Tipp legt „Antippen"
an (`BildEditor.tsx:2364`), „＋ Bereich" „Bereich 2" (`:2654`), „Hier trennen" „Bereich 2 2" (`eindeutigerName`, `masken.ts:2733`).
Umbenennen gibt es weder im Foto noch im Video (kein Eingabefeld, `name` wird nur beim Anlegen gesetzt).

**Abhilfe.**
- **a (klein, sichtbar):** ein Farbpunkt in den Chips des Reiters „Bereiche" in der Farbe der Bahn:
  `BildEditor`-Eigenschaft `bereichFarbe?: (id: string) => string | undefined`; `SchnittEditor` liefert
  `var(--maske-${maske.farbe % 8})` aus `masken` (dieselbe Klasse `mb-punkt` wie in der Leiste).
- **b (klein):** `eindeutigerName` erhöht eine angehängte Zahl statt eine zweite anzuhängen („Bereich 2" → „Bereich 3").
- **c (klein, auch Foto):** ein Namensfeld für den gewählten Bereich im Reiter („Name", `maxLength` 24,
  `merkenGebuendelt('bereichname-<id>')`); der Router übernimmt den Namen schon (`maskeFortschreiben`, `masken.ts`).
- **d:** der erste Tipp heisst „Bereich 1" statt „Antippen" (die Art steht im Teil-Chip).

**Abnahme.** vitest `masken.test.ts` für b; e2e: (a) der Farbpunkt jedes Chips hat denselben berechneten Wert für
`--mb-farbe` wie die Bahn der Maske; (c) Namen ändern → Chip, Leiste und `aria-label` der Bahn tragen ihn, ↺ stellt ihn
wieder her; Foto: gleiches Feld, `bilder.spec.ts` bleibt grün.

---

### L7 – Kein Weg „weiterer Bereich" an der Zeitleiste (niedrig bis mittel)

**Beleg.** `Zeitleiste.tsx:255-347`: Die Zeile ohne Maske hat ✂ ← → 🗑 ＋ (letzteres: „Abschnitt hinzufügen"!), ↺, ◐; mit
gewählter Maske ersetzt die Einstellungszeile alles. Eine neue Maske entsteht nur im Reiter „Bereiche" des Editors – steht
dort ein anderer Reiter (Zuschnitt, Ton), gibt es von der Zeitleiste aus keinen Weg.

**Abhilfe.** Das ◐ („Maske wählen") bleibt der Weg zu den Masken; `MaskenNamen` (`Maskenbahnen.tsx:1003`) bekommt am Ende
„＋ Bereich". Der Klick geht über einen Zähler `bereichNeu` (Eigenschaft von `BildEditor`; Effekt: `setWerkzeug('bereich')` und
`bereichAnlegen()`). KEIN weiteres „＋" in der Hauptzeile: Dort steht es schon für Abschnitte.

**Abnahme.** e2e: Editor auf Reiter „Ton", ◐ → „＋ Bereich": Reiter „Bereiche" ist aktiv, ein zweiter Bereich da und
in der Zeitleiste gewählt; bei vier Bereichen fehlt der Knopf (L8).

---

### L8 – Grenze erreicht: der Knopf verschwindet wortlos (niedrig; Foto gleich)

**Beleg.** `c1`: bei vier Bereichen `＋ Bereich`: 0 Knöpfe, die Hinweise im Reiter sind die allgemeinen. `BildEditor.tsx:3368-3376`
zeigt `bereicheGrund` nur, wenn weniger als `BEREICHE_MAX` Bereiche DA sind; bei genau vier ist es still. Im Foto ist
`bereicheGrund` nie gesetzt.

**Abhilfe.** Ist `doc.bereiche.length >= bereicheMax` und kein `bereicheGrund` da: „Mehr als 4 Bereiche gehen nicht – lösch einen,
oder tippe weitere Gegenstände in einen Bereich." (Bei `teilJeGegenstand` stimmt der zweite Halbsatz nach L2.)

**Abnahme.** e2e (ergänzt den Test „auch mit vier Masken" in `maskenSpuren.spec.ts:253`): bei vier Bereichen steht der Satz,
im Foto (`bilder.spec.ts`) ebenso.

---

### L9 – Formen folgen der Kamera, nicht dem Gegenstand – ohne Hinweis (niedrig bis mittel)

**Beleg.** `f1` (Radial, gemusterter Grund): die Ellipse bleibt an ihrer Stelle, A und B laufen hindurch
(A bei 1,65 s halb entsättigt `71,103,74`, sonst `51,110,54`). Das ist gewollt (`bildweise.ts`: „Stützpunkte … mit der Lage der
Kamera"), aber nirgends steht es: weder im Reiter noch in `maskenLage`. **Beobachtung ausserhalb dieses Themas:** auf
EINFARBIGEM Grund (erster `f1`-Lauf) wandert die Ellipse mit B nach unten – die Kamerabahn hält die Bewegung des einzigen
Gegenstands für einen Schwenk (`lageRobust` braucht strukturierte Blöcke). Nicht weiter untersucht.

**Abhilfe.** Im Video, bei gewähltem Verlauf/Radial/Pinsel, ein Satz im Reiter: „Diese Form bleibt an der Szene (sie folgt der
Kamera). Für einen Gegenstand, der sich bewegt: 👆 Antippen."

**Abnahme.** e2e: im Video steht der Satz bei einer gewählten Form, im Foto nicht, und nach 👆 Antippen nicht.

---

### L10 – Nichts weist die getrennte Verfolgung nach (mittel)

**Beleg.** `e2e/maskenSpuren.spec.ts` zählt bei mehreren Masken nur Knöpfe und Bahnen (`:253`, `:431`); der Pixeltest
(`:276`) hat EINE Maske. Die vitest-Fälle in `verfolger.test.ts` benutzen einen Ersatz ohne Bild; in `objektFolge.test.ts`
gibt es genau einen Gegenstand je Fall.

**Abhilfe.** Das Prüfpaket unter 6 – e2e `maskenBereiche.spec.ts` mit der Zwei-Gegenstände-Bühne (nach `e2e/buehne.ts`) und
die vitest-Fälle. Die Messskripte (`pruef/`, `messung/`) sind die Vorlage; die Abtastung braucht einen Wiederholungsversuch
gegen das schwarze erste Bild (siehe 8).

**Abnahme.** Die Tests aus 6 laufen grün; Lücke L10 ist geschlossen, wenn T1 (getrennte Wege) und die vitest-Fälle
zu L2/L3 im Repo stehen.

---

### L11 – Am Bildrand endet die Maske zu früh (niedrig)

**Beleg.** e2e `B1 zwei-hell-getrennt`: A ist bei 3,65 s noch zu mehr als der Hälfte im Bild (22 von 40 Spalten) und
**nicht** mehr grau; die letzte graue Stelle ist 3,45 s. Synthetisch (`messung/zzRand.test.ts.txt`, Farbflutung): Deckung 0,85–0,87
solange noch 25 und mehr von 40 Spalten sichtbar sind (Bilder 25–29), **0,00 bei 20, 15, 10 und 5 sichtbaren Spalten** (Bilder 30–33), obwohl noch
  Gegenstand da ist.
Der vorhandene Test `hängt nicht am Bildrand fest` prüft nur das Netz.

**Abhilfe.** Untersuchen, welche Prüfung die letzte Maske verwirft (Verdacht: `maskePasst` gegen eine auf den Rand gestutzte
Vorhersage). Erst klären, dann ändern.

**Abnahme.** vitest `objektFolge.test.ts`: derselbe Fall für `tipp` mit Deckung > 0,8 solange ≥ 25 % des Gegenstands im Bild sind.

---

### L12 – Wortwahl und Handbuch (niedrig)

`docs/FEATURES.md:226-242` spricht im Video nur von „Maske"; der Editor sagt „Bereich", die Zeitleiste „Maske" (`aria-label`
„Maske wählen", „Maske fertig", `maskenLage`). Der Satz „bis zu vier Bereiche je Bild" (`:184`) und „höchstens acht Masken im Film"
(`:239`) sind nicht verbunden. **Abhilfe:** in der Oberfläche der Zeitleiste „Bereich" sagen (die Beschriftungen der
Bahn/Leiste bleiben im Quelltext, nur der Text ändert sich); `FEATURES.md` bekommt im Abschnitt „Videos bearbeiten" einen
Absatz „Mehrere Bereiche": je Gegenstand einen Bereich (oder mehrere Gegenstände in einen), je Bereich eigene Regler und Gültigkeit.
**Abnahme:** `rg 'Maske' src/modules/video/*.tsx` zeigt in sichtbaren Texten keine Reste; Absatz steht in `FEATURES.md`.

---

## 6. Prüfpaket (Tests zu den Lücken)

**e2e `e2e/maskenBereiche.spec.ts` (neu), Bühne `e2e/zweiGegenstaende.ts` nach dem Muster von `e2e/buehne.ts`:**

| Test | Lücke | Inhalt (Zahlen aus den Läufen oben) |
|------|-------|--------------------------------------|
| T1 zwei Bereiche, getrennte Wege | L10 | `bx = 230`, Farbpaar „hell": A grau (`R≈G≈B`, 93±15), B belichtet (`G > 230`), Grund unverändert, an 8 Zeiten von 0,05 bis 3,45 s. Bereich 2 mit Zeitraum (Ab hier/Bis hier) → B vor 1,6 s und nach 3,6 s unverändert. |
| T2 Auswahl im Gleichklang | L1 | beide Richtungen, Reglerwerte je Bereich, nach „Hier trennen". |
| T3 ein Bereich, zwei Gegenstände | L2 | zwei Tipps ohne „＋ Bereich", zwei Teile-Chips, beide grau bis zum Austritt von A. |
| T4 Bereich fehlt am Bild | L4 | Satz mit Name, kein neuer Bereich durch Tipp, „Zur Maske". |
| T5 Einstellungszeile | L5 | Bounding-Boxen bei 375 und 412; Bühne ≥ 180 px. |
| T6 Farbpunkt und Name | L6 | Farbe Chip = Farbe Bahn; Umbenennen; ↺. |
| T7 „＋ Bereich" an der Zeitleiste | L7 | von Reiter „Ton" aus. |
| T8 Grenze | L8 | Satz bei vier Bereichen (Video und Foto). |
| T9 Formen | L9 | Satz im Video, nicht im Foto. |
| T10 kreuzen | L3 | A und B jeder an seiner Stelle nach der Kreuzung (nach L3). |
| T11 derselbe Gegenstand in zwei Bereichen | – (Schutz vor Rückschritt) | A in Bereich 1 (Sättigung −1) und Bereich 2 (Belichtung +1,5): A grau UND heller (≈152), nicht nur eines von beiden (Messung `B1 gleich-hell`, vor der Kreuzung). |

Gemeinsames: `bildAn(video, t)` wartet auf ein nicht schwarzes Bild (bis 5 × 50 ms), sonst fällt der Test wie
`maskenSpuren.spec.ts:338` unter Last. Der Kodierer fehlt → `test.skip`.

**vitest:** `bild/tippTeil.test.ts` (`tippGehoertDazu`), `video/masken.test.ts` (zwei Tippteile → zwei Spurteile;
`eindeutigerName`), `video/objektFolge.test.ts` (Verdeckung; Rand mit `tipp`) – die Szene steht in
`messung/zzBereicheMessung.test.ts.txt`, `zzDiag.test.ts.txt`, `zzRand.test.ts.txt` (nur kopieren und kürzen; die Mock-Köpfe
und `bild()`-Funktionen sind aus `objektFolge.test.ts` übernommen).

---

## 7. Reihenfolge, Aufwand, Abhängigkeiten

1. **L8, L9, L12** (Sätze, Handbuch) – Stunden, kein Risiko.
2. **L1 + L5 + L4** zusammen – ½ bis 1 Tag. L1 allein verschlechtert die Lage: Wer einen Chip tippt, wählt die Maske und verliert
   die Schnittknöpfe, deren Rückweg („Fertig") heute hinter der Wischkante liegt. L4 gehört dazu, weil L1 öfter „gewählt, aber
   hier nicht gültig" erzeugt.
3. **L6a, L6b, L7** – ½ Tag; **L6c, L6d** (Umbenennen, Standardnamen) auch für das Foto – wählbar.
4. **L2** – 1 Tag (Funktion, Prop, drei Stellen in `BildEditor`, Tests).
5. **L11** – ½ bis 1 Tag Untersuchung.
6. **L3** – mehrere Tage, eigenes Vorhaben mit Regressionsrisiko in der Verfolgung; erst die Tests, dann die Suche.

Alle Eingriffe in `BildEditor.tsx` sind kleine Eigenschaften und Effekte – wegen der parallelen Arbeit (Weichzeichnen/Bokeh
ändern `BEREICHSREGLER`, Wischen ändert `SchnittEditor`/`Zeitleiste`/`Maskenbahnen`) keine Umbauten, nur Zeilen dazu.

---

## 8. Risiken und offene Punkte

- **Die Messfilme sind künstlich** (einfarbige Quadrate, einfarbiger Grund); L3 und L11 sind an synthetischen UND
  e2e-Filmen reproduziert, die Quote an echtem Material ist unbekannt. Die Zahlen belegen Verhalten, keine Häufigkeit.
- **L2 verändert, was ein zweiter Tipp tut** – nur im Video, nur für `dazu`; „Letzten Tipp zurück" und die Zählung „N Stellen"
  müssen dabei mitwandern (sonst nimmt ↩ den falschen Punkt zurück). Ein Tipp auf dasselbe Ding ausserhalb der Maske
  (Schatten) wird ein eigenes Teil: harmlos für die Verfolgung (zwei Ketten, die mit demselben Gegenstand laufen), kostet
  aber Rechenzeit (mit Netz rund 30 bis 40 s je Teil im Hintergrund).
- **L1/L5 hängen aneinander** (siehe 7); wer L1 ohne L5 ausliefert, hat „Fertig" hinter der Wischkante.
- **L3 ändert die Verfolgung für alle Masken**: `objektFolge.test.ts` (5×2 Fälle, Rand, Eintritt) ist der Schutz;
  jede Änderung der Suche muss dort und in `verfolger.test.ts` grün bleiben.
- **Wackelstelle im bestehenden Test** `maskenSpuren.spec.ts:276/338`: das erste Bild nach `onseeked` kann noch schwarz sein
  (einzeln grün, im Gesamtlauf unter Last einmal rot). Kein Befund im Produkt; im neuen Test abfangen.
- **Parallele Arbeitsbäume** (Blur: `BildEditor`-Regler; Wischen: `SchnittEditor`/`Zeitleiste`) – Zusammenführen vor dem
  Ändern abstimmen, vor allem `BildEditorProps` und `Zeitleiste.tsx` (L7).
- **Nicht geprüft:** Modelle „Person", „Motiv", „Tiefe", „Hohe Qualität" (keine Grafikeinheit; „Motiv" ist ausgeschaltet);
  Querformat; echte Touch-Geräte (Playwright mit Maus); mehr als zwei Abschnitte mit mehreren Bereichen über die bestehenden
  Tests hinaus; Filme über fünf Sekunden; das Wischen (anderer Strang).
- **Offene Fragen an den Auftraggeber:** (1) L2: neues Teil im selben Bereich (empfohlen, gemeinsame Regler wie beim Foto) oder
  jeder weitere Gegenstand ein eigener Bereich? (2) Umbenennen gewünscht (auch im Foto)? (3) Soll „Fertig" in der
  Zeitleiste die Wahl im Editor auch aufheben (dann legte der nächste Tipp einen NEUEN Bereich an)?

---

## Anhang A – Bilder (in `shots/`)

| Datei | Zeigt |
|-------|-------|
| `a1-02-reiter-bereiche.png` | Reiter „Bereiche" beim ersten Öffnen im Video (412) |
| `a2-04-bereich1-im-editor-gewaehlt.png` | **L1**: Chip „Antippen" gedrückt, Zeitleiste „Bereich 2" |
| `a4-412-02-bahn1-gewaehlt.png` | **L1**: Bahn 1 gewählt, Chip „Bereich 2" gedrückt |
| `a3-04-vor-fertig.png`, `e1-375-leiste.png` | **L5**: Einstellungszeile abgeschnitten |
| `c1-03-vier-375.png` | vier Bereiche bei 375: Sammelbahn ohne Namen, „＋ Bereich" fehlt wortlos (**L6, L8**) |
| `c2-01-ausserhalb-zeitraum.png` | **L4**: Bereich 2 fehlt im Editor, Zeitleiste hat ihn gewählt |
| `c2-02-getrennt.png` | „Bereich 2 2" nach „Hier trennen", kein Chip gedrückt |
| `b1-zwei-hell-getrennt-bogen.png`, `d1-bogen.png` (mit Netz) | getrennte Wege: beide richtig |
| `b1-zwei-hell-bogen.png`, `b1-zwei-bogen.png` | **L3**: nach der Kreuzung sitzt A's Maske an der falschen Stelle |
| `b1-einBereich-hell-bogen.png` | **L2**: ein Bereich, zwei Tipps: A verliert die Maske |
| `d2-bogen.png` | zwei TEILE in einem Bereich: beide richtig |
| `f1-muster-bogen.png`, `f1-bogen.png` | Radial bleibt an der Szene; auf einfarbigem Grund wandert er mit (**L9**) |

## Anhang B – Messwerte (Auszug, volles Protokoll in `protokoll.log`)

Pixel im Kern; A = grau erwartet, B = belichtet erwartet.

| Lauf | t (s) | A | B |
|------|-------|---|---|
| `zwei-hell-getrennt` | 0,05 / 1,65 / 3,45 / 3,65 | 93 / 93 / 93 / **51,110,54** | 253,255,142 durchgehend |
| `einBereich-hell` | 0,05 / 0,45 / 2,05 | 93 / **51,110,56** / **51,110,54** | 182…184 (grau) durchgehend |
| `D2` (zwei Teile) | 0,05 / 1,65 / 3,25 | 93 / 93 / 93 | 184 durchgehend |
| `zwei-hell` (kreuzend) | 1,45 / 1,85 / 3,05 | 95 / **73,156,78** / **51,110,54** | 253,255,142 (Geist von A links von B) |
| `nurA-hell` (kreuzend) | 1,45 / 1,85 / 3,05 | 94 / **51,110,54** / **51,110,54** | 229,180,86 (unverändert) |
| `D1-150` (mit Netz, kreuzend) | 1,45 / 2,05 / 3,05 | 94 / **51,110,54** / **51,110,54** | 253,255,142 |

Synthetisch (`messung/ausgabe-zzBereicheMessung.txt`; `folgeTeile`, Farbflutung mit Toleranz 25, 320×180, A 4 Punkte je Bild nach rechts, B 2 Punkte je Bild nach unten, 50 Bilder, Schlüsselabstand 4; Höchstwert der Deckung 0,83 wegen der weichen Kante):

- A verdeckt (B oben): Deckung 0,83 bis Bild 19, 0,84 0,80 0,77 0,78 0,77 0,68 0,51 0,37 0,26 0,17 0,09 0,06 0,04 0,02 0,01, ab Bild 35 0,00.
- B verdeckt (A oben, B wird verfolgt): 0,83 bis Bild 20, dann 0,80 0,76 0,80 0,73 0,57 0,31 0,17, ab Bild 28 höchstens 0,05, 0,00 ab Bild 39.
- A oben (A verdeckt B, A wird verfolgt): 0,83 durchgehend.
- Zwei Teile, getrennte Wege: A und B je 0,83 durchgehend.
- Ein Teil, zwei Punkte, getrennte Wege: Anteil von A gedeckt 1,00 (Bild 0–4), 0,95 0,81 0,67 0,55 0,44 0,34 0,24 0,16 0,09 0,03, 0,00 ab Bild 15; B 1,00 durchgehend.

## Anhang C – Dateien

- `pruef/gemeinsam.ts` – Film, Bedienhilfen, Abtastung; `pruef/a*.spec.ts … f1.spec.ts` – die Läufe (`cd pruef && npx playwright test -c pw.config.ts <name>`;
  Umgebungsvariablen `SZENARIO`, `PALETTE=hell`, `GETRENNT=1` für `b1`, `BX`/`EIN` für `d1`).
- `protokoll.log` – alle Zeilen der Läufe; `shots/` – Bilder.
- `messung/zzBereicheMessung.test.ts.txt`, `zzDiag.test.ts.txt`, `zzRand.test.ts.txt` – vitest-Messungen
  (zum Ausführen als `src/modules/video/zz….test.ts` ablegen, danach wieder entfernen; sie gehören nicht ins Repo).
- `maskenSpuren-basis.out` – Ausgangslage der bestehenden Maskentests.
