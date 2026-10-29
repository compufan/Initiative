import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ORT,
  ortAnalysieren,
  suchtextOffen,
  type AdressFund,
  type Fund,
  type OrtAnalyse,
  type Sicherheit,
} from './adresse.js';

/** Die Funde, die an eine Karten-App gehen könnten (ohne Web). */
function kartenFunde(analyse: OrtAnalyse): Fund[] {
  return analyse.stuecke.filter(
    (stueck): stueck is Fund => stueck.art === 'adresse' || stueck.art === 'koordinate',
  );
}

function adressFund(ort: string): AdressFund {
  const fund = kartenFunde(ortAnalysieren(ort))[0];
  if (!fund || fund.art !== 'adresse') throw new Error(`Keine Adresse erkannt in „${ort}“`);
  return fund;
}

/* ---------- Adressen ---------- */

/**
 * Eingabe, Stufe, der Fundtext (so, wie er im Ort steht und verlinkt wird)
 * und der Adresskern, der an die Karten-App geht.
 *
 * Die Beispiele stammen aus dem Entwurf; jede Zeile hat einen Grund. Die
 * Erkennung ist eine Näherung (siehe `adresse.ts`), und diese Tabelle ist ihr
 * Vertrag: Wer eine Regel verbessert, sieht hier, was er daneben verschiebt.
 */
const ADRESSEN: [string, Sicherheit, string, string][] = [
  // Strasse und Hausnummer, eindeutiges Strassenwort
  ['Hauptstr. 5a', 'sicher', 'Hauptstr. 5a', 'Hauptstr. 5a'],
  ['Berliner Allee 12-14', 'sicher', 'Berliner Allee 12-14', 'Berliner Allee 12-14'],
  ['Via Roma 12', 'sicher', 'Via Roma 12', 'Via Roma 12'],
  ['12 Main Street', 'sicher', '12 Main Street', '12 Main Street'],
  ['10 Downing St.', 'sicher', '10 Downing St.', '10 Downing St.'],
  ['221B Baker Street, London', 'sicher', '221B Baker Street, London', '221B Baker Street, London'],
  ['Rue de la Paix 4', 'sicher', 'Rue de la Paix 4', 'Rue de la Paix 4'],
  [
    'Calle Mayor 5, 28013 Madrid',
    'sicher',
    'Calle Mayor 5, 28013 Madrid',
    'Calle Mayor 5, 28013 Madrid',
  ],
  ['Piazza Navona 1', 'sicher', 'Piazza Navona 1', 'Piazza Navona 1'],
  ['Bundesstraße 5', 'sicher', 'Bundesstraße 5', 'Bundesstraße 5'],
  ['Wilhelm-Leuschner-Str. 12', 'sicher', 'Wilhelm-Leuschner-Str. 12', 'Wilhelm-Leuschner-Str. 12'],
  ['Dr.-Müller-Weg 3', 'sicher', 'Dr.-Müller-Weg 3', 'Dr.-Müller-Weg 3'],
  ['Schillerstr. 12 - 14', 'sicher', 'Schillerstr. 12 - 14', 'Schillerstr. 12 - 14'],
  ['Hauptstr. 5/7', 'sicher', 'Hauptstr. 5/7', 'Hauptstr. 5/7'],
  ['Bahnhofsplatz 1', 'sicher', 'Bahnhofsplatz 1', 'Bahnhofsplatz 1'],
  ['Alte Landstraße 3', 'sicher', 'Alte Landstraße 3', 'Alte Landstraße 3'],
  ['Strasse des 17. Juni 114', 'sicher', 'Strasse des 17. Juni 114', 'Strasse des 17. Juni 114'],
  ['Am Markt 3', 'sicher', 'Am Markt 3', 'Am Markt 3'],
  ['Treffpunkt Marktplatz 7', 'sicher', 'Marktplatz 7', 'Marktplatz 7'],
  // mit Ort
  [
    '4 rue de la Paix, 75002 Paris',
    'sicher',
    '4 rue de la Paix, 75002 Paris',
    '4 rue de la Paix, 75002 Paris',
  ],
  [
    'Hauptstraße 5, 80331 München',
    'sicher',
    'Hauptstraße 5, 80331 München',
    'Hauptstraße 5, 80331 München',
  ],
  ['Hauptstr. 5, München', 'sicher', 'Hauptstr. 5, München', 'Hauptstr. 5, München'],
  ['Beethovenstraße 12, Bonn', 'sicher', 'Beethovenstraße 12, Bonn', 'Beethovenstraße 12, Bonn'],
  [
    'Bahnhofstrasse 1, 8001 Zürich',
    'sicher',
    'Bahnhofstrasse 1, 8001 Zürich',
    'Bahnhofstrasse 1, 8001 Zürich',
  ],
  [
    'Mariahilfer Straße 12/3/7, 1060 Wien',
    'sicher',
    'Mariahilfer Straße 12/3/7, 1060 Wien',
    'Mariahilfer Straße 12/3/7, 1060 Wien',
  ],
  [
    'Kärntner Ring 5-7, 1010 Wien',
    'sicher',
    'Kärntner Ring 5-7, 1010 Wien',
    'Kärntner Ring 5-7, 1010 Wien',
  ],
  [
    'Kirchgasse 2, 6900 Bregenz',
    'sicher',
    'Kirchgasse 2, 6900 Bregenz',
    'Kirchgasse 2, 6900 Bregenz',
  ],
  [
    'Keizersgracht 123, 1015 CJ Amsterdam',
    'sicher',
    'Keizersgracht 123, 1015 CJ Amsterdam',
    'Keizersgracht 123, 1015 CJ Amsterdam',
  ],
  [
    'Rue du Rhône 10, 1204 Genève',
    'sicher',
    'Rue du Rhône 10, 1204 Genève',
    'Rue du Rhône 10, 1204 Genève',
  ],
  [
    'Platz der Republik 1, 11011 Berlin',
    'sicher',
    'Platz der Republik 1, 11011 Berlin',
    'Platz der Republik 1, 11011 Berlin',
  ],
  [
    'Straße des 17. Juni 114, 10623 Berlin',
    'sicher',
    'Straße des 17. Juni 114, 10623 Berlin',
    'Straße des 17. Juni 114, 10623 Berlin',
  ],
  [
    'Unter den Linden 77, 10117 Berlin',
    'sicher',
    'Unter den Linden 77, 10117 Berlin',
    'Unter den Linden 77, 10117 Berlin',
  ],
  // schwaches Beiwort, aber mit Ort: sicher
  [
    'Große Bleichen 5, 20354 Hamburg',
    'sicher',
    'Große Bleichen 5, 20354 Hamburg',
    'Große Bleichen 5, 20354 Hamburg',
  ],
  [
    'Neuer Wall 10, 20354 Hamburg',
    'sicher',
    'Neuer Wall 10, 20354 Hamburg',
    'Neuer Wall 10, 20354 Hamburg',
  ],
  // Typwort allein als Strassenname: nur mit Ort dahinter
  ['Graben 20, A-1010 Wien', 'sicher', 'Graben 20, A-1010 Wien', 'Graben 20, 1010 Wien'],
  ['Markt 5, 12345 Berlin', 'sicher', 'Markt 5, 12345 Berlin', 'Markt 5, 12345 Berlin'],
  // Name und Beiwerk bleiben ausserhalb des Kerns
  [
    'Vereinsheim, Hauptstr. 5, 12345 Berlin',
    'sicher',
    'Hauptstr. 5, 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  [
    'Café Central, Herrengasse 14, 1010 Wien',
    'sicher',
    'Herrengasse 14, 1010 Wien',
    'Herrengasse 14, 1010 Wien',
  ],
  [
    'Bar 25, Holzmarktstraße 25-27, 10243 Berlin',
    'sicher',
    'Holzmarktstraße 25-27, 10243 Berlin',
    'Holzmarktstraße 25-27, 10243 Berlin',
  ],
  [
    'Hauptstr. 5, 3. OG, 12345 Berlin',
    'sicher',
    'Hauptstr. 5, 3. OG, 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  [
    'Raum 2.14 (Uni Passau, Innstraße 41, 94032 Passau)',
    'sicher',
    'Innstraße 41, 94032 Passau',
    'Innstraße 41, 94032 Passau',
  ],
  ['Wir treffen uns in der Hauptstr. 5 um 18 Uhr', 'sicher', 'Hauptstr. 5', 'Hauptstr. 5'],
  ['Lindenweg 4 Hintereingang', 'sicher', 'Lindenweg 4', 'Lindenweg 4'],
  ['Hauptstr. 5, Hinterhaus', 'sicher', 'Hauptstr. 5', 'Hauptstr. 5'],
  // Trenner zwischen Strasse und Postleitzahl
  [
    'Hauptstr. 5 / 12345 Berlin',
    'sicher',
    'Hauptstr. 5 / 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  [
    'Hauptstr. 5 | 12345 Berlin',
    'sicher',
    'Hauptstr. 5 | 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  [
    'Hauptstr. 5 · 12345 Berlin',
    'sicher',
    'Hauptstr. 5 · 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  [
    'Hauptstr. 5 (Hinterhof), 12345 Berlin',
    'sicher',
    'Hauptstr. 5 (Hinterhof), 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  ['Hauptstr. 5 12345 Berlin', 'sicher', 'Hauptstr. 5 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
  [
    'Hauptstr. 5 - 12345 Berlin',
    'sicher',
    'Hauptstr. 5 - 12345 Berlin',
    'Hauptstr. 5, 12345 Berlin',
  ],
  // Die Obergrenze eines Bereichs hat höchstens drei Ziffern: 5 und 1010, nicht „5-1010“.
  ['Hauptstr. 5 - 1010 Wien', 'sicher', 'Hauptstr. 5 - 1010 Wien', 'Hauptstr. 5, 1010 Wien'],
  // Kleinschreibung nach der Strasse, und das Land bleibt in der Suche
  ['hauptstr. 5, 12345 berlin', 'sicher', 'hauptstr. 5, 12345 berlin', 'hauptstr. 5, 12345 berlin'],
  [
    'hauptstr. 5, 12345 berlin, deutschland',
    'sicher',
    'hauptstr. 5, 12345 berlin, deutschland',
    'hauptstr. 5, 12345 berlin, deutschland',
  ],
  [
    'Dorfstraße 1, 01067 Dresden, Deutschland',
    'sicher',
    'Dorfstraße 1, 01067 Dresden, Deutschland',
    'Dorfstraße 1, 01067 Dresden, Deutschland',
  ],
  // Postleitzahl mit Ländervorsatz ist sicher; der Vorsatz geht nicht an die Suche
  ['D-80331 München', 'sicher', 'D-80331 München', '80331 München'],
  ['CH-3000 Bern', 'sicher', 'CH-3000 Bern', '3000 Bern'],
  ['L-1234 Luxembourg', 'sicher', 'L-1234 Luxembourg', '1234 Luxembourg'],
  // Postleitzahl und Ort allein: fünfstellig vermutlich, vierstellig offen
  ['12345 Berlin', 'vermutlich', '12345 Berlin', '12345 Berlin'],
  [
    '79098 Freiburg im Breisgau',
    'vermutlich',
    '79098 Freiburg im Breisgau',
    '79098 Freiburg im Breisgau',
  ],
  ['60311 Frankfurt am Main', 'vermutlich', '60311 Frankfurt am Main', '60311 Frankfurt am Main'],
  // schwache Strassenwörter ohne Ort: vermutlich
  ['An der Alster 12', 'vermutlich', 'An der Alster 12', 'An der Alster 12'],
  ['Zum Hirschen 4', 'vermutlich', 'Zum Hirschen 4', 'Zum Hirschen 4'],
  ['Im Wiesengrund 3', 'vermutlich', 'Im Wiesengrund 3', 'Im Wiesengrund 3'],
  ['Am Montagsmarkt 3', 'vermutlich', 'Am Montagsmarkt 3', 'Am Montagsmarkt 3'],
];

describe('Adressen erkennen', () => {
  it.each(ADRESSEN)('%s', (eingabe, sicherheit, fundText, suche) => {
    const analyse = ortAnalysieren(eingabe);
    expect(analyse.sicherheit).toBe(sicherheit);
    const fund = adressFund(eingabe);
    expect(fund.text).toBe(fundText);
    expect(fund.suche).toBe(suche);
    expect(fund.sicherheit).toBe(sicherheit);
    expect(analyse.hauptfund).toBe(analyse.stuecke.find((s) => s.art === 'adresse'));
    expect(analyse.ziel).toEqual({ art: 'text', text: suche });
    expect(analyse.nurWeb).toBe(false);
  });

  it('wertet eine vierstellige Postleitzahl allein nicht: zu nah an Jahreszahlen', () => {
    for (const eingabe of ['1010 Wien', '2025 Berlin Marathon', 'Konferenz 2025 in Berlin']) {
      const analyse = ortAnalysieren(eingabe);
      expect(analyse.sicherheit, eingabe).toBe('offen');
      expect(kartenFunde(analyse), eingabe).toEqual([]);
    }
  });

  it('merkt, was der Adresse fehlt – für den Hinweis im Editor', () => {
    expect(adressFund('Hauptstr. 5').luecke).toBe('ort');
    expect(adressFund('An der Alster 12').luecke).toBe('ort');
    expect(adressFund('12345 Berlin').luecke).toBe('strasse');
    expect(adressFund('Hauptstr. 5, 12345 Berlin').luecke).toBeNull();
    expect(adressFund('D-80331 München').luecke).toBeNull();
  });

  it('beginnt die Spanne beim Beiwort („Alte Landstraße“)', () => {
    expect(adressFund('Treffen an Alte Landstraße 3').text).toBe('Alte Landstraße 3');
    expect(adressFund('Neue Hauptstr. 5, 12345 Berlin').text).toBe(
      'Neue Hauptstr. 5, 12345 Berlin',
    );
    // Ohne Beiwort davor bleibt „der“ aussen vor.
    expect(adressFund('in der Hauptstr. 5').text).toBe('Hauptstr. 5');
  });

  it('zieht keine Namen vor der Strasse in die Adresse', () => {
    // Ein Beiwort auf -er („Peter“, „Becker“) gehörte sonst zum Namen der Strasse.
    expect(adressFund('Familie Becker Hauptstr. 5').text).toBe('Hauptstr. 5');
    expect(adressFund('Treffen bei Peter Hauptstr. 5').text).toBe('Hauptstr. 5');
  });

  it('nimmt die erste Adresse als Ziel und alle als Funde', () => {
    const analyse = ortAnalysieren('Hauptstr. 5, 12345 Berlin oder Lindenweg 3, 80331 München');
    expect(kartenFunde(analyse)).toHaveLength(2);
    expect(analyse.ziel).toEqual({ art: 'text', text: 'Hauptstr. 5, 12345 Berlin' });
  });

  it('nimmt bei gemischten Stufen den stärksten Fund als Ziel', () => {
    // Erst ein schwacher, dann ein sicherer Fund: Das Ziel richtet sich nach dem sicheren.
    const analyse = ortAnalysieren('Zum Hirschen 4 oder Hauptstr. 5, 12345 Berlin');
    expect(analyse.sicherheit).toBe('sicher');
    expect(analyse.ziel).toEqual({ art: 'text', text: 'Hauptstr. 5, 12345 Berlin' });
  });
});

/* ---------- Was KEINE Adresse ist ---------- */

const KEINE_ADRESSE = [
  'Raum 2.14',
  '12.30 Uhr',
  '24.08.2026',
  'Zoom',
  'bei Oma',
  'Online',
  'Treffpunkt: 18 Uhr am Eingang',
  'Halle 4',
  'Tel. 0151 2345678',
  'Zimmer 5',
  'Büro, 3. Stock',
  '5 Personen',
  'ab 14.30',
  'Terminal 2',
  'Gleis 7',
  'Tor 3',
  'Weg 3',
  'Markt 5',
  'Ring 3 Uhr',
  'Stand 12',
  'Kapitel 3',
  'Version 2.0',
  '10/12 Uhr',
  'Hauptbahnhof, Gleis 5',
  'Am Montag 12 Uhr',
  'Am Samstag 14.30',
  'Parkplatz 3',
  'Im Raum 5',
  'Stadtpark, Eingang Nord',
  'Platz 5',
  'Route 66',
  '1000 Euro',
  '2025 Berlin Marathon',
  'Gemeinde 20000 Besucher',
  'Spring 2',
  'Im Haus 3',
  'Am Wochenende 3 Stunden',
  '12.30, 14.45',
  '1.500, 2.500',
  'Haus 3',
  'Kapelle',
  'bei Familie Müller',
  'Hinterhof',
  'Sporthalle',
  'Büro 3. OG',
  'Im Garten',
  'Beim Treffen 5',
  'ab 17 Uhr',
  '3. Stock',
  'Gruppenraum 2',
  'Umweg 3',
  'Neue Nachricht',
  'Gebäude B, Raum 204',
  'Seminarraum 2.14',
  'Mensa, 2. Stock',
  'Vor dem Haus 3 Personen',
  'Eingang B',
  'Sprint 4',
  'Besprechungsraum 3',
  'Wohnung 12',
  'Hotel Sonne, Zimmer 12',
  'Stuttgart Hbf, Gleis 12',
  'Meeting 2025 Berlin',
  'Eingang Hauptstraße (keine Nummer)',
  'Spielplatz 3',
  'Sportplatz 2',
  'Grillplatz 4',
  'Hauptstr. 5 Personen',
  'Weg nach Hause 3',
  'Der Weg nach Hause 3 Stunden',
  '12345 Besucher',
  'Hauptstraße ohne Nummer',
  'Straße',
];

describe('Was keine Adresse ist', () => {
  it.each(KEINE_ADRESSE)('%s', (eingabe) => {
    const analyse = ortAnalysieren(eingabe);
    expect(kartenFunde(analyse), eingabe).toEqual([]);
    expect(analyse.sicherheit).toBe('offen');
    expect(analyse.hauptfund).toBeNull();
    // Ohne Fund bleibt der Ort ein einziges Textstück.
    expect(analyse.stuecke).toEqual([{ art: 'text', text: analyse.text }]);
  });

  it('gibt für Besprechungsdienste, „zu Hause“ und Offenes kein Ziel', () => {
    for (const eingabe of [
      'Zoom',
      'Online',
      'online',
      'Teams',
      'bei mir',
      'bei Oma',
      'zu Hause',
      'Homeoffice',
      'TBA',
      'noch offen',
      'wird noch bekannt gegeben',
      'Raum 2.14',
      'Tel. 0151 2345678',
      '😀',
      'ab',
    ]) {
      expect(ortAnalysieren(eingabe).ziel, eingabe).toBeNull();
    }
  });

  it('bietet bei einem Ort ohne Adresse den bereinigten Suchtext an', () => {
    expect(ortAnalysieren('Stadtpark, Eingang Nord').ziel).toEqual({
      art: 'text',
      text: 'Stadtpark',
    });
    expect(ortAnalysieren('Café Central').ziel).toEqual({ art: 'text', text: 'Café Central' });
  });

  // Bekannte, bewusst hingenommene Grenzen der Erkennung. Sie stehen hier,
  // damit niemand sie „repariert“ und dabei Besseres kaputt macht: Jede
  // Regel gegen sie ist eine Regel mehr, die echte Adressen verfehlen kann.
  describe('bekannte Grenzen', () => {
    it('Sperrliste ist lückenhaft: Festplatz 3 und Lagerplatz 2 gelten als Adresse', () => {
      // bekannte Grenze
      expect(ortAnalysieren('Festplatz 3').sicherheit).toBe('sicher');
      expect(ortAnalysieren('Lagerplatz 2').sicherheit).toBe('sicher');
    });

    it('Strassen ohne Typwort und ohne bekanntes Beiwort werden nicht erkannt', () => {
      // bekannte Grenze
      expect(ortAnalysieren('Hafenkante 3').sicherheit).toBe('offen');
    });

    it('Ein Beiwort auf -er vor einer zusammengesetzten Strasse bleibt aussen', () => {
      // bekannte Grenze: „Rosenheimer“ gehört zum Namen, ist aber von einem
      // Namen vor der Adresse („Becker Hauptstr. 5“) nicht zu unterscheiden.
      // Lieber die Strasse allein verlinken als einen Namen in die Suche ziehen.
      expect(adressFund('Rosenheimer Landstraße 23').text).toBe('Landstraße 23');
    });

    it('Ort VOR der Strasse: der Kern ist dann nur die Strasse', () => {
      // bekannte Grenze
      expect(adressFund('Berlin, Hauptstr. 5').suche).toBe('Hauptstr. 5');
    });

    it('Polen, Tschechien und Skandinavien bleiben offen', () => {
      // bekannte Grenze
      expect(ortAnalysieren('ul. Marszałkowska 10, 00-590 Warszawa').sicherheit).toBe('offen');
      expect(ortAnalysieren('Václavské náměstí 1, 110 00 Praha').sicherheit).toBe('offen');
    });

    it('Plus Codes und Drei-Wörter-Adressen werden nicht erkannt', () => {
      // bekannte Grenze
      expect(ortAnalysieren('8FWC2345+G6').sicherheit).toBe('offen');
      expect(ortAnalysieren('///filled.count.soap').sicherheit).toBe('offen');
    });
  });
});

/* ---------- Koordinaten ---------- */

describe('Koordinaten', () => {
  it.each<[string, number, number]>([
    ['48.1371, 11.5754', 48.1371, 11.5754],
    ['48.13743 11.57549', 48.13743, 11.57549],
    ['48.13743,11.57549', 48.13743, 11.57549],
    ['48,13743; 11,57549', 48.13743, 11.57549],
    ['48,13743 / 11,57549', 48.13743, 11.57549],
    ['48.1371° N, 11.5754° E', 48.1371, 11.5754],
    ['48.1371°N 11.5754°E', 48.1371, 11.5754],
    ['N 48.1371 E 11.5754', 48.1371, 11.5754],
    ['N 48.1371, O 11.5754', 48.1371, 11.5754],
    ['33.8688° S, 151.2093° E', -33.8688, 151.2093],
    ['40.7128° N, 74.0060° W', 40.7128, -74.006],
    ['-33.8688, 151.2093', -33.8688, 151.2093],
    ["48°8.228'N 11°34.524'E", 48.137133, 11.5754],
    ['Treffpunkt 48.13743, 11.57549 am Brunnen', 48.13743, 11.57549],
  ])('%s', (eingabe, breite, laenge) => {
    const analyse = ortAnalysieren(eingabe);
    expect(analyse.sicherheit).toBe('sicher');
    const fund = kartenFunde(analyse)[0];
    expect(fund.art).toBe('koordinate');
    if (fund.art !== 'koordinate') return;
    expect(fund.breite).toBeCloseTo(breite, 5);
    expect(fund.laenge).toBeCloseTo(laenge, 5);
    expect(analyse.ziel?.art).toBe('punkt');
    expect(analyse.nurWeb).toBe(false);
  });

  it('rechnet Grad, Minuten und Sekunden um', () => {
    const fund = kartenFunde(ortAnalysieren('48°08\'14"N 11°34\'31"E'))[0];
    if (fund?.art !== 'koordinate') throw new Error('Keine Koordinate');
    expect(fund.breite).toBeCloseTo(48.137222, 5);
    expect(fund.laenge).toBeCloseTo(11.575278, 5);
    // Mit den typografischen Zeichen für Minute und Sekunde.
    const typografisch = kartenFunde(ortAnalysieren('48°08′14″N 11°34′31″E'))[0];
    expect(typografisch?.art).toBe('koordinate');
  });

  it('verlinkt nur die Koordinate, nicht den Text darum', () => {
    const fund = kartenFunde(ortAnalysieren('Treffpunkt 48.13743, 11.57549 am Brunnen'))[0];
    expect(fund.text).toBe('48.13743, 11.57549');
  });

  it.each([
    '95.1234, 11.5',
    '95.12345, 11.12345',
    '48.12345, 190.12345',
    '91.12345 11.12345',
    `48°75'14"N 11°34'31"E`,
    `48°08'61"N 11°34'31"E`,
    `48°08'14"N 11°60'31"E`,
    `48°61.5'N 11°34.5'E`,
    'N 95.1234 E 11.5754',
    '48,1371, 11,5754',
    '12.30, 14.45',
    '1.500, 2.500',
    '19.99 24.99',
    'Preis 12.50, 3.75 Euro',
    '48.137, 11.575',
    'Version 2.0.1',
    'ab 14.30 bis 16.45',
    '24.08.2026',
  ])('%s ist keine Koordinate', (eingabe) => {
    const analyse = ortAnalysieren(eingabe);
    expect(
      kartenFunde(analyse).filter((fund) => fund.art === 'koordinate'),
      eingabe,
    ).toEqual([]);
  });
});

/* ---------- Webadressen ---------- */

describe('Webadressen', () => {
  const webFunde = (eingabe: string) =>
    ortAnalysieren(eingabe).stuecke.filter((stueck) => stueck.art === 'web');

  it.each<[string, string, string]>([
    [
      'https://zoom.us/j/123456789?pwd=abc',
      'https://zoom.us/j/123456789?pwd=abc',
      'zoom.us/j/123456789',
    ],
    [
      'Zoom: https://us02web.zoom.us/j/123.',
      'https://us02web.zoom.us/j/123',
      'us02web.zoom.us/j/123',
    ],
    [
      'meet.google.com/abc-defg-hij',
      'https://meet.google.com/abc-defg-hij',
      'meet.google.com/abc-defg-hij',
    ],
    [
      'Teams (https://teams.microsoft.com/l/meetup-join/19%3a)',
      'https://teams.microsoft.com/l/meetup-join/19%3a',
      'teams.microsoft.com/l/meetup-join/19%3a',
    ],
    ['www.example.com/ort', 'https://www.example.com/ort', 'www.example.com/ort'],
    ['https://example.org/a_(b).', 'https://example.org/a_(b)', 'example.org/a_(b)'],
    ['http://example.org', 'http://example.org/', 'example.org'],
    ['Link: "https://example.org/x",', 'https://example.org/x', 'example.org/x'],
    ['whereby.com/raum', 'https://whereby.com/raum', 'whereby.com/raum'],
    ['meet.jit.si/Besprechung', 'https://meet.jit.si/Besprechung', 'meet.jit.si/Besprechung'],
    ['zoom.us/j/1', 'https://zoom.us/j/1', 'zoom.us/j/1'],
    ['HTTPS://Example.ORG/Pfad', 'https://example.org/Pfad', 'example.org/Pfad'],
  ])('%s', (eingabe, url, anzeige) => {
    const funde = webFunde(eingabe);
    expect(funde).toHaveLength(1);
    const fund = funde[0];
    if (fund.art !== 'web') throw new Error('kein Web-Fund');
    expect(fund.url).toBe(url);
    expect(fund.anzeige).toBe(anzeige);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'ftp://x.de/a',
    'ftp://www.x.de/a',
    'data:text/html,<script>alert(1)</script>',
    'intent://x#Intent;scheme=http;end',
    'file:///etc/passwd',
    'https://user:pw@evil.example/',
    'https://bank.de@fremd.example/',
    'https://nur-ein-name/',
    'beispiel.de',
    'z.B. 2.14',
    'mailto:a@b.de',
    'notzoom.us/j/1',
  ])('%s wird nie zum Link', (eingabe) => {
    expect(webFunde(eingabe), eingabe).toEqual([]);
  });

  it('kürzt die Anzeige auf 40 Zeichen und leitet sie aus der Adresse ab', () => {
    const fund = webFunde(
      'https://example.org/ein/sehr/langer/pfad/der/nicht/in/die/zeile/passt?x=1',
    )[0];
    if (fund.art !== 'web') throw new Error('kein Web-Fund');
    expect(fund.anzeige).toHaveLength(40);
    expect(fund.anzeige.endsWith('…')).toBe(true);
    expect(fund.anzeige.startsWith('example.org/ein/sehr/')).toBe(true);
    // Die Anfrage gehört nicht in die Anzeige, aber in den Link.
    expect(fund.url).toContain('?x=1');
  });

  it('zeigt bei einer Adresse mit Umlauten die Punycode-Form des Rechners', () => {
    // Was angezeigt wird, ist, wohin der Link führt – kein Auseinanderfallen.
    const fund = webFunde('https://bücher.example/a')[0];
    if (fund.art !== 'web') throw new Error('kein Web-Fund');
    expect(fund.anzeige).toBe('xn--bcher-kva.example/a');
    expect(fund.url).toBe('https://xn--bcher-kva.example/a');
  });

  it('lässt Adressmuster in Webadressen nicht greifen', () => {
    // „Hauptstr. 5“ steht im Pfad: Es ist Teil der Webadresse, keine Adresse.
    const analyse = ortAnalysieren('https://example.org/Hauptstr.%205/12345');
    expect(kartenFunde(analyse)).toEqual([]);
    expect(analyse.stuecke).toHaveLength(1);
    expect(analyse.stuecke[0].art).toBe('web');
  });

  it('findet Adresse und Link nebeneinander', () => {
    const analyse = ortAnalysieren(
      'Vereinsheim, Hauptstr. 5, 12345 Berlin, https://example.org/anfahrt',
    );
    expect(analyse.stuecke.map((stueck) => stueck.art)).toEqual(['text', 'adresse', 'text', 'web']);
    expect(analyse.ziel).toEqual({ art: 'text', text: 'Hauptstr. 5, 12345 Berlin' });
    expect(analyse.nurWeb).toBe(false);
  });

  it('meldet „nur Web“ ohne Ziel: Zoom, Teams, Meet', () => {
    for (const eingabe of [
      'https://zoom.us/j/123',
      'Zoom: https://zoom.us/j/123',
      'meet.google.com/abc-defg-hij',
      'Teams (https://teams.microsoft.com/l/meetup-join/19%3a)',
    ]) {
      const analyse = ortAnalysieren(eingabe);
      expect(analyse.nurWeb, eingabe).toBe(true);
      expect(analyse.ziel, eingabe).toBeNull();
      expect(analyse.sicherheit, eingabe).toBe('offen');
    }
  });

  it('meldet nicht „nur Web“, wenn daneben etwas zu suchen ist', () => {
    const analyse = ortAnalysieren('Vereinsheim, https://zoom.us/j/1');
    expect(analyse.nurWeb).toBe(false);
    expect(analyse.ziel).toEqual({ art: 'text', text: 'Vereinsheim' });
  });
});

/* ---------- Spannen und Stücke ---------- */

const ALLE_BEISPIELE = [
  ...ADRESSEN.map(([eingabe]) => eingabe),
  '48.13743, 11.57549',
  'Treffpunkt 48.13743, 11.57549 am Brunnen',
  'Zoom: https://zoom.us/j/123. Dann Hauptstr. 5, 12345 Berlin',
  'Vereinsheim, Hauptstr. 5, 12345 Berlin, https://example.org/anfahrt',
  'https://example.org/Hauptstr.%205 und 48.13743 11.57549',
  'Hauptstr. 5, 12345 Berlin oder Lindenweg 3, 80331 München',
  '  Hauptstr.   5 ,\n 12345\tBerlin  ',
  '😀 Hauptstr. 5, 12345 Berlin 😀',
  'Stadtpark, Eingang Nord',
  '',
];

describe('Spannen und Stücke', () => {
  it.each(ALLE_BEISPIELE)('%j', (eingabe) => {
    const analyse = ortAnalysieren(eingabe);
    // Die Stücke ergeben wieder den normalisierten Text, lückenlos.
    expect(analyse.stuecke.map((stueck) => stueck.text).join('')).toBe(analyse.text);

    let position = 0;
    for (const stueck of analyse.stuecke) {
      expect(stueck.text.length).toBeGreaterThan(0);
      if (stueck.art !== 'text') {
        // Die Spanne zeigt auf genau diesen Text, und nichts überlappt.
        expect(analyse.text.slice(stueck.von, stueck.bis)).toBe(stueck.text);
        expect(stueck.von).toBe(position);
      }
      position += stueck.text.length;
    }
    expect(position).toBe(analyse.text.length);
  });

  it('zählt die Spanne im NORMALISIERTEN Text', () => {
    const analyse = ortAnalysieren('  Vereinsheim,\n\n  Hauptstr.  5,   12345 Berlin ');
    expect(analyse.text).toBe('Vereinsheim, Hauptstr. 5, 12345 Berlin');
    const fund = kartenFunde(analyse)[0];
    expect(analyse.text.slice(fund.von, fund.bis)).toBe('Hauptstr. 5, 12345 Berlin');
  });
});

describe('Suchkern ohne Namen, Etage und Klammerzusätze', () => {
  it.each<[string, string]>([
    ['Vereinsheim, Hauptstr. 5, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, 3. OG, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, EG, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, Hinterhaus, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, Aufgang B, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, Raum 2.14, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Hauptstr. 5, Eingang B, 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
    ['Raum 2.14 (Uni Passau, Innstraße 41, 94032 Passau)', 'Innstraße 41, 94032 Passau'],
    ['Bar 25, Holzmarktstraße 25-27, 10243 Berlin', 'Holzmarktstraße 25-27, 10243 Berlin'],
    ['Hauptstr. 5 (hinten rechts), 12345 Berlin', 'Hauptstr. 5, 12345 Berlin'],
  ])('%s', (eingabe, suche) => {
    const fund = adressFund(eingabe);
    expect(fund.suche).toBe(suche);
    // Weder Name noch Etage noch Raum noch Klammerinhalt.
    expect(fund.suche).not.toMatch(
      /Vereinsheim|OG|EG|Hinterhaus|Aufgang|Raum|Eingang|Uni Passau|Bar 25|\(/,
    );
  });

  it('legt den Link über die ganze Adresse, wie der Mensch sie geschrieben hat', () => {
    const fund = adressFund('Hauptstr. 5, 3. OG, 12345 Berlin');
    expect(fund.text).toBe('Hauptstr. 5, 3. OG, 12345 Berlin');
    expect(fund.suche).toBe('Hauptstr. 5, 12345 Berlin');
  });
});

/* ---------- suchtextOffen ---------- */

describe('suchtextOffen', () => {
  it.each<[string, string | null]>([
    ['Stadtpark, Eingang Nord', 'Stadtpark'],
    ['Stadtpark (Eingang Nord)', 'Stadtpark'],
    ['Mensa, Raum 2.14', 'Mensa'],
    ['Mensa [Raum 2.14]', 'Mensa'],
    ['Treffpunkt: Bahnhof', 'Bahnhof'],
    ['Treffpunkt Bahnhof', 'Bahnhof'],
    ['Ort: Stadtpark', 'Stadtpark'],
    ['Wo: Stadtpark', 'Stadtpark'],
    ['Uni Passau, Gebäude B, Raum 204', 'Uni Passau'],
    ['Café Central', 'Café Central'],
    ['Café Central, 3. OG', 'Café Central'],
    ['Zoom', null],
    ['Online', null],
    ['online.', null],
    ['Teams', null],
    ['Meet', null],
    ['bei mir', null],
    ['bei Oma', null],
    ['bei Familie Müller', null],
    ['zu Hause', null],
    ['daheim', null],
    ['Homeoffice', null],
    ['tba', null],
    ['noch offen', null],
    ['Raum 2.14', null],
    ['Tel. 0151 2345678', null],
    ['javascript:alert(1)', null],
    ['😀', null],
    ['ab', null],
    ['', null],
    ['   ', null],
  ])('%j → %j', (eingabe, erwartet) => {
    expect(suchtextOffen(eingabe)).toBe(erwartet);
  });

  it('schneidet Web-Funde heraus', () => {
    const text = 'Vereinsheim, https://zoom.us/j/1';
    expect(
      suchtextOffen(
        text,
        ortAnalysieren(text).stuecke.filter((s): s is Fund => s.art !== 'text'),
      ),
    ).toBe('Vereinsheim');
  });

  it('gibt nur Zoom + Link keinen Suchtext', () => {
    const text = 'Zoom: https://zoom.us/j/1';
    const funde = ortAnalysieren(text).stuecke.filter((s): s is Fund => s.art !== 'text');
    expect(suchtextOffen(text, funde)).toBeNull();
  });
});

/* ---------- Robustheit ---------- */

describe('Robustheit', () => {
  it('verträgt nichts, Leerraum und Unlesbares', () => {
    for (const eingabe of [null, undefined, '', '   ', '\n\t ', '​', '‮']) {
      const analyse = ortAnalysieren(eingabe);
      expect(analyse.sicherheit).toBe('offen');
      expect(analyse.ziel).toBeNull();
      expect(analyse.nurWeb).toBe(false);
      expect(analyse.hauptfund).toBeNull();
    }
    expect(ortAnalysieren(null).stuecke).toEqual([]);
    expect(ortAnalysieren('   ').text).toBe('');
  });

  it('verträgt etwas, das kein Text ist', () => {
    expect(ortAnalysieren(42 as unknown as string).text).toBe('');
    expect(ortAnalysieren({} as unknown as string).sicherheit).toBe('offen');
  });

  it('kürzt auf 300 Zeichen', () => {
    const lang = `Hauptstr. 5, 12345 Berlin ${'x'.repeat(400)}`;
    expect(ortAnalysieren(lang).text).toHaveLength(MAX_ORT);
    expect(ortAnalysieren('a'.repeat(300)).text).toHaveLength(300);
    expect(ortAnalysieren('a'.repeat(301)).text).toHaveLength(300);
  });

  it('teilt beim Kürzen kein Emoji', () => {
    // 299 Zeichen, dann ein Emoji aus zwei Hälften: Die erste Hälfte allein
    // wäre ein verwaistes Surrogat.
    const analyse = ortAnalysieren(`${'a'.repeat(299)}😀`);
    expect(analyse.text).toBe('a'.repeat(299));
    const ganz = ortAnalysieren(`${'a'.repeat(298)}😀`);
    expect(ganz.text).toBe(`${'a'.repeat(298)}😀`);
  });

  it('erkennt eine Adresse auch zwischen Emoji, Richtungs- und Nullbreiten-Zeichen', () => {
    expect(adressFund('📍 Hauptstr. 5, 12345 Berlin 🎉').suche).toBe('Hauptstr. 5, 12345 Berlin');
    expect(() => ortAnalysieren('‮رقم 5 شارع‬ Hauptstr. 5')).not.toThrow();
    expect(() => ortAnalysieren('Haupt​str.‍ 5, 12345 Berlin')).not.toThrow();
    expect(() => ortAnalysieren('\uD800 Hauptstr. 5 \uDC00')).not.toThrow();
  });

  it('wirft nie, auch nicht bei zufälligem Müll', () => {
    const teile = [
      'Str.',
      ' ',
      '5',
      ',',
      '12345',
      'Berlin',
      '(',
      ')',
      'http://',
      'N',
      '°',
      "'",
      '"',
      '-',
      '/',
      'ß',
      '😀',
    ];
    let zustand = 12345;
    const zufall = () => {
      zustand = (zustand * 1103515245 + 12345) & 0x7fffffff;
      return zustand;
    };
    for (let lauf = 0; lauf < 300; lauf += 1) {
      let eingabe = '';
      const laenge = zufall() % 40;
      for (let i = 0; i < laenge; i += 1) eingabe += teile[zufall() % teile.length];
      expect(() => ortAnalysieren(eingabe), eingabe).not.toThrow();
      const analyse = ortAnalysieren(eingabe);
      expect(analyse.stuecke.map((s) => s.text).join('')).toBe(analyse.text);
    }
  });

  describe('Zeit', () => {
    // Die Eingabe ist auf 300 Zeichen begrenzt; trotzdem darf kein Muster
    // bei bösartigen Eingaben ins Rechnen geraten. Die Skizze brauchte unter
    // 1,5 ms; 50 ms lässt Luft für eine belastete Maschine.
    const BOESARTIG: [string, string][] = [
      ['A', 'A'.repeat(300)],
      ['Aa ', 'Aa '.repeat(100)],
      ['1 ', '1 '.repeat(150)],
      ['a-', 'a-'.repeat(150)],
      ['Straße ', 'Straße '.repeat(40)],
      ['Am ', 'Am '.repeat(100)],
      ['Am Am Am ', 'Am Am Am '.repeat(33)],
      ['Alte Alte ', 'Alte Alte '.repeat(30)],
      ['Hauptstr. 1, ', 'Hauptstr. 1, '.repeat(23)],
      ['12345 Berlin ', '12345 Berlin '.repeat(23)],
      ['Berlin ×43 + 1', `${'Berlin '.repeat(43)}1`],
      ['Aaaa×75 + straße 1', `${'Aaaa'.repeat(75)}straße 1`],
      ['Aa-×99 + str.', `${'Aa-'.repeat(99)}str.`],
      ['1.2345 ', '1.2345 '.repeat(40)],
      ['https://a.a.a', `https://${'a.'.repeat(140)}`],
      ['48.12345 ', '48.12345 '.repeat(33)],
      ['Beiwerk', `Hauptstr. 5${', 3. OG'.repeat(35)}, 12345 Berlin`],
      ['Haus A', `Hauptstr. 5${' Haus A,'.repeat(35)} 12345 Berlin`],
      ['Aufgang', `Hauptstr. 5${' Aufgang B'.repeat(28)} 12345 Berlin`],
      ['Klammern', `https://x.de/${'(a)'.repeat(90)}`],
      ['Klammern zu', `https://x.de/a${')'.repeat(280)}`],
      ['Grad', `${"48°8'".repeat(50)}N`],
      ['Zahlen', '1234 '.repeat(60)],
      ['Bindestriche', `${'-'.repeat(298)}5`],
      ['Rue', `${'rue '.repeat(70)}`],
      ['Straße des', `Straße des ${'17. '.repeat(70)}`],
      ['Emoji', '😀'.repeat(150)],
    ];

    it.each(BOESARTIG)('%s', (_name, eingabe) => {
      const eingabeKurz = eingabe.slice(0, 300);
      const start = performance.now();
      const analyse = ortAnalysieren(eingabeKurz);
      const dauer = performance.now() - start;
      expect(dauer).toBeLessThan(50);
      expect(analyse.stuecke.map((s) => s.text).join('')).toBe(analyse.text);
    });
  });
});

/* ---------- Ausfallsicherheit ---------- */

describe('Ausfall des Regelwerks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('wird ohne Rückwärtssuche zu „offen“ mit Gesamttext – und stürzt nicht ab', async () => {
    vi.resetModules();
    const Echt = RegExp;
    // Ein Browser ohne Rückwärtssuche wirft beim Bauen eines solchen Musters.
    vi.stubGlobal(
      'RegExp',
      class extends Echt {
        constructor(muster: string | RegExp, flags?: string) {
          if (typeof muster === 'string' && muster.includes('(?<')) {
            throw new SyntaxError('Invalid regular expression: Invalid group');
          }
          super(muster, flags);
        }
      },
    );
    const frisch = await import('./adresse.js');
    const analyse = frisch.ortAnalysieren('Vereinsheim, Hauptstr. 5, 12345 Berlin');
    expect(analyse.sicherheit).toBe('offen');
    expect(analyse.hauptfund).toBeNull();
    expect(analyse.stuecke).toEqual([
      { art: 'text', text: 'Vereinsheim, Hauptstr. 5, 12345 Berlin' },
    ]);
    // Der Rückfall „Auf Karte suchen“ bleibt: Wer die Adresse nicht erkannt bekommt, verliert nichts.
    expect(analyse.ziel).toEqual({ art: 'text', text: 'Vereinsheim, Hauptstr. 5, 12345 Berlin' });
    // Und es bleibt dabei – auch beim zweiten Aufruf.
    expect(frisch.ortAnalysieren('Zoom').ziel).toBeNull();
  });
});
