# Entwurf: Pressen (Echtzeit-Trinkspiel)

Die vorhandenen Spiele sind rundenbasiert: ein Zug, der Server prüft ihn mit
seiner Rust-Regel, der Stand geht per `game.updated` an alle. „Pressen“ ist
Echtzeit. Der Entwurf lässt Sitzung, Zug-API und Realtime im Kern unverändert und
hängt nur das **Ergebnis eines Laufs** als Zug ein – dazu eine kleine Wahl vor dem
Start und, neu, eine **Sicht je Person**, damit fremde Zeiten bis zum Rundenende
verborgen bleiben.

## Aufteilung

| Was                                                          | Wo                                                                                                                   | Warum dort                                                                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physik (Glas in zwei Achsen, Neigung, Strahl, Mund, Abdrift) | `packages/shared/src/games/pressen-sim.ts`                                                                           | Reine Funktion mit festem Zeitschritt (20 ms) und Eingaben als Zeitstempel-Ereignissen „Taste runter/hoch“. Jeder Client rechnet seinen Lauf selbst; so fühlt sich die Steuerung ohne Netzwerk-Latenz an. |
| Wertung, Rollen, Malus, Start, Zugregeln                     | `packages/shared/src/games/pressen.ts` **und** `apps/api/src/games/pressen.rs`                                       | Wie bei allen Spielen: Der Server entscheidet (Rust), der Client hat die gleiche Regel für die sofortige Anzeige. Beide laufen gegen dieselben Testfälle (`testdaten/pressen.json`).                      |
| Sicht je Person (nur der eigene Lauf)                        | `GameDefinition::fuer_betrachter` in `apps/api/src/games/`                                                           | Der Server schwärzt auf **jedem** Weg nach draußen (siehe unten).                                                                                                                                         |
| Strichmännchen eines Kontos                                  | `pressen-figur.ts` / `pressen_figur.rs`, gespeichert in `users.settings.modules.pressenFigur`                        | Je Konto, über Geräte und Spiele hinweg; Grenzen auf beiden Seiten.                                                                                                                                       |
| Auslöser „Bierjunge“ / „hängt“                               | `apps/api/src/services/bierjunge.rs`, Migration `0026_bierjunge.sql`                                                 | Serverseitig beim Anlegen einer Textnachricht, damit es für alle Clients gleich wirkt.                                                                                                                    |
| Darstellung, Eingabe                                         | `apps/web/src/modules/games/boards/PressenBoard.tsx`, `PressenFigur.tsx`, `PressenFigurEditor.tsx`, `pressenLauf.ts` | wie die anderen Bretter, Eintrag in `boards/registry.ts`                                                                                                                                                  |

Ein Zug ist entweder `{ typ: 'ergebnis', runde, dauerMs, verschuettetDezi,
reaktionMs, vorzeitig, verzoegerungMs, versatzMs }` oder `{ typ: 'start', art:
'echtzeit' | 'asynchron' }`. Der Server wertet selbst (Dauer + Strafzeit), setzt
Atempo/Sieg und schaltet den nächsten Läufer frei. Gleichzeitiges Melden
kollidiert an der Versionsprüfung der Sitzung; für Spiele mit `echtzeit: true`
sendet der Client den Zug nach frischem Laden erneut (ein Lauf ist je Sitz und
Runde einmalig, doppeltes Senden wird abgelehnt).

## Die Bühne: von oben, leicht geneigt

Man schaut von oben auf die Tischplatte (1000 × 600 Einheiten). Das Glas hat zwei
Lageachsen – `x` links/rechts und `y` vor/zurück (im Bild unten/oben) – plus die
Neigung. Der Mund ist ein **Oval** (Halbachsen 62 × 42) bei `(500, 210)`.

Das Bier verlässt das Glas am vorderen Rand und fällt in einer Parabel:

```
Landepunkt x = x + vx · 0,22 s
Landepunkt y = y + vy · 0,22 s − (55 + 2 · Grad über der Kippschwelle)
```

Je weiter geneigt, desto weiter fliegt der Strahl nach vorn; die eigene Bewegung
fliegt ein Stück mit. **Nur was im Oval landet, ist getrunken**, alles andere
ist verschüttet. Also muss man das Glas nicht nur links/rechts über den Mund
bringen, sondern auch vor/zurück zur passenden Entfernung – und die ändert sich
mit der Gießstärke. Der Mund nimmt weiter höchstens 30 ml/s auf und fasst 25 ml
auf einmal.

Tasten: Pfeiltasten (alle vier) bewegen das Glas, Leertaste neigt, Esc stellt
vorzeitig ab. Touch: ein Steuerkreuz aus vier Knöpfen plus „Neigen“.

## Wie sich die Tasten anfühlen

Alles in `pressen-sim.ts`, nur `+ − × ÷` und Vergleiche (damit jeder Browser
bitgleich rechnet – die Abdrift ist deshalb eine Tabelle fertiger Richtungen
statt `sin`/`cos`).

- **Trägheit:** Eine Taste setzt nur ein Ziel-Tempo; die Geschwindigkeit holt es
  mit begrenzter Beschleunigung ein (620 Einheiten/s²).
- **Nichtlinear:** Das Ziel-Tempo hängt davon ab, wie lange die Taste schon
  gehalten wird: 22 Einheiten/s bei kurzem Druck („sehr langsam“), bis 340 nach
  1,25 s. Die Kurve ist quadratisch. Dasselbe gilt für das Neigen (7 bis 46 °/s).
  Ein Richtungswechsel beginnt die Kurve von vorn.
- **Gleiten:** Wer loslässt, bremst nicht abrupt – die Geschwindigkeit klingt mit
  einer Dämpfungsrate von 2,4/s ab (Halbwertszeit ca. 0,3 s, das Glas rutscht noch
  ein Stück). Gegenhalten bremst mit der Beschleunigung.
- **Abdrift:** Eine langsam wechselnde Beschleunigung (46 Einheiten/s², alle 3 s
  eine neue Richtung, dazwischen übergeblendet) schiebt das Glas immer leicht weg.
  Sie hängt **nur von der Runde** ab (`driftSeedFuer(runde)`, ganze Zahlen),
  nicht vom Gerät und nicht vom Sitz: Beide im Duell haben dieselben
  Bedingungen, und eine Wiederholung rechnet dasselbe.
- **Malus = Ermüdung:** Der Malus ist jetzt ein **Ermüdungswert** (0 bis 250
  „ms“). Er verzögert wie bisher Tastendruck und Loslassen, steuert aber auch die
  Physik (`physikFuer`): bei voller Ermüdung ist die Beschleunigung um 35 %
  geringer (träger), die Dämpfung halbiert (das Glas gleitet weiter), die Kurve
  geht von quadratisch Richtung kubisch (derselbe Druck bleibt länger kriechend),
  die Drehung des Glases ist träger und die Abdrift 40 % stärker.
  Auch **ausgeruht** gibt es Trägheit, Gleiten, Kurve und Abdrift – der Malus
  verstärkt sie nur. Er wächst weiter pro gespielter Runde um 40 (höchstens 250),
  nach zwei Minuten ist die Hälfte weg, im Spiegelmodus wächst er nicht, und er
  wird **angezeigt**: ein beschrifteter Balken „Malus (Ermüdung)“ mit Wert
  (`role="meter"`, Erklärung für Vorlesehilfen), im Lauf auch in der Kopfzeile.

## Balancing (gemessen)

Bots mit Regler laufen durch die **echte** Simulation (`pressen-bot.hilfe.ts`):
Sie schätzen, wo der Strahl landen würde, gleiten aufs Ziel zu (drücken, wenn die
Gleitstrecke zu kurz ist, gegenhalten bei Überschuss), kippen erst, wenn der
Landepunkt im Mund liegt, und sehen den Zustand mit einer menschlichen
Verzögerung (`reaktionTicks`, 8 Schritte = 160 ms) plus der Tastenverzögerung.
Mittel über acht Runden-Seeds (Wertung in s = Dauer + Strafe; ml verschüttet):

| Profil                                  | Malus 0         | 60         | 120        | 180        | 250         |
| --------------------------------------- | --------------- | ---------- | ---------- | ---------- | ----------- |
| ausgewogen (Ziel 20° über der Schwelle) | 16,6 s / 0,2 ml | 20,1 / 4,9 | 22,1 / 8,0 | 26,1 / 8,8 | 38,2 / 16,8 |
| hastig (60°, Fenster weit)              | 73,4 / 158 ml   | 72,4 / 156 | 69,4 / 150 | 66,9 / 144 | 75,9 / 151  |
| vorsichtig (6°)                         | 124 s / 0 ml    | 111 / 0    | 185 / 0    | 181 / 0    | 142 / 4     |

Gießstärke (Grad über der Kippschwelle) bei Malus 0, Wertung in s: 4° → 183, 8° →
71, 12° → 40, 16° → 22, 20° → 16,6, 22° → 14,9, **25° → 13,4 (Optimum)**, 30° →
18,6 (40 ml verschüttet), 40° → 41,5, 60° → 69, 100° → 77. Bei Malus 250 liegt das
Optimum bei 22° (35,7 s). Es gibt also ein Tal, keine Rampe.

Wahrnehmungsverzögerung des ausgewogenen Bots bei Malus 0: 80 ms → 14,1 s, 160 ms
→ 16,6 s, 200 ms → 17,8 s / 2,3 ml, 240 ms → 21,7 s / 9,3 ml. Wer ohne die zweite
Achse steuert (nur links/rechts), verschüttet über 250 ml.

Gelesen: Ein ausgewogener Spieler trifft den Mund zuverlässig (unter 1 ml
daneben), aber nicht mühelos – wer langsamer reagiert, spürt es in Zeit und
Pfützen. Sehr hastig und sehr vorsichtig bleiben beide deutlich schlechter
(Faktor 4 bis 8). Späte Runden sind mit 2,3× der Wertung spürbar schwerer, bleiben
aber machbar (16,8 ml daneben, 36 s). Die Tests (`pressen.test.ts`, „Balance“ und
„Die neue Physik …“) halten diese Zusammenhänge fest, nicht die genauen Zahlen.
Ein echter Spieltest mit Menschen steht aus (siehe „Offen“).

Die Mund-Größe (62 × 42) und die Strahlweite (2 Einheiten je Grad) sind das
Ergebnis dieser Messreihe: Mit 4,5 Einheiten je Grad und einem Mund von 54 × 38
schwankte schon ein Grad Neigung den Landepunkt aus dem Mund. Ein Bot mit nur
100 ms Wahrnehmungsverzögerung brauchte 30 s und verschüttete 25 bis 45 ml, einer
mit 160 ms kam kaum noch ans Ziel – zu schwer.

## Wertung

`wertungMs = dauerMs + Strafe(verschüttet)`,
`Strafe = 100 ms/ml · v + 2 ms/ml² · v²`. Die quadratische Komponente macht
„schnell und schlampig“ teuer (200 ml ≈ 100 s Strafe), die lineare verhindert,
dass ein paar verlorene Tropfen gratis sind. Atempo: Unterschied < 250 ms (je
Team mal Läuferzahl).

## Modi und Rollen (`planFuer(n)`)

- 1 Person: **gegen den Spiegel**. Das zweite Männchen trinkt synchron, also
  gleiche Wertung, also **immer Atempo**. Jede weitere Runde beginnt **erst mit
  „Anstoßen“** (früher startete sie nach 2,6 s von selbst – das ist weg: ein Lauf
  beginnt nie ohne den Knopf), bis jemand aufgibt. Der Malus wächst nicht. Der
  Spiegel ist eine **Übung ohne Chat** (siehe „Übung ohne Chat“).
- 2: Duell, beide gleichzeitig.
- 3: **Ampel** ist der dritte Sitz. Er trinkt und stellt ab, danach starten die
  beiden anderen. Seine Zeit wird nicht gewertet.
- ab 4: **Staffette**. Läufer 0, 2, 4 … bilden Team A, 1, 3, 5 … Team B. Aus
  jedem Team läuft immer einer; der nächste darf, sobald der Teamkollege
  abgestellt hat. Teamwertung = Summe der Läuferwertungen. Bei ungerader Zahl
  macht der letzte Sitz zuerst die Ampel.
- Die Aufstellung steht beim Anlegen fest (`can_join` lehnt Beitritt ab).

## Start: Echtzeit **und** asynchron

Beides ist möglich. Es zählt nur die Zeit und das verschüttete Bier.

**Wer gehört zu einer Gruppe?** Nur Sitze, die **gleichzeitig** loslaufen dürfen,
stimmen sich ab: im Duell beide, in der Staffette die beiden Erstläufer, nach der
Ampel die beiden Teams. Ein Einzelner (Spiegel, Ampel, Staffetten-Nachfolger)
hat nichts abzustimmen: Seine Zeit zählt immer **ab seinem eigenen „Anstoßen“** –
er hängt ja an der Reihenfolge, nicht am Gegenüber. (Entscheidung zu Ampel und
Staffette; die Reihenfolgenregel bleibt, die bestehenden Tests laufen
unverändert.)

**Vor dem Start** wählt jeder in der Gruppe _Zusammen (Echtzeit)_ oder _Wann ich
will (asynchron)_:

- Wählt **einer** asynchron, spielen **alle** zeitlich unabhängig; die Zeit zählt
  ab dem eigenen „Anstoßen“. Asynchron ist endgültig (kein Zurück zu Echtzeit).
- Bei **Echtzeit** bestätigen alle innerhalb von **10 s** („bereit“, sichtbarer
  Countdown). Sobald der Letzte bestätigt hat, setzt der Server den **gemeinsamen
  Beginn** auf _Serverzeit der letzten Bestätigung + 3 s_ (Countdown 3-2-1).
  Danach läuft die Uhr für alle – auch bevor jemand „Anstoßen“ gedrückt hat.
  **Wer 2 s später anstößt, ist 2 s langsamer:** Der Client rechnet
  `versatzMs = Serverzeit(Anstoßen) − Beginn` in die Dauer ein (`dauerMs =
versatzMs + Lauf`) und meldet den Versatz mit.
- Verfällt die Bereitschaft nach 10 s ohne den zweiten Spieler, fällt die
  Gruppe auf **asynchron** zurück, mit sichtbarem Hinweis. Ein „Doch lieber: Wann
  ich will“ ist jederzeit möglich, solange kein Beginn feststeht.
- **„Anstoßen“** (früher „Los, Lauf starten“) startet den Lauf **sofort**, ohne
  Anlauf und ohne weiteren Zwischenschritt. Vor dem gemeinsamen Beginn ist der
  Knopf gesperrt.
- **Nur der Knopf startet.** Klick, Tippen, Enter oder Leertaste **auf dem
  fokussierten Knopf** (Enter und Leertaste lösen beim Knopf einen Klick aus) –
  nichts sonst: weder ein Klick ins Brett oder daneben, noch ein Timer, noch die
  Leertaste außerhalb des Knopfs. Es gibt dafür keinen globalen Handler
  (`beimAnstossen` hängt nur am Knopf). Die Tastensteuerung (Pfeile, Leertaste =
  Neigen) wird erst scharf, wenn der Lauf läuft; eine Leertaste, die den Knopf
  auslöst, wirkt erst beim Loslassen und kann daher nicht zugleich „Neigen“ sein
  (Wiederholungen einer noch gehaltenen Taste werden ohnehin ignoriert).
  Getestet in `e2e/pressen.spec.ts` (Klick daneben startet nichts).

## Vollbild

Das **ganze Brett** (`.pressen`, samt Bühne, Steuerung, Ergebnis) füllt die
Anzeige. Zwei Wege, ein Aussehen (`pressenVollbild.ts`):

1. **Fullscreen-API** (`requestFullscreen`, Rückfall `webkitRequestFullscreen`).
2. **Überlagerung** (`position: fixed; inset: 0; height: 100dvh`, Ränder um
   `env(safe-area-inset-*)`): wo es die API nicht gibt (iPhone-Safari) – und als
   Rückfall, wenn der Browser sie verweigert. Das Brett wird dafür **sofort**
   bildschirmfüllend dargestellt und übernimmt das echte Vollbild, sobald es
   bestätigt ist (`fullscreenchange`).

Angefordert wird nur aus einer **Nutzergeste**, synchron im Klick: dem Klick auf
„Anstoßen“ oder dem eigenen Knopf „⛶ Vollbild“. Scheitert die Anfrage, läuft
das Spiel unverändert weiter. Im Querformat (Handy) steht die Bühne links, alles
andere rechts daneben, das Ergebnis wird kompakter, damit „Anstoßen“ ohne
Blättern erreichbar bleibt; im echten Vollbild wird zusätzlich
`screen.orientation.lock('landscape')` versucht (nur ein Wunsch).

**Beenden:** „✕ Vollbild beenden“ (immer sichtbar), **Esc**, die **Zurück-Taste**
(beide über den zentralen Dialogstapel `lib/dialogVerlauf`, der das Esc als
vergeben markiert) und das **Verlassen der Seite** (Aufräumen beim Entladen).
**Esc und der Lauf:** Im Vollbild schließt Esc _nur_ das Vollbild und bricht
keinen Lauf ab (der Lauf geht weiter); „Vorzeitig abstellen“ bleibt als Knopf.
Außerhalb des Vollbilds gilt Esc wie bisher als „vorzeitig abstellen“. Im
echten Browser-Vollbild bekommt die Seite Esc ohnehin nicht zu sehen – der
Browser schließt selbst und meldet es über `fullscreenchange`.
**Merker:** „Anstoßen“ geht von selbst ins Vollbild, bis jemand es mit „Vollbild
beenden“ (oder Esc/Zurück) wegschickt; der Knopf „Vollbild“ stellt es wieder an
(`localStorage`, nur eine Voreinstellung dieses Geräts).

Der Zustand steht im Spielstand (`state.start`): `gruppe`, je Sitz `art` und
`bereitAm`, und `beginn`. Die Frist wird **nicht** vom Server durch einen
Zeitgeber „ausgelöst“, sondern aus den Zeitstempeln abgeleitet (`startPhase`, in
TypeScript für die Anzeige): `wahl`, `wartet` (mit Frist), `zaehlt`, `gestartet`,
`asynchron` (`gewaehlt` oder `frist`), `frei`. Der Server braucht die Ableitung
nur beim Einbuchen: Ein „Zusammen“ nach Ablauf der Frist setzt keinen Beginn mehr.

**Uhren.** Jede Auslieferung trägt `serverTime`; der Client schätzt daraus die
Serverzeit (Fehler = die Laufzeit der Antwort, im Bereich von Zehntel­sekunden).
Für den Countdown reicht das; die Wertung hängt nicht davon ab, denn der Versatz
wird auf der Uhr des Spielers gemessen. Der Server prüft **Plausibilität**: Der
Versatz ist ganzzahlig und nicht negativ, der Lauf allein (`dauerMs − versatzMs`)
liegt in den physikalischen Grenzen, und die Gesamtdauer darf nicht größer sein
als `jetzt − Beginn + 5 s`. Ein untergeschobener kleiner Versatz lässt sich nicht
widerlegen – es gilt dasselbe wie unten bei „keine Nachrechnung“.

## Sicht: nur das eigene Ergebnis, bis alle fertig sind

Solange eine Runde läuft, sieht jeder **nur den eigenen Lauf**. Bei den anderen
steht nur „fertig“ oder „noch nicht“. Umgesetzt im Server, nicht im Client:

- `GameDefinition::fuer_betrachter(state, sitz)` (Standard: alles). Pressen
  ersetzt in `ergebnisse` jeden fremden Eintrag durch `{"verborgen": true}`,
  solange das Spiel läuft. Offen sind: der eigene Eintrag, `vorrunde` (nach
  Atempo ist die Runde abgeschlossen) und alles, sobald `fertig` gilt.
- Jeder Weg nach draußen geht durch `services::games::sicht_fuer`: Abfrage
  (`GET /games/sessions/{id}`), Liste, Antworten auf Beitritt, Zug und Abbruch,
  die Karte in Chat-Nachrichten (`GameExpander`, mit dem Betrachter des Aufrufs)
  und die **Echtzeitereignisse**: `game.updated` geht je Mitglied einzeln hinaus,
  und `ausspielen` in `services/messages.rs` baut die Spielkarte der
  Chat-Ereignisse je Empfänger frisch aus der Partie. Zuschauer sehen bis zum
  Rundenende nur „fertig“.
- Der Test `apps/api/tests/pressen_sicht.rs` hört mit (`hub.register`) und sucht
  in jedem ausgelieferten Stand nach den Zahlen des fremden Laufs.
- Der Client behandelt `{verborgen: true}` als „fertig“ (`istVerborgen`); die
  Vorhersage eines eigenen Zuges bucht dann nur den eigenen Lauf ein und wartet
  auf den Stand des Servers.

Nicht verborgen sind die Malus-Werte der anderen: Sie verraten nur, wie oft
jemand gespielt hat, nicht wie gut.

## Ergebnis

Steht eine Runde fest, zeigt das Brett ein **großes Ergebnis aus Sicht des
Betrachters** (`pressenErgebnis.ts`, getestet in `pressenErgebnis.test.ts`):

| Lage                                                 | Titel                                       |
| ---------------------------------------------------- | ------------------------------------------- |
| Partie entschieden, ich im Siegerteam                | „Du hast gewonnen“                          |
| Partie entschieden, ich im anderen Team              | „Du wurdest abgeschluckt“                   |
| Unterschied unter der Toleranz (im Spiegel immer)    | „Atempo“ – bis zum nächsten Anstoßen        |
| Zuschauer ohne Sitz, oder die Ampel (nicht gewertet) | „Anna hat gewonnen“ / „Team A hat gewonnen“ |

Darunter je Spieler **Zeit, verschüttetes Bier (ml) und Score** (= Wertung, Zeit
plus Strafe); die eigene Zeile ist hervorgehoben, Sieger tragen 👑, die Auszeichnung
„getrümmert“ 🏅; bei der Staffette steht das Teamergebnis („Team A 18,1 s : Team B
22,2 s“) im Untertitel, ein Sieg gilt für das ganze Team. Bei Atempo stehen die
Zeilen der Vorrunde und der Abstand in ms. **Die Sichtbarkeitsregel bleibt:** Das
Ergebnis erscheint erst, wenn die Runde feststeht – solange ein fremder Lauf
„verborgen“ ist, gibt es keine Zeile. Mitten in der Runde bleibt es beim Satz „Dein
Lauf: …; die Ergebnisse der anderen siehst du, sobald alle fertig sind“.

Barrierefrei: Titel und Untertitel stehen in einem `role="status"` (wird
vorgelesen), die Liste ist eine echte Liste mit `dl` je Zeile; Rahmen und Fläche
tragen die Farbe, die Schrift bleibt `--text` (Kontrast in hell und dunkel); die
Einblendung entfällt bei „Bewegung reduzieren“; die Titelschrift ist mindestens
`clamp(1.9rem, 8vw, 3rem)`. Nach einer entschiedenen Partie steht im Ergebnis
„Revanche“ (im Vollbild sind die Knöpfe der Spielansicht ja verdeckt); bei Atempo
geht es mit „Anstoßen“ weiter.

## Übung ohne Chat („gegen den Spiegel“)

Eine Übung allein braucht niemanden zum Spielen – also keinen Chat. Früher hing
jede Partie an einem Chat (`conversation_id not null`) und stand dort als Karte,
mit Vorschau in der Chatliste und Mitteilung. Jetzt (Migration `0027`):

- `game_sessions.conversation_id` ist **leer erlaubt**, neu ist `besitzer_id`
  (`on delete cascade`: das Konto löschen nimmt die Übung mit). Eine Prüfung
  verlangt Chat **oder** Besitzer. Bestehende Partien bleiben unberührt (auch
  alte Spiegel-Karten in Chats – sie werden nicht nachträglich entfernt).
- `POST /games/sessions` **ohne** `conversationId` und ohne Gegner legt eine
  Übung an (nur für Spiele mit `min_players <= 1`, also Pressen): **keine
  Nachricht, keine Karte, keine Chatlisten-Vorschau, keine Mitteilung** (der
  „am Zug“-Hinweis geht nur an andere). Ein **älterer Client**, der noch einen
  Chat mitschickt, aber keinen Gegner wählt, bekommt dieselbe Übung ohne Karte;
  `conversationId` ist in der Antwort `null`.
- **Zugriff:** Nur der Besitzer liest, spielt, gibt auf, startet Revanche
  (`sichtbar_fuer` liefert nur ihn, `game.updated` geht nur an ihn); alle anderen
  bekommen `404` (auch Mitglieder eines gemeinsamen Chats), die Liste zeigt die
  Übung nur ihm. Ein Chat-Filter blendet Übungen aus.
- **Aufräumen:** Es gibt **eine Übung je Spiel und Person**: Eine neue (auch die
  Revanche) räumt die vorige ab, dazu fertige Reste älter als ein Tag.
- **Zugang:** Spiele-Übersicht → „Pressen allein“ → „Gegen den Spiegel üben“. Im
  Startblatt aus dem Chat heißt es nicht mehr „Allein üben“; dort wählt man
  mindestens einen Gegner.
- Tests: `apps/api/tests/uebung_ohne_chat.rs` (keine Karte, nur Besitzer, 404 für
  Fremde, alter Client, Aufräumen, Konto löschen, Prüfung der Tabelle).

## Strichmännchen

Jeder gestaltet sein Männchen in einem Bearbeitungsblatt mit Live-Vorschau
(„Mein Strichmännchen“ – **unabhängig von einer Partie**: in der Spiele-Übersicht
und in den Einstellungen unter „Spiele“; im Brett nur noch ein Verweis dorthin
(`/spiele?figur=1`, öffnet das Blatt gleich)): Frisur (12), Haarfarbe (10),
Hautfarbe (7), Shirt (12), Bart (5), Brille (4), Hut (5), dazu „Würfeln“ und
„Zurücksetzen“. Jede Angabe ist eine kleine Nummer (kein Freitext, keine Farbcodes).

- **Gespeichert** pro Konto in `settings.modules.pressenFigur` über das
  vorhandene `PATCH /users/me`. Der Server prüft streng (`pressen_figur.rs`):
  alle sieben Merkmale, ganze Zahlen in den Grenzen, keine fremden Schlüssel, sonst 400. Dieselben Grenzen stehen in `pressen-figur.ts` (zod-Schema).
- **Sichtbar für Mitspielende:** `settings` ist privat (nur das eigene Konto sieht
  sie). Deshalb trägt die Partie selbst `figuren` (Benutzer → Figur), vom Server
  beim Ausliefern aus den Konten der Spielenden gelesen und erneut geprüft.
  Wer nichts eingestellt hat, bekommt eine aus der Kennung abgeleitete
  Standardfigur – bei allen gleich.
- **Zeichnung:** eigene SVG (`PressenFigur.tsx`), keine Fremdassets.
- **Animation:** Atmen/Wippen, Blinzeln, Schlucken (Kehlkopf), Wangen blähen sich
  mit dem Mundinhalt, die Arme führen das Glas (Gummiarme von den Schultern zur
  Hand), Schreck beim Verschütten (große Augen, Brauen hoch, 💦), Freude nach
  einem sauberen Lauf, Siegerpose (Arme und Glas hoch, 🏆), Verlierer-Gesicht,
  Abstellen des Glases auf den Tisch, ruhiges Wackeln des gehaltenen Glases.
  Bei `prefers-reduced-motion` steht alles still (Zustandswechsel bleiben), die
  Physik bleibt.

## Chat-Auslöser „Bierjunge“ / „hängt“

Serverseitig beim Anlegen einer **Textnachricht** (`create_message` ruft nach dem
Ausspielen `services::bierjunge::nach_nachricht`; ein Fehler dort wird nur
protokolliert). Wörter werden an Nicht-Buchstaben getrennt und klein
geschrieben, es zählen nur **ganze Wörter** („Bierjungenstreich“ nicht,
„aufgehängt“ nicht), auch „haengt“.

| Fall                    | Wirkung                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a) Einzelchat           | A „Bierjunge“, B „hängt“ innerhalb von 10 min → Partie A↔B im selben Chat.                                                                                                                                                                                                                                                                                                  |
| b) Gruppe, Name im Text | Nur das „hängt“ des Genannten zählt. Erkannt werden Benutzername, voller Anzeigename, einzelne Wörter davon (≥ 3 Zeichen) und der Spitzname im Chat, mit oder ohne `@`. Passt dasselbe Wort auf mehrere Mitglieder („Max“ bei zwei Max), gilt der Aufruf als namenlos; der volle Name oder Benutzername gewinnt immer. Ein Name, der zu keinem Mitglied passt, zählt nicht. |
| c) Gruppe, ohne Namen   | Das erste „hängt“ eines anderen Mitglieds startet das Spiel mit dem Ausrufer.                                                                                                                                                                                                                                                                                               |
| d) „Generalbierjunge“   | Jedes andere Mitglied kann mit „hängt“ ein Spiel mit dem Ausrufer starten, je Mitglied höchstens einmal je Aufruf; der Aufruf bleibt bis zum Ablauf offen.                                                                                                                                                                                                                  |
| e) Frist                | 10 Minuten ab der Zeit der Aufruf-Nachricht (bis zur Zeit des „hängt“, einschließlich). Danach tut ein „hängt“ nichts.                                                                                                                                                                                                                                                      |

Weiter: Ein normaler Aufruf ist nach dem ersten startenden „hängt“ verbraucht.
Eigene „hängt“ des Ausrufers zählen nicht, gelöschte Aufrufe zählen nicht mehr
(Join auf `messages.deleted_at`), Nichtmitglieder lösen nie etwas aus, und jedes
„hängt“ beantwortet höchstens einen Aufruf (den ältesten offenen). Die
auslösenden Nachrichten bleiben normale Nachrichten; die Partie entsteht über
`services::games::create_session` als gewöhnliche Spielkarte (Sitz 0 =
Ausrufer, Sitz 1 = Antwortender).

Tabellen (Migration `0026_bierjunge.sql`, `if not exists`): `bierjunge_aufrufe`
(Chat, Ausrufer, Nachricht – eindeutig –, Art, Zielperson, Zeit,
`verbraucht_am`) und `bierjunge_antworten` mit dem Schlüssel (Aufruf, Person).
**Rennen:** Zuerst wird die Antwort gebucht (Schlüssel verhindert Doppelantwort),
bei einem normalen Aufruf dann `update … where verbraucht_am is null` – genau ein
„hängt“ gewinnt, die Verlierer räumen ihre Antwort wieder weg; scheitert das
Anlegen der Partie, wird der Aufruf freigegeben. Aufgeräumt wird beim nächsten
Aufruf (älter als 24 h). Tests: `apps/api/tests/bierjunge.rs`.

## Abweichung: keine Nachrechnung des Eingabeprotokolls in Rust

Der Auftrag erlaubt, die Eingaben nachzurechnen. Bewusst nicht gemacht:

- Ein Eingabeprotokoll beweist nicht, dass ein Mensch gedrückt hat; ein Bot
  schickt ein perfektes. Nachrechnen würde nur Rechenfehler fangen, nicht
  Schummeln.
- Eine zweite Kopie der Physik in Rust bräuchte bitgleiche Gleitkommarechnung und
  doppelte Pflege. Die Sitzungsdaten würden zudem mit jedem Lauf um
  Ereignislisten wachsen.
- Stattdessen prüft der Server **Plausibilität** aus den Physikkonstanten
  (Mindestdauer, höchstens so viel getrunken, wie der Mund schlucken kann,
  Reaktion ≥ 120 ms, Versatz) und rechnet Wertung, Atempo, Rollen und Malus
  **selbst**. Das Eingabeprotokoll hat zwar jetzt eine zweite Achse (`hoch`,
  `runter`), kommt aber nie beim Server an; er sieht nur das Ergebnis.

## Auszeichnung „getrümmert“

Das Projekt hat kein Erfolgssystem. Daher eine kleine lokale Auszeichnung
(`localStorage`, Schlüssel `pressen.getruemmert`): Glas ganz geleert und danach
in höchstens 450 ms abgestellt. Der Server markiert den Lauf (`getruemmert`),
sodass auch die anderen es sehen (nach Rundenende).

## Zugänglichkeit

Alle Eingaben per Tastatur (vier Pfeile, Leertaste, Esc – im Vollbild schließt Esc nur
das Vollbild). Touch: Steuerkreuz und
Neigen-Knopf, je mindestens 64 px. Zustandsansagen über einen `aria-live`-Bereich
(Wahl, Warten, „Los!“, Glas leer); das Ergebnis sagt sein eigener `role="status"`
an. Der Malus-Balken ist ein `meter` mit
Beschriftung und Erklärung. `prefers-reduced-motion`: Atmen, Blinzeln, Schlucken
und Wackeln entfallen; die Physik bleibt (sie ist das Spiel).

## Offen

- Ein Spieltest mit Menschen: Die Balance ist an Bots gemessen (Reaktion 160 ms,
  fehlerfreie Regler); echte Hände sind ungenauer. Die Stellschrauben sind
  `MUND_HALB_X/Y`, `STRAHL_WEITE_PRO_GRAD`, `GLAS_V_MIN` und die Ermüdungsfaktoren
  in `physikFuer`.
- Der Malus gilt je Sitzung; eine Revanche beginnt wieder bei 0 (sitzungsübergreifend
  merken wäre möglich).
- Die Serveruhr wird aus `serverTime` geschätzt; ein Ping-Pong zur Messung der
  Laufzeit würde den Countdown auf Zehntelsekunden angleichen.
- Fremde Läufe werden nicht live gezeigt (nur „trinkt …“); eine Wiederholung nach
  Rundenende aus dem Eingabeprotokoll wäre möglich, weil die Physik bitgleich ist.
