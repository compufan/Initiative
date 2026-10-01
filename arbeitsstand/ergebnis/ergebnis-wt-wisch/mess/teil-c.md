
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
