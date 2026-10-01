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

