import { analysieren } from './adresse-proto.mjs';
const pos = [
 // [text, erwarteteSicherheit, erwarteterKern|null]
 ['Hauptstr. 5a', 'sicher', 'Hauptstr. 5a'],
 ['Am Markt 3', 'sicher', 'Am Markt 3'],
 ['Berliner Allee 12-14', 'sicher', 'Berliner Allee 12-14'],
 ['Via Roma 12', 'sicher', 'Via Roma 12'],
 ['12 Main Street', 'sicher', '12 Main Street'],
 ['Rue de la Paix 4', 'sicher', 'Rue de la Paix 4'],
 ['4 rue de la Paix, 75002 Paris', 'sicher', '4 rue de la Paix, 75002 Paris'],
 ['Vereinsheim, Hauptstr. 5, 12345 Berlin', 'sicher', 'Hauptstr. 5, 12345 Berlin'],
 ['Hauptstraße 5, 80331 München', 'sicher', 'Hauptstraße 5, 80331 München'],
 ['Hauptstr. 5, München', 'sicher', 'Hauptstr. 5, München'],
 ['Bahnhofstrasse 1, 8001 Zürich', 'sicher', 'Bahnhofstrasse 1, 8001 Zürich'],
 ['Mariahilfer Straße 12/3/7, 1060 Wien', 'sicher', 'Mariahilfer Straße 12/3/7, 1060 Wien'],
 ['Graben 20, A-1010 Wien', 'sicher', 'Graben 20, A-1010 Wien'],
 ['Markt 5, 12345 Berlin', 'sicher', 'Markt 5, 12345 Berlin'],
 ['Kärntner Ring 5-7, 1010 Wien', 'sicher', null],
 ['D-80331 München', 'sicher', 'D-80331 München'],
 ['CH-3000 Bern', 'sicher', 'CH-3000 Bern'],
 ['12345 Berlin', 'vermutlich', '12345 Berlin'],
 ['1010 Wien', 'offen', null],
 ['79098 Freiburg im Breisgau', 'vermutlich', '79098 Freiburg im Breisgau'],
 ['60311 Frankfurt am Main', 'vermutlich', null],
 ['Platz der Republik 1, 11011 Berlin', 'sicher', 'Platz der Republik 1, 11011 Berlin'],
 ['Straße des 17. Juni 114, 10623 Berlin', 'sicher', null],
 ['Unter den Linden 77, 10117 Berlin', 'sicher', null],
 ['An der Alster 12', 'vermutlich', 'An der Alster 12'],
 ['Im Wiesengrund 3', 'vermutlich', null],
 ['Große Bleichen 5, 20354 Hamburg', 'sicher', null],
 ['Calle Mayor 5, 28013 Madrid', 'sicher', null],
 ['Piazza Navona 1', 'sicher', null],
 ['Keizersgracht 123, 1015 CJ Amsterdam', 'sicher', null],
 ['48.1371, 11.5754', 'sicher', null],
 ['48.13743 11.57549', 'sicher', null],
 ['48,13743; 11,57549', 'sicher', null],
 ['48.1371° N, 11.5754° E', 'sicher', null],
 ['N 48.1371 E 11.5754', 'sicher', null],
 [`48°08'14"N 11°34'31"E`, 'sicher', null],
 [`48°8.228'N 11°34.524'E`, 'sicher', null],
 ['Treffpunkt Marktplatz 7', 'sicher', null],
 ['hauptstr. 5, 12345 berlin', 'sicher', null],
 ['Café Central, Herrengasse 14, 1010 Wien', 'sicher', null],
 ['Raum 2.14 (Uni Passau, Innstraße 41, 94032 Passau)', 'sicher', null],
 ['Hauptstr. 5 12345 Berlin', 'sicher', null],
 ['Hauptstr. 5, 12345 Berlin, Deutschland', 'sicher', 'Hauptstr. 5, 12345 Berlin, Deutschland'],
 ['10 Downing St.', 'sicher', null],
 ['221B Baker Street, London', 'sicher', null],
 ['Schillerstr. 12 - 14', 'sicher', null],
 ['Zum Hirschen 4', 'vermutlich', null],
 ['Neuer Wall 10, 20354 Hamburg', 'sicher', 'Neuer Wall 10, 20354 Hamburg'],
 ['Hauptstr. 5, 3. OG, 12345 Berlin', 'sicher', 'Hauptstr. 5, 3. OG, 12345 Berlin'],
 ['hauptstr. 5, 12345 berlin', 'sicher', 'hauptstr. 5, 12345 berlin'],
 ['Wilhelm-Leuschner-Str. 12', 'sicher', 'Wilhelm-Leuschner-Str. 12'],
 ['Dr.-Müller-Weg 3', 'sicher', 'Dr.-Müller-Weg 3'],
 ['Wir treffen uns in der Hauptstr. 5 um 18 Uhr', 'sicher', 'Hauptstr. 5'],
 ['Bar 25, Holzmarktstraße 25-27, 10243 Berlin', 'sicher', 'Holzmarktstraße 25-27, 10243 Berlin'],
 ['Hauptstr. 5 - 12345 Berlin', 'sicher', null],
 ['Hauptstr. 5 - 1010 Wien', 'sicher', null],
 ['Rue du Rhône 10, 1204 Genève', 'sicher', null],
 ['L-1234 Luxembourg', 'sicher', null],
 ['Strasse des 17. Juni 114', 'sicher', null],
 ['Alte Landstraße 3', 'sicher', 'Alte Landstraße 3'],
 ['Am Montagsmarkt 3', 'vermutlich', null],
];
const neg = [
 'Raum 2.14', '12.30 Uhr', '24.08.2026', 'Zoom', 'bei Oma', 'Online', 'Treffpunkt: 18 Uhr am Eingang',
 'Halle 4', 'Tel. 0151 2345678', 'Zimmer 5', 'Büro, 3. Stock', '5 Personen', 'ab 14.30', 'Terminal 2', 'Gleis 7',
 'Tor 3', 'Stand 12', 'Kapitel 3', 'Version 2.0', '10/12 Uhr', 'Hauptbahnhof, Gleis 5', 'Am Montag 12 Uhr',
 'Am Samstag 14.30', 'Parkplatz 3', 'Im Raum 5', 'Stadtpark, Eingang Nord', 'Platz 5', 'Route 66', '1000 Euro', '2025 Berlin Marathon',
 'Gemeinde 20000 Besucher', 'Spring 2', 'Im Haus 3', 'Am Wochenende 3 Stunden', '12.30, 14.45', 'Haus 3', 'Kapelle',
 '1.500, 2.500', 'bei Familie Müller', 'Hinterhof', 'Sporthalle', 'Büro 3. OG', 'Im Garten', 'Beim Treffen 5',
 'ab 17 Uhr', '3. Stock', 'Gruppenraum 2', 'Umweg 3', 'Spielplatz 3', 'Sportplatz 2', 'Grillplatz 4', 'Weg 3', 'Markt 5', 'Ring 3 Uhr', 'Neue Nachricht', 'Gebäude B, Raum 204', 'Seminarraum 2.14', 'Mensa, 2. Stock', 'Vor dem Haus 3 Personen', 'Eingang B', 'Spring 2', 'Sprint 4',
];
let fehler = 0;
for (const [t, s, k] of pos) {
  const r = analysieren(t);
  const kern = r.funde.filter(f=>f.art!=='web').map(f=>f.text).join(' | ');
  const ok = r.sicherheit === s && (k == null || r.funde.some(f => f.text === k));
  if (!ok) { fehler++; console.log('FALSCH POS', JSON.stringify(t), '->', r.sicherheit, JSON.stringify(kern), '(erwartet', s, k ?? '', ')'); }
}
for (const t of neg) {
  const r = analysieren(t);
  const f = r.funde.filter(f=>f.art!=='web');
  if (f.length) { fehler++; console.log('FALSCH NEG', JSON.stringify(t), '->', r.sicherheit, JSON.stringify(f.map(x=>x.text))); }
}
const web = [
 'https://zoom.us/j/123456789?pwd=abc', 'Zoom: https://us02web.zoom.us/j/123.', 'meet.google.com/abc-defg-hij', 'Teams (https://teams.microsoft.com/l/meetup-join/19%3a)', 'www.example.com/ort', 'javascript:alert(1)', 'https://user:pw@evil.example/', 'ftp://x.de/a', 'Zoom, https://example.org/a_(b).',
];
for (const t of web) console.log('WEB', JSON.stringify(t), JSON.stringify(analysieren(t).funde.map(f=>[f.art,f.text,f.url])));
console.log('Fehler:', fehler, 'von', pos.length + neg.length);
import { suchtextOffen } from './adresse-proto.mjs';
const off = [
  'Stadtpark, Eingang Nord', 'Stadtpark (Eingang Nord)', 'Mensa, Raum 2.14', 'Zoom', 'Online', 'bei Oma', 'Café Central', 'Treffpunkt: Bahnhof', 'Vereinsheim, https://zoom.us/j/1', 'Raum 2.14', 'Uni Passau, Gebäude B, Raum 204', '😀',
];
for (const t of off) { const a = analysieren(t); console.log('OFFEN', JSON.stringify(t), '->', JSON.stringify(suchtextOffen(t, a.funde))); }
const suchen = ['Vereinsheim, Hauptstr. 5, 12345 Berlin','Hauptstr. 5, 3. OG, 12345 Berlin','hauptstr. 5, 12345 berlin, deutschland','Raum 2.14 (Uni Passau, Innstraße 41, 94032 Passau)','D-80331 München'];
for (const t of suchen) console.log('SUCHE', JSON.stringify(t), '->', JSON.stringify(analysieren(t).funde.map(f=>f.suche)));
