# Entwurf: Flüssiges Wischen durch die Zeitleiste – der Wischspeicher

Stand: Entwurf, noch kein Produktivcode. Arbeitsbaum `wt-wisch` (Zweig `v-wisch`, Ausgangspunkt d786eab).
Grundlage: `messung-vorher.md` (alle Zahlen darin sind mit dem Messgerüst unter `mess/` erzeugt und wiederholbar).

Wunsch des Anwenders, wörtlich: „Beim Ziehen mit dem Finger durch die Zeitleiste sollte das live Video flüssiger mitlaufen
(das Bild anzeigen, auf dem der Finger gerade liegt) und dabei auch die Masken anzeigen."

## 0. Kurzfassung

**Was gemessen wurde** (Editor, 1280 × 720, 25 Bilder/s, 12 s, echte Zeigerereignisse mit 60 Hz, Sprünge zusätzlich auf 120 und 250 ms verzögert):

- Das Bild unter dem Finger kommt im Mittel 6–126 Filmbilder zu spät (grösster Wert 204), das Bild ist 120–580 ms alt, es wechselt 2–11-mal je Sekunde.
- Die bearbeitete Vorschau zeichnet während eines durchgehenden Zugs GAR NICHT (0,0 Zeichnungen/s in allen Bedingungen): An jedem Bildrückruf steht das Video schon wieder im nächsten Sprung (`readyState` 1), und `zeichnen()` bricht dann ab.
  Der Anwender sieht beim Wischen das rohe Video – ohne Bearbeitung und ohne Masken. Masken erscheinen erst, wenn der Finger ruht (0 % der Takte beim Wischen, 100 % der gezeichneten in der Ruhe).
- Die Sprünge selbst sind nicht zu retten: 87–233 ms je Sprung schon ohne künstliche Verzögerung, bei langem GOP bis 584 ms.

**Was gebaut wird.**

1. Ein **Wischspeicher** (`wischspeicher.ts`): kleine, komprimierte Bilder (lange Kante 480, WebP 0,75, JPEG als Ersatz) aller Rasterbilder des Films, gefüllt im Hintergrund über den EINEN Dekodierer (`leserDienst`),
   grob zu fein (jedes 16., 8., 4., 2., 1. Bild), höchstens 24 MB. 300 Bilder wiegen 3,2 MB.
2. Ein **Zeichenweg beim Wischen**: Zeigerereignis → (je Anzeigetakt zusammengefasst) das nächste Speicherbild → dieselbe Zeichnung mit Bearbeitung und Masken wie heute → Leinwand.
   Das Video springt beim Zug NICHT, solange der Speicher deckt; es schärft nach, wenn der Finger ruht, und beim Loslassen kommt das genaue Bild wie bisher.
3. **Bild und Maske gehören zum selben Rasterbild** `k`, bestimmt aus dem Film (`filmRaster`), nicht aus dem `mediaTime` eines Videobildes.
4. Kleine Umbauten, damit das trägt: Stufe `'mitte'` und ein „kleines Bild"-Auftrag im `leserDienst` samt Mitschnitt, ein gemeinsames Ruhetor, Prüfhaken.

**Was erreicht werden soll** (Abschnitt 7, je Kriterium ein Test): bei Sprüngen von 250 ms und gefülltem Speicher ≥ 25 verschiedene Bilder/s beim schnellen Wischen (vorher 2–3),
das Bild höchstens 2 Filmbilder neben dem Finger (vorher Ø 6–126), Bildalter ≤ 50 ms (vorher 120–580), Bearbeitung und Masken in ≥ 90 % der Takte sichtbar (vorher 0 %),
vor dem Füllen nicht schlechter als heute, nach dem Loslassen das genaue Bild innerhalb D + 500 ms, Speicher ≤ 24 MB, kein dritter Dekodierer, Schliessen räumt alles, alle bestehenden Tests grün.

**Was nicht gebaut wird** (Abschnitt 8): ein zweites `<video>`, Wiedergabe mit erhöhter Rate statt Sprüngen, WebCodecs, ein gelockerter `readyState`-Wächter (zeigt in 38–66 % der Takte ein falsches Bild).

---

## 1. Ausgangslage: was heute geschieht und warum es hakt

Der Zug auf der Leiste (`Zeitleiste.tsx`, `onPointerMove` → `onSpielkopf(filmMs, false)`; ebenso `Maskenbahnen.tsx` `onWischen` und die Griffe `onGriffZug`) führt in
`useFilmWiedergabe.setzen` (`filmWiedergabe.ts`) zu `springenZu(video, quelleMs/1000)`: EIN Sprung zugleich, dazwischen nur das neueste Ziel.
`useBearbeiteteVorschau` (`vorschau.ts`) hängt sich an die Bilder, die das Video anzeigt (`requestVideoFrameCallback`, Rückfall `seeked`), und zeichnet sie mit Bearbeitung und Masken (`useVorschauDoc` → `bildDocAn(…, 'vorschau')`).
Dazu ruht die Verfolgung beim Zug (`verfolgungRuhen('zug')`), damit sie Dekodierer und Rechenzeit nicht wegnimmt.

Vier Ursachen, jede mit einer Zahl aus der Messung:

**A. Ein Sprung ist zu langsam, um dem Finger zu folgen.** Je Sprung 87–105 ms (GOP 25) bis 165–233 ms (GOP 100), grösster 584 ms; der Finger legt bei `schnell` 300 Bilder in der Sekunde zurück.
Mit dem Zusammenlegen der Sprünge (`springenZu`) kommen 2–11 Bilder/s an, im Mittel 6–126 Bilder hinter dem Finger, und das erste Bild erscheint erst nach 72–402 ms.
Schneller wird das mit diesem Weg nicht: Das Video ist ein Dekodierer, kein Bildspeicher.

**B. Die Vorschau zeichnet während der Kette nie.** `zeichnen()` bricht bei `element.readyState < 2` ab (`vorschau.ts`). Die Kette setzt im `seeked`-Rückruf sofort den nächsten Sprung; der Bildrückruf kommt ein bis zwei Anzeigetakte
später, und dann steht das Video wieder im Sprung: an allen 275 Bildrückrufen des Videos während der 15 Züge ohne Stillstand (nativ: 168 von 168) stand `readyState` auf 1. Folge: 0,0 Zeichnungen/s, die bearbeitete Leinwand ist in 0 % der Takte zu sehen,
der Anwender sieht das ROHE Video. Den Wächter zu lockern hilft nicht: `drawImage` eines Videos im Sprung liefert das Bild VOR dem Sprung – in 38–66 % der Takte stimmte die Leinwand nicht mit dem gemeldeten Bild überein (Befund 7),
also ein altes Bild mit der Maske des neuen.

**C. Masken gibt es deshalb beim Wischen nie – und wenn, dann nur dort, wo verfolgt wurde, und nur in der Ruhe.** Gemessen: 0 % der Takte beim Wischen, 100 % der gezeichneten Takte bei stehendem Finger.
(Die Verfolgung liest beim Zug nichts: `__verfolger.lesen` bleibt gleich – das ist gewollt und bleibt.)

**D. Beim Loslassen arbeiten zwei Dekodierer gegeneinander, und die Vorschau kann einfrieren.** In 9 von 20 Läufen beginnt der Sprung des Lesers (Standbild, `'vorn'`), während der des sichtbaren Videos noch läuft;
Loslassen→Editor 120–687 ms. Kleinere Zufallsbefunde: ein Lauf mit einer eingefrorenen Vorschau (93 % der Takte dasselbe Bild, 3 s lang, Befund 4) und einer mit falschem Standbild (275 statt 299, Befund 5).

**Rahmenbedingung E. Das Zeichnen ist nicht umsonst.** In der Messumgebung (Software-Grafik) kostet eine Zeichnung 36–230 ms (Abschnitt 4.3 der Messung), auf einem Telefon mit Grafikeinheit einstellig.
Der Entwurf muss das Zeichnen je Anzeigetakt einmal und nie gestaut tun, eine Güte-Leiter behalten, und die Abnahmezahlen der bearbeiteten Vorschau relativ zur gemessenen Zeichenzeit fassen.

**Was das für die Lösung heisst.** Die Bilder müssen beim Wischen AUS EINEM SPEICHER kommen, nicht aus Sprüngen; und die Vorschau muss aus diesem Speicher zeichnen, nicht aus dem Video im Sprung.
Das Video bleibt die Quelle für das scharfe Bild, für das Abspielen und für das Füllen.

---

## 2. Überblick

```
   Finger (Zeitleiste · Maskenbahn · Griff · Kürzen-Griff)
        │ pointermove
        ▼
   onSpielkopf(filmMs, fertig)                       SchnittEditor · VideoEditorSheet (beide gleich)
        │
        ▼
   wiedergabe.wischen(filmMs, fertig)                NEU in filmWiedergabe.ts
        │ Stand + Abschnittsnummer (React, wie bisher)
        │ i = Filmbild unter dem Finger  = filmBilder[floor(filmMs / s)]      ← filmRaster(…).bilder
        ▼
   vorschau.zeigeBild(i) ──► Wischspeicher.hat(k) im Umkreis?
        │                      ja:  vorladen(k)  (createImageBitmap beim Ereignis, Vorrat von 8)
        │                           ein Zeichnen je Anzeigetakt (rAF), das NEUESTE Ziel gewinnt
        │                      nein: springenZu(video) – wie heute (kein Rückschritt)
        ▼
   zeichneBild: Bitmap → Rechengrösse → docFuerBild(nummer, k) → zeichneAnsicht/zeichneAusgabe → Leinwand
        │
        ├─ Finger ruht 100 ms ─► springenZu(video, bildMitte(k)) → scharfes Bild (Blatt: Video; Editor: später das Standbild)
        └─ Loslassen ──────────► wie heute (Stand, Standbild 'vorn', Verfolgung wacht nach 500 ms auf)
                                 + das Speicherbild steht sofort, bis das Standbild da ist

   Füllen (Hintergrund):
   leserDienst – EIN Dekodierer, Vorfahrt  'vorn' (Standbild)  >  'mitte' (Speicher, Stufen 16·8·4)  >  'hinten' (Verfolgung, Speicher Stufen 2·1, abwechselnd)
        Mitschnitt: Liest die Verfolgung ein Bild, das dem Speicher fehlt, gibt der Dienst das kleine Bild nebenbei ab.
```

Neu sind: `wischspeicher.ts`, `ruhetor.ts` (aus `verfolger.ts` herausgelöst), `e2e/wischen.spec.ts` mit Hilfsdatei.
Geändert werden: `leserDienst.ts`, `bilderLesen.ts`, `schnittZustand.ts`, `filmDoc.ts`, `vorschau.ts`, `filmWiedergabe.ts`, `SchnittEditor.tsx`, `VideoEditorSheet.tsx`, `styles.css` (eine Zeile).
Nicht angefasst werden: `Zeitleiste.tsx` (sie meldet schon jede Bewegung), `Maskenbahnen.tsx`, `masken.ts`, `verfolger.ts` (ausser dem herausgelösten Ruhetor), die Bearbeitung (`bild/…`), der Filmbau.

---

## 3. (a) Der Wischspeicher

### 3.1 Was er ist

Ein Speicher kleiner, komprimierter Bilder des **Films** – genauer: aller Rasterbilder `k` in `filmRaster(abschnitte, s, MAX_BILDER_FILM).menge`, also genau der Bilder, die die Zeitleiste zeigen kann und die der Filmbau lesen würde
(höchstens `MAX_BILDER_FILM` = 600). Schlüssel ist das Rasterbild `k` der QUELLE, nicht die Stelle im Film: Teilen, Kürzen und Umstellen ändern, WO im Film ein Quellbild steht, nie, was darauf zu sehen ist –
der Speicher bleibt dabei gültig (derselbe Grund, aus dem alle Spuren in `k` stehen, siehe `raster.ts`). Gelesen wird an `bildMitte(k, s)`, wie Verfolgung, Standbild und Filmbau: Dasselbe `k` ist überall dasselbe Bild.

Nur das rohe Bild, keine Bearbeitung: Regler, Masken und Schnitte ändern den Speicher nie. Bearbeitet wird erst beim Zeichnen.

### 3.2 Format und Grösse

| Wahl | Wert | Warum (gemessen, Abschnitt 4.2/4.5 der Messung) |
|---|---|---|
| lange Kante | **480** (`WISCH_KANTE`), Seitenverhältnis bleibt, gerade Zahlen, nie grösser als das Original (`masse()` aus `bilderLesen.ts`) | 480 × 270: im Prüfvideo 10,5 KB je Bild; 640 brächte 27–45 KB (2,6–3,3×) und gewinnt beim Wischen nichts – scharf wird ohnehin das Video, sobald der Finger ruht. 320 wirkt auf einem 412-Punkte-Schirm schon beim Wischen matschig. |
| Format | **WebP**, Güte 0,75 (`WISCH_GUETE`); wo `toBlob` kein WebP liefert (`blob.type !== 'image/webp'`): **JPEG** 0,8 | WebP ist bei gleicher Güte etwa halb so gross (2,9 gegen 5,2 KB einfach, 8,1 gegen 13,8 KB Textur). Safari kodiert nach unserem Kenntnisstand kein WebP in der Leinwand und gäbe PNG zurück (ein Vielfaches an Bytes; hier nicht prüfbar) – deshalb wird der Typ EINMAL beim Start geprüft (Abschnitt 3.9), nicht jedes Bild. |
| Entpackt | `ImageBitmap` über `createImageBitmap(blob)`, Vorrat von **8** Bildern (`ENTPACKT_MAX`), ≈ 4,2 MB (480 × 270 × 4 = 0,52 MB je Bild) | Entpacken kostet 1,2–5 ms (unter Grafiklast bis 16 ms), `drawImage` 0,2–2 ms. Der Vorversuch (Messung 4.5) zeigt: Entpacken IM Anzeigetakt reicht nicht (35–46 Bilder/s, Bildalter 95 % bis 400 ms); Entpacken beim Zeigerereignis, Zeichnen im Takt schafft den Takt des Schirms (49–59 Bilder/s, Bildalter Ø 9–14 ms). Vorausladen bringt nichts Messbares und bleibt weg. |
| Kein Eintrag im Gerätespeicher | Nur im Arbeitsspeicher, nichts in `IndexedDB`/Dateisystem | „Alles im Gerät": Der Film eines Anwenders gehört nicht in eine dauerhafte Ablage, und das Blatt schliesst ohnehin. |

Die Entscheidung für die kleine Kante hat einen Preis, der offen gesagt wird: Beim Wischen ist das Bild etwas weich (480 → bis 960/1400 Punkte hochgerechnet), sobald der Finger ruht, kommt das scharfe Videobild. Das ist bei Schnittprogrammen mit Proxies Stand der Technik.

### 3.3 Speichergrenze

- **Komprimierte Bilder: 24 MiB** (`WISCH_BUDGET`). Ein Film mit 600 Bildern (`MAX_BILDER_FILM`) braucht im Prüfvideo 6,3 MB, mit feiner Textur bis 10 MB; reines Rauschen wäre der schlimmste Fall (44–81 KB je Bild, 600 Bilder: 26–49 MB) und zwingt zum Verdrängen.
  Bei `navigator.deviceMemory ≤ 2` (wo es das gibt) halb so viel (12 MiB). Zum Vergleich: `SPUR_BUDGET` der Verfolgung 128 MB, Kompositspeicher 16 MB, `NETZ_BUDGET` 16 MB.
- **Entpackt: 8 Bilder ≈ 4,2 MB**, als `BytesLru` (`lru.ts`) mit `verdraengt: (k, bild) => bild.close()`.
- Zusammen also höchstens ~28 MB, typisch 4 + 4 MB.
- **Verdrängen, wenn das Budget reisst** – nicht nach „zuletzt gebraucht", sondern nach Nutzen für die Abdeckung: zuerst Bilder, die nicht mehr im Film liegen (nach einem Kürzen), dann die feinste Stufe (ungerade `k`, dann `k` mit Rest 2 zu 4 …),
  innerhalb einer Stufe die am weitesten vom Kopf entfernten. Stufe 0 (jedes 16.) wird nie verdrängt, solange ein feineres Bild da ist. Ein Speicher, der nur das zuletzt Gesehene behält, hätte beim Hin-und-her-Wischen Löcher, wo der Finger vorher nicht war.
- Kein einzelnes Bild über 200 KB: Ein solches Bild wird verworfen (Toleranz-Suche nimmt das Nachbarbild) – Schutz gegen Ausreisser der Kodierung.
- Hält der Vorrat der Verfolgung (`SPUR_BUDGET`) an (`SPEICHER_VOLL`), gibt der Wischspeicher seine entpackten Bilder frei (Abschnitt 3.9).

### 3.4 Reihenfolge des Füllens: grob zu fein

Stufen nach Rasterbild `k` (absolut, damit sie sich beim Kürzen und Verschieben nicht ändern):

```
schritt = 2^ceil(log2(0,5 s / s)), begrenzt auf 4 … 32        bei 25/s: 16 · 30/s: 16 · 60/s: 32 · 10/s: 8
Stufe 0: k % schritt == 0            ─ bei 25/s jedes 16. Bild (0,64 s)   ≈ 19 Bilder je 300
Stufe 1: k % (schritt/2) == 0        ─ jedes 8.                          + 19
Stufe 2: k % (schritt/4) == 0        ─ jedes 4.                          + 38
Stufe 3: k % (schritt/8) == 0        ─ jedes 2.                          + 75
Stufe 4: alle übrigen                ─ jedes Bild                        + 150
```

Innerhalb einer Stufe aufsteigend (Vorwärtssprünge im selben Schlüsselbildabschnitt sind am billigsten), angefangen bei der Stelle, an der der Anwender steht (`kopf(k)`), danach von vorn bis dorthin.
Jedes Bild wird genau EINMAL gelesen – die Stufen kosten keinen einzigen Sprung mehr als ein Durchlauf (gemessen sogar weniger bei langem GOP: 42 s gegen 57 s).

Gemessene Füllzeit (Messung 4.4, nativ, 300 Bilder; bei Sprüngen von 250 ms rechne man je Bild 250 ms dazu):

| GOP | Stufe 0 (19) | Stufe 1 (38) | Stufe 2 (75) | Stufe 3 (150) | alles (300) |
|---|---|---|---|---|---|
| 25 | 1,0–1,1 s | 1,9–2,2 s | 3,8–4,3 s | 7,6–8,7 s | 15–18 s |
| 100 | 2,0–2,4 s | 4,2–4,6 s | 8,4–10,5 s | 20–21 s | 42–44 s |

Was die Abdeckung bedeutet: Nach Stufe 1 liegt zu jeder Stelle ein Bild höchstens 4 Filmbilder entfernt, nach Stufe 2 höchstens 2, nach Stufe 3 höchstens 1, danach 0. „Früh ungefähr richtig" heisst: nach 2–5 s ±4 Bilder (0,16 s), nach 4–10 s ±2.

**Der Film beginnt mit höchstens fünf Sekunden** (`anfangen(min(dauer, 5000))`): Beim Öffnen sind es 125 Bilder, der Speicher ist nach 7–25 s komplett; jeder Abschnitt, der dazukommt, reiht seine neuen Bilder ein (`setzen` rechnet den Unterschied, wie der Verfolger).

### 3.5 Wer füllt: der `leserDienst`, kein zusätzlicher Dekodierer

Der Wischspeicher öffnet kein eigenes `<video>`. Er stellt Aufträge an den Dienst, der Editor, Verfolgung und Filmbau schon bedient (`leserDienst.ts`). Drei Änderungen dort:

1. **Prioritäten `'vorn' | 'mitte' | 'hinten'`.** `pumpen()` nimmt den ersten `'vorn'`, sonst den ersten `'mitte'`, sonst den vordersten. `'vorn'` bleibt dem Editor (Standbild); ein laufender Sprung wird nicht abgebrochen (20–300 ms).
2. **Ein „kleines Bild"-Auftrag.** `holen(ms, prio, { klein: { kante, typ, guete } })` liefert `Lesung.klein: Promise<Blob | null>`. Im Leser (`bilderLesen.ts`) kommt dafür `kleinAn(zeitMs, wunsch, abbruch)` dazu:
   springen (oder nicht, wenn das Video schon dort steht – wie beim zweiten `bildAn` an derselben Stelle), in eine EIGENE kleine Leinwand zeichnen (`imageSmoothingQuality = 'high'`, kein `getImageData`) und `toBlob` aufrufen.
   `toBlob` kopiert die Bildpunkte beim Aufruf; die Leinwand ist sofort wieder frei, der Dekodierer wartet nicht auf die Kodierung (gemessen 50 ms je Bild statt 60 ms). Höchstens zwei Kodierungen zugleich offen, sonst wartet der Dienst – Schutz vor einem Rückstau im Arbeitsspeicher und auf Browsern, in denen die Kodierung auf dem Hauptfaden läuft.
3. **Mitschnitt.** `leser.mitschnittSetzen({ wunsch, braucht(k), ablegen(k, blob) })`. Nach jeder Lesung eines anderen Auftrags (`voll`/`grau` der Verfolgung, Standbild), bei der das Video schon an `bildMitte(k)` steht, fragt der Dienst `braucht(k)`;
   fehlt dem Speicher das Bild, zeichnet er es verkleinert aus demselben Stand des Videos (kein zweiter Sprung, 0,3 ms) und gibt die Kodierung nebenher ab. Die Verfolgung liest ihre Bilder ohnehin, und jedes davon ist ein Bild weniger zu füllen.

**Vorrang gegenüber der Verfolgung – festgelegt, mit Begründung.**

- Die groben Stufen 0–2 (75 Bilder, 4–10 s) laufen als `'mitte'`: mit Vorfahrt vor der Verfolgung. Denn wer den Editor aufmacht und wischt, will sofort „ungefähr richtig" – dafür reichen 75 Bilder –, und die Verfolgung dauert je nach Verfahren eine halbe Minute (Tipp-Maske über 300 Bilder: 27–33 s in der Messung) bis mehrere Minuten (Masken mit Modell).
- Die feinen Stufen 3–4 (225 Bilder) laufen als `'hinten'`: abwechselnd mit der Verfolgung (jeder wartet auf seine eigene Lesung und reiht sich dann wieder hinten ein – die Warteschlange wechselt von selbst). Sie schaffen „±1 Bild" und „genau"; das ist wichtig, aber nie wichtiger als eine Maske, die der Anwender gerade erwartet.
- Die Verfolgung von Stufe 0 (`vorziehen(k)`: dem Anwender fehlt die Maske an seinem Bild) bleibt eine Entscheidung INNERHALB der Verfolgung und wird durch den Speicher nicht berührt.
- Abnahme: die Verfolgung wird durch das Füllen um höchstens 50 % länger (Kriterium K13).

### 3.6 Ruhegründe

Der Speicher hat sein eigenes Tor (`Ruhetor`, aus `verfolger.ts` in `ruhetor.ts` herausgelöst; Verfolger und Wischspeicher benutzen dieselbe Klasse). Gründe – und warum:

| Grund | wann | warum |
|---|---|---|
| `'wiedergabe'` | Der Film spielt im Blatt oder im Editor | Die Wiedergabe braucht Dekodierer und Rechenzeit; das Füllen daneben machte sie ruckelig (Güte-Leiter). |
| `'zug'` | Finger auf der Leiste, den Bahnen, den Griffen – und wie bei der Verfolgung ein Finger auf Bühne und Werkzeugen des Editors (`'finger'`) | Beim Zug zeichnet der Hauptfaden jeden Takt; das Standbild beim Loslassen braucht den Dekodierer SOFORT – ein Sprung des Füllens, der gerade läuft, hielte es bis zu 300 ms auf (`'vorn'` wartet immer auf den laufenden Sprung). |
| `'bauen'` | Der Filmbau läuft (`starten()` im Blatt) | Der Filmbau schliesst den Leser (`schnitt.leser.schliessen()`) und liest mit EINEM eigenen Dekodierer. Ein Auftrag des Speichers öffnete den Leser sofort wieder – derselbe Fehler, den die Verfolgung mit `'bauen'` schon einmal hatte. |
| `'verborgen'` | `document.hidden` | Nichts tun, was niemand sieht (Akku). |
| `'speicher'` | Die Verfolgung meldet `SPEICHER_VOLL`, oder `performance.memory` (wo es das gibt) steht über 80 % der Grenze | Siehe 3.9. |

Nach dem letzten Grund geht es 300 ms später weiter (`WEITER_MS`, wie bei der Verfolgung). Aufrufer rufen nicht mehr `spuren.verfolgungRuhen(…)`, sondern `schnitt.ruhen(grund, an)`, das an beide verteilt (Verfolgung und Speicher) –
das sind die heutigen Aufrufstellen in `SchnittEditor.tsx` (`'zug'`, `'wiedergabe'`, `'finger'`) und `VideoEditorSheet.tsx` (`'wiedergabe'`, `'bau'`).

### 3.7 Beginn, Ende, Schliessen

- **Beginn:** beim ersten `setzen(filmBilder)` mit Bildern (Blatt offen, Abschnitte gesetzt) – nicht im Konstruktor (StrictMode, wie `Verfolger.anlaufen`). Angelegt wird er in `useSchnitt` im Effekt zusammen mit dem Verfolger und mit demselben Schlüssel wie `leser` (`[datei, kante, schrittMs]`).
  Erst wird das Format geprüft (Abschnitt 3.9), dann die Schleife gestartet. Der Dekodierer ist zu dem Zeitpunkt meist schon offen (Standbild des Editors).
- **Ende des Füllens:** `stand().fertig`; der Dienst gibt den Dekodierer nach 30 s Leerlauf von selbst frei (`LEERLAUF_MS`).
- **Schliessen** (`schliessen()`): Schleife beenden (`generation` hochzählen), laufende und wartende Aufträge abbrechen (`AbbruchError` wird leise geschluckt), alle `ImageBitmap` `close()`, beide Vorräte leeren,
  `leser.mitschnittSetzen(null)`, Horcher auf `visibilitychange` abmelden. Aufgerufen im Aufräumen des Effekts in `useSchnitt` (Blatt zu, Grösse oder Bildrate gewechselt, `alleVerwerfen`). Ein späteres `setzen` fängt von vorn an (StrictMode führt Aufräumen und Effekt doppelt aus).
  Prüfbar: `window.__wisch.bilder/bytes/entpackt` = 0 nach dem Schliessen (K10).

### 3.8 Ungültigkeit

| Ändert sich … | Folge |
|---|---|
| Datei (`datei`) | neuer `leser`, neuer Speicher – das Blatt baut sich ohnehin neu auf. |
| Bildrate (`schrittMs`) | Das Raster ändert sich, `k` bedeutet ein anderes Bild: neuer Speicher. (Die Masken rücken dabei mit, `maskenUmrastern` – hier ist nichts zu retten.) |
| Rechengrösse (`kante`) | Der Speicher hängt nicht daran (kleine Leinwand, eigene Kante), aber `leser` ist an `kante` gebunden und wird neu gemacht. Der Speicher zieht deshalb mit um; die Grösse lässt sich nur wählen, solange nichts eingestellt ist – der Verlust ist klein. Wer das vermeiden will, reicht den Leser als Funktion herein; nicht nötig. |
| Abschnitte (Teilen, Kürzen, Verschieben, Entfernen, Dazu) | bleibt gültig. `setzen(filmBilder)` rechnet den Unterschied: neue Bilder der Liste hinten anstellen, nicht mehr gebrauchte werden zuerst verdrängt, wenn das Budget reisst. |
| Bearbeitung, Masken | bleibt gültig (nur rohe Bilder). |

### 3.9 Wenn etwas fehlt oder knapp wird

- **`toBlob` fehlt oder liefert `null`** (sehr alte Browser, Erschöpfung): `verfuegbar = false`, `zeigeBild` antwortet immer `'fehlt'`, der Zug läuft wie heute. Kein Fehlerdialog, kein Hinweis – der Anwender hat nichts verloren, nur etwas nicht gewonnen. Drei aufeinanderfolgende Kodierfehler genügen, die Schleife endet; ein einzelner lässt nur dieses Bild aus.
- **Kein WebP in der Leinwand** (Safari): beim Start wird EINE 8 × 8-Leinwand kodiert; `blob.type !== 'image/webp'` → JPEG 0,8. Liefert auch das nicht JPEG (PNG), ist der Speicher nicht verfügbar (PNG wäre ein Vielfaches so gross).
- **`createImageBitmap` fehlt** (Safari < 15): Rückfall auf ein `HTMLImageElement` (`URL.createObjectURL`, `img.decode()`, danach `revokeObjectURL`), gleicher Vorrat von 8. Langsamer, aber dasselbe Ergebnis.
- **`createImageBitmap` schlägt für ein Bild fehl** (verdorben): der Eintrag wird verworfen und das Bild später noch einmal gelesen; zweimal → ausgelassen.
- **Speicher knapp:** Budget-Verdrängung (3.3); ausserdem bei `SPEICHER_VOLL` der Verfolgung, bei `pagehide`/Seiteneinfrieren (`freeze`) und bei `performance.memory` > 80 % (Chromium): entpackten Vorrat leeren, Füllen ruhen lassen (`'speicher'`), Budget halbieren. Auf iOS gibt es keine solche Meldung – dort zählt die kleine Gesamtgrösse.
- **Die Kodierung läuft auf dem Hauptfaden** (manche Browser): höchstens zwei offen (3.5), zwischen zwei Aufträgen `luftholen()` wie in `maskenVerfolgen.ts`.

### 3.10 Schnittstelle (Skizze)

```ts
// leserDienst.ts
export type Prioritaet = 'vorn' | 'mitte' | 'hinten';
export interface KleinWunsch { readonly kante: number; readonly typ: string; readonly guete: number }
export interface Lesung {
  readonly voll: ImageData | null;
  readonly grau: Grau | null;
  /** Die Kodierung läuft nebenher – der Dekodierer ist schon frei, wenn der Auftrag fertig ist. */
  readonly klein: Promise<Blob | null> | null;
}
export interface Mitschnitt {
  readonly wunsch: KleinWunsch;
  braucht(k: number): boolean;
  ablegen(k: number, blob: Blob): void;
}
// Leserdienst: mitschnittSetzen(m: Mitschnitt | null): void;  holen(ms, prio, { voll?, grau?, klein?, abbruch? })

// bilderLesen.ts – VideoLeser
kleinAn(zeitMs: number, wunsch: KleinWunsch, abbruch?: AbortSignal): Promise<{ readonly kodiert: Promise<Blob | null> }>;

// wischspeicher.ts
export const WISCH_KANTE = 480, WISCH_GUETE = 0.75, WISCH_BUDGET = 24 * 1024 * 1024, ENTPACKT_MAX = 8;
export type WischRuhe = 'zug' | 'wiedergabe' | 'verborgen' | 'bauen' | 'speicher';
export interface WischStand {
  readonly version: number;
  readonly bilder: number; readonly von: number;        // gespeichert / im Film gebraucht
  readonly bytes: number; readonly stufe: number;       // 0…4: bis zu welcher Stufe alles da ist (-1: noch nichts)
  readonly fertig: boolean; readonly verfuegbar: boolean;
}
export class Wischspeicher {
  constructor(optionen: { leser: Leserdienst; s: number; kante?: number; budget?: number });
  setzen(filmBilder: readonly Filmbild[]): void;        // bei JEDER Änderung der Abschnitte – rechnet den Unterschied
  kopf(k: number): void;                                // wo der Anwender steht – für die Reihenfolge
  ruhen(grund: WischRuhe, an: boolean): void;
  hat(k: number): boolean;
  vorladen(k: number): void;                            // entpackt beim Zeigerereignis
  entpackt(k: number): ImageBitmap | null;              // synchron, nur aus dem Vorrat
  bild(k: number): Promise<ImageBitmap | null>;         // wartet auf das Entpacken
  abonnieren(fn: () => void): () => void;  stand(): WischStand;   // für useSyncExternalStore, höchstens 4 Meldungen je Sekunde
  schliessen(): void;
}
// reine Funktionen (mit Tests): grobSchritt(s), stufeVon(k, schritt), naechstesFehlendes(…), naechstesBild(filmBilder, i, hat, toleranz)
```

---

## 4. (b) Der Zeichenweg beim Wischen

### 4.1 Ablauf

1. **Zeigerereignis.** `Zeitleiste` meldet `onSpielkopf(filmMs, false)` (Maskenbahnen: `onWischen`, Griffe: `onGriffZug`). Der Browser fasst Ereignisse je Anzeigetakt zusammen.
2. **`wiedergabe.wischen(filmMs, false)`** (neu, `filmWiedergabe.ts`): setzt Stand und Abschnittsnummer wie `setzen` (React), bestimmt das Filmbild `i = min(n − 1, floor(filmMs / s + ε))`, `{ nummer, k } = filmBilder[i]`, und fragt `vorschau.zeigeBild(i)`.
3. **`zeigeBild(i)`** sucht im Umkreis von `TOLERANZ` Filmbildern (= `schritt/2`, bei 25/s 8) das nächste Bild, das der Speicher hat (`naechstesBild`), und sagt `'genau'` (Abstand 0), `'genaehert'` (Abstand ≤ Toleranz) oder `'fehlt'`.
   Bei `'genau'`/`'genaehert'` ruft es `speicher.vorladen(k')` (entpackt jetzt – beim Ereignis, nicht im Takt) und merkt sich das Ziel; `requestAnimationFrame` wird EINMAL je Takt angemeldet, nie gestapelt.
   Bei `'fehlt'` springt das Video wie heute (`springenZu`) – kein Rückschritt, solange der Speicher nicht deckt.
4. **Im Anzeigetakt** zeichnet `zeichneBild` das NEUESTE Ziel: das Bitmap aus dem Vorrat (ist es noch nicht entpackt: auf das Entpacken warten und zeichnen, falls das Ziel dann noch das neueste ist; sonst verwerfen);
   `q.stift.drawImage(bild, 0, 0, mass.b, mass.h)` auf die Rechengrösse hochrechnen; `quelleVeraendert(q.flaeche)`; das Dokument `docFuerBild(nummer', k')`; `zeichneAnsicht`/`zeichneAusgabe` mit `fluechtig: true`; Prüfhaken; Güte-Leiter.
   Was `bildDocAn(…, 'vorschau')` als Ersatz nimmt (veraltete Kette, nur eine Seite bekannt, grob), nimmt die Zeichnung unverändert; fehlt dem Dokument eine Maske (`fehlend`), wird `spuren.vorziehen(k')` gerufen – beim Zug höchstens alle 150 ms (Abschnitt 6).
   Ohne Bearbeitung und ohne Masken (`docUnberuehrt`) wird das Speicherbild direkt in die Leinwand gezeichnet (Blatt: mit `einpassen`), die Leinwand ist auch dann sichtbar – das rohe Video darunter ist beim Zug ja gerade nicht aktuell.
5. **Ruht der Finger 100 ms** (`RUHE_FINGER_MS`), springt das Video auf `bildMitte(k)/1000` (Verfeinerung). Sobald das scharfe Bild da ist, zeichnet die Vorschau es (Regel „nur näher", 4.5); ohne Bearbeitung und Masken wird die Leinwand wieder verborgen und das rohe, scharfe Video zeigt sich.
6. **Loslassen** (`fertig = true`): wie heute `setzen` (Abschnitt 4.4).

### 4.2 Welches Bild, welche Bearbeitung – `k`, `filmRaster`, `bildMitte`

Die jüngsten Fehler an dieser Stelle (`filmDoc.ts`: das Rasterbild aus dem `mediaTime` eines Videobildes zu raten und dabei jedes dritte Bild einer 30er-Quelle die Maske des vorigen zu geben) haben EINE Ursache: Der Weg von der Fingerstelle zum Rasterbild ging über das Video.
Im Speicherweg gibt es diesen Umweg nicht:

- Das Filmbild unter dem Finger kommt aus `filmRaster(abschnitte, s, MAX_BILDER_FILM).bilder[i]` – `{ stelle, nummer, k }` – derselben Liste, aus der der Filmbau die Bilder holt (`abtasten` mit `mitte`). `useSchnitt` hält sie als `useMemo` (heute wird nur `.menge` in einem Effekt gebildet) und reicht sie als `schnitt.filmBilder` weiter.
  Dasselbe gilt für Abschnitte, deren Kanten nicht auf dem Raster liegen: Die Liste ist der Massstab, nicht eine zweite Rechnung.
- Das Speicherbild `k'` wird an `bildMitte(k', s)` gelesen, genau wie Verfolgung, Standbild und Filmbau lesen. **Bild und Dokument gehören zum selben `k'`**: `docFuerBild(nummer', k')` ruft `bildDocAn(abschnitte[nummer'].doc, masken, spuren, k', 'vorschau', rahmen, speicher)`
  mit demselben `k'` – nicht mit dem Finger-`k`. Sonst läge die Maske des Fingerbildes über dem Bild daneben, und ein bewegter Gegenstand wäre ausserhalb der Maske.
- `nummer'` ist die Abschnittsnummer des gezeigten FILMBILDES, nicht die des Video-`mediaTime`. Kommt dasselbe `k` in zwei Abschnitten vor (derselbe Ausschnitt zweimal), ist entscheidend, in welchem das Filmbild liegt.
  Darum sucht `naechstesBild` im Raum der Filmbilder (`i ± d`), nicht im Raum der Rasterbilder: Es liefert den Index des Filmbildes, dessen `k` der Speicher hat.
- **Loslassen und Nachschärfen springen auf `bildMitte(k)`**, nicht auf `ort.quelleMs`. `filmZuQuelle(…).quelleMs` ist die Stelle im Film umgerechnet, nicht die Mitte des Rasterbildes; bei einer Quelle mit anderer Bildrate als der Film landet ein Sprung dorthin
  leicht auf dem Nachbarbild, und das scharfe Bild spränge gegenüber dem weichen um ein Bild. Mit `bildMitte(k)` stimmen Speicher, Verfeinerung, Standbild und Filmbau überein.
  (Dass `k = ceil(mediaTime/s − ½ − ε)` für das Bild, das ein Sprung auf `bildMitte(k)` liefert, wieder `k` ergibt, gilt für jede Quell- und Filmrate; ein Test sichert das, siehe 9.)

### 4.3 Was mit dem `<video>` während des Zugs geschieht

- Es bleibt angezeigt (`ist-verdeckt` = durchsichtig, nicht `display: none`): Versteckt meldet es keine Bilder mehr, und es ist der Rückfall (`'fehlt'`, zu langsames Gerät).
- Es **springt nicht**, solange der Speicher deckt. Ein laufender Sprung wird zu Ende geführt (kein Abbrechen, sonst steht das Video im Nichts); `sprungVergessen` verwirft nur das wartende Ziel.
- Es springt, wenn (a) der Speicher nicht deckt (`'fehlt'`) – genau das heutige Verhalten, (b) der Finger 100 ms ruht (Nachschärfen), (c) losgelassen wird (Blatt; im Editor nicht, siehe 4.4).
- Während der Zug den Speicher zeigt, liegen alle Sprünge des Videos nur noch bei Lücken und beim Nachschärfen: Bei vollem Speicher sind es 0 Sprünge/s statt 2–11.

### 4.4 Loslassen: das genaue Bild

1. Sofort (derselbe Takt): `wischen(filmMs, true)` zeigt zuerst das Speicherbild des Loslassbildes (`zeigeBild(i)`, ±0…2 Bilder je nach Füllstand) und tut dann, was `setzen` heute tut (Stand, Abschnitt, Pause). Die Überlagerung bleibt, bis das Standbild da ist – wie heute (`ueberlagert = spielt || zieht || !bereit`).
2. `ankommen(filmMs)` setzt `standSetzen` – unverändert; das Standbild wird über den Dienst mit `'vorn'` gelesen, ab der Stelle `bildMitte(bildIndex(standMs))`.
3. **Im Editor springt das sichtbare Video beim Loslassen NICHT mehr.** Heute laufen der Sprung des Videos und der des Lesers gleichzeitig (9 von 20 Läufen), obwohl der Editor nach dem Loslassen nie das Video zeigt, sondern sein Standbild. Ein Dekodierer weniger im Wettlauf verkürzt erwartungsgemäss die Zeit bis zum Standbild (K5 belegt es).
   Das Video bleibt an der Stelle des letzten Sprungs; vor dem nächsten Abspielen setzt `abspielen()` ohnehin selbst `currentTime`. `useFilmWiedergabe` bekommt dafür die Option `springenBeimLoslassen` (Editor `false`, Blatt `true`). Im Blatt (kein Standbild) springt das Video auf `bildMitte(k)` und schärft nach.
4. Die Zeit bis zum scharfen Standbild soll nicht schlechter werden als heute (Kriterium K5: ≤ D + 500 ms bei GOP 25, ≤ D + 800 ms bei GOP 100; heute 120–687 ms). Das Standbild für den Editor muss ein Bild in Rechengrösse sein (Bearbeitung!), das weiche Speicherbild taugt dafür nicht –
   deshalb bleibt die Überlagerung mit dem weichen Bild stehen, bis es da ist. Für den Anwender steht das richtige Bild beim Loslassen, und es wird 100–700 ms später scharf.
5. Die falsche-Standbild-Stelle (Befund 5: 1 von 20 Läufen zeigte das Bild 275 statt 299) wird im selben Zug geprüft: Der Test K5 vergleicht den Strichcode des Standbildes mit dem Bild der Loslassstelle in jedem Lauf.

### 4.5 Reihenfolge und Flackern: nur zeichnen, was näher ist

Zwei Quellen zeichnen in dieselbe Leinwand: der Speicher (Takt) und das Video (Bildrückruf nach einem Sprung: Verfeinerung, Lücke, Abspielen). Ohne Regel könnte ein spät ankommender Sprung des Videos das Bild eines längst überholten Ziels über ein neueres Speicherbild legen
(und der `readyState`-Wächter allein schützt davor nicht: Der späte Sprung IST fertig).

Regel: Die Vorschau merkt sich das Ziel (Filmbild-Index `i`) und den Abstand des gezeigten Bildes zu ihm. Eine Zeichnung aus dem Video für das Filmbild `j` wird verworfen, wenn `|j − i| > |gezeigt − i|` –
es wäre weiter vom Finger weg als das, was schon steht. Beim Abspielen und bei ruhendem Finger gibt es kein Ziel, dann gilt die Regel nicht. Ein neues Ziel rechnet den Abstand des gezeigten Bildes neu.
Damit gilt auch beim Nachschärfen: Das scharfe Bild erscheint, wenn es ankommt und das Ziel noch dasselbe ist; ist der Finger inzwischen weitergezogen, wird es verworfen.

Zweite Regel, gegen das Einfrieren (Befund 4): Liegt das gezeigte Bild weiter als `TOLERANZ` Filmbilder vom Ziel – der Speicher deckt nicht, das Video hinkt –, wird die Leinwand verborgen (`zeigen(false)`), und das rohe Video zeigt, was es hat. Ein Bild, das nicht mehr zum Finger gehört, bleibt nie stehen; das ist der Stand vor dem Füllen, nur ohne das Stehenbleiben.

`docFuer(quelleMs)` liefert dafür künftig `{ doc, nummer, k, fehlend }` (heute nur `doc`); `docFuerBild(nummer, k)` liefert dasselbe aus dem Speicherweg.

### 4.6 Qualität: vom kleinen Bild zum Bild der Vorschau, Güte-Leiter

- **Hochskalieren:** Das entpackte Bild (480 px) wird mit `imageSmoothingQuality = 'high'` auf die Rechengrösse (640/960/1280) in dieselbe Leinwand `q.flaeche` gezeichnet, in die heute das Video gezeichnet wird – ab da ist alles unverändert (Masken liegen in Rechengrösse, `zeichneAnsicht` bekommt `mass.b/mass.h`).
  Nicht das Bitmap direkt als Quelle: Die Zeichenfunktion nimmt an, dass Quelle und Dokumentgrösse übereinstimmen (Verpixelungsstriche lesen `quellSkala`); die 960-Punkte-Leinwand kostet 0,04–2 ms.
- **Zeichenkante:** wie heute `max(512, min(1400, clientWidth · Pixeldichte))`, mal 0,6 in Güte 1.
- **Güte-Leiter beim Wischen** (Erweiterung von `stufen()`; Zeiten relativ zum Anzeigetakt `T = 16,7 ms`):
  - heute bleibt: eine Zeichnung über 120 ms → Güte 1 (kleiner zeichnen);
  - neu: sechs Zeichnungen in Folge über `3 T` (50 ms) → Güte 1; der Median der letzten acht über `12 T` (200 ms) → **Notstufe**: beim Wischen wird das rohe Speicherbild ohne Bearbeitung gezeigt, die bearbeitete Vorschau erscheint, sobald der Finger 100 ms ruht.
    Dazu eine Zeile über der Zeitleiste: „Dieses Gerät ist zum Wischen mit Bearbeitung zu langsam – sie erscheint, sobald du anhältst."
  - Erholung: 90 % der letzten Zeichnungen unter `1,5 T` für 3 s → eine Stufe zurück (wie heute).
  - In der Messumgebung (Software-Grafik, Zeichnung 36–230 ms) würde Güte 1 greifen und bei 960 Punkten mit mehreren Masken die Notstufe. Der Test setzt dafür `window.__vorschau.ohneNotstufe = true` (Abschnitt Anhang A); Güte 1 bleibt wirksam und macht die Zeichnung billiger.
- **Nach dem Füllen** ist das Weiche am Bild der einzige Qualitätsunterschied zu heute; Bearbeitung, Masken, Zuschnitt, Drehung sind unverändert dieselbe Zeichnung.

### 4.7 Wie oft gezeichnet wird

Eine Zeichnung je Anzeigetakt, nie mehr (zusammengefasst über `requestAnimationFrame`), das neueste Ziel gewinnt, eine noch laufende Zeichnung wird nie unterbrochen, sondern die nächste wartet den Takt ab. Das Entpacken geschieht beim Ereignis (Vorversuch: Bildalter Ø 9–14 ms, 95 % ≤ 17 ms).
Die Zeichendauer bestimmt damit die Bildrate (bei 40 ms je Zeichnung 25/s), aber nicht mehr das Bildalter der Sprünge – das war der Sinn von `springenZu`, und er bleibt erhalten: Die Sprungkette wartet nie auf das Zeichnen.

---

## 5. (c) Editor UND Blatt, Bahnen, Griffe

**Ein Speicher, zwei Anzeigen.** Der Speicher gehört `useSchnitt` (zusammen mit `leser`, `spuren`, `speicher`=Kompositspeicher), und `schnitt` wird dem Editor hineingereicht – Blatt und Editor sehen DENSELBEN Speicher
(auch wenn der Editor aufgeht, bleibt er gefüllt; beim Schliessen des Editors steht das Blatt mit gefülltem Speicher da). Gezeichnet wird je Anzeige in ihre Leinwand: Editor `art: 'ansicht'` (`canvas.bild-wiedergabe-bild`), Blatt `art: 'ausgabe'` (`canvas.vg-quelle-bild`, mit `einpassen`).
Beide benutzen `useBearbeiteteVorschau` (neuer Auftrag `speicher`, `filmBilder`, `docFuerBild`) und `useFilmWiedergabe` (neue Methode `wischen`) – keine zweite Fassung. `SchnittZustand` bekommt: `wisch` (der Speicher, `null` bis zum Effekt), `filmBilder`, `ruhen(grund, an)`.

**Änderungen an den Aufrufstellen** (alle klein):

| Stelle | heute | künftig |
|---|---|---|
| `SchnittEditor.tsx`, `onSpielkopf` der Zeitleiste | `wiedergabe.setzen(filmMs); setZieht(!fertig); if (fertig) ankommen(filmMs)` | `wiedergabe.wischen(filmMs, fertig); setZieht(!fertig); if (fertig) ankommen(filmMs)` |
| `SchnittEditor.tsx`, `onGriffZug` der Maskenleiste | `anhalten(); setzen(filmMs); setZieht(!fertig); …` | `anhalten(); wischen(filmMs, fertig); …` – der Griff zeigt mit dem Bild am Rand des Zeitraums (`griffStelle`) sofort, was in der Maske liegt |
| `VideoEditorSheet.tsx`, `onSpielkopf` | `wiedergabe.setzen(filmMs); if (!fertig) return; …` | `wiedergabe.wischen(filmMs, fertig); if (!fertig) return; …` |
| `SchnittEditor.tsx` und `VideoEditorSheet.tsx`, `onKuerzen(…, false)` der Zeitleiste | `springenZu(element, vonMs oder bisMs)` | `wiedergabe.zeigeQuelle(kanteMs)`: Rasterbild der Kante (`von`: `round(vonMs/s)`, `bis`: `round(bisMs/s) − 1`) aus dem Speicher, sonst `springenZu` wie heute. Die Kante liegt nicht zwingend im Film (verlängern!) – dann fehlt das Bild, und es springt das Video. |
| `SchnittEditor.tsx`, `VideoEditorSheet.tsx`: `spuren.verfolgungRuhen('zug' \| 'finger' \| 'wiedergabe' \| 'bau', …)` | nur die Verfolgung | `schnitt.ruhen(…)`: Verfolgung UND Speicher |
| `VideoEditorSheet.tsx`, `starten()` | `spuren.verfolgungRuhen('bau', true); schnitt.leser.schliessen()` | `schnitt.ruhen('bau', true)` VOR `leser.schliessen()` |
| Tasten (Pfeile, „Zur Maske", Zeitraumgriffe mit Tasten) | `onSpielkopf(…, true)` | unverändert (`fertig = true`, Sprung wie bisher) |

**Maskenbahnen-Wischen** braucht keine Änderung: `Zeitleiste` reicht `onSpielkopf` als `onWischen` hinein; ein Zug über die Bahnen ist derselbe Weg wie ein Zug über die Abschnitte.
Der Zug beginnt dort erst nach 6 Punkten Bewegung (Tipp wählt die Maske); das bleibt.

**Die Griffe der Maske** (`Maskenbahnen.tsx`, `Griffe`): `leiste.onGriffZug(filmMs, fertig)` meldet die Mitte des Randbildes INNERHALB des Zeitraums (`griffStelle`). Mit dem Speicher zeigt der Griff beim Ziehen sofort das Bild und – wo die Verfolgung schon ist – die Maske dort. Beim Loslassen `ankommen(filmMs)` wie bisher.

**Anzeigen im Editor** (die Zeile `bild-wiedergabe-zeile` über/unter dem Bild, Priorität von oben nach unten):

1. Notstufe (4.6): „Dieses Gerät ist zum Wischen mit Bearbeitung zu langsam – sie erscheint, sobald du anhältst."
2. Speicher noch nicht gefüllt, beim Wischen, `verfuegbar`: „Die Wischvorschau wird noch vorbereitet (62 %) – bis dahin läuft sie ruckliger." (`stand().bilder/von`)
3. Masken, die an diesem Bild fehlen: „„Motiv" wird an diesem Bild noch verfolgt und erscheint kurz nach dem Loslassen." (Mehrzahl: „… werden … erscheinen …"). Ersetzt die heutige allgemeine Zeile „Wo eine Maske noch verfolgt wird, fehlt sie hier noch." – jetzt mit Namen und für genau dieses Bild (`VorschauStand.fehlend`).

---

## 6. (d) Masken beim Wischen

**Was gezeigt wird.** Für das gezeigte Filmbild `{nummer', k'}` dasselbe wie heute in `bildDocAn(…, 'vorschau')` – nichts Neues in `masken.ts`:

| Stand der Maske an `k'` | beim Wischen |
|---|---|
| Anker, fein | sichtbar |
| grob, veraltet (Kette ersetzt), nur eine Seite bekannt („vorläufig", Form am Anker) | sichtbar (die Bahn zeigt es gestreift/dünn) – das ist der „nächste bekannte Stand", den `'vorschau'` heute schon nimmt |
| verloren (Gegenstand nicht im Bild) | keine Maske, richtig so |
| offen (noch nicht verfolgt, auch keine Nachbarseite) | **fehlt**; das Bild erscheint mit der Bearbeitung des Abschnitts ohne diese Maske; die Zeile nennt die Maske mit Namen (Abschnitt 5) |
| jenseits (hinter `MAX_BILDER_FILM`) | fehlt; die Zeile sagt es wie in `maskenLage` („hinter dem Ende des fertigen Films") |
| abgeschaltet | im Dokument mit `aktiv: false` (wie im Editor) – wirkt nicht |

Es wird **nichts erfunden**: kein Halten der Maske vom nächsten bekannten Bild, keine Schätzung. Eine Maske, die an einer Stelle noch fehlt, gehört dort nicht hin, und ein Bild mit einer Maske an der falschen Stelle wäre schlimmer als eines ohne. (Wo beide Seiten eines Schlüsselbildes bekannt sind, überblendet `bildDocAn` schon.)
Erwogen und verworfen: die Maske vom nächsten verfolgten Bild innerhalb von ±12 Bildern „halten" – beim Wischen fiele das selten auf, aber der Filmbau zeigt dann etwas anderes als die Vorschau. Kann später als bewusste Entscheidung mit sichtbarem Zeichen kommen.

**Darf die Verfolgung beim Zug weiterlaufen?** Nein – `'zug'` bleibt ein Ruhegrund der Verfolgung (und ist jetzt auch einer des Füllens). Begründung:

1. Die Rechnung der Verfolgung läuft auf dem Hauptfaden in Schritten (Bewegungssuche, RLE, Netz-Nachbearbeitung, `luftholen` dazwischen); ein Schritt von 20–100 ms liesse 2–6 Anzeigetakte des Zugs ausfallen, und der Zug zeichnet in jedem Takt.
2. Zeichnen und Verfolgen wollen dieselbe Grafikeinheit (Masken als Texturen, Modelle); Messumgebung: 36–230 ms je Zeichnung – mit einem Modell daneben wäre jede Zeichnung länger.
3. Der Dekodierer wird beim Loslassen für das Standbild gebraucht (`'vorn'` wartet auf den laufenden Sprung der Verfolgung, 20–300 ms).
4. Die Messung zeigt, dass die Ruhe wirkt: `window.__verfolger.lesen` bleibt während des Zugs gleich. Und die Verfolgung gewinnt nichts, wenn sie im Zug weiterrechnet, der Speicher aber den Zug ohne Sprünge trägt: Die Masken, die es beim Loslassen braucht, holt `vorziehen(k)` danach zuerst.

Was sich ändert: `vorziehen(k)` wurde heute bei jeder Zeichnung gerufen, die eine fehlende Maske hat (`filmDoc.ts`) – beim Wischen mit 60 Zeichnungen/s wäre das bei laufendem Fenster bis zu 60-mal `waehlen()`. Künftig: beim Zug höchstens alle 150 ms (`VORZIEHEN_MS`) und einmal beim Loslassen; das Ruhetor der Verfolgung hält die Wahl ohnehin bis 500 ms nach dem Zug fest (BiRefNet: 1 s).
Danach erscheinen die Masken durch den bestehenden Weg (`version` → `neuZeichnen` im Blatt, `nachladbar`/`neuLaden` im Editor) – unverändert.

**Der Speicher und die Verfolgung teilen sich den Dekodierer** (3.5): Stufen 0–2 zuerst, dann abwechselnd; die Verfolgung wird nicht mehr als 50 % länger (K13). Die Verfolgung liest während des Zugs weiterhin nichts (K7).

---

## 7. (e) Abnahmekriterien – je Kriterium ein Test

Gemessen mit dem Messgerüst (`mess/wischen.spec.ts`, Auswertung `auswerten.mjs`) bzw. seinem verschlankten Nachbau als `e2e/wischen.spec.ts` (Video mit Strichcode, Sprungschalter, Zugplan 60 Hz).
„Speicher gefüllt" heisst `window.__wisch.stufe ≥ 3` (jedes 2. Bild) bzw. `fertig`; der Test füllt bei Sprungzeit 0 und schaltet erst danach auf D = 250 ms – Füllen bei 250 ms dauerte 90 s.
Jeder Lauf mit Wiederholungen: Median von 3, Schwellen mit Abstand zu den erwarteten Werten, weil der Rechner geteilt ist (Streuung bis 1,5×).

| Nr. | Kriterium | Ausgangswert (vorher) | Zielwert | Test (`e2e/wischen.spec.ts`) |
|---|---|---|---|---|
| **K1** | **Durchsatz**, roh (keine Bearbeitung): verschiedene Bilder je Sekunde beim Zug, Speicher gefüllt, Sprünge 250 ms, GOP 100 | `schnell` 2–3 /s, `langsam` 2–2,5 /s | **≥ 25 /s** bei `schnell` und `langsam` (erwartet 45–59) | „beim schnellen Wischen wechselt das Bild mindestens 25-mal je Sekunde" |
| **K2** | **Bearbeitung** beim Wischen: bearbeitete Leinwand sichtbar, nicht das rohe Video (Schwarz-Weiss, `ohneNotstufe`) | 0 % der Takte, 0,0 Zeichn./s | **≥ 90 %** der Takte (`schnell`; `langsam` ≥ 95 %), Farbprobe der Leinwand grau in ≥ 95 % dieser Takte; Zeichn./s ≥ max(8, 0,6 · 1000 / Zeichenzeit-Median) (`__vorschau.zeichenMs`) | „beim Wischen ist die Bearbeitung zu sehen, nicht das rohe Video" |
| **K3** | **Verspätung**: Abstand Leinwandbild ↔ Bild unter dem Finger (Filmbilder, je Takt, Bezug letztes Ereignis) und Bildalter; Speicher ≥ Stufe 2 (jedes 4.), D = 250 | Ø 6–126, grösster 204 Bilder; Bildalter Ø 120–580, 95 % bis 843 ms | `langsam` (46 Bilder/s): 95 % ≤ **2 Filmbilder**, grösster ≤ 3; `schnell` und `hinher` (bis 300 Bilder/s), roh: Bildalter 95 % ≤ **50 ms**; Speicher voll: `langsam` 95 % ≤ 1. Deterministisch zusätzlich per Prüfhaken für ALLE Bewegungen: `abs(zielK − letzteK)` ≤ 2 (Stufe 2) / ≤ 1 (Stufe 3) / = 0 (voll) in JEDER Zeichnung. Bearbeitet: Bildalter 95 % ≤ 50 ms + 2 · Zeichenzeit | „das Bild unter dem Finger ist höchstens zwei Filmbilder entfernt" |
| **K4** | **Kein Rückschritt vor dem Füllen**: Speicher leer und angehalten (`__wisch.ruhen('speicher', true)` vor dem Füllen) gegen Speicher aus (`__wisch.aus = true`), im selben Lauf, GOP 100, CPU 6×, D = 250 | (gleich) | Bilder/s ≥ 0,85 ×, Verspätung Ø ≤ 1,25 ×, Bildalter Ø ≤ 1,25 ×, erstes Bild ≤ +50 ms gegenüber „aus"; dazu der bestehende Test „beim Wischen läuft das Video mit" grün (≥ 15 Sprünge, Lücke < 1,5 s) | „vor dem Füllen wischt es wie bisher" |
| **K5** | **Loslassen**: (a) das Bild der Loslassstelle (±2 Filmbilder bei Stufe 2, ±0 voll) steht im ersten Takt nach `pointerup` (≤ 50 ms) auf der Leinwand; (b) der Editor zeigt sein genaues Standbild (Strichcode = Bild der Loslassstelle) binnen **D + 500 ms** (GOP 25) / **D + 800 ms** (GOP 100) | (a) 120–687 ms bis irgendein richtiges Bild; (b) 120–687 ms, in 1 von 20 Läufen das falsche Standbild | (a) ≤ 50 ms; (b) Median ≤ Zielwert und nicht schlechter als der Ausgangswert + 100 ms, und 100 % richtig in 20 Läufen (4 Bewegungen × 5 Bedingungen) | „nach dem Loslassen steht das genaue Bild" |
| **K6** | **Stillstand**: Finger liegt still, danach (a) das Bild der Fingerstelle (Abstand 0 bei vollem Speicher) binnen 50 ms, (b) das scharfe Videobild nach dem Nachschärfen binnen 100 ms + D + 300 ms | 67–892 ms bis zum richtigen Bild | (a) ≤ 50 ms; (b) wie angegeben | „bleibt der Finger liegen, wird das Bild scharf" |
| **K7** | **Masken** beim Wischen: Tipp-Maske (grünes Quadrat entsättigt), Bahn voll | 0 % der Takte beim Wischen | **≥ 90 %** der Takte des Zugs zeigen das entsättigte Quadrat; an einem Bild, an dem die Verfolgung (angehalten) noch nichts hat, ist das Quadrat farbig, und die Zeile nennt die Maske mit Namen; `__verfolger.lesen` bleibt während des Zugs gleich | „beim Wischen ist die Maske zu sehen, wo sie verfolgt wurde" |
| **K8** | **Speicher**: `__wisch.bytes ≤ 24 MiB`; Rauschvideo (jedes Bild neues Zufallsrauschen, 44–81 KB je Bild): Bytes ≤ Budget, weniger als 300 Bilder, Wischen funktioniert weiter (K1 mit ≥ 25 /s); Normalvideo: alle 300 Bilder ≤ 5 MB; `__wisch.entpackt ≤ 8`; JS-Heap-Zuwachs nach vollem Füllen ≤ 40 MB (`performance.memory`, Chromium) | — | wie angegeben | „der Wischspeicher bleibt unter seiner Grenze" |
| **K9** | **Kein zusätzlicher Dekodierer**: Zahl verschiedener Videoelemente, die nach dem Laden der Vorschaubilder während Füllen, Zug und Verfolgung springen oder spielen (Zähler im Sprungschalter, je Element) | 2 (sichtbares Video, Leser) | **≤ 2**; während des Zugs springt das sichtbare Video bei gefülltem Speicher gar nicht (0 Sprünge), der Leser nicht (Füllen ruht) | „das Füllen öffnet keinen dritten Dekodierer" |
| **K10** | **Schliessen räumt alles**: Blatt schliessen (`weg()`), auch nach zweimaligem Öffnen/Schliessen (StrictMode) | — | `__wisch.bilder = bytes = entpackt = 0`; keine Videoelemente mit Quelle; alle `URL.createObjectURL` freigegeben; 2 s danach keine `seeking`-Ereignisse mehr, keine Zähleränderung an `__verfolger` | „Schliessen räumt alles" |
| **K11** | **Bestehende Tests grün**: `e2e/videoSchnitt.spec.ts` (15 Tests, darunter „beim Wischen läuft das Video mit, statt erst am Ende zu springen" und „beim Wischen im Editor zeigt die Vorschau das bearbeitete Bild"), `videoBearbeiten`, `videoFreistellen`, `maskenSpuren`, `videoGif`, `videoSchreiben`, `vorschau`, `standbild` und die ganze vitest-Suite | grün | grün, ohne Schwellen zu lockern. Der Test „beim Wischen läuft das Video mit" prüft das Fallback-Verhalten (`window.__wisch.aus`), ein neuer Zwillings-Test prüft dasselbe mit Speicher („Sprünge des Videos beim Zug nur bei Lücken") | die vorhandenen Dateien |
| **K12** | **Füllen**: Stufe 0 ≤ 3 s, Stufe 2 ≤ 10 s, alles ≤ 40 s (GOP 25, nativ; Messwerte 1,1 / 4,3 / 18 s); GOP 100: Stufe 0 ≤ 6 s, alles ≤ 90 s (2,4 / 42 s) | — | wie angegeben, ab dem Setzen der Abschnitte (Blatt offen, Vorschaubilder da) | „der Wischspeicher ist nach kurzer Zeit grob, dann fein gefüllt" |
| **K13** | **Verfolgung nicht ausgebremst**: Zeit bis „Maske überall verfolgt" (Tipp-Maske, 300 Bilder, 5 Abschnitte) mit laufendem Füllen | 27–33 s | **≤ 1,5 × Ausgangswert + 10 s** (≈ 60 s) | „das Füllen bremst die Verfolgung nur begrenzt" |
| **K14** | **Ausweichen**: ohne `toBlob` und ohne `createImageBitmap` (`addInitScript`); `toBlob` liefert PNG statt WebP | — | kein Fehler, `__wisch.verfuegbar = false`, Verhalten wie K4; bei PNG-Antwort `__wisch.format = 'image/jpeg'` | „ohne Bildkodierung wischt es wie bisher" |
| **K15** | **Einfrieren**: `hinher`, GOP 25, D = 0, je 10 Wiederholungen mit leerem (angehaltenem) und mit gefülltem Speicher | 1 von 2 Läufen: Bildalter Ø 1571 ms | 0 Läufe mit Bildalter Ø > 300 ms (bei leerem Speicher: Bildalter Ø ≤ dem Ausgangswert ohne Einfrieren, 135 ms + 50 %) | „die Vorschau friert beim Wischen nicht ein" |
| **K16** | **vitest**: `wischspeicher.test.ts` (Stufen, Reihenfolge, Verdrängen, Suche im Umkreis, Format, Ruhe, Schliessen), `leserDienst.test.ts` (`'mitte'`, `klein`, Mitschnitt), `filmDoc.test.ts` (`k` zu `bildMitte` für alle Film-/Quellraten), Güte-Leiter und Wischentscheidung als reine Funktionen | — | grün, `tsc`, `prettier`, ganze Suite ~30 s | die genannten Dateien |

**Warum die Verspätung bei schnellem Wischen in Millisekunden steht.** Bei `schnell` legt der Finger 300 Bilder in der Sekunde zurück, also 5 Bilder je Zeigerereignis (60 Hz); „höchstens 2 Bilder" wären 7 ms, weniger als ein Anzeigetakt (16,7 ms) – das kann kein Zeichenweg leisten, auch kein idealer. Was der Speicher leisten muss, ist ein Bild aus der Nähe des Fingers (Prüfhaken: ≤ 2 bei Stufe 2) binnen eines Takts (Bildalter ≤ 50 ms = drei Takte). Die Zahl in Bildern gilt deshalb dort, wo sie etwas misst: bei der langsamen Bewegung (0,8 Bilder je Ereignis).

**Reihenfolge der Kriterien beim Bauen:** K16 und K11 laufen nach jedem Schritt; K1–K3, K5–K7 nach Schritt 6; K4, K8–K10, K12–K15 nach Schritt 7.

---

## 8. (f) Verworfene Alternativen

**Den `readyState`-Wächter lockern** (die kleinste denkbare Änderung: `zeichnen()` auch bei `readyState 1` zeichnen lassen). Gemessen (Messung, Befund 7): Die Vorschau zeichnet dann 8–68 Bilder je Zug, aber die Leinwand zeigt in **38 % (`schnell`, nativ) bis 66 % (`schnell`, 250 ms)** der Takte ein anderes Bild als gemeldet, im Mittel 8–64 Bilder daneben, bis 112.
`drawImage` eines Videos im Sprung liefert das Bild vor dem Sprung – also ein altes Bild mit der Maske des neuen. Schlimmer als nichts.

**Ein zweites `<video>` nur zum Wischen.** Hilft dem Sprung nicht: Jedes `<video>` ist ein Dekodierer mit demselben Sprungaufwand (87–584 ms). Dazu der dritte Dekodierer, den das Design des `leserDienst` ausdrücklich vermeiden will (Telefone haben wenige, iOS hält jedes dekodierte Video als Speicher).

**Wiedergabe mit erhöhter Rate statt Sprüngen** (Wischen als schnelles Vor- und Zurückspielen). Gemessen (Füllversuch): bei 2× kommen 80 % der Bilder an (240 von 300), bei 4× 57 %, bei 8× 30 % – der Anzeigetakt lässt Bilder fallen; rückwärts spielt Chromium nicht (keine negativen Raten), und der Finger ist nicht der Takt der Zeit.
Als **Füllweg** dagegen ist es bemerkenswert: 12 s Film sind in 12 s (1×) vollständig (299 von 300), ohne einen Sprung (Seeks brauchen 15–57 s). Nicht in diesem Entwurf, weil (a) jedes Bild dem Rasterbild `k` zugeordnet werden muss (Quellrate ≠ Filmrate: das Bild, das `bildMitte(k)` zeigt),
(b) iOS Videos im Hintergrund nicht verlässlich spielt und (c) es die Wiedergabe ohne Sicht auf die Seite braucht. Kandidat für eine zweite Runde: nach den groben Stufen der Sprünge das Übrige per Wiedergabe mitschneiden.

**WebCodecs** (`VideoDecoder` direkt). Schneller und genauer als Sprünge und ohne `<video>` – aber: Die App hat einen Schreiber für WebM (`webm.ts`), keinen LESER: Ein Matroska-Leser für WebM und ein MP4-Leser (Kameraaufnahmen, H.264) wären nötig, beides ohne neue Abhängigkeit selbst zu schreiben (die gängigen Bibliotheken sind Abhängigkeiten, die hier nicht gewollt sind);
Decoder-Unterstützung und Schlüsselbildwahl verschieden je Gerät; Safari erst ab 16.4; ein eigener Zugriff auf die GOP-Struktur. Ein Vorhaben für sich, nicht für dieses Thema. Der Speicher ist dafür kein Hindernis: Käme WebCodecs, füllte er ihn billiger.

**Alle Bilder unkomprimiert** (`ImageBitmap` je Rasterbild): 0,52 MB × 300 = 155 MB bei 480 Punkten; bei 600 Bildern 310 MB. Dafür wirft ein Telefon den Reiter weg.

**Die 16 Filmstreifen-Bilder wiederverwenden** (`vorschau` in `VideoEditorSheet`: 96 Punkte, 16 Stück über den Film): zu klein und zu wenige, und sie kommen als Data-URL.

**Die ganze Quelle füllen statt nur die Bilder des Films.** Die Zeitleiste zeigt nur den Film; bei einer langen Quelle (Minuten, 18 000 Rasterbilder bei 30/s) wäre das ein Vielfaches an Zeit und Speicher für Bilder, die nie gezeigt werden. Beim Verlängern eines Abschnitts (Kürzen-Griff nach aussen) fehlt die Kante im Speicher – dort springt das Video wie heute, und die neuen Bilder kommen mit `setzen` dazu, sobald der Zug geendet hat.

**Füllen erst beim ersten Wischen.** Dann wäre das erste Wischen leer, und gerade das ist der Moment, den der Anwender kennt. Begonnen wird mit dem Blatt; die Stufen 0–2 sind nach 4–10 s da, die Kosten tragen Akku und Dekodierer nur, solange das Blatt offen und sichtbar ist (`'verborgen'`).

**Auf Server auslagern** (Zwischenbilder berechnen lassen): „alles im Gerät". Verworfen, ohne Rechnung.

**Die Bearbeitung in den Speicher einbacken** (bearbeitete Bilder speichern): jede Änderung am Regler entwertete alle Bilder; beim Wischen gerade das, was sich dauernd ändert.

**Die Verfolgung beim Zug weiterlaufen lassen, um Masken „live" zu haben**: Abschnitt 6 – Hauptfaden und Grafik gehören im Zug dem Zeichnen; der Speicher macht Sprünge unnötig und damit Rechenzeit für die Verfolgung nicht frei.

---

## 9. Umsetzung

### 9.1 Schritte (jeder grün: `tsc`, `prettier`, vitest der Datei; Commit deutsch, nur im Zweig)

1. **`leserDienst`/`bilderLesen`**: Stufe `'mitte'`, `klein`-Auftrag (`kleinAn`), Mitschnitt, höchstens zwei offene Kodierungen. Tests in `leserDienst.test.ts` (Vorfahrt `'vorn' > 'mitte' > 'hinten'`, `klein` ohne zweiten Sprung, Mitschnitt nur wenn es fehlt, Abbruch, kein Horcher bleibt zurück).
2. **`ruhetor.ts`**: `Ruhetor` und `RuheGrund` aus `verfolger.ts` herauslösen; `verfolger.ts` importiert. Kein anderes Verhalten; die vorhandenen `verfolger.test.ts` bleiben unverändert grün.
3. **`wischspeicher.ts` mit `wischspeicher.test.ts`**: reine Funktionen (`grobSchritt`, `stufeVon`, Füllreihenfolge, `naechstesBild`, Verdrängen) und die Klasse gegen einen Ersatz-Leser (wie in `leserDienst.test.ts`); Format-/`toBlob`-Ersatz.
4. **`schnittZustand.ts`**: `filmBilder` (`useMemo` über `filmRaster`), Speicher im Effekt neben dem Verfolger (gleicher Schlüssel wie `leser`), `ruhen(grund, an)` verteilt; `window.__wisch`.
5. **`filmDoc.ts`, `vorschau.ts`**: `docFuer` liefert `{ doc, nummer, k, fehlend }`; `docFuerBild(nummer, k)`; `zeichneBild` (Zeichnen mit gegebener Bildquelle herausgelöst aus `zeichnen`), „nur näher", Güte-Leiter mit Notstufe, `zeigeBild`, die Regel „Leinwand weg, wenn das gezeigte Bild weiter als `TOLERANZ` vom Ziel liegt", `VorschauStand.fehlend`, neue Prüfhaken. Die Zeichenteile werden als reine Funktionen geschnitten und getestet (Güte-Leiter, Abstandsregel).
   Neu `filmDoc.test.ts`: Für Filmraten 24/25/30/50/60 und Quellraten 24/25/30/60 ergibt jedes `k` über `bildMitte` und das Video-`mediaTime` (Bild, das die Mitte enthält) wieder `k`.
6. **`filmWiedergabe.ts`, `SchnittEditor.tsx`, `VideoEditorSheet.tsx`**: `wischen`, `zeigeQuelle`, Aufrufstellen (Abschnitt 5), die drei Hinweiszeilen, `styles.css` (Zeile), Loslassen im Editor ohne Video-Sprung.
7. **e2e**: `e2e/wischen.spec.ts` + `e2e/wischenHilfe.ts` (Nachbau des Messgeräts: Prüfvideo mit Strichcode, Sprungschalter mit Elementzähler, Zugplan, Auswertung); Anpassung des Tests „beim Wischen läuft das Video mit" (Fallback-Fall) und ein Zwillings-Test; K1–K15.
8. **Nachher-Messung**: dieselbe Reihe `WISCH_MARKE=nachher` → `messung-nachher.md` im Ergebnisordner; Vergleich mit `messung-vorher.md`.

### 9.2 Prüfhaken (Anhang A) und Testschalter

`window.__vorschau` (besteht: `gezeichnet`, `guete`, `erzwingeLangsam`, `letzteMs`) erhält: `aus: 'video' | 'speicher' | 'keins'`, `letzteK`, `zielK`, `speicherGezeichnet`, `zeichenMs` (gleitender Mittelwert der letzten 8 Zeichnungen), `bereiche` (Masken im Dokument der letzten Zeichnung), `fehlend`, `ohneNotstufe`.
`window.__wisch` (neu, gesetzt beim ersten `setzen`, wie `__verfolger`): `verfuegbar`, `format`, `stufe`, `bilder`, `bytes`, `entpackt`, `fertig`, `ruhe: string[]`, `zaehler: { gelesen, mitgeschnitten, kodiert, fehler }`, `aus` (Test: Speicher ausschalten; `ruhen('speicher', true)` hält das Füllen an).
Der Sprungschalter (`window.__sprung.ms`) bleibt reiner Testcode in `e2e/wischenHilfe.ts` und nicht in der App.

### 9.3 Vorgabe für die Kommentare

Im Bestand erklären die Kommentare das WARUM, mit dem Ergebnis der Messung, wo es eines gibt. Der Kopf von `wischspeicher.ts` nennt: warum kleine Bilder in der Hand statt Sprünge, warum Stufen, warum Vorfahrt nur für die groben, warum bei `'zug'` Ruhe, warum `k` und nicht `mediaTime`; `vorschau.ts` bekommt im Kopf den Befund zum `readyState` (warum der Wächter nicht gelockert werden darf).

---

## 10. Risiken und offene Fragen

1. **Streuung der Messung.** Geteilter Rechner (Last 1–4), Faktor bis 1,5 zwischen Läufen, einzelne Ausreisser. → Median von 3 Läufen, Schwellen mit Abstand, relative Schwellen (K4) statt absoluter, wo sich das anbietet.
2. **Software-Grafik in der Testumgebung.** Jede bearbeitete Zeichnung 36–230 ms; die Zahl „≥ 25 Bilder/s" ist dort nur ohne Bearbeitung erreichbar (K1), mit Bearbeitung nur relativ (K2). Ob ein echtes Telefon (Grafikeinheit) in K2 die erwarteten 40–60/s erreicht, ist im Entwurf NICHT belegt, nur geschlossen. → Nach dem Umbau auf einem Gerät nachmessen (Prüfhaken `zeichenMs`).
3. **Weiche Bilder beim Wischen.** 480 Punkte auf einem Schirm von 1000+ Geräte-Punkten. Bewusst; bei Beanstandung `WISCH_KANTE` auf 640 (2,6–3,3× Bytes) oder nach Schirmbreite. Die Kante ist eine Konstante, die Abdeckung ändert sich dabei nicht.
4. **Zwei Quellen zeichnen in eine Leinwand** (Speicher und Video): Flackern/Zurückspringen, wenn die Regel „nur näher" an einer Stelle durchlässt. → Regel als reine Funktion testen; Prüfhaken `zielK/letzteK` prüft jede Zeichnung.
5. **`leserDienst` ändert sich im Kern** (Stufen, Mitschnitt): Er bedient Editor, Verfolgung, Filmbau. Der Mitschnitt läuft im Pfad jeder Verfolgungslesung. → Schalter `mitschnittSetzen(null)`, der Mitschnitt nur an `braucht(k)`; Tests mit Ersatz-Leser; K13 prüft, dass die Verfolgung nicht leidet.
6. **Kodierung auf dem Hauptfaden** (Safari): zwei offene Kodierungen und `luftholen()` dämpfen; nicht gemessen (Safari nicht verfügbar). → K14 prüft das Ausweichen, nicht die Geschwindigkeit dort.
7. **Füllzeit auf echten Telefonen** unbekannt: 15–57 s in Chromium headless; Sprünge auf Geräten 50–300 ms je Bild → 15–90 s für 300 Bilder. Stufe 0–2 (75 Bilder) sind nach 4–22 s da. Hält sie länger, hilft die Wiedergabe als Füllweg (Abschnitt 8) oder `WISCH_KANTE` kleiner.
8. **Akku.** Das Füllen dekodiert bis zu ein bis zwei Minuten im Hintergrund, auch wenn der Anwender nie wischt. Gemildert durch: Ruhe beim Verbergen, Stufen mit Abbruch-Möglichkeit, der Dekodierer schliesst nach 30 s. Offen: ob ein Schalter nötig ist („Wischvorschau vorbereiten" aus).
9. **Der Editor springt beim Loslassen nicht mehr** (4.4): Bleibt `currentTime` stehen, muss jede Stelle, die `currentTime` liest (`abspielen`, `nachSprung`, `neuZeichnen`), das wissen. Für `abspielen` gilt es (setzt es selbst); die Stelle mit `neuZeichnen` liest `element.currentTime` nur bei `element.paused` und nur bei aktiver Überlagerung. → Test „Wischen, loslassen, Regler ändern, Abspielen".
10. **Falsches Standbild (Befund 5)** und **Einfrieren (Befund 4)** sind Zufallsfehler des heutigen Wegs; der Entwurf erwartet, dass beide verschwinden (Einfrieren im Speicherweg ausgeschlossen, im Rückfallweg durch die zweite Regel aus 4.5; das falsche Standbild nur wahrscheinlich). K5/K15 prüfen es.
11. **Nicht gemessen:** Berührungs- statt Mausereignisse (`touch-action`, Zusammenfassen der Ereignisse durch das Betriebssystem), Videos mit veränderlicher Bildrate und B-Bildern, Hochkantvideos (Drehung in den Metadaten), Filme über 600 Bilder (`jenseits`: dort fehlt der Speicher, es springt das Video).
12. **Offene Entscheidungen für die Leitung:** (a) Stufen 0–2 als `'mitte'`, 3–4 als `'hinten'` (3.5) – andere Aufteilung möglich; (b) Budget 24 MiB und Kante 480 (3.2/3.3); (c) ob beim Wischen eine Notstufe ohne Bearbeitung akzeptiert wird oder die Bearbeitung immer Vorrang hat; (d) ob das Füllen per Wiedergabe (Abschnitt 8) schon jetzt dazugehört.

---

## Anhang A: Prüfhaken im Überblick

| Haken | Inhalt | Verwendet in |
|---|---|---|
| `__vorschau.gezeichnet`, `.letzteMs`, `.guete`, `.erzwingeLangsam` | besteht. Bei Zeichnungen aus dem Speicher ist `letzteMs = k'·s` (Anfang des Rasterbildes, wie `mediaTime` eines Videobildes), damit das Messgerät unverändert rechnet | alle |
| `__vorschau.aus` | `'video' \| 'speicher' \| 'keins'` – woher das zuletzt gezeichnete Bild kam | K1, K4 |
| `__vorschau.letzteK`, `.zielK` | Rasterbild des gezeichneten Bildes / Rasterbild unter dem Finger bei dieser Zeichnung | K3, K5 |
| `__vorschau.zeichenMs` | Mittel der letzten 8 Zeichnungen | K2, K3 |
| `__vorschau.bereiche`, `.fehlend` | Masken im Dokument / fehlende Masken der letzten Zeichnung | K7 |
| `__vorschau.ohneNotstufe` | Test: nie auf „roh beim Wischen" zurückfallen | K2, K7 |
| `__wisch.*` | siehe 9.2 | K8–K10, K12, K14 |
| `__verfolger.lesen` | besteht | K7, K13 |

## Anhang B: Wie das Messgerüst benutzt wird

`mess/wischen.spec.ts` (Umgebung `WISCH_MARKE`, `WISCH_GOP`, `WISCH_SPRUNG`, `WISCH_SZENEN`, `WISCH_CPU`, `WISCH_MASKE`, `WISCH_STRICHCODE`) schreibt je Lauf eine Datei `mess/roh/<marke>-gop<G>-sprung<S>-<szene>.json`;
`node mess/auswerten.mjs <marke>` macht daraus dieselbe Tabelle wie in `messung-vorher.md`. Nach dem Umbau: `bash mess/alle.sh nachher 25:0 100:0 25:120 25:250 100:250`, dazu `WISCH_MASKE=1` für K7.
Die Auswertung kennt `gezeigt` aus `lw` (Leinwand sichtbar) und `ms`, sonst dem letzten Bildruf des Videos; mit dem Speicher zeichnet die Leinwand auch ohne Bearbeitung – die Spalte „bearb. %" bleibt vergleichbar, weil die Leinwand dann immer sichtbar ist.
Einschränkung: Das Messgerät schätzt „gezeigtes Bild" aus `letzteMs`; mit dem Speicher sollte der Nachbau `__vorschau.letzteK` lesen und den Strichcode je 10. Takt gegenprüfen (`WISCH_STRICHCODE=1`).
