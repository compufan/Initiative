// Wegwerf-Skizze zur Erprobung der Erkennungsregeln (kommt NICHT ins Repo).
const L = String.raw`\p{L}`;
const NAME = String.raw`[\p{L}'’-]`;
const KAP = String.raw`\p{Lu}${NAME}*`;

// Hausnummer
const HN = String.raw`(?<![\d\p{L}])\d{1,4}[a-zA-Z]?(?:\s?[-–/]\s?\d{1,3}[a-zA-Z]?){0,2}(?![\d\p{L}])(?![.:]\d)(?!\s*(?:Uhr\b|h\b|Min|Std|Stunden|Minuten|Personen|Leute|Euro|€|%|Tage|Jahre|Wochen|Kinder|Gäste|Teilnehmer|Mal\b))`;

const STRASSEN_ENDEN = String.raw`(?:straße|strasse|str\.|str(?![\p{L}])|weg|allee|gasse|platz|ring|damm|ufer|chaussee|steig|pfad|stieg|zeile|promenade|kai|lände|graben|gässchen|brücke|gracht|straat|laan|plein|kade|singel)`;
const SPERRE_ZUSAMMENGESETZT = /^(?:park|stell|sitz|arbeits|stand|liege|zelt|camping|spiel|sport|grill|um|rück|heim|aus|vor|ab)(?:platz|weg)$/i;

const ADJ = String.raw`(?:(?:Alte[rnms]?|Neue[rnms]?|Gro(?:ß|ss)e[rnms]?|Kleine[rnms]?|Lange[rnms]?|Breite[rnms]?|Obere[rnms]?|Untere[rnms]?|Hohe[rnms]?|Hintere[rnms]?|Vordere[rnms]?|Heilige[rnms]?)|\p{Lu}[\p{L}'’-]*er)`;

const SPERRWOERTER = String.raw`(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Raum|Saal|Zimmer|Haus|Gebäude|Stock|Etage|Tisch|Gleis|Tor|Halle|Stand|Beispiel|Anfang|Ende|Wochenende|Abend|Morgen|Mittag|Moment|Treffen)`;

const TITEL = String.raw`(?:(?:Dr|Prof|St|Hl|Ing)\.[-\s]?)?`;
const ADJ_LISTE = String.raw`(?:Alte[rnms]?|Neue[rnms]?|Gro(?:ß|ss)e[rnms]?|Kleine[rnms]?|Lange[rnms]?|Breite[rnms]?|Obere[rnms]?|Untere[rnms]?|Hohe[rnms]?|Hintere[rnms]?|Vordere[rnms]?|Heilige[rnms]?)`;
const PREP = String.raw`(?:Am|An der|An den|An dem|Auf dem|Auf der|Auf den|Im|In der|In den|Zum|Zur|Zu den|Unter den|Unter der|Hinter dem|Vor dem|Bei der|Beim|Über dem)`;

const TYPEN_VORN = String.raw`(?:Straße|Strasse|Platz|Weg|Allee|Ufer|Damm|Gasse|Ring|Markt|Brücke|Rue|Avenue|Boulevard|Chemin|Place|Route|Impasse|Quai|Via|Viale|Piazza|Corso|Largo|Vicolo|Strada|Calle|Carrer|Avenida|Plaza|Paseo|Rua|Praça|Ulica|Straat|Laan|Plein)`;
const PARTIKEL = String.raw`(?:(?:de la|de l'|de l’|du|des|de|di|del|della|dei|da|do|van|von|vom|zum|zur|an der|am|der|die|das|dem|des|d'|d’)\s+)`;

const TYPEN_HINTEN = String.raw`(?:Straße|Strasse|Str\.|Allee|Platz|Weg|Ring|Damm|Ufer|Gasse|Chaussee|Graben|Markt|Brücke|Zeile|Steig|Pfad)`;

const EN_TYP = String.raw`(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Court|Boulevard|Blvd\.?|Way|Square|Close|Terrace|Place|Crescent|Highway|Parkway)(?![\p{L}])`;
const FR_TYP = String.raw`(?:rue|avenue|av\.|boulevard|bd\.?|chemin|place|route|impasse|quai|allée|cours|passage|square|ruelle)`;

const STRASSEN = [
  { id: 'zusammengesetzt', st: 'stark', re: new RegExp(String.raw`(?<![\p{L}\d])${TITEL}${NAME}{3,}?${STRASSEN_ENDEN}\s*${HN}`, 'giu') },
  { id: 'zweiwort', st: 'stark', re: new RegExp(String.raw`(?<![\p{L}\d])(?:${KAP}\s+){1,2}${TYPEN_HINTEN}\s*${HN}`, 'gu') },
  { id: 'vorn', st: 'stark', re: new RegExp(String.raw`(?<![\p{L}\d])${TYPEN_VORN}\s+${PARTIKEL}?(?:\d{1,2}\.\s+)?${KAP}(?:\s+${KAP}){0,2}\s*${HN}`, 'giu') },
  { id: 'praep', st: 'schwach', re: new RegExp(String.raw`(?<![\p{L}\d])${PREP}\s+(?!${SPERRWOERTER}(?![\p{L}]))${KAP}(?:\s+(?!${SPERRWOERTER}(?![\p{L}]))${KAP}){0,2}\s+${HN}`, 'gu') },
  { id: 'adj', st: 'schwach', re: new RegExp(String.raw`(?<![\p{L}\d])${ADJ_LISTE}\s+(?!${SPERRWOERTER}(?![\p{L}]))${KAP}(?:\s+${KAP})?\s+${HN}`, 'gu') },
  { id: 'nackt', st: 'schwach', nurMitOrt: true, re: new RegExp(String.raw`(?<![\p{L}\d])(?:Graben|Markt|Ring|Kai|Damm|Ufer|Zeile|Anger|Platz|Weg|Gasse|Allee|Straße|Strasse|Chaussee|Promenade|Brücke|Steig|Pfad)\s+${HN}`, 'gu') },
  { id: 'en', st: 'stark', re: new RegExp(String.raw`(?<![\p{L}\d])\d{1,5}[a-zA-Z]?\s+(?:\p{Lu}[\p{L}'’.-]*\s+){1,3}${EN_TYP}`, 'gu') },
  { id: 'fr', st: 'stark', re: new RegExp(String.raw`(?<![\p{L}\d])\d{1,4}(?:bis|ter)?,?\s+${FR_TYP}\s+(?:(?:de la|de l'|de l’|du|des|de)\s+)?\p{L}${NAME}*(?:\s+\p{L}${NAME}*){0,2}`, 'giu') },
];

const SPERRE_ORT = /^(?:Uhr|Euro|EUR|Teilnehmer|Personen|Besucher|Gäste|Kinder|Mitglieder|Minuten|Stunden|Meter|Kilometer|Mann|Leute|Plätze|Stück|Jahre|Tage|Wochen|Prozent|Dollar|Schüler|Zuschauer|Fans|Läufer|Cent|Punkte|Mal|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)$/i;
const ORTS_VORSILBE = String.raw`(?:Bad|Sankt|St\.|Neu|Alt|Gro(?:ß|ss)|Klein|Ober|Unter|Nieder|Hohen|Schwäbisch|Königs|Lutherstadt|Hansestadt)`;
const PLZ_ORT = new RegExp(
  String.raw`(?<![\p{L}\d.,/+-])(?:(?<land>D|DE|A|AT|CH|L|FL|I|F|B|NL)\s?[-–]\s?)?(?<plz>\d{5}|\d{4}(?:\s?[A-Z]{2})?)(?![\d.,]\d)\s+(?<ort>(?:${ORTS_VORSILBE}[\s-])?\p{L}[\p{L}'’.-]*(?:\s+(?:am|im|an der|bei|ob der|in|vor der|unter)\s+\p{Lu}[\p{L}'’-]*)?)`,
  'giu',
);

const LAENDER = String.raw`(?:Deutschland|Germany|Österreich|Austria|Schweiz|Switzerland|Suisse|Svizzera|Italien|Italia|Frankreich|France|Niederlande|Nederland|Belgien|Luxemburg|Dänemark|Polen|Tschechien)`;

function maskieren(text, von, bis) {
  return text.slice(0, von) + ' '.repeat(bis - von) + text.slice(bis);
}

function webFunde(text) {
  const funde = [];
  const re = /(?:https?:\/\/|www\.)[^\s<>"]+|(?<![\p{L}\d@.\/-])(?:[\p{L}\d-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si|webex\.com|discord\.gg)(?:\/[^\s<>"]*)?/giu;
  let m;
  while ((m = re.exec(text))) {
    let roh = m[0];
    // Satzzeichen am Ende abschneiden; Klammer nur, wenn unausgewogen.
    for (;;) {
      const letztes = roh.slice(-1);
      if (/[.,;:!?'"»”]/.test(letztes)) roh = roh.slice(0, -1);
      else if (letztes === ')' && (roh.match(/\(/g) || []).length < (roh.match(/\)/g) || []).length) roh = roh.slice(0, -1);
      else break;
    }
    const mitSchema = /^https?:\/\//i.test(roh) ? roh : `https://${roh}`;
    let url;
    try { url = new URL(mitSchema); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.username || url.password) continue;
    if (!url.hostname.includes('.')) continue;
    funde.push({ art: 'web', von: m.index, bis: m.index + roh.length, text: roh, url: url.href });
  }
  return funde;
}

function dezimal(s) { return Number(s.replace(',', '.')); }
function koordFunde(text) {
  const funde = [];
  const gueltig = (b, l) => Math.abs(b) <= 90 && Math.abs(l) <= 180;
  const add = (m, b, l) => { if (gueltig(b, l)) funde.push({ art: 'koordinate', von: m.index, bis: m.index + m[0].length, text: m[0], breite: b, laenge: l }); };
  let m;
  // Dezimal, Punkt, Komma/Semikolon/Leerraum getrennt, je >=3 Nachkommastellen, eine >=4
  const dez = /(?<![\d.,])([+-]?\d{1,2}\.\d{3,8})\s*[,;/]?\s+([+-]?\d{1,3}\.\d{3,8})(?![\d.])|(?<![\d.,])([+-]?\d{1,2}\.\d{3,8})\s*,\s*([+-]?\d{1,3}\.\d{3,8})(?![\d.])/gu;
  while ((m = dez.exec(text))) {
    const a = m[1] ?? m[3], b = m[2] ?? m[4];
    const stellen = (s) => (s.split('.')[1] ?? '').length;
    if (Math.max(stellen(a), stellen(b)) < 4) continue;
    add(m, Number(a), Number(b));
  }
  // Dezimalkomma nur mit Semikolon oder Schrägstrich dazwischen
  const komma = /(?<![\d.,])([+-]?\d{1,2},\d{4,8})\s*[;/]\s*([+-]?\d{1,3},\d{4,8})(?![\d,])/gu;
  while ((m = komma.exec(text))) add(m, dezimal(m[1]), dezimal(m[2]));
  // Hemisphäre: 48.1371° N, 11.5754° E | N 48.1371 E 11.5754
  const hemi = /(\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])[,;\s]+(\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EOW])(?![\p{L}])/gu;
  while ((m = hemi.exec(text))) add(m, dezimal(m[1]) * (m[2] === 'S' ? -1 : 1), dezimal(m[3]) * (m[4] === 'W' ? -1 : 1));
  const hemiVor = /(?<![\p{L}])([NS])\s*(\d{1,2}(?:[.,]\d+)?)\s*°?[,;\s]+([EOW])\s*(\d{1,3}(?:[.,]\d+)?)\s*°?/gu;
  while ((m = hemiVor.exec(text))) add(m, dezimal(m[2]) * (m[1] === 'S' ? -1 : 1), dezimal(m[4]) * (m[3] === 'W' ? -1 : 1));
  // Grad Minuten Sekunden
  const dms = /(\d{1,2})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|''|’’)\s*([NS])[,;\s]+(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|''|’’)\s*([EOW])/gu;
  while ((m = dms.exec(text))) {
    if (Number(m[2]) >= 60 || dezimal(m[3]) >= 60 || Number(m[6]) >= 60 || dezimal(m[7]) >= 60) continue;
    const b = (Number(m[1]) + Number(m[2]) / 60 + dezimal(m[3]) / 3600) * (m[4] === 'S' ? -1 : 1);
    const l = (Number(m[5]) + Number(m[6]) / 60 + dezimal(m[7]) / 3600) * (m[8] === 'W' ? -1 : 1);
    add(m, b, l);
  }
  const dm = /(\d{1,2})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['’′]\s*([NS])[,;\s]+(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['’′]\s*([EOW])/gu;
  while ((m = dm.exec(text))) {
    if (dezimal(m[2]) >= 60 || dezimal(m[5]) >= 60) continue;
    add(m, (Number(m[1]) + dezimal(m[2]) / 60) * (m[3] === 'S' ? -1 : 1), (Number(m[4]) + dezimal(m[5]) / 60) * (m[6] === 'W' ? -1 : 1));
  }
  return funde;
}

export function analysieren(eingabe) {
  const text = eingabe.replace(/\s+/g, ' ').trim();
  let arbeit = text;
  const web = webFunde(text);
  for (const f of web) arbeit = maskieren(arbeit, f.von, f.bis);
  const koord = koordFunde(arbeit);
  for (const f of koord) arbeit = maskieren(arbeit, f.von, f.bis);

  // Strassen
  const strassen = [];
  for (const { id, st, re, nurMitOrt } of STRASSEN) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(arbeit))) {
      let treffer = m[0];
      if (id === 'zusammengesetzt') {
        const wort = treffer.split(/\s+/).filter((w) => /str|weg|platz|ring/i.test(w))[0] ?? '';
        const kern = treffer.replace(/\s*\d.*$/, '').split(/\s+/).pop();
        if (SPERRE_ZUSAMMENGESETZT.test(kern.replace(/\.$/, ''))) continue;
      }
      let von = m.index;
      if (id === 'zusammengesetzt') {
        // Beiwort davor ("Alte Landstraße"): ohne i-Flag, sonst passt \p{Lu} auch auf "der".
        const davor = new RegExp(String.raw`(?<![\p{L}\d])${ADJ}\s+$`, 'u').exec(arbeit.slice(0, von));
        if (davor) von = davor.index;
      }
      strassen.push({ von, bis: m.index + treffer.length, st, id, nurMitOrt });
    }
  }
  // PLZ + Ort
  const plzOrt = [];
  PLZ_ORT.lastIndex = 0;
  let m;
  while ((m = PLZ_ORT.exec(arbeit))) {
    const ersterOrt = m.groups.ort.split(/\s+/)[0];
    if (SPERRE_ORT.test(ersterOrt)) continue;
    plzOrt.push({ von: m.index, bis: m.index + m[0].length, land: m.groups.land ?? null, plz: m.groups.plz, ort: m.groups.ort, gross: /^\p{Lu}/u.test(m.groups.ort) });
  }

  // Zwischen Strasse und PLZ darf Beiwerk stehen (Etage, Aufgang ...), das nicht an die Karte geht.
  const BEIWERK = /^(?:[\s,;–-]*(?:\d{1,2}\.?\s*(?:OG|Stock|Etage|Obergeschoss)|[EU]G|Hinterhaus|Vorderhaus|Aufgang\s*\w|Haus\s*\w|Raum\s*[\d.]+|Zimmer\s*[\d.]+|Eingang\s*\w))*[\s,;–-]*$/iu;
  const adressen = [];
  const benutzt = new Set();
  const nachVon = (a) => a.sort((x, y) => x.von - y.von);
  const landNach = (pos) => new RegExp(String.raw`^\s*,\s*(${LAENDER})(?![\p{L}])`, 'iu').exec(arbeit.slice(pos));
  for (const st of nachVon(strassen)) {
    if (adressen.some((a) => st.von < a.bis && st.bis > a.von)) continue;
    let bis = st.bis, ort = null, ortsname = null;
    const p = plzOrt.find((o) => o.von >= st.bis && BEIWERK.test(arbeit.slice(st.bis, o.von)));
    if (p) { bis = p.bis; ort = p; benutzt.add(p); }
    else {
      const rest = arbeit.slice(st.bis);
      const mo = /^\s*,\s*(\p{Lu}[\p{L}'’-]+(?:\s+(?:am|im|an der|bei)\s+\p{Lu}[\p{L}'’-]+)?)(?=\s*(?:[,;(]|$))/u.exec(rest);
      if (mo && !SPERRE_ORT.test(mo[1]) && !new RegExp(`^${SPERRWOERTER}$`, 'i').test(mo[1])) { bis = st.bis + mo[0].length; ortsname = mo[1]; }
    }
    const land = landNach(bis);
    if (land) bis += land[0].length;
    const strasseText = arbeit.slice(st.von, st.bis).trim();
    const suche = [strasseText, ort ? `${ort.plz} ${ort.ort}` : ortsname, land ? land[1] : null].filter(Boolean).join(', ');
    if (st.nurMitOrt && !(ort || ortsname)) continue;
    adressen.push({ von: st.von, bis, st, hatOrt: Boolean(ort || ortsname), suche });
  }
  for (const p of plzOrt) {
    if (benutzt.has(p) || !p.gross) continue;
    if (adressen.some((a) => p.von < a.bis && p.bis > a.von)) continue;
    let bis = p.bis;
    const land = landNach(bis);
    if (land) bis += land[0].length;
    adressen.push({ von: p.von, bis, plzAllein: p, hatOrt: true, suche: [`${p.land ? p.land + '-' : ''}${p.plz} ${p.ort}`, land ? land[1] : null].filter(Boolean).join(', ') });
  }

  const funde = [];
  for (const a of nachVon(adressen)) {
    let sicherheit;
    if (a.st) {
      sicherheit = a.hatOrt || a.st.st === 'stark' ? 'sicher' : 'vermutlich';
    } else {
      const p = a.plzAllein;
      sicherheit = p.land ? 'sicher' : p.plz.replace(/\s?[A-Z]{2}$/, '').length === 5 || /[A-Z]{2}$/.test(p.plz) ? 'vermutlich' : 'offen';
    }
    if (sicherheit === 'offen') continue;
    funde.push({ art: 'adresse', von: a.von, bis: a.bis, text: text.slice(a.von, a.bis), suche: a.suche, sicherheit });
  }
  const alle = [...web.map((f) => ({ ...f, sicherheit: 'sicher' })), ...koord.map((f) => ({ ...f, sicherheit: 'sicher' })), ...funde].sort((x, y) => x.von - y.von);
  const rang = { offen: 0, vermutlich: 1, sicher: 2 };
  const karte = alle.filter((f) => f.art !== 'web');
  const sicherheit = karte.reduce((b, f) => (rang[f.sicherheit] > rang[b] ? f.sicherheit : b), 'offen');
  return { text, sicherheit, funde: alle };
}

const OHNE_KARTE = /^(?:online|zoom|teams|meet|jitsi|webex|telefon(?:isch)?|per telefon|digital|virtuell|remote|video(?:call|konferenz)?|zu ?hause|daheim|bei (?:mir|dir|uns|euch)|homeoffice|home office|tba|tbd|n\.? ?n\.?|noch offen|wird noch bekannt gegeben|folgt)\.?$/iu;
const BEIWERK_SEGMENT = /^(?:Raum|Zimmer|Saal|Etage|Stock|EG|UG|OG|Eingang|Ausgang|Treffpunkt|Gebäude|Haus)\b|^\d{1,2}\.\s*(?:OG|Stock|Etage)/iu;
export function suchtextOffen(eingabe, funde = []) {
  let t = eingabe.replace(/\s+/g, ' ').trim().replace(/^(?:Treffpunkt|Ort|Wo)\s*:\s*/iu, '');
  for (const f of [...funde].sort((a, b) => b.von - a.von)) if (f.art === 'web') t = t.slice(0, f.von) + t.slice(f.bis);
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const segmente = t.split(/\s*[,;]\s*/).filter((x) => x && !BEIWERK_SEGMENT.test(x));
  t = segmente.join(', ').replace(/^(?:Treffpunkt|Ort|Wo)\s*:\s*/iu, '').replace(/[:,;\s-]+$/, '').trim();
  if ((t.match(/\p{L}/gu) ?? []).length < 3) return null;
  if (OHNE_KARTE.test(t)) return null;
  return t;
}
