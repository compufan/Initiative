# Entwurf: Termin – „Sammlung verknüpfen“, auch neu anlegen (auch als Unterordner)

Zweig `e-sammlung` (Ausgangspunkt d786eab). Nur Entwurf, kein Produktivcode.
Messung des Bestands: `ergebnis-wt-sammlung/befund.sh` mit Ausgabe `befund-bestand.txt`
(gegen den laufenden API-Server, zwei Nutzer, Gruppenchat, Termin, Sammlungen).

## 0. Befund im Bestand (das, worauf alles aufbaut)

### 0.1 Was „Verknüpfen“ heute tut

- Web: `modules/calendar/EventCollection.tsx` – ein `<select>` „Mit einer Sammlung verknüpfen“, `Keine` löst.
  Er lädt `api.collections.list()` selbst (nicht über den Dateien-Speicher `useFiles`) und zeigt **alle**
  sichtbaren Sammlungen mit flachem Namen, auch die, in die man nur schauen darf.
- Server: `PATCH /calendar/events/{id}/collection` (`calendar.rs::link_collection`): `assert_editable` am Termin
  (Ersteller oder Chat-Admin), `require_collection(…, Level::Edit)` an der Sammlung, dann nur
  `update calendar_events set collection_id`. Danach `broadcast_event`.
- **Es werden keinerlei Rechte vergeben.** Gemessen: Anna legt eine Sammlung ohne Chat an und verknüpft sie mit
  dem Termin. Bodo (eingeladen, `GET /calendar/events/{id}` = 200) bekommt auf `GET /collections/{id}` ein
  **404 „Sammlung nicht gefunden“**, seine Sammlungsliste ist leer. Der Eingeladene sieht im Termin also einen
  Knopf „📁 Zur Sammlung“ (der Name ist ihm unbekannt, weil er nicht in seiner Liste steht), der laut
  `DateienScreen` auf eine leere Ansicht mit Fehlerband führt (`loadItems` scheitert, `loaded` wird nie wahr).
- Die Dokumente am Termin (`EventDocuments`, Tabelle `event_attachments`) haben mit der Sammlung **nichts**
  zu tun. Die Annahme im Auftrag „Dokumente am Termin liegen dann in der Sammlung“ stimmt im Code nicht (auch
  `docs/FEATURES.md` Abschnitt „Dateien am Termin“ behauptet es so: „dann liegen seine Dateien dort“). Dokumente
  sind für Eingeladene über `zugriff.rs` (`Grund::Termin`, abgeleitet aus der Teilnehmerzeile) lesbar; die
  Sammlung hat ein eigenes, davon unabhängiges Rechtesystem. Das bleibt so; die Doku wird berichtigt (Abschnitt 8).

### 0.2 Wie ein Mensch an eine Sammlung kommt (Rechte, `permissions.rs`, Migration 0015)

Stufen `view` < `edit` < `own`. Die höchste gefundene gewinnt, vererbt wird von oben nach unten (Elternordner
→ Kind). Quellen, je Sammlung der Kette:

1. ausdrückliches Recht an die Person (`collection_grants.user_id`),
2. ausdrückliches Recht an einen Chat, in dem die Person ist (`collection_grants.conversation_id`),
3. `collections.conversation_id` + `member_level <> 'none'` (Mitglied des Herkunftschats; Vorgabe `edit`),
4. Ersteller (`created_by`) = `own`.

Gemessen: Chat-Sammlung (`conversationId` gesetzt, Vorgabe `edit`) → Chatmitglied Bodo bekommt 200.
Ein Recht am Elternordner trägt bis ins Kind (Bodo mit `view` am Elternordner sieht den frisch angelegten
Unterordner mit `myLevel: view`). Termin-Einladung ist **keine** Quelle. `zugriff.rs` kennt „Termin“ nur für
`event_attachments`, nicht für Sammlungseinträge.

### 0.3 Anlegen, Unterordner, Tiefe

- `POST /collections` (`collections.rs::create`): `name` 1–120 Zeichen, `parentId` optional (dann
  `require_collection(Edit)` am Elternordner und Tiefenprüfung), `conversationId` optional (dann Mitgliedschaft),
  `memberLevel` Vorgabe `edit`. Der Anleger ist über `created_by` automatisch `own`.
- Tiefe: `COLLECTION_DEPTH_MAX = 8` (Web: `LIMITS.collectionDepthMax`). Gemessen: Wurzel = Ebene 1, die achte
  Ebene geht, die neunte antwortet 400 „Mehr als 8 Ebenen sind nicht vorgesehen“.
- Validierungsfehler kommen als Sammeltext „Eingabe konnte nicht verarbeitet werden“ mit `details` – der
  Web-Client zeigt `error.message`. Der Name wird deshalb **vor** dem Senden geprüft (wie `CollectionSheet`).
- `DELETE /collections/{id}` (Level `own`) markiert nur (`deleted_at`) – das ist der Aufräumweg.
- Es gibt **keine** vorhandene Baum- oder Ordnerwahl im Web: `buildCollectionTree` (shared, mit `depth`) und
  `useFiles.tree()` existieren, werden aber von keiner Komponente benutzt; Dateien navigiert Ebene für Ebene.
  `AddToCollectionSheet` ist eine flache Liste. Wiederverwendbar sind also: `buildCollectionTree`, `pfadZu`,
  `useFiles` (Speicher, `upsert`), `CollectionSheet`-Muster (Name, Prüfung, `onSaved`), `PersonenWahl`,
  `ShareSheet`, `allowsLevel`, `Sheet`, die Klassen `fil-*`.

### 0.4 Wer „Eingeladene“ sind

`event.attendees` (Teilnehmerzeilen) ist die einzige Quelle. Im Zweig der Einladungsarbeit
(Hauptbaum, Migration 0023) ist der Chat kein Zugang mehr: Wer sieht den Termin, bestimmt allein die
Teilnehmerzeile. Daraus folgt für diesen Entwurf zwingend: **Rechte an der Sammlung gehen an Personen aus
`event.attendees`, nie an den Chat** (Abschnitt 2).

## 1. Ablauf in der Oberfläche

### 1.1 Abschnitt „Sammlung“ (`EventCollection`, nur für Verwalter ändernd)

Zwei sichtbare Wege, untereinander:

```
Sammlung
[📁 Familie › Wochenende 2026]                       <- Link, falls verknüpft (Abschnitt 4)
Zugriff der Eingeladenen: Alle 5 kommen hinein.      <- nur Verwalter, falls verknüpft (Abschnitt 2.4)

Bestehende Sammlung verknüpfen
[ Keine                            v ]               <- wie heute, aber: nur Sammlungen mit Änderungsrecht,
                                                        Pfad statt Name, Baumreihenfolge
oder
[ ＋ Neue Sammlung anlegen … ]                        <- öffnet das Blatt aus 1.2
```

Änderungen am Bestand dabei (klein, aber nötig, damit die zwei Wege gleich ehrlich sind):

- Die Liste kommt aus `useFiles` (`load()` beim Einhängen). Nach dem Anlegen genügt `upsert`, und Dateien kennt die
  neue Sammlung sofort, ohne Neuladen.
- Das `<select>` bietet nur Sammlungen mit `allowsLevel(myLevel, 'edit')` an (der Server lehnte die anderen mit 403
  ab: Knopf, der sicher scheitert) – plus die gerade verknüpfte, auch wenn sie nur „ansehen“ erlaubt.
  Beschriftung: Pfad `Eltern › Kind` (`pfadText`, Abschnitt 6), Reihenfolge wie der Baum, damit Kinder bei ihren
  Eltern stehen und gleichnamige Unterordner unterscheidbar sind.
- „Keine“ (Lösen): Hinweis nach Erfolg: „Verknüpfung gelöst. Wer schon Zugriff bekam, behält ihn – das lässt
  sich in Dateien unter „Teilen“ zurücknehmen.“ Gelöscht wird nichts.
- Ist ein Termin verknüpft und man wählt „Neue anlegen“, steht im Blatt: „Die Verknüpfung mit „X“ wird ersetzt.
  Die Sammlung selbst bleibt.“
- Verknüpft, aber nicht erreichbar (nicht in der Liste, obwohl sie geladen ist): Eingeladene sehen statt des
  toten Knopfes: „Zu diesem Termin gehört eine Sammlung, die dir nicht freigegeben ist. Frag {Ersteller}, ob er sie
  dir freigibt.“ (Gelöscht oder nicht freigegeben sind für sie nicht zu unterscheiden, und sollen es auch nicht
  sein.) Verwalter bekommt zusätzlich „Verknüpfung lösen“.

### 1.2 Blatt „Neue Sammlung zum Termin“ (neu: `TerminSammlungSheet.tsx`, `Sheet`, Knopf wie `CollectionSheet` im Kopf)

```
Neue Sammlung zum Termin                      [ Anlegen und verknüpfen ]
────────────────────────────────────────────────────────────────────
Name
[ Hüttenwochenende                         ]   120
(Hinweis, falls im gewählten Ordner schon eine gleichnamige liegt:
 „Dort gibt es schon „Hüttenwochenende“ – lieber die verknüpfen?“)

Wo soll sie liegen?                            (Filterfeld erst ab 10 Zeilen)
 (•) Oberste Ebene
 ( )   Familie
 ( )     Urlaube
 ( )       2025                 [zu tief]       <- grau, nicht wählbar
 ( )   Arbeit                   [nur ansehen]   <- grau, nur sichtbar, weil darunter etwas änderbar ist
 ( )     Projekte
Unter einem Ordner gilt dessen Zugriff mit: Anna (ändern), alle in „Familiengruppe“ (ansehen).

Wer bekommt Zugriff?
Du: Besitzer.
Die Eingeladenen dürfen:  (•) ansehen und ändern   ( ) nur ansehen
  Ändern heißt: Dateien hinzufügen, umbenennen, verschieben und entfernen.
 [Alle auswählen]                                  5 Personen
  [x] Bodo   [x] Cleo   [x] Dora (hat abgesagt)   [ ] Emil   [x] Fritz
Wer später eingeladen wird, bekommt den Zugriff nicht von allein – im Abschnitt „Sammlung“ lässt sich das nachholen.
```

Bausteine:

- **Name**: `<input class="input" maxLength={LIMITS.collectionNameMax}>`, vorbelegt mit `event.title` (auf 120
  Zeichen gekürzt; der Termintitel darf 160 lang sein), beim Öffnen frisch gesetzt (`useEffect` auf `open`, wie
  der Kommentar in `CollectionSheet` es verlangt – das Blatt bleibt eingehängt). Leer/nur Leerzeichen:
  „Die Sammlung braucht einen Namen.“ (kein Netzaufruf).
- **Ordnerwahl** (neu: `modules/files/OrdnerWahl.tsx`, reine Logik in `modules/files/ordner.ts`): eine
  `role="radiogroup"` aus nativen Radios. Zeilen kommen aus `buildCollectionTree(useFiles.collections)` (die
  `depth` ist schon da), flach in Baumreihenfolge, Einrückung über eine Eigenschaft `--tiefe` (Klasse
  `fil-baum-zeile`, `padding-inline-start: calc(var(--tiefe) * 16px)`), Zeile 0 ist „Oberste Ebene“ und
  Vorgabe. Native Radios, weil Tastatur, Vorlesehilfe und Playwright (`getByRole('radio', { name })`) sie
  kostenlos kennen; kein ARIA-Tree-Eigenbau.
  - Wählbar: `allowsLevel(myLevel, 'edit')` und Tiefe ok. Ein Ordner, in dem man nur ansehen darf, bleibt als
    graue Zeile stehen, **wenn darunter etwas Änderbares liegt** (sonst wäre das Kind ohne Zusammenhang
    gezeigt); ohne änderbaren Nachfahren fehlt er ganz. Beides ist die Regel „nur Sammlungen, in denen man ändern
    darf“, ohne die Struktur zu zerreissen.
  - Tiefe: ein Ordner mit `ebenen(id) >= LIMITS.collectionDepthMax` ist nicht wählbar, Kennzeichen „zu tief“ und
    ein erklärender Satz unter der Liste, sobald mindestens eine solche Zeile da ist: „Mehr als 8 Ebenen sind nicht
    vorgesehen. Wähle einen Ordner weiter oben.“ (`ebenen` = Länge des **sichtbaren** Pfads; ist ein
    Elternordner unsichtbar, ist das nur eine Untergrenze – der Server entscheidet, siehe 5.)
  - Filter: ab 10 Zeilen ein Suchfeld; Treffer samt Vorfahren, Vorfahren ohne Treffer gedämpft. Kein Ein-/Ausklappen
    (ein Tipp weniger, keine Zustandsverwaltung, und bei einem Telefon mit 40 Ordnern ist eine durchgehende
    Liste mit Filter schneller als Aufklappen).
  - **Geerbter Zugriff wird gezeigt** (siehe 2.2): Wählt man einen Ordner, lädt das Blatt `api.collections.grants`
    für ihn und jeden sichtbaren Vorfahren und nennt, wer dort Zugriff hat. Ohne diese Zeile wäre „Unterordner“
    eine stille Rechteausweitung in der anderen Richtung.
- **Zugriff**: `PersonenWahl` (wiederverwendet) mit `vorschlaege` = `event.attendees` ohne mich,
  `gewaehlt` = alle, `suchbar={false}`, `zusatz` = Hinweis „hat abgesagt“ bei Status `no`. Darüber zwei Radios
  für die Stufe (`view`/`edit`, Wortlaut wie im bestehenden `ShareSheet`: „ansehen“ / „ansehen und ändern“).
  Vorgabe `edit`, begründet: Zweck einer Termin-Sammlung ist, dass die Bilder vom Wochenende von allen
  hineinkommen, und `edit` ist auch die Vorgabe `member_level` aller Chat-Sammlungen im Bestand. Die Stufe ist
  im Blatt immer sichtbar (nicht eingeklappt) und steht im Wortlaut am Knopf bzw. in der Zusammenfassung:
  - Unter der Liste eine Zusammenfassung in Klartext: „Außer dir bekommen 4 Personen Zugriff (ansehen und
    ändern): Bodo, Cleo, Dora, Fritz.“ – oder „Nur du hast Zugriff. Die Eingeladenen sehen den Link, kommen aber
    nicht hinein.“
  - Hat der Termin außer mir niemanden: „Sonst ist noch niemand eingeladen.“ und der Block ist knapp.
- **Anlegen und verknüpfen** – Reihenfolge und Schritte siehe 1.3.

### 1.3 Der Zug „anlegen und verknüpfen“ (Web-only, drei Schritte, jeder einzeln wiederholbar)

```
1. POST /collections { name, parentId?, memberLevel: 'none' }     -> neue Sammlung (Besitzer: ich)
2. PATCH /calendar/events/{id}/collection { collectionId }         -> Termin zeigt auf sie (Rundruf an Eingeladene)
3. POST /collections/{id}/grants { userId, level }  je Person      -> der sichtbar gewählte Zugriff
```

- Verknüpfen kommt **vor** dem Freigeben: Das Verknüpfen ist, was der Anwender verlangt hat; ein Freigabefehler ist
  nachholbar und sichtbar (Abschnitt 2.4), ein verlorenes Verknüpfen nicht.
- Kein `conversationId`, kein Chat-Recht: Siehe 2.1. `memberLevel: 'none'` nur, damit die Absicht ausdrücklich
  ist; ohne `conversationId` greift die Chat-Regel ohnehin nicht.
- Die Personen für Schritt 3 sind der Stand, den der Anwender im Blatt **gesehen und bestätigt** hat (Momentaufnahme
  beim Tipp), nicht ein später gelesener Stand.
- Schritt 3 läuft nacheinander mit Zwischenstand und Fortschritt am Knopf („Gibt frei … 3 von 8“), wie
  `ShareSheet.alleVergeben`: Ein stiller Teilerfolg wäre schlimmer als ein sichtbarer.
- Die ganze Folge steckt in **einer reinen, einspeisbaren Funktion** `sammlungAnlegenUndVerknuepfen(plan, dienste)`
  in `modules/calendar/terminSammlung.ts` (Dienste = die vier API-Aufrufe), damit sie ohne Browser getestet
  wird. Sie lebt im Elternteil (`EventCollection`), nicht im Blatt: Schliesst jemand das Blatt mitten im Zug,
  läuft der Zug zu Ende und meldet sich per Hinweis.
- **Doppelklick/Doppeltipp**: ein `useRef`-Wächter (`laeuft.current`), der **sofort** greift, plus
  `disabled` am Knopf und `<form onSubmit>` (Enter im Namensfeld). Ein bloßes `useState(busy)` käme zu spät – der
  zweite Klick läge noch im selben Render. Der Server hat für Sammlungen keinen Schlüssel zur Wiederholung
  (anders als die Termine mit `clientId`); der Wächter ist die Absicherung, im e2e belegt (Abnahme 7).

## 2. Zugriff

### 2.1 Entscheidung

**Verknüpfen verändert nie stillschweigend Rechte. Rechte ändert nur ein ausdrücklicher, sichtbarer Schritt:
Freigeben an namentlich genannte Eingeladene.** Daraus:

- *Bestehende Sammlung verknüpfen* bleibt, wie es ist: kein Recht wird vergeben. Neu ist, dass der Abschnitt
  danach **zeigt**, wer nicht hineinkommt, und das Nachholen anbietet (2.4). Vorher blieb es bei einem toten Knopf.
- *Neue Sammlung anlegen* nimmt denselben Schritt „Freigeben“ **in das Blatt vor**: Der Anwender sieht vor dem
  Tipp, wer Zugriff bekommt, kann einzelne abwählen oder die Stufe senken und es kann nichts hineingehen, was
  nicht im Blatt stand.
- Rechte gehen an **Personen** (`collection_grants.user_id`), nicht an den Chat des Termins: Der Chat gibt an
  einem Termin keinen Zugang mehr (Migration 0023); eine Chat-Freigabe oder `conversationId` + `member_level`
  würde auch Abgewählte und später Beigetretene hineinlassen – genau die Ausweitung, die 0023 beseitigt hat. Nebenbei
  entfällt die irreführende Zeile im `ShareSheet` („Alle im zugehörigen Chat haben trotzdem Zugriff“).
- Abgeleiteter Zugriff nach dem Muster `Grund::Termin` (Teilnehmerzeile ⇒ Zugriff) wäre in sich stimmiger, ist
  aber eine Änderung am Rechtemodell (neue Quelle in `sichtbare_sammlungen`, `wer_sieht_sammlung`, `KETTE/STUFEN`)
  und würde **jede** verknüpfte Sammlung samt allen Unterordnern für alle Eingeladenen öffnen, auch eine
  bestehende private. Das ist eine stille Rechteausweitung, nicht der Auftrag. Nicht vorgesehen, siehe 3.

### 2.2 Unterordner und geerbte Rechte

Ein Unterordner erbt, was am Elternordner vergeben ist (gemessen). Wer „Familie“ geteilt hat, teilt auch
„Familie › Wochenende“ mit denselben Leuten, und zwar mit deren Stufe, auch `own`. Das gehört zur Gleichung
„wer Zugriff bekommt“ und wird im Blatt genannt (1.2): je Vorfahr `GET /collections/{id}/grants` (View genügt,
parallel, höchstens 8 Aufrufe), dazu Herkunftschat und `member_level` des Vorfahrs. Ist der oberste sichtbare
Vorfahr selbst ein Kind (`parentId` gesetzt, Elternteil unsichtbar), steht dabei: „Weitere Personen können über
Ordner Zugriff haben, die du selbst nicht siehst.“ Bis die Auskunft da ist, steht „…“ statt einer leeren Zeile.

### 2.3 Wer darf das

- Anlegen: jeder; Unterordner nur mit `edit` am Elternordner (Server prüft, Web filtert).
- Verknüpfen: Verwalter des Termins (`canManage`) und `edit` an der Sammlung (die neue ist `own`).
- Freigeben: nur wer die Sammlung **besitzt** (`own`). Beim neuen Weg ist das der Anleger, immer.
  Beim bestehenden Weg oft nicht: Dort sagt der Abschnitt, wer es kann („Freigeben kann nur, wem die Sammlung
  gehört: {Name}.“) statt eines Knopfes, der mit 403 scheitert.

### 2.4 Abschnitt „Zugriff der Eingeladenen“ (gemeinsame Stütze beider Wege)

Für Verwalter, solange eine Sammlung verknüpft und erreichbar ist (neu: `SammlungZugriff.tsx`, Rechnung in
`terminSammlung.ts::zugriffsLage`, rein):

- Eingabe: `event.attendees` ohne mich; je Sammlung der Kette (`pfadZu`) die Rechte (`grants`, nur die an der
  Sammlung selbst, `itemId == null`), der Anleger (`createdBy`), und – nur wenn der Chat im Chat-Speicher bekannt
  ist – Mitglieder zu Chat-Rechten und zu `conversationId` + `memberLevel <> 'none'`.
- Ausgabe: je Person die höchste **belegte** Stufe oder keine. Es zählt nur, was belegt ist: Die Rechnung kann sich
  also nur in Richtung „fehlt“ irren, nie in Richtung „hat Zugriff“. Ein überflüssiges Freigeben (wegen eines
  unsichtbaren Elternordners) ist harmlos, ein behauptetes „hat Zugriff“ wäre es nicht.
- Anzeige: „Alle 5 Eingeladenen kommen hinein.“ oder „2 von 5 Eingeladenen kommen nicht hinein: Cleo, Dora.“
  Mit Knopf **„Freigeben …“**, der das vorhandene `ShareSheet` öffnet – erweitert um zwei freiwillige Eigenschaften
  `personen` (statt der Mitglieder des Herkunftschats: die Eingeladenen) und `vorgewaehlt` (die Fehlenden). Damit
  kommt kein zweiter Freigabe-Bildschirm dazu, und Zurücknehmen (`Zurücknehmen`-Knopf, Anzeige bestehender Rechte,
  Teilfehler) ist schon da.
- Das ist auch die Reparatur für den Teilfehler aus Schritt 3 und für Drift: später Eingeladene bekommen keinen
  Zugriff von allein; Ausgeladene behalten ihn, bis jemand ihn im `ShareSheet` zurücknimmt (die Zeile nennt
  Ausgeladene nicht – ausdrücklich unter Risiken, 7).

## 3. Muss der Server etwas ändern?

**Nein, nicht für das, was gewünscht ist.** Alles läuft über Bestandsrouten, die in 0.3 gemessen sind
(`POST /collections`, `PATCH /calendar/events/{id}/collection`, `POST /collections/{id}/grants`,
`DELETE /collections/{id}`, `GET …/grants`). Kein Migrationsbedarf, kein neuer Fehlertext, keine neue Route.

Was Web-only kostet, und warum es tragbar ist:

| Schwäche | Folge | Gegenmittel im Entwurf |
| --- | --- | --- |
| nicht atomar | Sammlung angelegt, Verknüpfen scheitert | Aufräumen bei endgültigem Fehler, sonst Zustand „angelegt, nicht verknüpft“ mit „Erneut verknüpfen“ / „Verwerfen“ (Abschnitt 5) |
| N Aufrufe für Freigaben | bei 200 Eingeladenen (Obergrenze der Einladungsarbeit) spürbar | nacheinander mit Fortschritt; Normalfall 3–15 Personen |
| Momentaufnahme | spätere Einladungen ohne Zugriff | Abschnitt 2.4 zeigt es und holt es nach |

Falls der Lead die Atomarität doch will (optional, nicht Teil dieses Entwurfs): `POST
/calendar/events/{id}/collection` mit zusätzlichem Körper `{ neu: { name, parentId?, stufe?, personenIds[] } }` –
in **einer** Transaktion `insert collections` (Anleger `own`, kein Chat), Teilnehmerprüfung der `personenIds` gegen
`event_attendees`, `insert collection_grants … on conflict do update` je Person, `update calendar_events`, ein
`broadcast_event`; Antwort `{ termin, sammlung, freigegeben[] }`. Rechte wie bisher
(`assert_editable`, bei `parentId` `require_collection(Edit)` und Tiefenprüfung). Keine Migration. Das würde
Aufräumen und den Zwischenzustand ersparen, den Web-Teil (Blatt, Ordnerwahl, Zugriff) aber nicht verkleinern.

## 4. Wo die verknüpfte Sammlung danach sichtbar ist

- **Abschnitt „Sammlung“ im Termin** (Hauptstelle): der Knopf wird zu `📁 Familie › Wochenende 2026` und führt per
  `Link` zu `/dateien/{id}` (kein rohes `href`, wie der Kommentar in `EventCollection` es schon verlangt). Pfad aus
  `pfadText(collections, id)`: höchstens die letzten drei Ebenen, davor „… › “, wenn gekürzt wird oder der oberste
  sichtbare Vorfahr selbst einen unsichtbaren Elternordner hat; voller Pfad im `data-tipp`. Einzeilig mit
  Auslassung (`truncate`).
- Sofort nach dem Zug: Hinweis „„Familie › Wochenende 2026“ angelegt und verknüpft.“ (`toast`, `success`) und –
  bei Teilfehlern – `error` mit den Namen (2.4 zeigt es danach dauerhaft).
- **Dateien** kennt die Sammlung am richtigen Platz im Baum (über `useFiles.upsert`), Brotkrumen `pfadZu` und
  „Zurück zum Elternordner“ gibt es schon.
- **Eingeladene** sehen den Knopf mit dem Pfad, sobald sie Zugriff haben (die Sammlung steht dann in ihrer
  Liste; der Rundruf `event.updated` nach dem Verknüpfen trägt `collectionId`). Wer keinen hat, bekommt den
  Hinweis aus 1.1.
- Bewusst **nicht** im Rahmen: eine Zeile „📁 …“ im Kopf des Termins (`EventDetailScreen` ist im Zweig der
  Einladungsarbeit stark umgebaut – das gäbe nur Zusammenführungsärger; als Nachfolgearbeit vormerken) und ein
  Rückverweis „📅 Termin“ in Dateien (es gibt keine Abfrage „Termine zu dieser Sammlung“).

## 5. Fehlerfälle

| Fall | Erkennung | Verhalten |
| --- | --- | --- |
| Name leer / nur Leerzeichen | vor dem Senden | „Die Sammlung braucht einen Namen.“ am Feld, kein Aufruf, Fokus ins Feld |
| Name zu lang | `maxLength={120}` (Einfügen wird gekürzt) | zusätzlich Zähler ab 100 Zeichen; Server-Zeichenzählung ist nach Code-Punkten, JS nach UTF-16, also nur strenger |
| gleichnamige Sammlung im Ordner | Vergleich ohne Groß-/Kleinschreibung unter `childrenOf` | nur Hinweis, kein Sperre (der Server erlaubt Namensgleichheit) |
| offline beim Anlegen | `ApiError.isOffline` bei Schritt 1 | Blatt bleibt, Eingaben bleiben; „Keine Verbindung zum Server – es wurde nichts angelegt.“ Nichts zu räumen |
| Rechte fehlen am Elternordner | Server 403/404 bei Schritt 1 | Meldung des Servers („Du darfst diese Sammlung nur ansehen“ bzw. „Sammlung nicht gefunden“) am Ordnerfeld; `useFiles.load()`, Auswahl springt auf „Oberste Ebene“ |
| Tiefe überschritten (Server) | 400 „Mehr als 8 Ebenen …“ bei Schritt 1 | Satz aus 1.2 am Ordnerfeld; der Ordner wird für diese Sitzung als „zu tief“ gemerkt (Untergrenze der Clientrechnung war zu niedrig, 0.3) |
| Anlegen klappt, Verknüpfen endgültig abgelehnt (403 „Nur der Ersteller …“, 404 Termin weg, 409) | 4xx ausser 408/429 bei Schritt 2 | die frisch angelegte Sammlung wird mit `DELETE` aufgeräumt; Meldung: „Das Verknüpfen hat nicht geklappt: {Servertext}. Die neue Sammlung wurde wieder entfernt.“ Scheitert auch das Aufräumen: „Die Sammlung „X“ liegt noch in Dateien und lässt sich dort löschen.“ |
| Anlegen klappt, Verknüpfen nicht erreichbar (offline, Zeitüberschreitung, 5xx, 408, 429) | `isOffline` / ≥ 500 | **nicht** aufräumen (der Server hat vielleicht doch verknüpft): Blatt zeigt „„X“ ist angelegt, aber noch nicht mit dem Termin verknüpft.“ mit **Erneut verknüpfen** (wiederholt nur Schritt 2 und 3, legt nichts zweites an) und **Verwerfen** (DELETE; scheitert er: Hinweis wie oben). Schliesst der Anwender das Blatt, gilt „Verwerfen“ als gewählt und wird versucht |
| Verknüpft, Freigeben teils/ganz gescheitert | Ergebnisliste von Schritt 3 | Blatt schliesst, `error`-Hinweis „Verknüpft, aber nicht freigegeben für: Cleo, Dora.“; Abschnitt 2.4 zeigt es dauerhaft und bietet „Freigeben …“ |
| Doppelklick / Doppeltipp / Enter und Tipp | `laeuft.current` (sofort) | zweiter Aufruf wird verworfen, genau eine Sammlung entsteht |
| Blatt wird während des Zugs geschlossen | Zug lebt im Elternteil | läuft zu Ende, Ergebnis kommt als Hinweis |
| Termin ändert sich während des Zugs (Rundruf) | `event` ist ein Prop | Schritt 3 nimmt die Momentaufnahme aus dem Tipp (was bestätigt wurde), nicht den neuen Stand |
| Eingeladener ohne Zugriff öffnet den Termin | Liste geladen, Sammlung nicht darin | Hinweis aus 1.1 statt Knopf, der ins Leere führt |
| Verknüpfte Sammlung später gelöscht (weiche Löschung, `collection_id` bleibt) | wie oben | derselbe Hinweis; Verwalter kann die Verknüpfung lösen |
| Sammlungsliste nicht ladbar | `useFiles.status === 'error'` ohne Daten | wie heute: „Die Sammlungen konnten nicht geladen werden.“ + „Erneut versuchen“; Ordnerwahl zeigt dann nur „Oberste Ebene“ und den Hinweis |

Ob ein Fehler „endgültig“ ist, entscheidet eine kleine reine Funktion `istEndgueltig(error)` (ApiError mit Status
400–499 ausser 408 und 429); sie ist Teil der Tests.

## 6. Bausteine und Dateizuschnitt

Neu:

- `modules/files/ordner.ts` – rein: `ordnerZeilen(collections, { nurAendern, maxTiefe, filter })` (Baumreihenfolge,
  `{ collection, depth, wahlbar, grund: null | 'nurAnsehen' | 'zuTief' | 'kontext' }`), `ebenen(collections, id)`,
  `pfadText(collections, id, { max })`, `gleichnamigUnter(collections, parentId, name)`.
- `modules/files/OrdnerWahl.tsx` – die Radioliste mit Einrückung, Filter, Hinweis; Eigenschaften: `collections`,
  `wert`, `onChange`, `nurAendern`, `maxTiefe`, `obersteEbeneText`, `gesperrt` (Ids, die der Server schon
  abgelehnt hat). Bewusst im Dateien-Modul: dasselbe Bauteil trägt später „Verschieben“.
- `modules/calendar/terminSammlung.ts` – rein: `standardName(titel)`, `istEndgueltig(error)`,
  `sammlungAnlegenUndVerknuepfen(plan, dienste)`, `nochmalVerknuepfen(plan, sammlung, dienste)`,
  `zugriffsLage(...)`, `erbtVon(...)` (aus Rechten der Kette „wer gilt dort“).
- `modules/calendar/TerminSammlungSheet.tsx`, `modules/calendar/SammlungZugriff.tsx`.
- Stile: Klassen `fil-baum*` in `modules/files/styles.css` (die ist durch `files/module.ts` in der App; der
  Kalender-Stilbogen bleibt unberührt, weil er im Zweig der Einladungsarbeit stark verändert ist).
- `e2e/terminSammlung.spec.ts`, `modules/files/ordner.test.ts`, `modules/calendar/terminSammlung.test.ts`.

Geändert (klein):

- `modules/calendar/EventCollection.tsx` – Aufbau aus 1.1 (Speicher `useFiles`, Auswahl nur änderbar, Pfad,
  zweiter Weg, Hinweis für Eingeladene, `SammlungZugriff`).
- `modules/files/ShareSheet.tsx` – zwei freiwillige Eigenschaften (`personen`, `vorgewaehlt`), sonst unverändert;
  die Ersatzzeile „Alle im zugehörigen Chat haben trotzdem Zugriff“ nur noch, wenn `member_level <> 'none'`.
- `docs/FEATURES.md` („Dateien am Termin“ berichtigen und erweitern), `docs/SICHERHEIT.md` (ein Absatz: Verknüpfen
  vergibt nichts; Freigabe ausdrücklich je Person; Unterordner erbt).
- **Nicht** geändert: Server, `api.ts` (alle Aufrufe gibt es), `packages/shared`, `EventDetailScreen`
  (`EventCollection` behält seine Eigenschaften `event`, `canManage`, `onChanged`).

## 7. Abnahmekriterien

Einheit (vitest, Umgebung `node`, daher reine Logik und Zustand, wie `files/state.test.ts`):

`modules/files/ordner.test.ts`
1. `ordnerZeilen` liefert Baumreihenfolge mit richtiger `depth`, Namen nach `de` sortiert.
2. Ein Ordner mit nur `view` ist `nurAnsehen`/nicht wählbar und **verschwindet**, wenn darunter nichts mit `edit`
   liegt; liegt darunter etwas mit `edit`, bleibt er als `kontext` stehen.
3. Tiefe: Pfadlänge 7 → Kind erlaubt, 8 → `zuTief` (Wurzel = Ebene 1, wie der Server); Zyklus
   (`a`↔`b`) und fehlender Elternordner brechen ab, ohne zu hängen.
4. Filter zeigt Treffer samt Vorfahren; Vorfahren ohne Treffer als `kontext`.
5. `pfadText`: `Eltern › Kind`; mehr als drei Ebenen → `… › B › C › D`; unsichtbarer Elternordner → `… › ` vorn.
6. `gleichnamigUnter` ohne Beachtung von Groß-/Kleinschreibung und Randleerzeichen, für `null` auch bei
   Ordnern mit unsichtbarem Elternordner.

`modules/calendar/terminSammlung.test.ts` (mit `vi.fn`-Diensten)
7. Erfolg: Reihenfolge `anlegen → verknüpfen → freigeben(je Person)`; `anlegen` bekommt `name` getrimmt,
   `parentId`, **kein** `conversationId`, `memberLevel: 'none'`; `freigeben` genau für die Gewählten mit der
   gewählten Stufe; Ergebnis `fertig`, `nichtFreigegeben: []`.
8. Anlegen scheitert (400 Tiefe / 403 / offline) → `nichtAngelegt`, `verknüpfen` und `verwerfen` nie gerufen.
9. Verknüpfen 403/404/409 → `verwerfen` genau einmal, Ergebnis `nichtVerknuepft` mit `aufgeraeumt: true`;
   scheitert `verwerfen`, `aufgeraeumt: false`.
10. Verknüpfen offline/5xx/408/429 → `verwerfen` **nicht** gerufen, Ergebnis `nichtVerknuepft`,
    `aufgeraeumt: false`; `nochmalVerknuepfen` ruft `anlegen` nicht noch einmal, gelingt, gibt frei.
11. Freigeben scheitert bei der 2. von 3 Personen → Ergebnis `fertig`, `nichtFreigegeben` = genau diese eine; die
    dritte wird trotzdem versucht (Teilerfolg, kein Abbruch).
12. `standardName` kürzt 160 → 120 Zeichen, trimmt, fällt bei leerem Titel auf „Neue Sammlung“.
13. `istEndgueltig`: 400/403/404/409 ja; 0, 408, 429, 500, 503 nein.
14. `zugriffsLage`: Anleger, Nutzer-Recht, Chat-Recht (Chat bekannt), `member_level`, Recht am Elternordner zählen;
    Chat unbekannt zählt **nicht** (also „fehlt“); `none`-Mitgliedsstufe zählt nicht; höchste Stufe gewinnt;
    ich selbst fehle nie.

Browser mit Anmeldung (`e2e/terminSammlung.spec.ts`, Anmeldung und Nutzer wie `e2e/termine.spec.ts`: Anna, Bodo,
Cleo registrieren sich selbst; Termin per API mit `attendeeIds: [bodo]`, **ohne** Chatbindung – dadurch gilt
der Test unverändert vor und nach der Einladungsarbeit; Cleo ist nicht eingeladen)
1. **Neu im Unterordner, Eingeladene kommen hinein**: Anna legt per API „Familie“ an, öffnet den Termin, tippt
   „Neue Sammlung anlegen …“, sieht den Titel im Namensfeld, wählt in der Ordnerwahl „Familie“ (eingerückte
   Zeile), sieht Bodo (angehakt) und nicht Cleo, tippt „Anlegen und verknüpfen“. Erwartet: Knopf
   „📁 Familie › {Titel}“; per API `parentId` = „Familie“, Anna `own`; Bodo `GET /collections/{id}` = 200,
   `myLevel: edit`; Cleo = 404; Bodos Termin zeigt den Knopf mit Pfad, Klick öffnet die Sammlung (Überschrift).
2. **Oberste Ebene und Stufe**: Stufe „nur ansehen“ gewählt → Bodo `myLevel: view`; ohne Haken bei Bodo → Bodo 404,
   Zusammenfassung „Nur du hast Zugriff …“, Zugriffszeile im Abschnitt „Sammlung“ nennt Bodo als „kommt nicht
   hinein“.
3. **Ordnerwahl**: Bodo legt „Bodos“ an und gibt Anna nur `view`, darunter „Bodos › Offen“ mit `edit` für Anna →
   „Bodos“ grau mit „nur ansehen“ und nicht wählbar, „Offen“ wählbar; ein weiterer Ordner nur `view` fehlt ganz.
   Eine Kette von acht Ebenen (API) → die achte Zeile „zu tief“, nicht wählbar, Satz „Mehr als 8 Ebenen sind
   nicht vorgesehen“ sichtbar; die siebte wählbar und der Zug gelingt (achte Ebene entsteht).
4. **Geerbtes sichtbar**: Anna hat „Familie“ mit `view` für Cleo freigegeben; wählt sie „Familie“ → im Blatt steht
   „Cleo (ansehen)“ als Zugriff aus dem Ordner.
5. **Verknüpfen abgelehnt → aufgeräumt**: `page.route` beantwortet `PATCH …/collection` mit 403 → Meldung
   „Das Verknüpfen hat nicht geklappt … wieder entfernt“; Annas `GET /collections` enthält den Namen nicht mehr.
6. **Ohne Netz beim Verknüpfen → kein Doppeltes**: `route.abort()` für `PATCH …/collection` → Blatt zeigt
   „angelegt, aber noch nicht mit dem Termin verknüpft“; Route frei, „Erneut verknüpfen“ → verknüpft; in Annas
   Sammlungen **genau eine** mit diesem Namen. Variante „Verwerfen“ → keine mehr.
7. **Doppelklick**: schneller Doppelklick auf „Anlegen und verknüpfen“ → Anzahl `POST /collections` (über
   `page.on('request')`) = 1, genau eine Sammlung.
8. **Ohne Netz beim Anlegen**: `route.abort()` für `POST /collections` → „Keine Verbindung … nichts angelegt“;
   Blatt und Eingaben bleiben stehen; nach Freigabe der Route klappt derselbe Tipp.
9. **Bestehende verknüpfen**: Auswahl listet nur Sammlungen mit `edit`/`own` mit Pfad („Familie › Urlaube“); eine
   `view`-Sammlung fehlt. Nach dem Verknüpfen einer privaten Sammlung nennt „Zugriff der Eingeladenen“ Bodo als
   fehlend; „Freigeben …“ öffnet das `ShareSheet` mit Bodo vorgewählt; nach „Freigeben“ steht „Alle 1 kommen
   hinein“ und Bodo kommt hinein (200). Ist Anna dort nur `edit`, fehlt der Knopf und der Satz „Freigeben kann nur,
   wem die Sammlung gehört“ steht da.
10. **Eingeladener ohne Zugriff**: Bodo (nicht freigegeben) sieht den Hinweis „… nicht freigegeben. Frag {Anna} …“
    und keinen Knopf, der in ein Fehlerband führt.
11. **Lösen**: „Keine“ → Hinweis „Wer schon Zugriff bekam, behält ihn …“; Bodos Zugriff besteht weiter (API 200).

Sonstiges
12. `npx tsc -p tsconfig.json --noEmit`, `npx prettier --check` auf allen berührten Dateien, ganze Vitest-Suite einmal
    am Ende grün; keine neue Abhängigkeit; Server unverändert (`git diff --stat` zeigt nichts unter `apps/api`).
13. Bildschirmfotos (Handybreite) des Blatts mit Ordnerbaum, Zugriffsliste und der Zeile „zu tief“ werden mit dem
    Lesewerkzeug betrachtet (Einrückung lesbar, nichts abgeschnitten, Knopf erreichbar).

## 8. Doku

- `docs/FEATURES.md`, „Dateien am Termin“: zwei Wege nennen (bestehende verknüpfen / neu anlegen, wahlweise in einem
  Ordner), den sichtbaren Zugriffsschritt, „Verknüpfen allein vergibt keine Rechte“, und **berichtigen**: Dokumente
  am Termin und Sammlung sind zwei getrennte Dinge (der Satz „dann liegen seine Dateien dort“ stimmt nicht).
- `docs/SICHERHEIT.md`: Absatz zu Sammlungen am Termin: kein Zugang über Chat oder Einladung, Freigabe je Person,
  Vererbung an Unterordner, was bei Lösen/Ausladen bleibt.

## 9. Risiken und Entscheidungen für den Lead

1. **Momentaufnahme statt Ableitung.** Wer später eingeladen wird, bekommt keinen Zugriff, Ausgeladene behalten ihn.
   Abgemildert durch 2.4 (zeigt Fehlende, Nachholen mit einem Tipp), aber nicht aufgehoben. Die ableitende Lösung
   wäre ein Eingriff ins Rechtemodell (3, 2.1) und nicht Teil dieses Auftrags.
2. **Vorgabe `ändern`** erlaubt jedem Eingeladenen auch das Entfernen fremder Dateien aus der Sammlung (Bestandsregel
   `remove_item` verlangt nur `edit`). Gleiche Regel wie bei Chat-Sammlungen, im Blatt ausgeschrieben. Entscheidung:
   Vorgabe `edit` (Zweck: gemeinsam sammeln) oder `view` (vorsichtiger). Eine Zeile im Code.
3. **Nicht atomar.** Ein Rest „angelegte, nicht verknüpfte Sammlung“ ist möglich, wenn nach dem Anlegen alles
   abreisst (App geschlossen, kein Netz mehr, Aufräumen scheitert). Sie liegt dann in Dateien unter dem Namen des
   Termins, nur für den Anwender sichtbar; die Meldung nennt sie. Der optionale Servergriff (3) schlösse das.
4. **Viele Eingeladene.** Bis 200 Aufrufe nacheinander. Normalfall unkritisch; Fortschritt am Knopf. Eine
   Sammelroute für Freigaben wäre die Serverlösung, falls es je stört.
5. **Tiefe nur als Untergrenze.** Ist ein Elternordner unsichtbar, kennt der Client die wahre Tiefe nicht; der Server
   lehnt ab und das Blatt reagiert (5). Kein Datenschaden.
6. **Geerbte Rechte an Elternordnern, die man nicht sieht.** Das Blatt kann sie nicht nennen, sagt es aber ausdrücklich.
7. **Zugriffszeile nennt Ausgeladene nicht** (die Rechnung geht von den Eingeladenen aus); wer ausgeladen wird,
   behält ein früher vergebenes Recht, bis es im `ShareSheet` zurückgenommen wird. Als Nachfolgearbeit: beim
   Ausladen fragen „Auch den Zugriff auf „X“ zurücknehmen?“
8. **Zusammenführung mit der Einladungsarbeit.** Mein Zuschnitt fasst `EventDetailScreen`, `calendar/styles.css`
   und `api.ts` nicht an (dort hat der Hauptbaum Änderungen). Gemeinsame Dateien: nur `docs/FEATURES.md`
   (andere Abschnitte, triviale Zusammenführung) und das kleine `ShareSheet`. `canManage` bleibt `isCreator`;
   der Server lässt auch Chat-Admins verknüpfen – eine bestehende Abweichung, hier nicht angefasst.
9. **Fehlannahme im Auftrag** (Dokumente „liegen in der Sammlung“) – siehe 0.1; keine Folgen für den Entwurf, aber
   die Doku wird berichtigt. Dokumente am Termin zusätzlich in die Sammlung legen wäre ein eigener Wunsch.
10. **Teilnehmer, die abgesagt haben**, sind vorangehakt (mit Hinweis „hat abgesagt“): Zugriff ist keine Zusage,
    und sie können abgewählt werden.

## 10. Reihenfolge der Umsetzung (Commit-Zuschnitt)

1. `ordner.ts` + Test + `OrdnerWahl.tsx` + Stile („Dateien: Ordnerwahl als Baum, Pfadtext“).
2. `terminSammlung.ts` + Test (reine Logik, Dienste einspeisbar).
3. `TerminSammlungSheet.tsx` + `EventCollection.tsx` (zwei Wege, Pfad, Hinweise) + Browser 1–8, 10–11.
4. `SammlungZugriff.tsx` + `ShareSheet`-Eigenschaften + Browser 9 (trennbar; wenn der Lead nur den Wunsch im engeren
   Sinn will, kann 4 entfallen – dann bleibt das „Verknüpfen verändert nichts“-Verhalten des Bestands, aber die
   neue Sammlung kommt weiter mit sichtbarer Freigabe im Blatt).
5. Doku, Prettier, `tsc`, ganze Suite, Bildschirmfotos.
