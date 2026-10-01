export const meta = {
  name: 'video-foto-events-web',
  description: 'Weichzeichnen/Bokeh, Wischspeicher, Bereiche im Video, Ort als Adresse, Sammlung anlegen – je Thema Entwurf, Bau, Prüfung, Gegenprobe, Beheben (eigene Arbeitsbäume)',
  phases: [
    { title: 'Entwurf', detail: 'Messen, lesen, Entwurf mit Abnahmekriterien' },
    { title: 'Bauen', detail: 'Umsetzen, testen, committen' },
    { title: 'Prüfen', detail: 'Prüfer mit je einer Linse' },
    { title: 'Gegenprobe', detail: 'Jeder Befund wird zu widerlegen versucht' },
    { title: 'Beheben', detail: 'Bestätigtes beheben, erneut testen, committen' },
  ],
}

const S = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad'
const BASIS = 'd786eab'
const FUSS = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01XgRwauwg73maopdhZbXcy7'

function regeln(it) {
  const dir = `${S}/${it.name}`
  return `
Du arbeitest an einer kommerziellen, deutschsprachigen PWA (pnpm-Workspace im Repo /home/user/Initiative: apps/web = Vite/React/TypeScript, apps/api = Rust/axum/Postgres, packages/shared). Lies ZUERST ${S}/anforderungen-2.md – der Wunsch des Anwenders wörtlich, die Grundsätze und die verbindliche Auslegung.

ARBEITSBAUM: ${dir} (Git-Zweig ${it.branch}, Ausgangspunkt ${BASIS}). Arbeite NUR dort. Der Hauptbaum /home/user/Initiative gehört jemand anderem und darf weder gelesen-zum-Ändern noch verändert werden (Lesen zum Nachschlagen ist in Ordnung, Änderungen nicht). Abhängigkeiten sind per Symlink geteilt: nichts installieren, keine neuen Abhängigkeiten.

GRUNDSÄTZE (hart): nur MIT/Apache-2.0/BSD; keine fremden Skripte/Server/kostenpflichtigen APIs; alles im Gerät bzw. auf dem eigenen Server. Deutsch: Bezeichner, Kommentare (sie erklären das WARUM, wie im Bestand), Oberflächentexte. Passe Stil, Kommentardichte, Namen und Idiome dem umgebenden Code an. Keine Modell- oder Werkzeugnamen in Code, Kommentaren oder Commits.

PRÜFEN (in ${dir}/apps/web): npx tsc -p tsconfig.json --noEmit · npx prettier --check <Dateien> (bzw. --write) · npx vitest run <Datei> (die ganze Suite nur einmal am Ende, sie dauert ~30 s) · Browser: Dev-Server neu starten mit  bash ${S}/vite-neu.sh ${dir}/apps/web ${it.port} ${S}/ergebnis-${it.name}/vite.log  (nach jeder grösseren Änderung neu starten – doppelte Modulinstanzen nach HMR verfälschen Tests), dann  npx playwright test -c ${S}/pw/pw-${it.name}.config.ts e2e/<datei> -g "<name>" . Tests mit Anmeldung registrieren ihre Nutzer selbst gegen den API-Server auf Port 8080 (Beispiel: e2e/termine.spec.ts); diesen Server NICHT neu starten. Die Maschine hat nur 4 Kerne und teilt sie mit anderen Arbeiten: Tests gezielt laufen lassen, keine Endlosschleifen, keine Hintergrundprozesse zurücklassen (ausser dem Dev-Server).

COMMITS: nur in deinem Zweig, gezielt mit  git add <Pfade> , deutsche Nachricht (Betreff knapp, Rumpf erklärt das Warum), am Ende genau diese zwei Zeilen:
${FUSS}
Nichts pushen, keinen PR. Hilfsdateien, Skizzen, Messungen und Bilder gehören nach ${S}/ergebnis-${it.name}/ – nicht ins Repo.
Zu Bildern: Mit dem Lesewerkzeug lassen sich PNG-Dateien ansehen – nutze das, um Ergebnisse wirklich zu betrachten.
`
}

const ENTWURF_SCHEMA = {
  type: 'object',
  properties: {
    datei: { type: 'string', description: 'Pfad der Entwurfsdatei (Markdown)' },
    zusammenfassung: { type: 'string' },
    abnahmekriterien: { type: 'array', items: { type: 'string' } },
    risiken: { type: 'array', items: { type: 'string' } },
  },
  required: ['datei', 'zusammenfassung', 'abnahmekriterien'],
}

const BAU_SCHEMA = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' } },
    dateien: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'Was lief, mit Zahlen' },
    abweichungen: { type: 'string', description: 'Wo und warum vom Entwurf abgewichen wurde' },
    offen: { type: 'string', description: 'Was nicht erledigt ist und warum' },
  },
  required: ['commits', 'tests'],
}

const BEFUNDE_SCHEMA = {
  type: 'object',
  properties: {
    befunde: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          datei: { type: 'string' },
          zeile: { type: 'number' },
          schwere: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
          szenario: { type: 'string', description: 'Konkrete Eingaben/Zustand -> falsches Verhalten' },
          vorschlag: { type: 'string' },
        },
        required: ['titel', 'datei', 'zeile', 'schwere', 'szenario', 'vorschlag'],
      },
    },
  },
  required: ['befunde'],
}

const URTEILE_SCHEMA = {
  type: 'object',
  properties: {
    urteile: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          echt: { type: 'boolean' },
          begruendung: { type: 'string' },
        },
        required: ['titel', 'echt', 'begruendung'],
      },
    },
  },
  required: ['urteile'],
}

const BEHOBEN_SCHEMA = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' } },
    je_befund: { type: 'array', items: { type: 'object', properties: { titel: { type: 'string' }, ergebnis: { type: 'string' } }, required: ['titel', 'ergebnis'] } },
    tests: { type: 'string' },
  },
  required: ['commits', 'je_befund', 'tests'],
}

/* ---------------------------------------------------------------- Themen */

const BLUR = {
  key: 'blur',
  name: 'wt-blur',
  branch: 'v-blur',
  port: 5191,
  entwurf: `
THEMA: Weichzeichnen und Bokeh (Foto UND Video – beide nutzen denselben Renderer).

HEUTE: Je Bereich gibt es EINEN Regler „Weichzeichnen" (Feld "unschaerfe" in Bereichston, apps/web/src/modules/bild/doc.ts). Der Renderer rechnet ihn als Zerstreuungsscheibe (Bokeh): GPU in bild/tonGpu.ts (Funktionen bokehAn, zerstreuen, Szene/Uniformen, Bereiche-Atlas), Prozessorweg in bild/bokeh.ts (bokehRgba) und tonGpu.ts ab etwa Zeile 1130 (bokehGewicht, Stufen). Dazu bild/weich.ts (bokehRadius), bild/zeichnen.ts, bild/maskenSpeicher.ts (Schlüssel "u:"), bild/tiefe.ts (Tiefenkarte als Maske mit Verlauf), bild/rezept.ts (Serialisierung), bild/entwurf.ts, und im Video video/masken.ts (Felder je Maske/Bereich, Routing der Änderungen aus dem Editor). Tests: e2e/bereich.spec.ts (u.a. „das Bokeh verwischt nur hinter der Maske und blutet nicht heraus", „die Zerstreuung ist eine Scheibe und keine Glocke", GLSL-gegen-TypeScript-Parität), bild/bokeh.test.ts, bild/tiefe.test.ts.

MELDUNG DES ANWENDERS: „Weichzeichnen geht bei Fotos und Videos noch über die Kanten der Maske hinaus, was beim Freistellen suboptimal ist. Zudem sollten echte Bokeh-Effekte dabei sichtbar werden (vielleicht normales Weichzeichnen und separat Bokeh als weiteren Slider)."

DEINE AUFGABE – NUR ENTWURF, noch kein Produktivcode:

1. LESEN. Die genannten Dateien gründlich, dazu wie Masken entstehen und weich werden (bild/netzMaske.ts kanteWeichzeichnen/weichzeichnerFuer, bild/maske.ts, "Weichheit" im Editor, im Video die Verfolgung: video/objektFolge.ts, video/masken.ts Überblendung, RLE-Quantisierung in video/rle.ts).

2. REPRODUZIEREN UND MESSEN, statt zu raten. Baue unter ${S}/ergebnis-wt-blur/ ein Messgerüst (Playwright-Test oder Skript, das im Browser genauso rendert wie e2e/bereich.spec.ts – Chromium mit SwiftShader für den GPU-Weg, dazu der Prozessorweg). Synthetische Szenen, zum Beispiel: (a) ein rotes Motiv (Scheibe/Figur mit Textur) auf grünem, gemustertem Grund; (b) dunkler Grund mit kleinen hellen Lichtpunkten (wie Lichterketten oder Autolichter) hinter einem Motiv; Masken: hart, weich (verschiedene Weichheit), wie sie ein Freistellnetz liefert (weicher Saum, leicht verrauscht: aussen 0…12, innen 235…255), und wie eine verfolgte Videomaske (RLE-quantisiert, überblendet). Fälle: Bereich auf dem Motiv (Maske = Motiv), Bereich auf dem Hintergrund (Umkehren, Portraitmodus), mit Tiefenkarte. Miss je Fall: (A) Änderung AUSSERHALB der Maske (Abstand zur Maskenkante gegen Betrag der Abweichung vom Original); (B) Farbverunreinigung INNERHALB (Anteil der Farbe von ausserhalb der Maske im weichgezeichneten Bereich, z.B. Rot des Motivs im Hintergrund oder Grün im Motiv); (C) Kantenverbreiterung (Breite des Übergangs im Ergebnis gegen Breite der Maskenkante); (D) Schärfe des Motivrandes beim Hintergrundweichzeichnen (Halo, Verschmieren, verschwundener Rand); (E) Lichtpunkte: Spitzenwert-Erhalt und ob eine erkennbare Scheibe mit Rand entsteht. Schaue dir die Ergebnisbilder (Ausschnitte, vergrössert, nebeneinander Original/Ergebnis/Differenz) WIRKLICH an. Prüfe beide Wege (GPU, Prozessor) – sie sollen gleich aussehen.

3. URSACHEN benennen, mit Beleg aus den Messungen und Zeilen im Code. Mögliche Kandidaten, die du prüfen sollst, nicht als gegeben nehmen: weicher Maskensaum (Maske > 0.002 gilt als Bereich, die Scheibe ist dort schon klein, aber die Farben kommen von Nachbarn im Saum), gewichtete Abtastung nach Maskenwert statt Kern der Maske, Saum-Pixel enthalten Mischfarben aus Motiv und Grund, der Prozessorweg (bokehRgba über das ganze Bild, dann Mischen mit dem Gewicht) holt Farben von ausserhalb, Tiefenkarten, Verfolgungsmasken mit grossem Saum, Rauschen in der Maske. Auch: Wirkt das Weichzeichnen auf das Motiv selbst (Maske = Motiv) wirklich nur innerhalb der Silhouette?

4. ENTWURF (schreibe ${S}/ergebnis-wt-blur/entwurf.md, deutsch, knapp aber vollständig):
 a) Zwei Regler je Bereich: „Weichzeichnen" (gewöhnlich, sauber an der Maske begrenzt) und „Bokeh" (echte Linse). Beide dürfen zugleich wirken – lege fest, wie sie zusammenspielen (Reihenfolge, Radien, Gewichte) und begründe es optisch. Neues Feld in Bereichston (Name, Bereich 0…1, Neutralwert), Verhalten für Alt-Dokumente, Rezepte (bild/rezept.ts, mit Klemmen/Prüfen), Entwürfe (bild/entwurf.ts), docUnberuehrt/haengtAmBild-artige Prüfungen, maskenSpeicher-Schlüssel, video/masken.ts (Feldtabelle FELDER/feldArt: global oder lokal; Bereich-Regler laufen ohne neuen Anker in alle Anker), Rückgängig-Verlauf, Vorher/Nachher, „Tiefe" (Tiefenkarte) und „Motiv + Tiefe".
 b) Das Verfahren für „an der Maske begrenzt": Ausserhalb der Maske bleibt das Bild BIT-GLEICH. Innerhalb kommt keine Farbe von ausserhalb herein (normalisierte Faltung über Maskengewicht mit Kern/Erosion statt Saum, Randfortsetzung für Pixel nahe der Kante, Rückfall wo keine gültigen Abtastungen), die Kante wird nicht breiter, der Rand des Motivs bleibt beim Hintergrundweichzeichnen scharf und ohne Halo, der Übergang folgt dem Verlauf der Maske. Für jede Wahl: Kosten (GPU-ms bei 1200×900 und bei 1920×1080 für die Vorschau, Anzahl Abtastungen), Rauschfreiheit (keine Ringe), Verhalten bei Radius 0, NaN, winzigen Bildern, Bildrand.
 c) Das Verfahren für „Bokeh sichtbar": Blendenscheibe, Glanzlichter werden erkennbare helle Scheiben mit Rand (Verstärkung heller Stellen vor dem Mitteln im linearen Licht, stärker als heute, einstellbar über den Regler oder fest), keine Wirbel/Zwiebelringe behaupten, Radius-Obergrenzen, Tupfenzahl für Telefon, Verhalten mit Tiefenkarte (Radius folgt der Tiefe).
 d) Prozessorweg und GPU-Weg müssen gleich aussehen; lege die Toleranz fest und wie die bestehenden Paritätstests erweitert werden.
 e) Leistungsbudget: Vorschau im Video (Flüchtigmodus ohne Zwischenspeicher, siehe video/vorschau.ts, bild/zeichnen.ts "fluechtig") und Export; ein Telefon schafft etwa ein Drittel der Rechnerleistung.
 f) Oberfläche: Regler im Bereichspanel von bild/BildEditor.tsx (BEREICHSREGLER, REGLER_TIPP mit den Tooltips, Doppeltipp = zurücksetzen), Namen und Texte; wie es im Video-Editor aussieht.
 g) ABNAHMEKRITERIEN mit Zahlen, je Kriterium ein Test (Einheit oder Browser): mindestens (A)–(E) aus Punkt 2 als Schwellen, Parität, Alt-Dokument, Video-Routing ohne neuen Anker, Leistung.
 h) Was du verworfen hast und warum.
Gib am Ende die Entwurfsdatei, eine Zusammenfassung, die Abnahmekriterien und die Risiken zurück.`,
  bau: `
THEMA: Weichzeichnen und Bokeh – UMSETZUNG des Entwurfs.
Der Entwurf liegt unter {ENTWURF}. Lies ihn vollständig und halte dich daran; Abweichungen sind erlaubt, wenn Messungen oder Code sie erzwingen – dann schreibe sie in das Ergebnis.
Liefere: (1) Renderer auf GPU UND Prozessor, gleiche Optik; (2) Datenmodell (neues Feld, Alt-Dokumente, Rezepte, Entwürfe, maskenSpeicher, Video-Routing in video/masken.ts und alles, was Bereichston-Felder aufzählt – suche per grep nach "unschaerfe" und nach den Feldlisten, damit nichts vergessen wird); (3) Oberfläche: zwei Regler mit Tooltips im Bereichspanel, im Foto- und im Video-Editor; (4) Tests: Einheitentests, Browser-Tests (bereich.spec.ts erweitern: Kantenbegrenzung, Farbverunreinigung, Bokeh-Scheiben, Parität), Video-Fluss (ein Regler ändert nur anpassung, kein neuer Anker – siehe video/masken.test.ts); (5) kurze Doku im Abschnitt „Fotos bearbeiten" von docs/FEATURES.md (Bereiche, Tiefenschärfe). Die Abnahmekriterien des Entwurfs müssen erfüllt sein und durch Tests belegt; melde Zahlen. Am Ende: tsc, prettier, ganze vitest-Suite, die Browser-Tests der Dateien bereich.spec.ts, vorschau.spec.ts und videoSchnitt.spec.ts (letztere prüft, dass die Vorschau weiter läuft) – alles grün, und committen.`,
  linsen: [
    'Numerik und Parität: GPU gegen Prozessor, Randfälle (Radius 0, NaN, Bildrand, winzige Bilder, Maske überall 0 oder 1, vier Bereiche mit verschiedenen Reglern, Tiefenkarte, Umkehren), bit-gleiche Aussenseite, Farbverunreinigung, Kantenbreite, Halo am Motivrand, Ringe/Rauschen, Bokeh-Scheiben wirklich sichtbar, Überläufe/Unterläufe im linearen Licht.',
    'Datenfluss und Kompatibilität: doc.ts, rezept.ts (Klemmen, Alt-Rezepte), entwurf.ts, maskenSpeicher.ts (Schlüssel enthalten ALLE Felder, die das Bild ändern), Rückgängig/Vorher-Nachher, video/masken.ts (Feldtabelle, Routing ohne neuen Anker, Zusammensetzen, Kompositspeicher-Schlüssel), Video-Vorschau im Flüchtigmodus und Export (videoBauen), Blatt-Vorschau, jede Stelle, die Felder von Bereichston einzeln aufzählt (grep).',
    'Leistung und Oberfläche: Telefonbudget (Abtastungen, Durchläufe, Zwischenspeicher, Speicher), Vorschau beim Ziehen des Reglers im Foto und im Video, Texte/Tooltips/Beschriftungen auf Deutsch und korrekt, Barrierefreiheit der Regler, Reihenfolge und Platz im Panel auf 375 px Breite, Stabilität der neuen Browser-Tests (keine Zeitabhängigkeit, keine Reihenfolgeabhängigkeit).',
  ],
}

const WISCH = {
  key: 'wisch',
  name: 'wt-wisch',
  branch: 'v-wisch',
  port: 5192,
  entwurf: `
THEMA: Flüssiges Wischen durch die Zeitleiste des Video-Editors, mit Bearbeitung UND Masken.

WUNSCH: „Beim Ziehen mit dem Finger durch die Zeitleiste sollte das Live-Video flüssiger mitlaufen (das Bild anzeigen, auf dem der Finger gerade liegt) und dabei auch die Masken anzeigen."

HEUTE (apps/web/src/modules/video): Zeitleiste.tsx (Zug auf der Leiste → onSpielkopf), Maskenbahnen.tsx (Wischen über die Bahnen, Griffe), SchnittEditor.tsx und VideoEditorSheet.tsx (Editor und Blatt, je mit einem sichtbaren <video> und einer Leinwand darüber), filmWiedergabe.ts (useFilmWiedergabe, springenZu: ein Sprung zugleich, danach zum neuesten Ziel), vorschau.ts (useBearbeiteteVorschau: zeichnet das Bild des Videos mit Bearbeitung, requestVideoFrameCallback und 'seeked'-Rückfall, Güte-Leiter, window.__vorschau), filmDoc.ts (useVorschauDoc: bildDocAn(..., 'vorschau') mit den Masken), leserDienst.ts (EIN Dekodierer für Editor, Verfolgung, Filmbau; Vorfahrt 'vorn'), verfolger.ts (Verfolgung ruht während eines Zugs, verfolgungRuhen('zug'), vorziehen(k)), masken.ts (bildDocAn mit art 'vorschau', 'editor', 'bild'; Kompositspeicher), bild/zeichnen.ts (zeichneAnsicht mit fluechtig, maxKante). e2e/videoSchnitt.spec.ts hat Tests „beim Wischen läuft das Video mit…" und „beim Wischen im Editor zeigt die Vorschau das bearbeitete Bild" – sie müssen grün bleiben oder sinnvoll weiterentwickelt werden.

Problem: Jede Stelle beim Wischen ist ein Sprung im Dekodierer des <video> (auf einem Telefon 50–300 ms, bei langen GOPs mehr). Auch mit Zusammenlegen der Sprünge hinkt das Bild hinter dem Finger her, und Masken gibt es beim Wischen nur dort, wo schon verfolgt wurde.

DEINE AUFGABE – NUR ENTWURF, noch kein Produktivcode:

1. LESEN der genannten Dateien gründlich.

2. MESSEN. Baue unter ${S}/ergebnis-wt-wisch/ ein Messgerüst (Playwright), das ein Video von 1280×720, 25 Bildern/s, 12 s mit der App-eigenen Schreibfunktion erzeugt (siehe e2e/videoSchnitt.spec.ts: videoSchreiben über e2e/buehne.ts), den Editor öffnet und mit Zeigerereignissen (60 Hz, 1 s über die ganze Leiste; dazu langsames Wischen, Hin-und-her, Stopp und Loslassen) über die Leiste zieht. Erfasse je Zeigerereignis: Fingerstelle (Filmzeit), und wann welches Bild tatsächlich auf der Leinwand erschien (window.__vorschau.letzteMs, gezeichnet-Zähler; ergänze Prüfhaken nur, wenn nötig). Kenngrössen: angezeigte verschiedene Bilder je Sekunde, mittlere und grösste Verspätung (Abstand angezeigtes Bild gegen Bild unter dem Finger, in Filmbildern), Zeit bis zum richtigen Bild nach dem Loslassen. Weil headless Chromium mit einem kleinen Video viel schneller springt als ein Telefon: ein Schalter, der Sprünge künstlich verzögert (z.B. 120/250 ms pro Sprung, in Testcode, nicht im Produktivpfad; oder ein Video mit langem GOP), damit die Messung telefonähnlich ist. Halte die Zahlen in ${S}/ergebnis-wt-wisch/messung-vorher.md fest.

3. ENTWURF (schreibe ${S}/ergebnis-wt-wisch/entwurf.md, deutsch, vollständig):
 a) Der Wischspeicher: kleine, komprimierte Bilder des ganzen Films (alle Rasterbilder des Films, siehe raster.ts filmRaster, oder der Quelle), im Hintergrund gefüllt, beim Wischen sofort gezeigt. Lege fest: Format und Grösse (z.B. lange Kante ≤ 480, WebP/JPEG über toBlob oder OffscreenCanvas, Dekodieren über createImageBitmap mit kleinem LRU der entpackten Bilder), Speichergrenze in Bytes (Telefon!), Reihenfolge des Füllens (grob zu fein: jedes 16., 8., 4., 2., 1. Bild, damit früh ungefähr richtig gezeigt werden kann), WER füllt (kein zusätzlicher Dekodierer: über leserDienst; Vorrang gegenüber der Verfolgung? Abgabe an den Editor 'vorn'; Mitschnitt der Bilder, die die Verfolgung ohnehin liest – siehe Lesung.voll), Ruhegründe (Wiedergabe, Zug, Filmbau, verborgenes Fenster, Speicherdruck), Schliessen, Ungültigkeit (Rechengrösse/kante/Bildrate/Datei ändert sich), Verhalten wenn canvas.toBlob/ImageBitmap fehlt oder der Speicher knapp wird.
 b) Der Zeichenweg beim Wischen: Zeigerereignis → (per requestAnimationFrame zusammengefasst) nächstes Speicherbild → Bearbeitung und Masken (bildDocAn 'vorschau' mit dem bekannten Stand der Verfolgung; Verfolgung für dieses Bild vorziehen, soweit das die Ruhe beim Zug erlaubt; Ersatz/veraltet wie in masken.ts) → Leinwand. Was geschieht mit dem <video> während des Zugs (nicht springen, solange der Speicher es deckt?), wie wird beim Loslassen das genaue Bild gezeigt (Sprung und Standbild), wie stimmt das gezeigte Bild mit k = Rasterbild und mit bildMitte überein (siehe die jüngsten Fehler dazu: filmDoc.ts). Qualität: wie wird aus dem kleinen Speicherbild das Bild der Vorschau (Hochskalieren auf Rechengrösse, maxKante/Güte-Leiter), Masken liegen in Rechengrösse.
 c) Wie Editor UND Blatt dasselbe nutzen; wie Maskenbahnen-Wischen und Griffe (onGriffZug) einbezogen sind.
 d) Masken beim Wischen: was wird gezeigt, wo die Verfolgung noch fehlt (Hinweis? nächster bekannter Stand? nichts?), und darf die Verfolgung beim Zug weiterlaufen (Dekodierer-Streit) – lege es fest und begründe.
 e) ABNAHMEKRITERIEN mit Zahlen, je Kriterium ein Test: bei künstlich 250 ms langsamen Sprüngen und gefülltem Speicher mindestens 25 verschiedene Bilder je Sekunde beim schnellen Wischen und Verspätung höchstens 2 Filmbilder; vor dem Füllen kein Rückschritt gegenüber heute; nach dem Loslassen das genaue Bild innerhalb einer definierten Zeit; Masken sichtbar beim Wischen dort, wo verfolgt wurde; Speicher unter der Grenze; kein zusätzlicher Dekodierer; Schliessen räumt alles; bestehende Tests grün.
 f) Verworfene Alternativen und warum (z.B. ein zweites <video>, Wiedergabe mit Rate statt Sprüngen, WebCodecs).
Gib am Ende die Entwurfsdatei, eine Zusammenfassung, die Abnahmekriterien und die Risiken zurück.`,
  bau: `
THEMA: Flüssiges Wischen (Wischspeicher) – UMSETZUNG des Entwurfs.
Der Entwurf liegt unter {ENTWURF}; die Messung davor unter ${S}/ergebnis-wt-wisch/messung-vorher.md. Lies beides vollständig und halte dich daran; Abweichungen sind erlaubt, wenn Messungen oder Code sie erzwingen – dann schreibe sie in das Ergebnis.
Liefere: (1) das Speichermodul mit Einheitentests (Reihenfolge, Grenze in Bytes, LRU, Ungültigkeit, Schliessen, Fehlerfälle); (2) Anbindung an leserDienst/Verfolger ohne zusätzlichen Dekodierer; (3) Zeichenweg beim Wischen in vorschau.ts/filmWiedergabe.ts/SchnittEditor.tsx/VideoEditorSheet.tsx/Zeitleiste.tsx/Maskenbahnen.tsx mit Bearbeitung und Masken; (4) Browser-Tests mit den Zahlen der Abnahmekriterien (Messgerüst wiederverwenden, nach e2e/ übernehmen, so dass es auch in der Suite stabil läuft – keine Zeitabhängigkeit, die auf langsamen Maschinen bricht: Schwellen grosszügig, aber aussagekräftig); (5) kurze Doku im Abschnitt „Videos bearbeiten" von docs/FEATURES.md; (6) messung-nachher.md mit denselben Kenngrössen wie vorher. Am Ende: tsc, prettier, ganze vitest-Suite, die Browser-Tests von videoSchnitt.spec.ts, maskenSpuren.spec.ts, vorschau.spec.ts – alles grün, und committen.`,
  linsen: [
    'Korrektheit und Zustand: Bildzuordnung (Fingerstelle → Filmzeit → Quellzeit → Rasterbild k, bildMitte, floor/ceil, Abschnitte mit umgestellter Reihenfolge, derselbe Quellbereich in zwei Abschnitten, Kanten), Masken des richtigen Bildes und Abschnitts, Wettläufe (Zug, Loslassen, Abspielen, Kürzen während des Zugs, Schliessen des Editors, Wechsel der Bildrate), Aufräumen (Zeitgeber, ImageBitmap.close, Blob-URLs), StrictMode, dass beim Loslassen das genaue Bild erscheint.',
    'Leistung und Speicher auf dem Telefon: Byte-Grenze wirklich eingehalten (auch die entpackten Bilder), Dekodierer-Streit (Füllen gegen Editor-Stellbild gegen Verfolgung gegen Wischsprünge), Rechenzeit je Zeigerereignis, requestAnimationFrame-Zusammenfassen, Güte-Leiter, Hauptfaden-Blockaden (toBlob/Kodieren in Häppchen), Akku (Füllen nur wenn sinnvoll, Ruhe im verborgenen Fenster), Verhalten bei langen Videos (600 Bilder Grenze, MAX_BILDER_FILM) und bei hoher Auflösung.',
    'Oberfläche und Tests: Blatt UND Editor, Griffe und Bahnen-Wischen, Hinweistexte, Stabilität der neuen Browser-Tests (keine Zeitabhängigkeit), ob die Messzahlen der Abnahme echt belegt sind und nicht durch die Testanlage geschönt, ob bestehende Tests weiter das Richtige prüfen.',
  ],
}

const BEREICHE = {
  key: 'bereiche',
  name: 'wt-bereiche',
  branch: 'v-bereiche',
  port: 5193,
  entwurf: `
THEMA: Mehrere Bereiche im Video-Editor „wie beim Foto", jeder mit eigener, getrennt verfolgter Maske.

WUNSCH: „Es sollten bei Videos auch wie beim Foto mehrere Bereiche geben, für die separate Masken separat getrackt werden."

STAND: Im Code ist das seit der letzten Runde angelegt (apps/web/src/modules/video/masken.ts: jeder Bereich des Fotoeditors ist im Video eine "Maske" mit eigener Kennung, eigenen Teilen/Ankern, eigener Geltung, eigener Bahn in der Zeitleiste – Maskenbahnen.tsx, und eigener Verfolgung – verfolger.ts; bis zu 4 je Bild, 8 im Film; im Editor: Reiter „Bereiche", Knopf „＋ Bereich", BildEditor.tsx mit bereicheMax/bereicheGrund; e2e/maskenSpuren.spec.ts hat Tests mit mehreren Masken). Der Anwender hat es trotzdem vermisst. Finde heraus, WARUM: nicht auffindbar? verhält es sich anders als beim Foto? Bricht etwas, sobald es zwei oder mehr Bereiche mit verschiedenen Gegenständen sind?

DEINE AUFGABE – NUR PRÜFEN UND ENTWERFEN, noch kein Produktivcode:

1. NUTZE DIE OBERFLÄCHE WIE EIN ANWENDER (Playwright im Arbeitsbaum, Dev-Server auf deinem Port, 412×880 und 375×667), mit Bildschirmfotos unter ${S}/ergebnis-wt-bereiche/ – und schau dir die Bilder an. Erzeuge ein Testvideo (siehe e2e/maskenSpuren.spec.ts und e2e/buehne.ts) mit ZWEI verschieden bewegten Gegenständen (A wandert nach rechts, B nach unten; später kreuzen sie sich; eine Weile läuft A aus dem Bild), nur Verfahren ohne Modell (Antippen ohne Netz, Verlauf, Ellipse, Pinsel – Modelle stehen in dieser Umgebung nur teilweise bereit; prüfe, ob public/models Modelle hat, und nutze sie, wenn sie laufen). Spiele durch: Bereich 1 auf A antippen, „＋ Bereich", Bereich 2 auf B antippen; je Bereich verschiedene Regler (Sättigung, Belichtung); Bereich 1 im ganzen Film, Bereich 2 nur ein Zeitraum; umbenennen, ausschalten, löschen, ↺; Bereich im Editor wählen ↔ Maske in der Zeitleiste wählen; Bahnen, Griffe, „Hier trennen"; den fertigen Film bauen und pro Bild nachmessen, dass JEDER Gegenstand seine eigene Bearbeitung trägt und keiner die des anderen. Halte fest, was nicht geht oder anders geht als beim Foto.

2. VERGLEICH MIT DEM FOTO: Gehe bild/BildEditor.tsx Bereiche-Reiter durch und stelle zusammen, was das Foto kann und das Video nicht oder anders (Bereich anlegen, wählen, umbenennen – gibt es das im Foto?, löschen, Reihenfolge, Teile je Bereich, mehrere Teile in einem Bereich: Person + Antippen, Regler je Bereich, Maximalzahl, Hinweise, Rückgängig). Achte besonders auf den Gleichklang zwischen dem Bereich, der im Editor gewählt ist (bereichId/teilId in BildEditor), und der Maske, die in der Zeitleiste gewählt ist (schnitt.gewaehlt) – das sind heute zwei getrennte Auswahlen.

3. ENTWURF (schreibe ${S}/ergebnis-wt-bereiche/entwurf.md, deutsch): eine nummerierte Liste jeder Lücke, mit Beleg (Bild/Messung/Zeile), Schwere und konkreter Abhilfe (kleinste sinnvolle Änderung): zum Beispiel Auswahl-Gleichklang beider Richtungen, ein sichtbarer Weg „weitere Maske/Bereich anlegen" direkt an der Zeitleiste (Knopf, der den Editor auf den Bereiche-Reiter stellt), Namen der Bereiche in der Zeitleiste, Hinweis wenn die Grenze erreicht ist, Verhalten zweier Bereiche mit demselben Gegenstand, getrennte Verfolgung nachweisen (Test), Dinge, die beim Foto gehen und im Video fehlen. Nichts erfinden, was nicht belegt ist; wenn etwas schon richtig funktioniert, sag das mit dem Beleg. ABNAHMEKRITERIEN je Lücke mit Test.
Gib die Entwurfsdatei, eine Zusammenfassung, die Abnahmekriterien und Risiken zurück.`,
  bau: `
THEMA: Mehrere Bereiche im Video – UMSETZUNG der Lücken aus dem Entwurf.
Der Entwurf liegt unter {ENTWURF}. Lies ihn und setze die Lücken um, die er nennt (alle mit Schwere hoch und mittel, niedrige wenn billig). Schreibe für jede Abnahme einen Browser-Test in e2e/maskenSpuren.spec.ts (oder eine neue Datei e2e/videoBereiche.spec.ts), darunter den Nachweis mit zwei verschieden bewegten Gegenständen: zwei Bereiche, getrennt verfolgt, im fertigen Film trägt jeder Gegenstand seine eigene Bearbeitung. Kurze Doku im Abschnitt „Videos bearbeiten" von docs/FEATURES.md (wie man weitere Bereiche anlegt, wählt, eingrenzt). Am Ende: tsc, prettier, ganze vitest-Suite, Browser-Tests maskenSpuren.spec.ts und videoSchnitt.spec.ts grün, committen.`,
  linsen: [
    'Zustand und Gleichklang: Auswahl Editor ↔ Zeitleiste in beide Richtungen, Wettläufe beim Neuladen des Editors (fassung/neuLaden), Rückgängig im Editor und ↺ der Zeitleiste, mehrere Bereiche mit Tipp-Teilen, gelöschte Bereiche, Grenzen (4 je Bild, 8 im Film), Fokus und Tastatur, nichts hängt nach Wechsel des Abschnitts.',
    'Oberfläche und Tests: Auffindbarkeit auf 375 px, Texte (Deutsch, Grammatik), Barrierefreiheit (Namen, Rollen, Fokus), Stabilität und Aussagekraft der neuen Tests (prüfen sie wirklich getrennte Verfolgung und getrennte Bearbeitung im Film, ohne Schönung), Doku stimmt mit dem Verhalten.',
  ],
}

const ORT = {
  key: 'ort',
  name: 'wt-ort',
  branch: 'e-ort',
  port: 5194,
  entwurf: `
THEMA: Termine – der Ort wird als Adresse erkannt und verlinkt.

WUNSCH: „Beim Ort sollten Adressen erkannt und verlinkt werden (ohne kostenpflichtige APIs oder Lizenzen), sodass alle, die eingeladen sind, diese Adresse mit der Karten-App ihrer Wahl öffnen können."

STAND: Der Ort ist ein freier Text (Feld "location" am Termin; apps/web/src/modules/calendar: EventEditor.tsx, EventDetailScreen.tsx, EventBubble.tsx (Karte im Chat), EventRow.tsx, AgendaView.tsx; Hilfen in helpers.ts; Server apps/api/src/modules/calendar.rs, dto.rs, ical.rs). Der Ort erscheint in Detailansicht, Chatkarte und Listen als Text.

DEINE AUFGABE – NUR ENTWURF, noch kein Produktivcode:
1. LESEN: wo der Ort überall angezeigt wird (grep nach location und Ort in apps/web/src, auch die Chatkarte, Einladungen, Kalender-Abo/ical.rs, Benachrichtigungen/Push-Texte in apps/api), wie Sheets/Menüs in der App gebaut sind (components/Sheet.tsx, bestehende Auswahlblätter), wo Einstellungen des Anwenders liegen (modules/profile, state/ui.ts, localStorage-Schlüssel "initiative.*").
2. RECHERCHE der URL-Formen (aus deinem Wissen, ohne Netz nötig): Karten-Apps, die sich mit reinen Links öffnen lassen, ohne Schlüssel und ohne Kosten: Systemstandard über geo:-Adresse (Android), Apple Karten (maps.apple.com), Google Maps (Such- und Routenlinks "Maps URLs"), OpenStreetMap, Waze, HERE WeGo, Bing Karten, Organic Maps/Magic Earth o.ä. nur wenn verlässlich. Für jede: Suche nach Text, Route dorthin, Verhalten auf iOS/Android/Desktop, ob eine installierte App sich über den Link öffnet, Kodierung, bekannte Stolpersteine. Keine eigene Geokodierung, keine Kartenkacheln von fremden Servern, keine Vorschaukarte, nichts wird an uns oder Dritte geschickt, bevor der Anwender tippt.
3. ENTWURF (schreibe ${S}/ergebnis-wt-ort/entwurf.md, deutsch):
 a) Erkennung (reine Funktionen, eigene Datei z.B. apps/web/src/lib/adresse.ts mit Einheitentests): Was gilt als Adresse – Strasse + Hausnummer (Deutschland, Österreich, Schweiz, dazu verbreitete Muster aus Nachbarländern: "Hauptstr. 5a", "Am Markt 3", "Berliner Allee 12-14", "Via Roma 12", "12 Main Street", "Rue de la Paix 4"), PLZ + Ort (4- und 5-stellig, mit Ländervorsatz D-/A-/CH-), Koordinaten (Dezimal, Grad/Minuten), Mischformen mit Namen ("Vereinsheim, Hauptstr. 5, 12345 Berlin"). Was ist KEINE Adresse (Raum 2.14, "12.30 Uhr", Datumsangaben, "Zoom", Links, "bei Oma"). Gib eine Stufe der Sicherheit aus (sicher / vermutlich / offener Text). Web-Adressen im Ort (Zoom, Teams, Meet) werden als gewöhnliche Links erkannt und geöffnet (nur http/https, rel="noopener noreferrer"). Ein Test mit vielen Positiv- und Negativbeispielen, auch schwierigen.
 b) Karten-Links (reine Funktionen, z.B. lib/karten.ts): je App eine Funktion Text → URL (korrekt kodiert), plus Route. Liste der Apps, Reihenfolge, Namen auf Deutsch.
 c) Oberfläche: der Ort wird an allen Stellen zu einem Link; Tipp öffnet ein Auswahlblatt „Öffnen mit" mit den Apps, „Adresse kopieren" und – wo sinnvoll – „Route"; die Wahl wird gemerkt (localStorage, try/catch) und beim nächsten Tipp gleich benutzt, mit einem Weg, die Wahl zu ändern (im Blatt selbst und unter Profil → Einstellungen „Karten-App"); Verhalten, wenn der Ort kein Adresstext ist (Link „Auf Karte suchen" zurückhaltender). Alle Eingeladenen sehen den Link, jeder mit SEINER Karten-App. Barrierefrei (Rollen, Namen, Fokus), auf 375 px bedienbar. Wo im Editor ein Hinweis unter dem Feld „Ort" sinnvoll ist („Adresse erkannt – Eingeladene können sie in ihrer Karten-App öffnen").
 d) Sicherheit und Datenschutz: nichts wird ohne Tipp geladen; Kodierung gegen Einschleusen; Datenschutz-Hinweis im Blatt, dass beim Öffnen die Adresse an die gewählte App geht.
 e) ABNAHMEKRITERIEN mit Tests (Einheit und Browser).
 f) Verworfene Alternativen (eigene Geokodierung, eingebettete Karte) und warum.
Gib die Entwurfsdatei, eine Zusammenfassung, die Abnahmekriterien und Risiken zurück.`,
  bau: `
THEMA: Ort als Adresse – UMSETZUNG des Entwurfs.
Der Entwurf liegt unter {ENTWURF}. Lies ihn vollständig und halte dich daran; Abweichungen nur mit Grund (ins Ergebnis schreiben).
Liefere: (1) lib-Module mit vielen Einheitentests (Erkennung, Links); (2) Komponente(n) und das Auswahlblatt, in Detailansicht, Chatkarte, Listen, Agenda und überall sonst, wo der Ort steht; (3) Einstellung „Karten-App" im Profil; (4) Browser-Tests mit Anmeldung (Nutzer registrieren sich selbst, siehe e2e/termine.spec.ts): Termin mit Adresse anlegen, als Eingeladener die Detailansicht und die Chatkarte öffnen, Blatt erscheint, Links stimmen (href prüfen, nicht wirklich navigieren), Wahl wird gemerkt; (5) Doku als neuer Unterabschnitt „Adressen und Karten" im Abschnitt „Kalender" von docs/FEATURES.md. Am Ende: tsc, prettier, ganze vitest-Suite, die Browser-Tests, die du geschrieben hast, plus e2e/termine.spec.ts und e2e/events.spec.ts (falls vorhanden) grün, committen.`,
  linsen: [
    'Erkennung und Links: Fehlalarme und Fehlschläge der Erkennung (viele echte Beispiele aus DE/AT/CH und Nachbarländern, Unicode, Sonderzeichen, sehr lange Texte, Zeilenumbrüche, Injektion in URLs: Kodierung von Leerzeichen, &, #, ?, Anführungszeichen, %, Klammern), stimmen die Linkformen der Apps wirklich (Syntax der Anbieter, iOS-/Android-Verhalten), Protokolle (nur https/geo), rel-Attribute.',
    'Oberfläche, Datenschutz und Tests: alle Stellen, an denen der Ort steht, sind erfasst (grep), Blatt und Wahl merken (localStorage ohne Absturz im privaten Modus), Barrierefreiheit, 375 px, Texte, nichts wird ohne Tipp geladen, CSP/Header der App (apps/web/public/_headers) kollidiert nicht, Stabilität und Aussagekraft der Browser-Tests.',
  ],
}

const SAMMLUNG = {
  key: 'sammlung',
  name: 'wt-sammlung',
  branch: 'e-sammlung',
  port: 5195,
  entwurf: `
THEMA: Termine – „Sammlung verknüpfen": auch eine NEUE Sammlung anlegen, wahlweise als Unterordner.

WUNSCH: „Bei Sammlung verknüpfen sollte man nicht nur eine bestehende Sammlung verknüpfen können, sondern auch wahlweise eine erstellen können (auch in einem Unterordner, wobei ich mit Ordner Sammlungen meine)."

STAND: apps/web/src/modules/calendar/EventCollection.tsx verknüpft eine bestehende Sammlung (API: PATCH /calendar/events/{id}/collection in apps/api/src/modules/calendar.rs, link_collection; Rechte: require_collection(..., Level::Edit)). Sammlungen sind verschachtelbar (apps/api/src/modules/collections.rs: parent_id, COLLECTION_DEPTH_MAX, Rechte im Elternordner; Web: modules/files und lib/api.ts). Der Termin hat "collection_id"; die Dokumente am Termin (EventDocuments.tsx) liegen dann in der Sammlung. Zugriff der Eingeladenen auf die Sammlung: apps/api/src/services/zugriff.rs und permissions.rs – lies genau, wie ein Eingeladener an Dateien einer verknüpften Sammlung kommt.

DEINE AUFGABE – NUR ENTWURF, noch kein Produktivcode:
1. LESEN aller genannten Stellen; wie die Dateiverwaltung Sammlungen und Unterordner anzeigt und auswählt (vorhandene Auswahl-/Baumkomponenten wiederverwenden!), wie Sammlungen angelegt werden (Web-API), Rechte, Mitglieder, Freigabe (member_level, Mitglieder, conversation_id), und was beim Verknüpfen mit den Zugriffsrechten der Eingeladenen geschieht.
2. ENTWURF (schreibe ${S}/ergebnis-wt-sammlung/entwurf.md, deutsch):
 a) Ablauf in der Oberfläche: Im Blatt/Abschnitt „Sammlung" zwei Wege – „Bestehende verknüpfen" (wie heute) und „Neue anlegen": Name (vorbelegt mit dem Termintitel), Ordner (oberste Ebene oder unter einer bestehenden Sammlung als Unterordner: Auswahl als Baum mit Einrückung, nur Sammlungen, in denen man ändern darf; Tiefengrenze mit verständlichem Hinweis), danach legt die App die Sammlung an und verknüpft sie in einem Zug. Fehlerfälle: Anlegen klappt, Verknüpfen nicht (aufräumen oder klar melden), Rechte fehlen, Tiefe überschritten, Name leer/zu lang, Doppelklick, offline.
 b) Zugriff: Wer darf die neue Sammlung sehen und füllen? Stelle fest, was beim Verknüpfen einer BESTEHENDEN Sammlung für die Eingeladenen gilt, und mache die neue konsistent (Mitglieder/Freigabe für die Eingeladenen, oder was der Bestand vorsieht). Keine stille Rechteausweitung: Der Anwender soll sehen, wer Zugriff bekommt.
 c) Muss der Server etwas ändern (ein atomarer Weg „anlegen und verknüpfen"), oder reicht der Bestand (anlegen, dann verknüpfen, bei Fehler aufräumen)? Bevorzuge Web-only; wenn der Server nötig ist, beschreibe die Änderung genau (kein Migrationsbedarf erwartet) – ausgeführt wird sie später vom Lead.
 d) Wo in der Oberfläche die verknüpfte Sammlung danach sichtbar ist (Link zu ihr, Pfad „Eltern › Kind").
 e) ABNAHMEKRITERIEN mit Tests (Einheit und Browser mit Anmeldung, siehe e2e/termine.spec.ts).
Gib die Entwurfsdatei, eine Zusammenfassung, die Abnahmekriterien und Risiken zurück.`,
  bau: `
THEMA: Sammlung neu anlegen und verknüpfen – UMSETZUNG des Entwurfs.
Der Entwurf liegt unter {ENTWURF}. Lies ihn vollständig und halte dich daran; Abweichungen nur mit Grund (ins Ergebnis schreiben). Falls der Entwurf eine Serveränderung verlangt: NICHT umsetzen (der API-Server wird hier nicht gebaut), sondern im Ergebnis unter "offen" genau beschreiben, und die Oberfläche so bauen, dass sie mit dem Bestand funktioniert.
Liefere: Oberfläche und Logik in EventCollection.tsx (und neuen Dateien), Einheitentests, Browser-Tests mit Anmeldung (Anlegen oberste Ebene, Anlegen als Unterordner, Fehlerfälle, danach ist die Sammlung verknüpft und ein Eingeladener kommt – soweit vorgesehen – an die Dateien), kurze Doku im Unterabschnitt „Dateien am Termin" von docs/FEATURES.md. Am Ende: tsc, prettier, ganze vitest-Suite, deine Browser-Tests plus e2e/termine.spec.ts grün, committen.`,
  linsen: [
    'Rechte und Daten: wer sieht/füllt die neue Sammlung, keine stille Ausweitung, Tiefengrenze, Eltern-Rechte, Aufräumen bei halbem Erfolg, Doppelklick/Wettlauf, gelöschte Eltern, Sammlungen anderer Nutzer, Konsistenz mit dem Verknüpfen einer bestehenden Sammlung und mit dem Lösen der Verknüpfung.',
    'Oberfläche und Tests: Baumauswahl (Tastatur, Screenreader, 375 px), Texte, Fehlermeldungen, vorhandene Komponenten wiederverwendet statt nachgebaut, Stabilität und Aussagekraft der Browser-Tests.',
  ],
}

const ITEMS = [BLUR, WISCH, BEREICHE, ORT, SAMMLUNG]

/* ------------------------------------------------------- Pipeline je Thema */

function schluessel(b) {
  return `${b.datei}|${b.titel}`
}

const ergebnisse = await pipeline(
  ITEMS,
  // 1. Entwurf
  (it) =>
    agent(`${regeln(it)}\n${it.entwurf}`, {
      label: `entwurf:${it.key}`,
      phase: 'Entwurf',
      schema: ENTWURF_SCHEMA,
    }),
  // 2. Bauen
  (entwurf, it) => {
    if (!entwurf || !entwurf.datei) throw new Error(`kein Entwurf für ${it.key}`)
    log(`${it.key}: Entwurf ${entwurf.datei}`)
    return agent(`${regeln(it)}\n${it.bau.replace('{ENTWURF}', entwurf.datei)}\n\nWICHTIG: Ein früherer Lauf dieser Umsetzung wurde unterbrochen (Nutzungsgrenze). Der Arbeitsbaum kann schon angefangene Arbeit enthalten: prüfe zuerst  git log ${BASIS}..HEAD , git status und git diff. Das Vorhandene ist UNGEPRÜFT – lies es kritisch, übernimm das Brauchbare, behebe Fehler und mache dann weiter, statt neu anzufangen. Committe früh und oft, damit eine erneute Unterbrechung nichts kostet.`, {
      label: `bauen:${it.key}`,
      phase: 'Bauen',
      schema: BAU_SCHEMA,
    }).then((bau) => {
      if (!bau) throw new Error(`Bauen fehlgeschlagen: ${it.key}`)
      return { entwurf, bau }
    })
  },
  // 3. Prüfen (je Linse ein Prüfer)
  (stand, it) =>
    parallel(
      it.linsen.map((linse, i) => () =>
        agent(
          `${regeln(it)}
DU BIST PRÜFER (nur lesen und ausführen, NICHTS ändern, nichts committen). Geprüft wird der Zweig ${it.branch} gegen ${BASIS}:  git -C ${S}/${it.name} diff ${BASIS}..HEAD  und die neuen Dateien. Der Entwurf: ${stand.entwurf.datei}. Die Anforderungen: ${S}/anforderungen-2.md.
DEINE LINSE: ${linse}
Suche konkrete Fehler mit Datei:Zeile und einem Szenario (Eingaben/Zustand → falsches Verhalten). Kein Stil, keine Spekulation ohne Mechanismus. Wo es geht, WEISE DEN FEHLER NACH (ein kurzer Test oder Lauf im Arbeitsbaum – aufräumen, nichts im Repo hinterlassen, Hilfsdateien nach ${S}/ergebnis-${it.name}/). Liefere höchstens 10 Befunde, die schwersten zuerst.`,
          { label: `prüfen:${it.key}:${i + 1}`, phase: 'Prüfen', schema: BEFUNDE_SCHEMA },
        ),
      ),
    ).then((listen) => {
      if (listen.some((l) => !l)) throw new Error(`Prüfer fehlgeschlagen: ${it.key}`)
      const alle = []
      const gesehen = new Set()
      for (const l of listen.filter(Boolean)) {
        for (const b of l.befunde || []) {
          const k = schluessel(b)
          if (gesehen.has(k)) continue
          gesehen.add(k)
          alle.push(b)
        }
      }
      return { ...stand, befunde: alle }
    }),
  // 4. Gegenprobe
  (stand, it) => {
    if (!stand.befunde.length) return { ...stand, bestaetigt: [], verworfen: [] }
    return agent(
      `${regeln(it)}
DU BIST SKEPTIKER (nur lesen und ausführen, NICHTS ändern, nichts committen). Prüfer haben die folgenden Befunde zum Zweig ${it.branch} gemeldet. Versuche JEDEN zu WIDERLEGEN: lies die tatsächlichen Codewege (Aufrufer, Schutzbedingungen, Reacts Verhalten, Verträge der Bibliotheken), führe wo möglich einen Nachweis aus. echt=true NUR, wenn du das Szenario wirklich bestätigen kannst; bei Zweifel echt=false. Behalte die Titel unverändert.

${JSON.stringify(stand.befunde, null, 2)}`,
      { label: `gegenprobe:${it.key}`, phase: 'Gegenprobe', schema: URTEILE_SCHEMA },
    ).then((u) => {
      if (!u) throw new Error(`Gegenprobe fehlgeschlagen: ${it.key}`)
      const urteile = (u && u.urteile) || []
      const bestaetigt = []
      const verworfen = []
      for (const b of stand.befunde) {
        const v = urteile.find((x) => x.titel === b.titel)
        if (v && v.echt) bestaetigt.push({ ...b, begruendung: v.begruendung })
        else verworfen.push({ titel: b.titel, grund: v ? v.begruendung : 'kein Urteil' })
      }
      return { ...stand, bestaetigt, verworfen }
    })
  },
  // 5. Beheben
  (stand, it) => {
    if (!stand.bestaetigt.length) {
      return { key: it.key, entwurf: stand.entwurf, bau: stand.bau, bestaetigt: 0, verworfen: stand.verworfen.length, behoben: null }
    }
    return agent(
      `${regeln(it)}
BEHEBEN. Die folgenden Befunde zum Zweig ${it.branch} sind von einem Skeptiker bestätigt worden. Behebe jeden: zuerst den Fehler mit einem Test nachstellen (wo möglich), dann die KLEINSTE passende Änderung, dann prüfen. Wo du einen Befund nach genauem Hinsehen nicht für richtig hältst, schreibe das mit Begründung ins Ergebnis, statt etwas zu ändern. Am Ende tsc, prettier, ganze vitest-Suite und die Browser-Tests deines Themas (Dateien, die du oder der Bau geschrieben hat, plus die bestehenden betroffenen) grün, dann committen.

${JSON.stringify(stand.bestaetigt, null, 2)}`,
      { label: `beheben:${it.key}`, phase: 'Beheben', schema: BEHOBEN_SCHEMA },
    ).then((behoben) => {
      if (!behoben) throw new Error(`Beheben fehlgeschlagen: ${it.key}`)
      return {
      key: it.key,
      entwurf: stand.entwurf,
      bau: stand.bau,
      bestaetigt: stand.bestaetigt.length,
      verworfen: stand.verworfen.length,
      behoben,
    }
    })
  },
)

log('fertig: ' + ergebnisse.filter(Boolean).map((e) => e.key).join(', '))
return ergebnisse.filter(Boolean)
