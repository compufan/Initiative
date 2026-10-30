# Entwurf: Pressen (Echtzeit-Trinkspiel)

Die vorhandenen Spiele sind rundenbasiert: ein Zug, der Server prüft ihn mit
seiner Rust-Regel, der Stand geht per `game.updated` an alle. „Pressen“ ist
Echtzeit. Der Entwurf lässt Sitzung, Zug-API und Realtime unverändert und hängt
nur das **Ergebnis eines Laufs** als Zug ein.

## Aufteilung

| Was | Wo | Warum dort |
| --- | --- | --- |
| Physik (Glas, Neigung, Fluss, Mund) | `packages/shared/src/games/pressen-sim.ts` | Reine Funktion mit festem Zeitschritt (20 ms) und Eingaben als Zeitstempel-Ereignissen „Taste runter/hoch“. Jeder Client rechnet seinen Lauf selbst; so fühlt sich die Steuerung ohne Netzwerk-Latenz an. |
| Wertung, Rollen, Malus, Zugregeln | `packages/shared/src/games/pressen.ts` **und** `apps/api/src/games/pressen.rs` | Wie bei allen Spielen: Der Server entscheidet (Rust), der Client hat die gleiche Regel für die sofortige Anzeige. Beide laufen gegen dieselben Testfälle (`testdaten/pressen.json`). |
| Darstellung, Eingabe, Strichmännchen | `apps/web/src/modules/games/boards/PressenBoard.tsx` u. a. | wie die anderen Bretter, Eintrag in `boards/registry.ts` |

Ein Zug ist `{ typ: 'ergebnis', runde, dauerMs, verschuettetDezi, reaktionMs,
vorzeitig, verzoegerungMs }`, gemeldet von dem Sitz, der gerade laufen darf.
Der Server wertet selbst (Dauer + Strafzeit), setzt Atempo/Sieg und schaltet den
nächsten Läufer frei. Gleichzeitiges Melden zweier Spieler kollidiert an der
Versionsprüfung der Sitzung; für Spiele mit `echtzeit: true` sendet der Client
den Zug nach frischem Laden erneut (der Zug ist je Sitz und Runde einmalig,
doppeltes Senden wird abgelehnt).

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
  Reaktion ≥ 120 ms) und rechnet Wertung, Atempo, Rollen und Malus **selbst**.
  Die Physik nutzt ausschließlich `+ − × ÷` und Vergleiche, damit alle Browser
  bitgleich rechnen.

## Modi und Rollen (`planFuer(n)`)

- 1 Person: **gegen den Spiegel**. Das zweite Männchen spiegelt dieselbe Eingabe,
  also gleiche Wertung, also immer Atempo, bis jemand abbricht. Der Malus wächst
  nicht.
- 2: Duell, beide gleichzeitig.
- 3: **Ampel** ist der dritte Sitz. Er trinkt und stellt ab, danach starten die
  beiden anderen. Seine Zeit wird nicht gewertet.
- ab 4: **Staffette**. Läufer 0, 2, 4 … bilden Team A, 1, 3, 5 … Team B. Aus
  jedem Team läuft immer einer; der nächste darf, sobald der Teamkollege
  abgestellt hat. Teamwertung = Summe der Läuferwertungen. Bei ungerader Zahl
  macht der letzte Sitz zuerst die Ampel.
- Der Mindeststand für „Spiegel“ ist 1 Person (`minPlayers = 1`). Die Aufstellung
  steht beim Anlegen fest (`can_join` lehnt Beitritt ab), damit die Rollen nicht
  mitten im Lauf kippen.

## Wertung (balanciert)

`wertungMs = dauerMs + Strafe(verschüttet)`,
`Strafe = 100 ms/ml · v + 2 ms/ml² · v²`.

Die quadratische Komponente macht „schnell und schlampig“ teuer (200 ml ≈ 100 s
Strafe), die lineare verhindert, dass ein paar verlorene Tropfen gratis sind und
„vorsichtig“ unschlagbar wird. Die Tests fahren Spielerprofile durch die
echte Simulation (hastig, ausgewogen, vorsichtig und einen Durchlauf von
Zielflüssen) und verlangen, dass das Minimum im Inneren liegt.
Atempo: Unterschied < 250 ms (je Team mal Läuferzahl).

## Malus

Je Sitz eine Verzögerung, mit der **Tastendruck und Loslassen** (Position und
Neigung) später registriert werden. Jeder gespielte Lauf erhöht sie um
`MALUS_PRO_RUNDE_MS` (40 ms, höchstens 250 ms); sie halbiert sich alle
`MALUS_HALBWERTSZEIT_MS` (2 min). Die Uhr ist die des Servers (Zeitstempel im
Spielstand); der Client schätzt die Serverzeit aus `updatedAt` + eigener Laufzeit,
Uhrabweichungen des Telefons spielen keine Rolle. Im Spiegelmodus bleibt der
Malus 0. Er gilt je Sitzung; eine Revanche beginnt wieder bei 0 (offen:
sitzungsübergreifend merken).

## Auszeichnung „getrümmert“

Das Projekt hat kein Erfolgssystem. Daher eine kleine lokale Auszeichnung
(`localStorage`, Schlüssel `pressen.getruemmert`): Glas ganz geleert und danach
in höchstens 450 ms abgestellt (`GETRUEMMERT_MS`). Der Server markiert den Lauf
(`getruemmert`), sodass auch die anderen es sehen.

## Zugänglichkeit

Pfeiltasten links/rechts bewegen das Glas, Leertaste oder der rechte Knopf
neigt (halten), Esc stellt vorzeitig ab (Rest zählt als verschüttet). Touch:
Links/Rechts-Knöpfe und ein Neige-Knopf. Zustandsansagen über einen
`aria-live`-Bereich. `prefers-reduced-motion`: Wackeln, Zählanimation und
Schluck-Animation entfallen; die Physik selbst bleibt (sie ist das Spiel).
