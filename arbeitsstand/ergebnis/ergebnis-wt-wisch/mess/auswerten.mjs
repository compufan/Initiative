#!/usr/bin/env node
// Wertet die Rohdaten des Messgeräts aus (roh/<marke>-*.json) und schreibt Markdown-Tabellen.
// Aufruf: node auswerten.mjs vorher [json]
import { readdirSync, readFileSync } from 'node:fs';

const marke = process.argv[2] ?? 'vorher';
const alsJson = process.argv[3] === 'json';
const dir = new URL('./roh/', import.meta.url).pathname;

const zahl = (x, n = 0) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(n).replace('.', ','));
const mittel = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const quantil = (a, q) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function auswerten(d) {
  const s = d.s;
  const letztes = d.bilder - 1;
  const frame = (ms) => Math.max(0, Math.min(letztes, Math.floor(ms / s + 1e-7)));
  const { links, breite, gesamtMs, umfangMs } = d.lage;
  const filmMs = (x) => Math.min(gesamtMs, Math.round(Math.min(1, Math.max(0, (x - links) / breite)) * umfangMs));

  // Finger
  const ev = d.ev.map((e) => ({ a: e.a, t: e.t, F: frame(filmMs(e.x)) }));
  const down = ev.find((e) => e.a === 'd');
  const up = [...ev].reverse().find((e) => e.a === 'u');
  const moves = ev.filter((e) => e.a === 'm');
  if (!down || !up) return null;
  const dauerS = (up.t - down.t) / 1000;

  // Bilder, die das Video wirklich gezeigt hat (Doppelte aus mehrfachen Horchern entfernt)
  const gesehen = new Set();
  const rv = d.rv
    .filter((r) => {
      if (gesehen.has(r.pf)) return false;
      gesehen.add(r.pf);
      return true;
    })
    .sort((a, b) => a.t - b.t);

  // Was sieht der Anwender zu jedem Anzeigetakt?
  //  - bearbeitete Vorschau sichtbar (lw = 1): das zuletzt gezeichnete Bild (ms)
  //  - sonst das rohe Video: das zuletzt gemeldete Bild des Videos
  let ri = 0;
  // Vor dem ersten Bildruf im Zug steht das Bild da, bei dem die Wiedergabestelle vorher lag.
  const vorDown = [...d.pr].filter((p) => p.t < down.t - 1 && p.vt >= 0).pop();
  let letztesRoh = vorDown ? frame(vorDown.vt) : null;
  const proben = [];
  for (const p of d.pr) {
    while (ri < rv.length && rv[ri].t <= p.t) {
      if (rv[ri].t >= down.t - 5) letztesRoh = frame(rv[ri].mt);
      ri += 1;
    }
    if (p.t < down.t - 20) continue;
    let bild = null;
    if (p.lw === 1 && p.ms >= 0) bild = frame(p.ms);
    else if (p.wh === 1) bild = letztesRoh;
    proben.push({ t: p.t, bild, wh: p.wh, lw: p.lw, sc: p.sc, px: p.px });
  }

  // Fingerstand je Takt: das zuletzt gelieferte Ereignis
  let ei = 0;
  let aktuell = null;
  for (const p of proben) {
    while (ei < ev.length && ev[ei].t <= p.t) {
      if (ev[ei].a !== 'u') aktuell = ev[ei];
      ei += 1;
    }
    p.F = aktuell ? aktuell.F : null;
  }

  const imZug = proben.filter((p) => p.t >= down.t + 30 && p.t <= up.t && p.bild !== null && p.F !== null);
  const spaet = imZug.map((p) => Math.abs(p.F - p.bild));
  const vorzeichen = imZug.map((p) => p.F - p.bild);

  // Bildalter: wie lange ist her, dass der Finger dort war, wo das gezeigte Bild herkommt (±1 Bild)?
  // Der Finger bewegt sich zwischen zwei Ereignissen geradlinig und bleibt nach dem letzten stehen.
  const weg = ev.filter((e) => e.a !== 'u');
  /** Der späteste Zeitpunkt vor `bis`, an dem der Finger höchstens ein Bild von `ziel` entfernt war – oder null. */
  const zuletztBei = (ziel, bis) => {
    // Stücke von hinten: zuerst das "stehen geblieben" seit dem letzten Ereignis, dann die Ereignispaare
    let n = weg.length - 1;
    while (n >= 0 && weg[n].t > bis) n -= 1;
    if (n < 0) return null;
    if (Math.abs(weg[n].F - ziel) <= 1) return bis;
    for (let i = n - 1; i >= 0; i -= 1) {
      const a = weg[i];
      const b = weg[i + 1];
      const lo = Math.max(ziel - 1, Math.min(a.F, b.F));
      const hi = Math.min(ziel + 1, Math.max(a.F, b.F));
      if (lo > hi) continue;
      if (a.F === b.F) return b.t;
      // wachsend: der späteste Punkt im Band liegt bei hi; fallend: bei lo
      const g = b.F > a.F ? hi : lo;
      return a.t + ((g - a.F) / (b.F - a.F)) * (b.t - a.t);
    }
    return null;
  };
  const alter = [];
  let ohneTreffer = 0;
  for (const p of imZug) {
    const z = zuletztBei(p.bild, p.t);
    if (z === null) ohneTreffer += 1;
    else alter.push(Math.max(0, p.t - z));
  }

  // Wechsel des gezeigten Bildes im Zug
  let wechsel = 0;
  let vor = null;
  const inFenster = proben.filter((p) => p.t >= down.t && p.t <= up.t);
  const verschieden = new Set();
  for (const p of inFenster) {
    if (p.bild === null) continue;
    if (vor !== null && p.bild !== vor) wechsel += 1;
    verschieden.add(p.bild);
    vor = p.bild;
  }

  // Erstes neues Bild nach dem Aufsetzen
  const ersteres = inFenster.find((p) => p.bild !== null && p.bild !== (inFenster[0]?.bild ?? null));
  const erstesBildMs = ersteres ? ersteres.t - down.t : null;

  // Zeit bis zum Bild der letzten Fingerstelle – bei noch liegendem Finger
  const letzteBewegung = moves.length ? moves[moves.length - 1] : down;
  const richtigStill = proben.find((p) => p.t >= letzteBewegung.t && p.bild === letzteBewegung.F && p.lw === 1 || (p.t >= letzteBewegung.t && p.bild === letzteBewegung.F));
  const bisRichtigStillMs = richtigStill ? richtigStill.t - letzteBewegung.t : null;

  // Nach dem Loslassen: bis der Editor sein genaues Bild zeigt (Überlagerung weg)
  const nachUp = proben.filter((p) => p.t >= up.t);
  const editorDa = nachUp.find((p) => p.wh === 0);
  const bisEditorMs = editorDa ? editorDa.t - up.t : null;
  const richtigNachUp = nachUp.find((p) => p.bild === up.F);
  const bisRichtigNachUpMs = richtigNachUp ? richtigNachUp.t - up.t : null;

  // Sprünge
  const prot = d.protokoll ?? [];
  const eSprung = prot.filter((x) => x.e === 'E');
  const gesetzt = eSprung.filter((x) => x.w === 'seeked' && x.t >= down.t && x.t <= up.t).length;
  const dauern = [];
  let offen = null;
  for (const x of eSprung) {
    if (x.w === 'seeking') offen = x.t;
    else if (x.w === 'seeked' && offen !== null) {
      dauern.push(x.t - offen);
      offen = null;
    }
  }
  const leserSprung = prot.filter((x) => x.e === 'L' && x.w === 'set').length;

  const lebende = d.pr.filter((p) => p.lv >= 0).map((p) => p.lv);
  const gzeich = d.pr.length
    ? (() => {
        const a = d.pr.find((p) => p.t >= down.t);
        const b = [...d.pr].reverse().find((p) => p.t <= up.t);
        return a && b ? b.g - a.g : null;
      })()
    : null;

  const roh = rv.filter((r) => r.t >= down.t && r.t <= up.t);
  const bearbeitetAnteil = imZug.length ? imZug.filter((p) => p.lw === 1).length / imZug.length : null;
  // Maske sichtbar: Die Mitte des Quadrats ist entsättigt (Sättigung höchstens 45), obwohl es grün ist.
  const mitProbe = imZug.filter((p) => p.lw === 1 && p.px >= 0);
  const maskeAnteil = d.pr.some((p) => p.px !== undefined && p.px !== -2) && imZug.length
    ? imZug.filter((p) => p.lw === 1 && p.px >= 0 && p.px <= 45).length / imZug.length
    : null;
  const maskeVonBearbeitet = mitProbe.length ? mitProbe.filter((p) => p.px <= 45).length / mitProbe.length : null;

  return {
    szene: d.szene,
    gop: d.gop,
    sprungMs: d.sprungMs,
    cpu: d.cpu,
    dauerS,
    ereignisse: ev.length,
    ereignisseJeS: moves.length / dauerS,
    bilderJeS: wechsel / dauerS,
    verschiedene: verschieden.size,
    videoBilderJeS: roh.length / dauerS,
    sprungeJeS: gesetzt / dauerS,
    gezeichnetJeS: gzeich === null ? null : gzeich / dauerS,
    sprungMittelMs: mittel(dauern),
    sprungMaxMs: dauern.length ? Math.max(...dauern) : null,
    spaetMittel: mittel(spaet),
    spaetP50: quantil(spaet, 0.5),
    spaetP95: quantil(spaet, 0.95),
    spaetMax: spaet.length ? Math.max(...spaet) : null,
    vorzeichenMittel: mittel(vorzeichen),
    alterMittelMs: mittel(alter),
    alterP95Ms: quantil(alter, 0.95),
    alterMaxMs: alter.length ? Math.max(...alter) : null,
    alterOhneTreffer: ohneTreffer,
    proben: imZug.length,
    erstesBildMs,
    bisRichtigStillMs,
    bisRichtigNachUpMs,
    bisEditorMs,
    stillbild: d.stillbild,
    sollStillbild: up.F,
    stillbildRichtig: d.stillbild === up.F,
    bearbeitetAnteil,
    maskeAnteil,
    maskeVonBearbeitet,
    verfolgerLesen: d.verfolger?.vorher && d.verfolger?.nachher ? (d.verfolger.nachher.lesen ?? 0) - (d.verfolger.vorher.lesen ?? 0) : null,
    videoelementeMax: lebende.length ? Math.max(...lebende) : null,
    leserSprunge: leserSprung,
  };
}

const dateien = readdirSync(dir)
  .filter((n) => n.startsWith(`${marke}-`) && n.endsWith('.json'))
  .sort();
const erg = [];
for (const n of dateien) {
  const d = JSON.parse(readFileSync(dir + n, 'utf8'));
  const a = auswerten(d);
  if (a) erg.push(a);
}
if (alsJson) {
  console.log(JSON.stringify(erg, null, 1));
  process.exit(0);
}

const reihenfolge = ['schnell', 'langsam', 'hinher', 'stopp'];
const bedingungen = [...new Set(erg.map((e) => `${e.gop}|${e.sprungMs}|${e.cpu}`))].sort((a, b) => {
  const [g1, s1, c1] = a.split('|').map(Number);
  const [g2, s2, c2] = b.split('|').map(Number);
  return s1 - s2 || g1 - g2 || c1 - c2;
});
console.log(`Marke: ${marke} – ${erg.length} Läufe\n`);
console.log('| GOP | Sprung | Szene | Dauer s | Zeiger/s | Bilder/s (Anzeige) | Video-Bilder/s | Sprünge/s | Sprung ms Ø/max | Verspät. Bilder Ø | p95 | max | Bildalter ms Ø | p95 | max | Zeichn./s | bearb. % | Maske sichtbar % | 1. Bild ms | Stillstand→richtig ms | Loslassen→Editor ms | Standbild ok |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const b of bedingungen) {
  const [g, sp, c] = b.split('|').map(Number);
  for (const sz of reihenfolge) {
    const e = erg.find((x) => x.gop === g && x.sprungMs === sp && x.cpu === c && x.szene === sz);
    if (!e) continue;
    console.log(
      `| ${g} | ${sp}${c > 1 ? ` (CPU ${c}x)` : ''} | ${sz} | ${zahl(e.dauerS, 1)} | ${zahl(e.ereignisseJeS)} | ${zahl(e.bilderJeS, 1)} | ${zahl(e.videoBilderJeS, 1)} | ${zahl(e.sprungeJeS, 1)} | ${zahl(e.sprungMittelMs)} / ${zahl(e.sprungMaxMs)} | ${zahl(e.spaetMittel, 1)} | ${zahl(e.spaetP95)} | ${zahl(e.spaetMax)} | ${zahl(e.alterMittelMs)} | ${zahl(e.alterP95Ms)} | ${zahl(e.alterMaxMs)} | ${zahl(e.gezeichnetJeS, 1)} | ${zahl(e.bearbeitetAnteil === null ? null : e.bearbeitetAnteil * 100)} | ${zahl(e.maskeAnteil === null ? null : e.maskeAnteil * 100)} | ${zahl(e.erstesBildMs)} | ${zahl(e.bisRichtigStillMs)} | ${zahl(e.bisEditorMs)} | ${e.stillbildRichtig ? 'ja' : `nein (${e.stillbild} statt ${e.sollStillbild})`} |`,
    );
  }
}
