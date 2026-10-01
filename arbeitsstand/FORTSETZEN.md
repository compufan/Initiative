# Arbeitsstand der zweiten Runde – pausiert, zum Fortsetzen gesichert

Angehalten auf Wunsch des Anwenders (die Läufe kosten zu viel Guthaben). Nichts ist verloren: Jeder Arbeitsbaum
ist als Zweig `wip/…` gesichert, die Entwürfe, Messungen und Skripte liegen in diesem Ordner.

Der Wunsch des Anwenders steht wörtlich in `anforderungen-2.md`, dazu die verbindliche Auslegung.

## Wo liegt was

| Thema | Zweig auf GitHub | Stand |
|---|---|---|
| **Einladen** (alle Personen, Gruppenchat, Zustellung, Synchronität) | `claude/initiative-pwa-messenger-4b5ms6` (Hauptzweig) | Entwurf, API (Migration 0023), Oberfläche, Browser-Tests mit mehreren Nutzern, Doku – **gebaut UND geprüft** (Prüfer, Gegenprobe, Beheben sind durchgelaufen). Offen: die Abnahme über beide Termin-Themen. |
| **Erinnern** an ausstehende Antworten | Entwurf: `ergebnis/ergebnis-events/entwurf-erinnern.md`; Code: `wip/erinnern-api` | Entwurf fertig. API-Teil 1 angefangen (Migration 0024, Dienst, Konfiguration, Programm `erinnern_einmal`, Tests – **nicht gebaut, nicht geprüft**). Offen: API-Teil 2 (Einstellung, Aufräumen, Push), Oberfläche, Prüfung, Abnahme. |
| **Weichzeichnen und Bokeh** | `wip/v-blur` (11 Commits) | Entwurf mit Messung und Prototyp fertig. Gebaut: Feld `bokeh`, Rechnung auf Prozessor und Grafikeinheit, zwei Regler, Browser-Tests, Doku. Offen: Prüfung (3 Linsen), Gegenprobe, Beheben, volle Testläufe. |
| **Wischen mit Masken (Wischspeicher)** | `wip/v-wisch` (14 Commits) | Entwurf mit Messung vorher fertig. Gebaut: Wischspeicher, Zeichenweg, Ruhetor, Tests, Doku. Offen: Messung nachher, Prüfung, Gegenprobe, Beheben, volle Testläufe. |
| **Mehrere Bereiche im Video** | `wip/v-bereiche` (7 Commits) | Prüfung und Entwurf fertig (Gründe: ein Teil je Gegenstand fehlte, zwei getrennte Auswahlen). Gebaut: eine Auswahl, ein Teil je Gegenstand, Leiste fürs Telefon, Namen, Verfolgung bis zum Bildrand, Tests, Doku. Bekannte Grenze: Verdeckung (der verdeckende Gegenstand nimmt die Maske mit) – eigenes Vorhaben. Offen: Prüfung, Gegenprobe, Beheben. |
| **Ort als Adresse** | `wip/e-ort` (5 Commits) | Entwurf fertig. Gebaut: Erkennung, Karten-Links, gemerkte Karten-App, Ortszeile, Auswahlblatt, Browser-Tests, Doku, Datenschutz. Offen: Prüfung, Gegenprobe, Beheben. |
| **Sammlung neu anlegen (auch als Unterordner)** | `wip/e-sammlung` (4 Commits, der letzte ist ein WIP-Stand) | Entwurf fertig. Gebaut: Ordnerwahl als Liste mit Einrückung, Berechnung des Zugriffs, Oberfläche (teilweise). Offen: Fertigstellen, Tests, Doku, Prüfung. |

Ausgangspunkt aller `wip/…`-Zweige (ausser `wip/erinnern-api`, das auf dem Hauptzweig aufsetzt): Commit `d786eab`.
Beim Zusammenführen sind Überschneidungen zu erwarten in `docs/FEATURES.md` (jeder Zweig ergänzt seinen Abschnitt),
in `apps/web/src/modules/calendar/` (Ort, Sammlung, Einladen, Erinnern) und in `apps/web/src/modules/video/` und
`apps/web/src/modules/bild/` (Weichzeichnen, Wischen, Bereiche).

## Bekannte Befunde, die nicht Teil des Auftrags waren

- **Die Erinnerungen vor dem Termin („10 Min / 1 Std / 1 Tag vorher") werden von niemandem ausgeliefert.** Der Wert
  `reminder_minutes` wird nur in die `.ics`-Ausgabe geschrieben. Beleg: `ergebnis/ergebnis-events/bestand-erinnern.md`,
  Abschnitt 2. Der Dienst für das Erinnern an Antworten könnte sie mit ausliefern – das ist eine Entscheidung des Anwenders
  (Push oder Chatnachricht?), noch nicht gefallen.
- Zwei Funde zum Einladen (403 für Eingeladene ausserhalb des Chats, Karte mit fremder Kennung zeigt den ganzen Termin)
  sind im Hauptzweig behoben.

## So geht es weiter

1. Aufräumen und holen: `git fetch origin`. Je Zweig einen Arbeitsbaum anlegen, z.B.
   `git worktree add <Ordner> wip/v-blur`; Abhängigkeiten per Symlink aus dem Hauptbaum teilen
   (`skripte/wt-neu.sh` zeigt die Handgriffe: `node_modules`, `apps/web/node_modules`, `packages/shared/node_modules`,
   `apps/web/public/{icons,mediapipe,models,marke}`). Die Playwright-Konfigurationen stehen in `pw/`, Dev-Server und
   Server in `skripte/vite-neu.sh` und `skripte/api-neu.sh`. **Pfade in den Skripten anpassen** (sie zeigen auf das
   Arbeitsverzeichnis des früheren Containers).
2. Erst lesen, dann prüfen: Der Stand jedes `wip/…`-Zweigs ist **ungeprüft**. Zuerst `npx tsc -p tsconfig.json --noEmit`,
   `npx vitest run`, dann die Browser-Tests des Themas.
3. Dann die fehlenden Stufen laufen lassen (Prüfer mit je einer Linse → Skeptiker → Beheben). Die Skripte der beiden Läufe
   liegen in `workflows/` (`video-foto-events-web.js`, `events-einladen-erinnern.js`), samt Prompts und Linsen; die
   Entwürfe sind fertig und werden NICHT neu geschrieben. Ein Fortsetzen mit `resumeFromRunId` geht nur in derselben
   Sitzung (Läufe `wf_95f64787-69a` und `wf_02e83ed2-acb`); in einer neuen Sitzung beginnt man bei „Prüfen" mit den
   Entwurfsdateien als Grundlage.
4. Erinnern fertig bauen (Entwurf `entwurf-erinnern.md`), Migration 0024.
5. Zusammenführen in den Hauptzweig (Konflikte siehe oben), volle Tests, Doku, pushen.

## Beschränkungen der Maschine

Vier Kerne, 15 GB Arbeitsspeicher: Je Lauf arbeiten höchstens zwei Agenten zugleich. Mehrere Läufe gleichzeitig verlängern
sich entsprechend. Läufe bis hierher: etwa 14 Stunden Rechenzeit, mehrere Millionen Token.

## Dateien in diesem Ordner

- `anforderungen-2.md` – Wunsch des Anwenders, Grundsätze, Auslegung
- `ergebnis/ergebnis-wt-blur`, `-wisch`, `-bereiche`, `-ort`, `-sammlung`, `ergebnis-events` – Entwürfe (`entwurf.md`),
  Messungen, Prototypen und Messgeräte (Skripte; Bilder und grosse Ausgaben sind nicht gesichert)
- `workflows/` – die zwei Skripte und die Journale der Läufe
- `skripte/`, `pw/` – Hilfsskripte und Playwright-Konfigurationen
