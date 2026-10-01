# Entwurf: Der Ort eines Termins wird als Adresse erkannt und verlinkt

Zweig `e-ort` (Ausgangspunkt d786eab). Nur Entwurf, kein Produktivcode im Repo.
Belege liegen in `ergebnis-wt-ort/proto/` (Wegwerf-Skizzen, nicht fürs Repo):

- `adresse-proto.mjs` und `test-proto.mjs`: Erkennung, gegen 123 Beispiele geprüft, 0 Abweichungen.
- `stress.mjs`: Zeitprobe mit bösartigen 300-Zeichen-Eingaben, jeweils unter 1,5 ms.
- `karten-proto.mjs` und `karten-test.mjs`: URL-Bauer, Kodierung, Einschleusungsprobe, Plattformerkennung.

## 0. Kurzfassung und die Entscheidungen, auf die es ankommt

Der Ort bleibt, was er ist: ein freier Text am Termin. Nichts am Server, an der Datenbank, am Schema
oder an der ICS-Ausgabe ändert sich. Die Erkennung läuft in jedem Gerät aus dem Text, also sehen alle
Eingeladenen denselben Link, und jeder öffnet ihn mit SEINER Karten-App. Ältere App-Fassungen zeigen
weiter den reinen Text.

| Frage | Entscheidung | Warum |
|---|---|---|
| Wo wird erkannt? | Reine Funktionen in `lib/adresse.ts`, im Gerät, bei jedem Anzeigen | Keine Geokodierung, kein Netz, keine Migration, Altbestand wirkt sofort |
| Was geht an die Karten-App? | Nur der Adresskern (Straße, Nummer, PLZ, Ort, Land), ohne Namen, Etage, Klammerzusätze | Strenge Suchen (OpenStreetMap) scheitern an „Vereinsheim" oder „3. OG" |
| Wie öffnet sich eine App? | Echte `<a href>`-Links, `target="_blank"`, `rel="noopener noreferrer"`; für `geo:` ohne `target` | Link bleibt Link (Tastatur, Langdruck, Screenreader); kein Referer an Dritte |
| Welche Apps? | Standard-Karten-App (`geo:`, nur Android), Apple Karten (nur Apple), Google Maps, OpenStreetMap, Waze, Bing Karten | Alle ohne Schlüssel und Kosten, Text-Suche per Link belegt. HERE, Organic Maps, Magic Earth: kein verlässlicher Text-Link (siehe 2.3) |
| Wahl merken? | Je Gerät in `localStorage` (`initiative.karten-app`), nicht am Konto | Karten-App hängt am Gerät (iPhone: Apple, Android-Tablet: Google). Kontoweit wäre falsch |
| Liste (`EventRow`) | Bleibt Navigation, KEIN Karten-Link | Verschachtelte Links sind ungültig, und in einer Liste, die man mit dem Daumen durchwischt, wären Fehltipps häufig. Ein Tipp tiefer (Detail) ist der Link da |
| Kalender-Abo (`ical.rs`), Push-Texte | Unverändert | `LOCATION` ist schon reiner Text, die Kalender-Apps machen daraus selbst Karten-Links. Push-Vorschau für Termine ist „Termin" (`constants.rs::message_preview`), enthält keinen Ort |
| Route | Zweiter Schalter im Blatt („Karte zeigen" / „Route hierher") | „Wo sinnvoll": bei Adressen und Koordinaten immer, bei OpenStreetMap nur mit Koordinaten (siehe 2.2) |

Berührungspunkte mit anderen Arbeitszweigen: `EventEditor.tsx`, `EventDetailScreen.tsx`, `EventBubble.tsx`
werden auch von „Einladen" und „Sammlung" angefasst. Die Änderungen hier sind absichtlich klein und
abgegrenzt (je eine Zeile ersetzen bzw. ein Hinweis unter dem Feld), damit das Zusammenführen leicht ist.

## 1. Bestand (Lesebefund)

### 1.1 Wo der Ort vorkommt

| Stelle | Datei:Zeile | Heute | Änderung |
|---|---|---|---|
| Detailansicht | `calendar/EventDetailScreen.tsx:212` | `<p className="cal-detail-line">📍 {event.location}</p>` | `OrtZeile` (Variante „zeile") |
| Chatkarte | `calendar/EventBubble.tsx:62` | `<span className="cal-bubble-line truncate">📍 …` INNERHALB des `<Link className="cal-bubble-head">` | Zeile aus dem Kartenkopf nehmen, darunter als eigene Zeile `OrtZeile` (Variante „inline"); verschachtelte Links gibt es nicht |
| Agenda, Monatsliste | `calendar/EventRow.tsx:15` | `meta` mit `event.location?.trim()`, ganze Zeile ist `Link` | Unverändert (Begründung in Abschnitt 0) |
| Suche | `calendar/KalenderScreen.tsx:131` | Ort geht in den Suchtext | Unverändert |
| Editor | `calendar/EventEditor.tsx:348` | `<input id="cal-location" maxLength={300}>` | Hinweis darunter (`OrtHinweis`), `aria-describedby` |
| Terminfindung | `calendar/PlanningSheet.tsx:261` (`maxLength` am Schema: 200) | Eingabefeld „Ort (freiwillig)" | Derselbe Hinweis |
| Umfrage zu Termin | `polls/CreateEventSheet.tsx:124` | Eingabefeld „Ort (optional)" | Derselbe Hinweis |
| Google-Kalender-Link | `shared/util/ics.ts:149` | `location` geht als Parameter an Google Calendar | Unverändert |
| ICS-Abo | `api/src/ical.rs:103` (`LOCATION:`) | Reiner Text, maskiert | Unverändert |
| Push | `api/src/services/notify.rs`, `constants.rs::message_preview` | „📅 Termin", kein Ort | Unverändert |
| Datenschutzerklärung | `api/src/modules/datenschutz.rs` (Abschnitte „Kalender-Abo", „Streamen auf einen Fernseher") | Kennt keine Karten-Links | Neuer Abschnitt (Text in 3.4) |

Das Schema (`shared/schemas/calendar.ts`): `location: z.string().max(300).nullable().optional()`, bei der
Terminfindung `max(200)`. Die Erkennung kappt ohnehin bei 300.

### 1.2 Wie Blätter, Einstellungen und Browserrahmen gebaut sind

- `components/Sheet.tsx`: `variant="sheet"` (unten) oder `"modal"`, `role="dialog"`, `aria-modal`,
  `aria-labelledby` auf die Titelüberschrift, Zurück-Taste und Esc über `lib/dialogVerlauf.ts`. Das Blatt
  verwaltet KEINEN Fokus (kein Einsprung, keine Rückgabe). Das ist hier nachzurüsten (siehe 3.3, Barrierefreiheit).
- Auswahlblätter im Bestand: `media/DateiAktionen.tsx` (Abschnitte mit `aria-expanded`, `ul.list` mit
  `button.list-row`), `PersonenWahl`. Stile `.list`, `.list-row`, `.btn`, `.btn-block`, `.fil-hint`, `.cal-hint`,
  `.prf-segment` liegen in `styles/global.css` bzw. den Modul-CSS.
- Einstellungen des Anwenders: `profile/SettingsScreen.tsx` reiht Karten (`AppearanceCard`, `CalendarCard`, …) und
  scrollt bei `#hash` zur Karte (`id="kalender"`). Geräteeinstellungen liegen in `localStorage` unter
  `initiative.*` mit `try/catch` (Muster: `stickers/engines/settings.ts`: `initiative.cutout-qualitaet`;
  `video/einstellungen.ts`: `initiative.video-qualitaet`; `state/ui.ts`: Theme, Marke). Kontoeinstellungen gehen
  über `patchMe({ settings })`; `settings.modules` ist ein offener Eintrag je Modul. Für die Karten-App bewusst
  NICHT genutzt (Abschnitt 0).
- Tests: Vitest läuft mit `environment: 'node'`, `localStorage` wird je Test mit `vi.stubGlobal` ersetzt (Muster in
  `stickers/engines/settings.test.ts`). Es gibt keine DOM-Umgebung: Oberfläche wird mit Playwright geprüft
  (Anmeldung per API-Registrierung, Muster `e2e/termine.spec.ts`).
- CSP (`vercel.json`, `Caddyfile`): `default-src 'self'`, kein `navigate-to`. Ein Klick auf einen `<a>` zu einer
  fremden Adresse oder zu `geo:` ist davon nicht berührt; `connect-src`, `img-src` usw. betreffen nur Abrufe der
  Seite selbst. `form-action 'self'` betrifft nur Formulare. Keine CSP-Änderung nötig. Der Service Worker greift nur
  bei Navigationen im eigenen Geltungsbereich (`sw.ts:145`), fremde Ziele sind nicht betroffen.
- `Referrer-Policy: strict-origin-when-cross-origin`: Ohne `noreferrer` ginge die Herkunft (unser Server) an die
  Karten-App. `rel="noopener noreferrer"` schliesst das aus.
- `build.target: 'es2022'` (`vite.config.ts:182`): deckt Rückwärtssuche in regulären Ausdrücken ab (Safari 16.4,
  dieselbe Untergrenze wie Klassen-Blöcke in ES2022). Trotzdem wird das Regelwerk erst bei der ersten Benutzung
  gebaut und eingefangen (siehe 3.1, „Ausfallsicherheit").

## 2. Recherche: Karten-Links ohne Schlüssel und ohne Kosten

Quellen: in dieser Sitzung gegen die Herstellerseiten gelesen: Google Maps URLs, Waze Deep Links, Apple
„Map Links", Android „Common intents" (Maps), Bing Maps „Create a Custom Map URL". Für OpenStreetMap ist nur
`mlat`/`mlon`/`#map=` belegt gelesen worden; die Seiten `/search?query=` und `/directions?route=` stehen aus
Kenntnis (Quelltext der Seite war nicht abrufbar) und sind deshalb als „im Browser zu prüfen" geführt.

### 2.1 Je App

| App (deutscher Name) | Karte zeigen (Text) | Route (Text) | Karte / Route (Koordinaten) | Verhalten | Stolpersteine |
|---|---|---|---|---|---|
| Standard-Karten-App | `geo:0,0?q=<q>` | keine | `geo:<lat>,<lon>?q=<lat>,<lon>` | Nur Android: Absicht (Intent) an die Standard-Karten-App oder Auswahlliste (Google Maps, Organic Maps, OsmAnd, Magic Earth, …). iOS: kein Handler, Link tut nichts. Desktop: nur, wo ein Handler eingetragen ist (z. B. GNOME Karten) | `q` muss kodiert sein (Android-Doku). Ohne installierten Handler passiert nichts, die Seite kann das nicht feststellen. Kein `target`. Route per `geo:` unbekannt |
| Apple Karten | `https://maps.apple.com/?q=<q>` | `https://maps.apple.com/?daddr=<q>` | `?ll=<lat>,<lon>&q=<lat>,<lon>` / `?daddr=<lat>,<lon>` | iOS, iPadOS, macOS: öffnet die App (Universal Link). Andere Systeme: Webkarte im Browser | `dirflg` (`d`/`w`/`r`) wird weggelassen: Karten nimmt die zuletzt benutzte Fortbewegungsart. Ältere Beispiele nutzen `http://`; `https://` ist die Form für heute. Kommt es in einer iOS-PWA zu keiner Übergabe an die App, ist `maps://` der Rückfall (Konstante, siehe Risiken) |
| Google Maps | `https://www.google.com/maps/search/?api=1&query=<q>` | `https://www.google.com/maps/dir/?api=1&destination=<q>` | `query=<lat>%2C<lon>` / `destination=<lat>%2C<lon>` | Android und iOS: öffnet die App, falls installiert, sonst Browser (Doku). Desktop: Browser | `api=1` ist Pflicht. Höchstens 2048 Zeichen. Leerzeichen `%20` oder `+`, Komma `%2C`. Erfahrungsgemäß zeigt die Webseite in der EU nicht angemeldeten Besuchern zuerst eine Einwilligungsseite |
| OpenStreetMap | `https://www.openstreetmap.org/search?query=<q>` | nur mit Koordinaten: `https://www.openstreetmap.org/directions?route=%3B<lat>%2C<lon>` | `?mlat=<lat>&mlon=<lon>#map=17/<lat>/<lon>` | Nur Browser, auf allen Systemen. Keine App, kein Konto | Die Suche ist streng (Nominatim): Namen und Beiwerk führen zu „nichts gefunden", daher der Adresskern. Ob die Route Freitext als Ziel annimmt, ist nicht belegt: bei Text wird sie NICHT angeboten |
| Waze | `https://waze.com/ul?q=<q>` | `https://waze.com/ul?q=<q>&navigate=yes` | `?ll=<lat>%2C<lon>` / `…&navigate=yes` | Mit App: öffnet sie; ohne: Waze im Browser (Doku) | Waze ist eine Navigations-App: „Route" startet die Zielführung. Enthält der Text keinen Ort, hängen die Treffer vom Standort des Geräts ab |
| Bing Karten | `https://bing.com/maps/default.aspx?where1=<q>` | `…?rtp=~adr.<q>` (leerer Start ist belegt) | `?cp=<lat>~<lon>&lvl=17&sp=point.<lat>_<lon>_Ort` / `?rtp=~pos.<lat>_<lon>` | Browser, unter Windows teils die Karten-App | Die Tilde trennt Wegpunkte: Eingabe MUSS `%7E` kodieren (die Standard-Kodierung lässt `~` durch). Die Doku vermerkt „Parameter können sich ändern" |

Beispiele für „Hauptstr. 5, 12345 Berlin" (Ausgabe der Skizze, 1:1 als Testwerte zu übernehmen):

```
system  geo:0,0?q=Hauptstr.%205%2C%2012345%20Berlin
apple   https://maps.apple.com/?q=Hauptstr.%205%2C%2012345%20Berlin
        https://maps.apple.com/?daddr=Hauptstr.%205%2C%2012345%20Berlin
google  https://www.google.com/maps/search/?api=1&query=Hauptstr.%205%2C%2012345%20Berlin
        https://www.google.com/maps/dir/?api=1&destination=Hauptstr.%205%2C%2012345%20Berlin
osm     https://www.openstreetmap.org/search?query=Hauptstr.%205%2C%2012345%20Berlin
waze    https://waze.com/ul?q=Hauptstr.%205%2C%2012345%20Berlin
        https://waze.com/ul?q=Hauptstr.%205%2C%2012345%20Berlin&navigate=yes
bing    https://bing.com/maps/default.aspx?where1=Hauptstr.%205%2C%2012345%20Berlin
        https://bing.com/maps/default.aspx?rtp=~adr.Hauptstr.%205%2C%2012345%20Berlin
Punkt 48.13743 / 11.57549:
system  geo:48.13743,11.57549?q=48.13743%2C11.57549
apple   https://maps.apple.com/?ll=48.13743%2C11.57549&q=48.13743%2C11.57549
google  https://www.google.com/maps/search/?api=1&query=48.13743%2C11.57549
osm     https://www.openstreetmap.org/?mlat=48.13743&mlon=11.57549#map=17/48.13743/11.57549
waze    https://waze.com/ul?ll=48.13743%2C11.57549
bing    https://bing.com/maps/default.aspx?cp=48.13743~11.57549&lvl=17&sp=point.48.13743_11.57549_Ort
```

### 2.2 Kodierung (für alle gleich)

`kodiere(text)` = Steuer- und Richtungszeichen entfernen (`U+0000–001F`, `007F–009F`, `200B–200F`,
`202A–202E`, `2066–2069`, `FEFF`), Leerraum zusammenfassen, verwaiste Surrogate durch `U+FFFD` ersetzen
(`encodeURIComponent` wirft sonst einen `URIError`), auf 300 Zeichen kappen, dann
`encodeURIComponent` PLUS die Zeichen `! ' ( ) * ~`, die es durchlässt. Alles Veränderliche geht ausschliesslich
über diesen einen Weg in eine Adresse; Hosts, Pfade und Parameternamen sind Konstanten. Koordinaten werden
als Zahlen geprüft (endlich, Breite höchstens 90, Länge höchstens 180) und mit Punkt und höchstens sechs
Nachkommastellen geschrieben, nie landesabhängig.

### 2.3 Warum nicht mehr Apps

- **HERE WeGo**: Die dokumentierten Links brauchen Koordinaten (`here-route://`, ältere `share.here.com`-Formen
  leiten um). Ein Text-Link ist nicht belegt.
- **Organic Maps, OsmAnd, Magic Earth**: Eigene Schemata (`om://`, `magicearth://`) sind je Gerät nicht
  verlässlich; auf iOS ohne installierte App melden sie einen Fehler. Auf Android erscheinen sie in der Auswahl
  der Standard-Karten-App (`geo:`), das reicht.
- **Apple Karten auf Android oder Linux**: Die Webkarte ist je nach Browser lückenhaft. Deshalb wird Apple nur auf
  Apple-Geräten angeboten.
- **Markenzeichen**: Keine Logos, nur Namen als Text (benennende Nennung), dazu eine neutrale Symbolzeile.

## 3. Entwurf

### 3.1 Erkennung: `apps/web/src/lib/adresse.ts` (rein, ohne Netz, ohne Zustand)

```ts
export type Sicherheit = 'sicher' | 'vermutlich' | 'offen';

import type { Ziel } from './karten.js'; // Text oder Punkt: was an die Karten-App geht

interface FundBasis { von: number; bis: number; text: string } // Spanne im normalisierten Ort

export interface WebFund extends FundBasis {
  art: 'web';
  url: string;       // new URL(...).href, nur http/https, ohne Zugangsdaten
  anzeige: string;   // Host + Pfad, auf 40 Zeichen mit „…" gekürzt, aus der URL abgeleitet
}
export interface AdressFund extends FundBasis {
  art: 'adresse';
  sicherheit: 'sicher' | 'vermutlich';
  suche: string;     // Adresskern: „Straße Nr, PLZ Ort[, Land]" – ohne Namen, Etage, Klammern
  luecke: 'ort' | 'strasse' | null; // was fehlt, für den Hinweis im Editor
}
export interface PunktFund extends FundBasis {
  art: 'koordinate';
  breite: number;
  laenge: number;
}
export type Fund = WebFund | AdressFund | PunktFund;
export type Stueck = { art: 'text'; text: string } | Fund; // lückenlos: Stücke ergeben wieder den Text

export interface OrtAnalyse {
  text: string;            // normalisiert: getrimmt, Leerraum zusammengefasst, höchstens 300 Zeichen
  sicherheit: Sicherheit;  // stärkste Stufe aller KARTEN-Funde (Web zählt nicht), sonst 'offen'
  stuecke: Stueck[];
  ziel: Ziel | null;       // erstes Karten-Fund-Ziel, sonst offener Suchtext, sonst null
  nurWeb: boolean;         // enthält Links und sonst nichts Kartierbares (Zoom, Teams, Meet)
}

export function ortAnalysieren(ort: string | null | undefined): OrtAnalyse;
export function suchtextOffen(text: string, funde: Fund[]): string | null;
```

Stufen und was sie bewirken:

| Stufe | Bedeutung | Wirkung |
|---|---|---|
| `sicher` | Straße + Nummer MIT Ort/PLZ; oder Straße + Nummer mit eindeutigem Straßenwort (`-straße`, `-str.`, `-weg`, `-allee`, `Rue …`, `Via …`, `12 Main Street`); oder PLZ mit Ländervorsatz (`D-`, `A-`, `CH-`, `L-`); oder gültige Koordinaten | Der Adressteil ist ein Link; Editor: „Adresse erkannt …" |
| `vermutlich` | Straße + Nummer nur mit schwachem Straßenwort (`Am Markt`-artig, `Alte/Neue/Große … Name Nr`, `Im/Zum/Unter den … Name Nr`) ohne Ort; oder 5-stellige PLZ + Ort allein | Ebenfalls Link; Editor: Hinweis, was für genaueres Finden fehlt |
| `offen` | Nichts davon (auch 4-stellige PLZ + Ort allein: zu nah an Jahreszahlen, „2025 Berlin Marathon") | Kein Link im Text; gedämpft „Auf Karte suchen" mit dem bereinigten Gesamttext |

#### Pipeline

1. Normalisieren: Leerraum zusammenfassen, trimmen, auf 300 Zeichen kappen. Leer, `null`, `undefined` ergeben `offen` ohne Ziel.
2. Web-Funde zuerst (`https?://…`, `www.…`, dazu BLOSS die Besprechungsdienste ohne Schema: `zoom.us`, `meet.google.com`,
   `teams.microsoft.com`, `teams.live.com`, `whereby.com`, `meet.jit.si`, `webex.com`, `discord.gg`).
   Satzzeichen am Ende abschneiden (`. , ; : ! ? " '`), `)` nur, wenn unausgewogen. Mit `new URL()` prüfen: Schema muss
   `http:` oder `https:` sein, KEIN Benutzername/Kennwort (`https://bank.de@fremd.example` wäre Täuschung), Host mit Punkt.
   Die Spanne wird danach MASKIERT (durch Leerzeichen ersetzt), damit Adressmuster nicht in Webadressen greifen. Nackte Domains
   („beispiel.de") bleiben Text: zu viele Fehltreffer („z.B.", „2.14").
3. Koordinaten (nach Maskierung): Dezimal mit Punkt (`48.1371, 11.5754`, beide mindestens drei, eine mindestens vier
   Nachkommastellen: schliesst „12.30, 14.45" und Preise aus), Dezimalkomma nur mit `;` oder `/` dazwischen, Himmelsrichtung
   (`48.1371° N, 11.5754° E`, `N 48.1371 E 11.5754`, `O` für Ost), Grad-Minuten-Sekunden (`48°08'14"N 11°34'31"E`, auch `′ ″`),
   Grad-Dezimalminuten. Bereichsprüfung: Breite ≤ 90, Länge ≤ 180, Minuten und Sekunden < 60. Danach maskieren.
4. Straßen (jeweils eine Regel, Quelle in der Skizze): zusammengesetzt (`Hauptstraße`, `Hauptstr.`, `Goethestr`, `Lindenweg`, `…allee`,
   `…gasse`, `…platz`, `…ring`, `…damm`, `…ufer`, `…chaussee`, `…steig`, `…pfad`, `…zeile`, `…promenade`, `…graben`, niederländisch
   `…gracht/straat/laan/plein/kade/singel`, mit mindestens 3 Buchstaben davor, optionaler Titel `Dr.-`, `Prof.-`, `St.-`),
   zweiwortig (`Berliner Allee 12-14`, `Platz der Republik`), Typ vorn (`Rue de la Paix 4`, `Via Roma 12`, `Calle Mayor 5`,
   `Piazza Navona 1`, `Straße des 17. Juni 114`), Präposition (`Am Markt 3`, `An der Alster 12`, `Unter den Linden 77`, schwach),
   Beiwort (`Große Bleichen 5`, `Neuer Wall 10`, schwach), Zahl vorn englisch (`12 Main Street`, `221B Baker Street`, `10 Downing St.`)
   und französisch (`4 rue de la Paix`), dazu „nackte" Typwörter als ganzer Straßenname (`Graben 20`, `Markt 5`, `Ring 2`), die NUR gelten, wenn
   unmittelbar PLZ + Ort oder `, Ortsname` folgt (sonst wären „Weg 3" und „Platz 5" Adressen). Hausnummer: `5`, `5a`, `12-14`, `12 - 14`, `12/3/7`, nicht gefolgt von
   Ziffer, Buchstabe, `.\d`, `:\d`, `Uhr`, `h`, `Min`, `Std`, `Personen`, `Euro`, `€`, `%`, `Tage`, `Kinder`, `Gäste`, …
   Die Obergrenze eines Bereichs hat höchstens 3 Ziffern: „Hauptstr. 5 - 1010 Wien" liest sich so als Nummer 5 und PLZ 1010 (und nicht als „5-1010").
5. PLZ + Ort: 5 oder 4 Ziffern (niederländisch `1015 CJ`), optional `D-`/`A-`/`CH-`/`L-`/… davor, Ort mit Vorsilben
   (`Bad`, `Sankt`, `St.`, `Neu`, `Groß`, `Ober`, `Unter`, `Schwäbisch`, …), Bindewörtern (`Frankfurt am Main`,
   `Freiburg im Breisgau`, `Rothenburg ob der Tauber`) und Bindestrich (`Berlin-Mitte`). Ort mit Sperrliste (`Uhr`, `Euro`,
   `Teilnehmer`, `Personen`, `Besucher`, Wochentage, Monate, …). Allein stehend muss der Ort großgeschrieben sein; nach einer
   Straße darf er klein stehen („hauptstr. 5, 12345 berlin").
6. Zusammenfassen: Straße + PLZ/Ort zu EINEM Fund, wenn nur Trenner (`, ; – -`) und Beiwerk (`3. OG`, `EG`, `Hinterhaus`,
   `Aufgang B`, `Raum 2.14`, `Eingang B`) dazwischen stehen; ebenso Straße + `, Ortsname` (ein großgeschriebenes Wort) und ein
   folgendes `, Deutschland`/`Österreich`/`Schweiz`/`Italien`/… . `suche` wird aus den BESTANDTEILEN zusammengesetzt
   („Hauptstr. 5, 12345 Berlin"), das Beiwerk fällt weg. Die Spanne (`von`/`bis`) umfasst es trotzdem: Der Link liegt über der
   ganzen Adresse, wie der Mensch sie geschrieben hat.
7. Beiwort vor einer zusammengesetzten Straße („Alte Landstraße") wird NACHTRÄGLICH ohne `i`-Flag davorgesetzt (siehe Stolperstein).
8. Ziel: erster Koordinaten- oder Adressfund; sonst `suchtextOffen`; sonst `null`.

`suchtextOffen(text, funde)`: Präfix `Treffpunkt:`/`Ort:`/`Wo:` weg, Webfunde herausschneiden, Klammern `()` und `[]` samt Inhalt weg,
nach Komma/Semikolon zerlegen und Segmente mit Beiwerk (`Raum …`, `Zimmer`, `Saal`, `Etage`, `Stock`, `EG/UG/OG`, `Eingang`, `Gebäude`,
`Haus`, `3. OG`) streichen, wieder zusammensetzen. Weniger als drei Buchstaben oder ein Wort der Liste „ohne Karte" (`Online`, `Zoom`,
`Teams`, `Meet`, `Telefon`, `digital`, `virtuell`, `remote`, `Video`, `zu Hause`, `daheim`, `bei mir/dir/uns/euch`, `Homeoffice`,
`tba`, `tbd`, `noch offen`, `wird noch bekannt gegeben`) → `null`: dann gibt es auch keinen „Auf Karte suchen"-Link.

#### Ausfallsicherheit und Stolpersteine

- Das Regelwerk wird erst beim ersten Aufruf gebaut (`let regeln: Regeln | null`) und ein Fehler beim Bauen (alter Browser ohne
  Rückwärtssuche) wird gefangen: Dann liefert `ortAnalysieren` immer „offen" mit Gesamttext. Eine Karte, die nicht aufgeht, ist besser als
  eine App, die beim Laden eines Moduls abstürzt.
- `\p{Lu}` trifft mit dem Flag `i` AUCH Kleinbuchstaben („der Hauptstr." wurde als Straßenbeiwort „der" geschluckt). Muster mit
  Großschreibungsanforderung laufen ohne `i`; die kleinschreibbaren Typwörter bekommen dort Zeichenklassen oder laufen in einem
  eigenen `i`-Muster. Ein Test hält das fest („Wir treffen uns in der Hauptstr. 5 um 18 Uhr").
- Wortgrenzen: `\b` ist in JS auch mit `u` ASCII-only (ß, ä). Stattdessen `(?<![\p{L}\d])` und `(?![\p{L}\d])`.
- Sperrliste für Zusammengesetztes (Parkplatz, Stellplatz, Sitzplatz, Arbeitsplatz, Spielplatz, Sportplatz, Grillplatz, Zeltplatz,
  Campingplatz, Umweg, Rückweg, Heimweg …) und für Namen nach Präpositionen (Wochentage, Monate, Raum, Saal, Zimmer, Haus, Gebäude,
  Stock, Etage, Tisch, Gleis, Tor, Halle, Stand, Beispiel, Anfang, Ende, Wochenende, Abend, Morgen, Treffen …). Die Listen sind
  benannte Konstanten, jede Zeile ist durch einen Test belegt.
- Zeit: Alle Muster sind ohne verschachtelte Wiederholungen gebaut. Die Skizze braucht für 300-Zeichen-Worst-Cases
  (`Straße ` mal 40, `Am ` mal 100, `Aa-` mal 99 + `str.`, `1.2345 ` mal 40, …) unter 1,5 ms; als Test mit Obergrenze 50 ms.
- Kein Wörterbuch der Postleitzahlen: Wir können „12345 Besucher" nicht von „12345 Berlin" über eine Ortsliste trennen. Deshalb sind
  PLZ + Ort allein nur „vermutlich" (5-stellig) bzw. „offen" (4-stellig) und die Sperrliste fängt die häufigsten Zahlwörter.

#### Prüfbeispiele (werden die Einheitentests; Spalte „Kern" ist `suche` bzw. Fundtext)

Positiv (Text → Stufe):

```
Hauptstr. 5a                                   sicher
Berliner Allee 12-14                           sicher
Via Roma 12                                    sicher
12 Main Street                                 sicher
Rue de la Paix 4                               sicher
4 rue de la Paix, 75002 Paris                  sicher
Vereinsheim, Hauptstr. 5, 12345 Berlin         sicher   suche = Hauptstr. 5, 12345 Berlin
Hauptstraße 5, 80331 München                   sicher
Hauptstr. 5, München                           sicher
Bahnhofstrasse 1, 8001 Zürich                  sicher
Mariahilfer Straße 12/3/7, 1060 Wien           sicher
Graben 20, A-1010 Wien                         sicher   Typwort allein, nur mit Ort davor
Markt 5, 12345 Berlin                          sicher
Kärntner Ring 5-7, 1010 Wien                   sicher
D-80331 München / CH-3000 Bern / L-1234 Luxembourg   sicher
12345 Berlin                                   vermutlich
79098 Freiburg im Breisgau                     vermutlich
60311 Frankfurt am Main                        vermutlich
1010 Wien                                      offen
Am Markt 3                                     sicher   (Markt ist Typwort)
An der Alster 12                               vermutlich
Zum Hirschen 4 / Im Wiesengrund 3              vermutlich
Am Montagsmarkt 3                              vermutlich
Platz der Republik 1, 11011 Berlin             sicher
Straße des 17. Juni 114, 10623 Berlin          sicher
Unter den Linden 77, 10117 Berlin              sicher
Große Bleichen 5, 20354 Hamburg                sicher   (schwaches Beiwort + PLZ Ort)
Neuer Wall 10, 20354 Hamburg                   sicher
Alte Landstraße 3                              sicher   Spanne beginnt bei „Alte"
Calle Mayor 5, 28013 Madrid / Piazza Navona 1  sicher
Keizersgracht 123, 1015 CJ Amsterdam           sicher
Rue du Rhône 10, 1204 Genève                   sicher
Kirchgasse 2, 6900 Bregenz                     sicher
Bundesstraße 5                                 sicher
10 Downing St. / 221B Baker Street, London     sicher
Hauptstr. 5, 3. OG, 12345 Berlin               sicher   suche = Hauptstr. 5, 12345 Berlin; Link über die ganze Spanne
hauptstr. 5, 12345 berlin                      sicher   (Kleinschreibung nach Straße)
hauptstr. 5, 12345 berlin, deutschland         sicher   suche behält das Land
Wilhelm-Leuschner-Str. 12 / Dr.-Müller-Weg 3   sicher
Wir treffen uns in der Hauptstr. 5 um 18 Uhr   sicher   Fund = „Hauptstr. 5"
Bar 25, Holzmarktstraße 25-27, 10243 Berlin    sicher   suche = Holzmarktstraße 25-27, 10243 Berlin
Hauptstr. 5 12345 Berlin / Hauptstr. 5 - 12345 Berlin / Hauptstr. 5 - 1010 Wien   sicher   suche = Hauptstr. 5, 12345 Berlin bzw. Hauptstr. 5, 1010 Wien
Café Central, Herrengasse 14, 1010 Wien        sicher
Raum 2.14 (Uni Passau, Innstraße 41, 94032 Passau)   sicher   suche = Innstraße 41, 94032 Passau
Treffpunkt Marktplatz 7                        sicher
48.1371, 11.5754 / 48.13743 11.57549 / 48,13743; 11,57549     sicher (Koordinate)
48.1371° N, 11.5754° E / N 48.1371 E 11.5754                   sicher
48°08'14"N 11°34'31"E / 48°8.228'N 11°34.524'E                 sicher
```

Negativ (darf KEIN Karten-Fund werden; `ziel` bleibt der bereinigte Suchtext oder `null`):

```
Raum 2.14 · 12.30 Uhr · 24.08.2026 · Zoom · bei Oma · Online · Treffpunkt: 18 Uhr am Eingang
Halle 4 · Tel. 0151 2345678 · Zimmer 5 · Büro, 3. Stock · 5 Personen · ab 14.30 · Terminal 2 · Gleis 7
Tor 3 · Weg 3 · Markt 5 · Ring 3 Uhr · Stand 12 · Kapitel 3 · Version 2.0 · 10/12 Uhr · Hauptbahnhof, Gleis 5 · Am Montag 12 Uhr
Am Samstag 14.30 · Parkplatz 3 · Im Raum 5 · Stadtpark, Eingang Nord · Platz 5 · Route 66 · 1000 Euro
2025 Berlin Marathon · Gemeinde 20000 Besucher · Spring 2 · Im Haus 3 · Am Wochenende 3 Stunden
12.30, 14.45 · 1.500, 2.500 · Haus 3 · Kapelle · bei Familie Müller · Hinterhof · Sporthalle · Büro 3. OG
Im Garten · Beim Treffen 5 · ab 17 Uhr · 3. Stock · Gruppenraum 2 · Umweg 3 · Neue Nachricht
Gebäude B, Raum 204 · Seminarraum 2.14 · Mensa, 2. Stock · Vor dem Haus 3 Personen · Eingang B · Sprint 4
Besprechungsraum 3 · Wohnung 12 · Hotel Sonne, Zimmer 12 · Stuttgart Hbf, Gleis 12 · Meeting 2025 Berlin
Eingang Hauptstraße (keine Nummer) · Spielplatz 3 · Sportplatz 2 · Grillplatz 4
```

Bekannte, bewusst hingenommene Grenzen der Skizze (kommen als Testfälle mit `// bekannte Grenze` in die Datei, damit
niemand sie „repariert" und dabei Besseres kaputt macht): die Sperrliste ist lückenhaft (`Festplatz 3`, `Lagerplatz 2` würden als Adresse gelten); Straßen ohne Typwort und ohne bekanntes Beiwort (z. B. `Hafenkante 3`);
Ort VOR der Straße (`Berlin, Hauptstr. 5`: der Kern ist dann nur die Straße); Polen/Tschechien/Skandinavien (`ul.`, `110 00 Praha`):
bleiben „offen" mit Suchlink; Plus Codes und Drei-Wörter-Adressen: nicht erkannt.

Web (Beispiele): `https://zoom.us/j/123456789?pwd=abc` → Link; `Zoom: https://us02web.zoom.us/j/123.` → Link ohne den Punkt;
`meet.google.com/abc-defg-hij` → Link auf `https://meet.google.com/abc-defg-hij`; `Teams (https://teams.microsoft.com/l/meetup-join/19%3a)` →
Link ohne die schliessende Klammer; `www.example.com/ort` → `https://www.example.com/ort`; `https://example.org/a_(b).` → behält `(b)`;
KEIN Link: `javascript:alert(1)`, `ftp://x.de/a`, `https://user:pw@evil.example/`, `data:`, `intent:`, `file:`.

### 3.2 Karten-Links: `apps/web/src/lib/karten.ts` (rein)

```ts
export type KartenAppKey = 'system' | 'apple' | 'google' | 'osm' | 'waze' | 'bing';
export type Plattform = 'ios' | 'android' | 'mac' | 'andere';
export type Modus = 'karte' | 'route';
export type Ziel = { art: 'text'; text: string } | { art: 'punkt'; breite: number; laenge: number };

export interface KartenApp {
  key: KartenAppKey;
  name: string;      // deutsch
  hinweis: string;   // eine Zeile unter dem Namen im Blatt
  plattformen: Plattform[];
  imBrowser: boolean; // für `target="_blank"`: nur die https-Formen; `geo:` ohne
}

export const KARTEN_APPS: readonly KartenApp[];
export function kodiere(text: string): string;                       // siehe 2.2
export function karteUrl(app: KartenAppKey, ziel: Ziel): string;
export function routeUrl(app: KartenAppKey, ziel: Ziel): string | null; // null: nicht angeboten
export function plattformErkennen(umgebung?: { userAgent: string; plattform: string; touchPunkte: number }): Plattform;
export function appsFuer(plattform: Plattform, modus: Modus, ziel: Ziel): KartenApp[]; // geordnet und gefiltert
export function zielText(ziel: Ziel): string; // was angezeigt und kopiert wird: Adresskern bzw. „48.13743, 11.57549"
```

| Plattform | Erkennung | Reihenfolge |
|---|---|---|
| `android` | `Android` im UserAgent | Standard-Karten-App, Google Maps, OpenStreetMap, Waze, Bing Karten |
| `ios` | `iPhone/iPad/iPod`, oder `Mac` mit `maxTouchPoints > 1` (iPadOS gibt sich als Mac aus) | Apple Karten, Google Maps, Waze, OpenStreetMap, Bing Karten |
| `mac` | `Mac` ohne Touch | Apple Karten, Google Maps, OpenStreetMap, Waze, Bing Karten |
| `andere` | alles übrige (Windows, Linux) | Google Maps, OpenStreetMap, Bing Karten, Waze |

Filter je Modus: `routeUrl(...) === null` blendet die App im Modus „Route" aus (Standard-Karten-App immer, OpenStreetMap bei Text).
Im Blatt steht dazu ein Satz, damit das Fehlen niemanden wundert (Text in 3.3).

Hinweiszeilen (deutsch, ehrlich): Standard-Karten-App „Öffnet die Karten-App deines Geräts, bei mehreren fragt Android nach";
Apple Karten „Öffnet Karten"; Google Maps „Öffnet die App, falls vorhanden, sonst den Browser"; OpenStreetMap „Im Browser, ohne Konto";
Waze „Öffnet die App, falls vorhanden, sonst den Browser. „Route" startet die Zielführung"; Bing Karten „Im Browser".

Einschleusungsprobe (Einheitentest): `x&api=2#frag?q=1~adr.Evil=%00\n<script>"' javascript:alert(1) ‮\uD800 ä€😀` durch alle Apps;
danach muss gelten: `new URL(url)` hat den erwarteten Host, die erwarteten Parameternamen und NUR diese, `searchParams.get(<q-Name>)` ergibt
den bereinigten Text zurück, es gibt keinen Hash (ausser dem festen bei OpenStreetMap-Punkten) und die Ausgabe enthält kein `<`, kein `"`,
kein Steuerzeichen. Die Skizze zeigt für alle sechs Apps: `kein Hash`, nur `q`/`query`/`where1`/`api,query`.

### 3.3 Oberfläche

Neue Dateien (alle deutsch benannt, Stil des Bestands):

| Datei | Inhalt |
|---|---|
| `lib/adresse.ts`, `lib/adresse.test.ts` | 3.1 |
| `lib/karten.ts`, `lib/karten.test.ts` | 3.2 |
| `lib/kartenWahl.ts`, `lib/kartenWahl.test.ts` | Gemerkte Wahl (siehe unten) |
| `components/OrtZeile.tsx` | Der Ort als Inhalt: Stücke, Links, „Auf Karte suchen", „⋯" |
| `components/KartenBlatt.tsx` | Das Auswahlblatt „Öffnen mit" |
| `components/OrtHinweis.tsx` | Zeile unter den Ort-Feldern der drei Editoren |
| `modules/profile/KartenAppCard.tsx` | Einstellung „Karten-App" |
| `e2e/ortKarte.spec.ts` | Browserprüfung |
| Stile | Abschnitt „Orte und Karten" in `styles/global.css`, Karte der Einstellung in `profile/styles.css` |

#### Gemerkte Wahl: `lib/kartenWahl.ts`

- Schlüssel `initiative.karten-app`; Wert ist ein `KartenAppKey`; fehlend heisst „jedes Mal fragen".
- `leseKartenApp()`, `schreibeKartenApp(key | null)` (`null` löscht), `useKartenApp()` (`useSyncExternalStore`, hört auf `storage` für
  einen zweiten Tab und auf eine eigene Abonnentenliste für denselben Tab), `gemerkteApp(plattform)` (liefert die App nur, wenn sie auf
  dieser Plattform angeboten wird, sonst `null`: Blatt öffnet sich wieder).
- Jeder Zugriff in `try/catch`. Wirft der Speicher (privates Fenster, gesperrt), gilt die Wahl bis zum Neuladen aus einer Variablen im Modul.
  Unbekannte oder alte Werte werden ignoriert.

#### Der Ort als Inhalt: `OrtZeile`

Props: `ort: string`, `variante: 'zeile' | 'inline'`. Die Analyse kommt aus `useMemo(() => ortAnalysieren(ort), [ort])`.

- `text`-Stücke: einfacher Text. `overflow-wrap: anywhere`.
- `web`-Stücke: `<a href={url} target="_blank" rel="noopener noreferrer">{anzeige}</a>`, Symbol davor: Kettenglied statt Ortsnadel, wenn
  `nurWeb`. Voller Link als `title` und `aria-label` mit Zusatz „(öffnet im Browser)".
- `adresse`/`koordinate`-Stücke:
  - Keine gemerkte Wahl: `<button type="button" className="ort-link" aria-haspopup="dialog">` mit dem Fundtext; Tipp öffnet das Blatt.
  - Gemerkte Wahl: `<a className="ort-link" href={karteUrl(app, ziel)} target="_blank" rel="noopener noreferrer">` (für `geo:` ohne `target`),
    zusätzlich ein verstecktes `<span className="visually-hidden"> – öffnet in {App}</span>` und daneben
    `<button type="button" className="ort-mehr" aria-label="Mit anderer Karten-App oder als Route öffnen" data-tipp="Anders öffnen">⋯</button>`,
    das das Blatt öffnet. Das direkte Öffnen ist damit ein echter Link: kein Blockieren durch Popup-Sperren, kein Skript beim Tippen.
- Stufe `offen` mit `ziel`: der Text bleibt schlicht; dahinter, gedämpft (`ort-suchen`, Textfarbe `--text-muted`, kleiner, unterstrichen nur beim
  Fokus oder Zeigen): „Auf Karte suchen". Tipp öffnet das Blatt (oder bei gemerkter Wahl den Link, dann mit „⋯" wie oben).
- Stufe `offen` ohne `ziel` oder nur Web: kein Kartenelement.
- Variante `zeile` (Detail): Flex-Zeile mit Mindesthöhe 44 px, Symbol links, Text umbrechend. Variante `inline` (Chatkarte): eine Zeile unter dem
  Kartenkopf, auf zwei Zeilen begrenzt (`line-clamp`), „⋯" als 32-px-Fläche.
- Das Ortssymbol ist `aria-hidden`. Der sichtbare Text ist der Name des Knopfes oder Links; ein zusätzlicher `aria-label` würde ihn nur überschreiben.

Chatkarte (`EventBubble`): Der Kartenkopf (`Link` zum Termin) enthält weiterhin Datum, Titel, Zeit, Wiederholung. Die Ort-Zeile wandert
darunter (`<div className="cal-bubble-ort"><OrtZeile … variante="inline" /></div>`), vor den Nachrichtentext. Damit gibt es keinen Link
im Link, und ein Tipp auf den Kartenkopf navigiert wie bisher. Im e2e gibt es keinen Locator auf `.cal-bubble-*` (per Suche geprüft); der Umbau bricht dort nichts.

#### Das Blatt: `KartenBlatt`

Props: `open`, `onClose`, `ziel: Ziel`, `offen: boolean` (Ort war kein Adresstext), `ausloeser` (Referenz für die Fokusrückgabe).
Aufbau, von oben nach unten (Sheet, `variant="sheet"`):

1. Titel: „Öffnen mit" (bei `offen`: „Auf Karte suchen").
2. Zielzeile (`.karten-ziel`, `overflow-wrap: anywhere`): genau der Text, der an die App geht, z. B. „Hauptstr. 5, 12345 Berlin". Bei `offen` zusätzlich
   `fil-hint`: „Das sieht nicht nach einer Adresse aus. Die Suche kann ins Leere laufen."
3. Umschalter „Karte zeigen" / „Route hierher" (`role="group"`, `aria-label="Was soll geöffnet werden?"`, zwei Knöpfe mit `aria-pressed`, Stil `.prf-segment`
   mit zwei Spalten). Vorgabe „Karte zeigen". Im Modus „Route": Satz „Nicht jede App lässt sich per Link zu einer Route auffordern: Es stehen nur die hier
   gelisteten zur Wahl."
4. Liste (`ul.list`) der Apps aus `appsFuer(plattform, modus, ziel)`: je `<a className="list-row karten-app" href=… target=…>` mit Name, Hinweiszeile,
   bei der gemerkten App zusätzlich „· Standard" (`aria-current="true"`). Mindesthöhe 48 px. Beim Öffnen: `onClick` merkt die Wahl (wenn „Wahl merken" an ist)
   und schliesst das Blatt über `setTimeout(onClose, 0)`: ein sofortiges Aushängen des angeklickten Links vor der Weiterleitung ist in React 18 möglich,
   weil Updates aus Klicks vor der Standardaktion des Browsers durchgeschrieben werden.
5. „Adresse kopieren" (`btn btn-block`): `copyText(zielText(ziel))` aus `calendar/helpers.ts`, dann `toast('Adresse kopiert', 'success')`; scheitert es:
   `toast('Kopieren hat nicht geklappt', 'error')`.
6. Zeile mit Kontrollkästchen „Diese Wahl merken" (nativ, 44-px-Zeile; Vorgabe an: so wünscht es der Auftrag). Ist bereits eine Wahl gemerkt, daneben Textknopf
   „Jedes Mal fragen" (löscht).
7. Datenschutzhinweis (`fil-hint`): „Beim Öffnen geht die Adresse an die gewählte Karten-App und deren Anbieter. Initiative selbst lädt keine Karte und schickt
   nichts, bevor du tippst."
8. Textlink „Karten-App ändern: Profil → Einstellungen" (`Link` zu `/profil/einstellungen#karten-app`; `SettingsScreen` scrollt bereits zu `#hash`).

Das Blatt lädt nichts nach, enthält keine Bilder von Dritten und keine Vorschau.

Barrierefreiheit und Fokus: `Sheet` setzt keinen Fokus. `KartenBlatt` setzt beim Öffnen den Fokus auf die erste App (bei gemerkter Wahl auf diese) über ein `ref`
mit `focus()` im Effekt und gibt ihn beim Schliessen an den Auslöser zurück (`ausloeser.current?.focus()`, wenn das Element noch im Dokument steht). Alle Knöpfe
haben sichtbare Namen; `ort-mehr` einen `aria-label`; die Karte in der Einstellung ist ein `role="radiogroup"` mit `role="radio"`/`aria-checked`.
Fokusrahmen wie im Bestand. Mindestgrösse der Berührungsflächen 44 px, Ausnahme `ort-mehr` in der Chatkarte 32 px (innerhalb der Karte, mit Abstand).

#### Einstellung: `KartenAppCard` (Profil → Einstellungen, Karte „Karten-App", `id="karten-app"`)

Zwischen `CalendarCard` und `CutoutCard`. Inhalt: Überschrift „Karten-App"; Hinweis „Tippst du in einem Termin auf eine Adresse, öffnet sie sich in dieser
App. Dein Handy bekommt die Adresse erst beim Tippen."; `radiogroup` mit „Jedes Mal fragen" (Vorgabe) und den Apps der eigenen Plattform (`appsFuer(plattform, 'karte', …)`
mit einem festen Beispielziel, nur für die Auswahl der Liste); Datenschutzhinweis wie im Blatt; Link „Datenschutzerklärung" wie in `PrivacyCard`. Die Karte hängt an
`useKartenApp()`, wählt man im Blatt „Jedes Mal fragen", ändert sich die Einstellung live.

#### Editor: `OrtHinweis`

Unter dem Feld (`<p id="cal-location-hint" className="cal-hint">`, Eingabe mit `aria-describedby`). Kein `aria-live`: Tippen würde bei jedem Zeichen vorlesen,
der Hinweis wird beim Fokus gelesen. Texte:

| Zustand | Text |
|---|---|
| leer | „Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen." |
| sicher (Adresse) | „Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen." (Zusatzklasse `cal-hint-ok`) |
| vermutlich, `luecke: 'ort'` | „Sieht nach einer Adresse aus. Mit Postleitzahl und Ort findet die Karte sie genauer." |
| vermutlich, `luecke: 'strasse'` | „Nur Postleitzahl und Ort erkannt. Mit Straße und Hausnummer landet die Karte genau am Ziel." |
| Koordinate | „Koordinaten erkannt: Wer eingeladen ist, kann die Stelle in seiner Karten-App öffnen." |
| nur Web | „Link erkannt: Wer eingeladen ist, kann ihn antippen." |
| offen mit `ziel` | „Keine Adresse erkannt. Wer eingeladen ist, kann den Ort trotzdem auf der Karte suchen." |
| offen ohne `ziel` | kein Text (Online, Zoom, bei mir …) |

Dieselbe Komponente steht unter dem Ort-Feld in `PlanningSheet` und `polls/CreateEventSheet` (dort `id` und `aria-describedby` entsprechend).

#### Alle Eingeladenen sehen den Link, jeder mit seiner App

Der Link entsteht beim Anzeigen aus dem Ort-Text. Der Text liegt am Termin, und die Einladungskarten in Gruppen- und Einzelchats sowie die Detailansicht
zeigen denselben `event.location`. Die Wahl der App steht lokal im jeweiligen Gerät. Es gibt keinen Fall, in dem eine Person „den Link der anderen" benutzt.
Wird der Ort geändert, aktualisieren die Karten über den bestehenden Terminstrom; `OrtZeile` rechnet neu.

### 3.4 Sicherheit und Datenschutz

- **Nichts vor dem Tipp**: Die Seite lädt keine Karte, kein Bild, keine Vorschau und setzt kein `rel="prefetch"`/`preconnect`. Die Links sind `<a>`: der Browser
  holt nichts, bis jemand tippt. Der Browsertest zeichnet alle Anfragen auf und verlangt: keine Anfrage an Google, Apple, OpenStreetMap, Waze oder Bing, solange nichts
  getippt wurde (Termin, Chat, Einstellungen).
- **Kein Referer, keine Rückreferenz**: `rel="noopener noreferrer"` an jedem fremden Link. Der Test prüft, dass die Anfrage des geöffneten Fensters keinen `Referer` trägt.
- **Kodierung**: Eine einzige Funktion (`kodiere`), Hosts und Parameter sind Konstanten, Koordinaten sind geprüfte Zahlen. Eingabe wie `javascript:`, `"><script>`, `%00`,
  `&api=2`, `~adr.` bleibt Text in einem Parameterwert. Nutzerwebadressen: nur `http`/`https`, keine Zugangsdaten, angezeigt wird aus der URL Abgeleitetes
  (kein Auseinanderfallen von Anzeige und Ziel).
- **Datenschutz-Hinweis im Blatt** (siehe oben) und in der Einstellung.
- **Datenschutzerklärung** (`api/src/modules/datenschutz.rs`, neuer Abschnitt nach „Kalender-Abo"; Wortlaut zur rechtlichen Prüfung vorgeschlagen):

  > **Karten-Links.** Steht bei einem Termin ein Ort, erkennt die App Adressen und Koordinaten im Text deines Geräts und macht daraus einen Link. Dabei geht nichts an
  > uns oder an Dritte. Erst wenn du den Link antippst und eine Karten-App wählst, wird die Adresse an diese App beziehungsweise ihren Dienst übergeben
  > (Apple, Google, Microsoft/Bing, Waze, die OpenStreetMap Foundation oder die Karten-App deines Android-Geräts). Dann gelten deren Bedingungen; wir haben mit ihnen
  > keinen Vertrag. Wir laden keine Karten und keine Vorschaubilder. Welche App du gewählt hast, merkt sich nur dein Gerät.

  `docs/FEATURES.md` (Abschnitt „Kalender") bekommt zwei Sätze, `docs/SICHERHEIT.md` einen Absatz zu `noreferrer` und zur Kodierung.
- **Keine neuen Abhängigkeiten**, kein neuer Server, keine Schlüssel.

### 3.5 Verhalten bei Nicht-Adressen (zusammengefasst)

| Ort | Anzeige | Karte |
|---|---|---|
| „Hauptstr. 5, 12345 Berlin" | Adressteil als Link | Blatt; Ziel = Adresskern |
| „Vereinsheim, Hauptstr. 5, 12345 Berlin" | „Vereinsheim, " Text, Adressteil als Link | Ziel = „Hauptstr. 5, 12345 Berlin" |
| „48.13743, 11.57549" | Koordinaten als Link | Ziel = Punkt |
| „Stadtpark, Eingang Nord" | Text; dahinter gedämpft „Auf Karte suchen" | Ziel = „Stadtpark" (Beiwerk gestrichen); Blatt mit Vorsichtshinweis |
| „Zoom" / „Online" / „bei mir" | Text | keine Karte |
| „https://zoom.us/j/123" | Link (Kettenglied), öffnet im Browser | keine Karte |
| „Zoom: https://zoom.us/j/123" | „Zoom: " Text, Webadresse als Link | keine Karte |

## 4. Abnahmekriterien mit Tests

E = Einheitentest (Vitest), B = Browser (Playwright, `e2e/ortKarte.spec.ts`; Vorbild `e2e/termine.spec.ts`: Nutzer per API registrieren, Termin per API anlegen,
fremde Hosts per `context.route` abfangen und abbrechen, damit nichts Echtes geladen wird).

| Nr. | Kriterium | Prüfung |
|---|---|---|
| A1 | Alle Positivbeispiele aus 3.1 liefern die genannte Stufe und `suche` | E `adresse.test.ts` (`it.each`) |
| A2 | Alle Negativbeispiele liefern keinen Karten-Fund | E |
| A3 | Spannen stimmen: `ort.slice(von, bis) === fund.text`, Stücke ergeben zusammengesetzt den normalisierten Text, keine Überlappung | E |
| A4 | `suche` enthält weder Namen noch Etage/Raum noch Klammerinhalt | E (Beispiele „Vereinsheim, …", „… 3. OG …", „Raum 2.14 (Uni …)") |
| A5 | Webadressen: nur http/https, keine Zugangsdaten, Satzzeichen und Klammern richtig, `javascript:`/`data:`/`ftp:` nie ein Link | E |
| A6 | Koordinaten: alle Formate, Bereichsprüfung (95,1234 / 11,5 abgelehnt; Minuten 60 abgelehnt), Preise und Uhrzeiten keine Koordinaten | E |
| A7 | Robust: leer, `null`, nur Leerraum, 300 und 301 Zeichen, Emoji, Rechts-nach-links, Steuerzeichen, Nullbreiten-Zeichen; Worst-Case-Eingaben unter 50 ms | E |
| A8 | Jede App: exakte URL für Karte und Route (Text und Punkt) wie in 2.1; Einschleusungsprobe besteht (Host, Parameternamen, kein Hash, Wert gleich bereinigter Text) | E `karten.test.ts` |
| A9 | Plattform: Android/iOS/iPadOS-als-Mac/Mac/Windows/Linux richtig erkannt; `geo:` nur Android; Apple nur Apple; Reihenfolge je Plattform; Route blendet Apps ohne Route aus | E |
| A10 | Wahl merken: schreiben, lesen, löschen; kaputter Wert → `null`; werfender Speicher → Rückfall in den Speicher des Moduls ohne Fehler; nicht angebotene App → `gemerkteApp` ist `null` | E `kartenWahl.test.ts` (Muster `settings.test.ts`) |
| A11 | Vor dem Tippen keine Anfrage an Karten-Hosts (Termin, Chat mit Karte, Einstellungen) | B |
| A12 | Detail: Ort mit Adresse ist ein Knopf mit dem Adressteil als Namen; Tipp öffnet Blatt „Öffnen mit" mit Zielzeile, Umschalter, Appliste (Desktop: Google Maps, OpenStreetMap, Bing Karten, Waze; kein Apple, keine Standard-Karten-App), „Adresse kopieren", „Diese Wahl merken", Datenschutzhinweis | B |
| A13 | Wahl „OpenStreetMap" öffnet ein neues Fenster mit `https://www.openstreetmap.org/search?query=Hauptstr.%205%2C%2012345%20Berlin`; das Blatt schliesst sich; die Anfrage trägt keinen `Referer` | B (`context.waitForEvent('page')`) |
| A14 | Nach Wahl mit „merken": Neuladen; der Ort ist ein `<a href>` mit demselben Ziel; Tipp öffnet direkt; „⋯" öffnet das Blatt; „Jedes Mal fragen" stellt den Zustand zurück und der nächste Tipp öffnet das Blatt | B |
| A15 | Einstellung: Karte „Karten-App" mit `radiogroup`; Auswahl „Waze" ändert `localStorage` und den Link im Termin; Änderung im Blatt spiegelt sich in der Karte | B |
| A16 | Chatkarte: Ort-Zeile ist ein eigener Knopf; kein `a` in `a` (`.cal-bubble a a` zählt 0); Tipp auf den Kartenkopf navigiert weiter zum Termin; Anna und Bodo (zwei Browserkontexte) sehen den Link und haben unabhängige Wahl | B |
| A17 | Agenda/Liste: Zeile bleibt ein einziger Link zum Termin; Ort ist Text | B |
| A18 | „Stadtpark, Eingang Nord": Text plus gedämpftes „Auf Karte suchen", Blatt mit Vorsichtshinweis; „Zoom"/„Online": kein Kartenelement; Ort „https://zoom.us/j/123": `<a>` mit `target="_blank"` und `rel` mit `noopener` und `noreferrer`, kein Kartenelement | B |
| A19 | Editor (und Terminfindung, Umfrage): Hinweis je Stufe, `aria-describedby` am Feld; Hinweis beim Leeren | B |
| A20 | Barrierefrei: Tab-Reihenfolge, Enter öffnet das Blatt, Esc schliesst, Fokus landet erst auf der ersten App und kehrt zum Auslöser zurück; Rollen und Namen vorhanden; Berührungsflächen im Blatt mindestens 44 px; bei 375 px Breite kein waagerechtes Scrollen in Blatt, Detail und Karte | B (`viewport 375`) |
| A21 | „Adresse kopieren" legt `zielText` in die Zwischenablage (Berechtigung gewähren), Meldung „Adresse kopiert" | B |
| A22 | Plattformen: Android-UserAgent → „Standard-Karten-App" mit `href` `geo:0,0?q=…` ohne `target`; iPhone-UserAgent → „Apple Karten" zuerst mit `https://maps.apple.com/?q=…` | B (`userAgent` im Kontext setzen) |
| A23 | `tsc` ohne Fehler, `prettier --check` auf den berührten Dateien, volle Vitest-Suite grün (einmal am Ende), `e2e/termine.spec.ts` und die Terminfälle in `e2e/events.spec.ts` weiter grün | Lauf |
| A24 | `package.json` und `pnpm-lock.yaml` unverändert; keine neue Netzadresse im Bauergebnis ausser den statischen Link-Konstanten | Prüfung des Diffs |

Die Browserprüfung der echten App-Übergabe (iOS-PWA, Android-WebAPK) ist am Gerät zu machen und nicht automatisierbar (siehe Risiken).

Umsetzungsreihenfolge und Commits: (1) `lib/adresse.ts`, `lib/karten.ts`, `lib/kartenWahl.ts` mit Einheitentests (die Skizzen in `proto/` sind die Vorlage, die
Prüfbeispiele werden zu Tabellen); (2) Oberfläche (`OrtZeile`, `KartenBlatt`, `OrtHinweis`, `KartenAppCard`, Einbau in Detail, Chatkarte, drei Editoren, Stile);
(3) `e2e/ortKarte.spec.ts`, Datenschutzabschnitt, `FEATURES.md`/`SICHERHEIT.md`.

## 5. Risiken und offene Punkte

1. **Fehltreffer und Fehlschläge der Erkennung.** Ohne Postleitzahlen- und Straßenverzeichnis ist die Erkennung eine Näherung. Gegenmittel: Stufen, Sperrlisten, und
   der Rückfall „Auf Karte suchen" für alles Übrige: Wer einen Ort nicht als Adresse erkannt bekommt, verliert nichts. Ein falscher Link kostet höchstens einen Tipp.
2. **Übergabe aus der installierten PWA.** Ob ein Link aus einer iOS-Startbildschirm-App (Standalone) wirklich in Apple Karten oder Google Maps landet oder in einem
   Browserfenster der App, ist je iOS-Version unterschiedlich und hier nicht prüfbar. Rückfall für Apple: `maps://` statt `https://maps.apple.com` (eine Konstante
   in `karten.ts`). Am Gerät mit iOS und Android prüfen, bevor das Merken als „fertig" gilt.
3. **`geo:` ohne Handler.** Die Seite kann nicht feststellen, ob eine App den Link annimmt. Auf Android ist fast immer eine da; fehlt sie, passiert nichts. Darum gibt es
   daneben immer „Adresse kopieren" und die Browser-Apps. Auf anderen Systemen wird `geo:` gar nicht angeboten.
4. **Drittadressen ändern sich.** Apple dokumentiert die Parameter in einem Archivdokument, Bing vermerkt „Parameter können sich ändern", die OpenStreetMap-Seiten
   `search` und `directions` sind nicht schriftlich belegt gelesen worden. Alle Formen stehen an EINER Stelle (`karten.ts`) mit je einem Test mit festem Wert; ein Browsertest
   gegen die echten Seiten gehört NICHT in die Standardläufe (Netz, Zugriffsbedingungen), wohl aber in die Handprüfung vor der Freigabe. Route bei OpenStreetMap
   bewusst nur mit Koordinaten.
5. **Google in der EU** zeigt nicht angemeldeten Besuchern zunächst eine Einwilligungsseite, bevor die Suche erscheint. Das liegt bei Google; wer es nicht will, wählt
   OpenStreetMap oder die Standard-App.
6. **Datenschutzrechtliche Bewertung** der Übergabe an Dritte nach Tipp des Anwenders und der neue Abschnitt der Erklärung gehören zur Prüfung durch jemanden, der das
   verantwortet; der Entwurf des Wortlauts oben ist ein Vorschlag.
7. **Liste ohne Karten-Link.** Entscheidung gegen die Anforderung „überall"; wer sie anders trifft: Zeile als `div`, Hauptlink mit `::after` über die ganze Zeile,
   Ort als Geschwisterknopf darüber (gestreckter Link). Mehr Aufwand und mehr Fehltipps.
8. **Umbau der Chatkarte** (Ort-Zeile unter den Kartenkopf) verschiebt die Zeile um eine Position; Ausrichtung und Abstand im CSS prüfen (Bildschirmfoto bei 375 px ansehen).
9. **Merge-Aufwand** mit den Zweigen „Einladen" und „Sammlung" in `EventEditor.tsx`, `EventDetailScreen.tsx`, `EventBubble.tsx`: kleine, getrennte Änderungen und früh zusammenführen.
10. **Fokus im Blatt** ist ein neues Verhalten (das `Sheet` hat es nicht). Es bleibt auf `KartenBlatt` beschränkt, damit kein anderes Blatt sich ändert; eine Vereinheitlichung im `Sheet`
    wäre ein eigener Auftrag.
11. **Regelwerk und alte Browser**: Rückwärtssuche (Safari 16.4); der Fang beim Bauen macht aus einem Fehler „kein Fund" statt eines Absturzes.
12. **Der Text kann den Suchtext verfälschen.** Wer „bei Oma" ins Feld schreibt, bekommt den Link „Auf Karte suchen" mit „bei Oma". Das ist gedämpft und harmlos, aber nicht klug;
    die Liste „ohne Karte" fängt nur die häufigsten Fälle.

## 6. Verworfene Alternativen

| Alternative | Warum nicht |
|---|---|
| **Eigene Geokodierung** (Nominatim, Photon, Pelias, auf eigenem Server) | Brauchte Datenbestand und Betrieb (Planetendaten im zweistelligen bis dreistelligen Gigabyte-Bereich, ODbL mit Namensnennung und Weitergabe unter gleichen Bedingungen) für etwas, das die Karten-App ohnehin kann. Die öffentliche Nominatim-Instanz verbietet den Dauerbetrieb aus Anwendungen. Zusätzlich würde jede Eingabe ans eigene (oder fremde) System gehen, ohne dass jemand getippt hat. Der Gewinn (Koordinaten) steht in keinem Verhältnis. |
| **Eingebettete Karte / Vorschaukarte** (Leaflet oder MapLibre mit OpenStreetMap-Kacheln) | Kacheln kämen von einem fremden Server und würden beim blossen Öffnen des Termins geladen: Verstoss gegen „nichts vor dem Tipp". Die Kachelserver der OpenStreetMap Foundation sind nicht für den Dauerbetrieb einer kommerziellen App gedacht; eigene Kacheln wären ein weiteres Betriebsprojekt. Eine Marke brauchte außerdem Koordinaten, also Geokodierung (siehe oben). |
| **Statisches Kartenbild eines Anbieters** | Schlüssel und Kosten; ausgeschlossen. |
| **Strukturierte Adresse am Termin** (neue Spalten, Migration, Rust-Erkennung) | Doppelte Logik (Rust und TypeScript), Altbestand ohne Wert, ältere Apps sähen nichts; Eingeladene gewinnen nichts, weil sich alles aus dem Text ableiten lässt. Der Text bleibt Quelle der Wahrheit. |
| **`GEO:`/`X-APPLE-STRUCTURED-LOCATION` im ICS-Abo** | Bräuchte die Erkennung im Server; die Kalender-Apps erkennen den `LOCATION`-Text schon selbst. |
| **Nur ein `geo:`-Link, kein Blatt** | Geht nur auf Android; iOS und Desktop gingen leer aus. |
| **Systemteilen-Blatt** (`navigator.share`) | Zeigt Ziele für Weitergeben, nicht „Öffnen in Karte"; kein Weg zur Route. |
| **Zwischenseite auf dem eigenen Server** (`/karte?q=`) | Zusätzlicher Dienst, der jede Adresse sieht; kein Vorteil gegenüber dem direkten Link. |
| **Wahl am Konto speichern** | Die Karten-App hängt am Gerät. Wer iPhone und Android-Tablet hat, will nicht dieselbe. |
| **Logos der Apps** | Markenzeichen; Text und neutrale Zeile genügen. |
| **Verlinken in Chattexten und Beschreibungen** | Nicht beauftragt; würde dieselbe Erkennung nutzen, aber mehr Fehltreffer in Fliesstext bedeuten. Als Folgearbeit möglich, weil `ortAnalysieren` unabhängig ist. |
| **HERE WeGo, Organic Maps (`om://`), Magic Earth** | Kein belegter Text-Link bzw. nicht verlässlich (2.3). |
