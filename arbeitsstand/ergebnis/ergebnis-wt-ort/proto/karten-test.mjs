import { karteUrl, routeUrl, kodiere, plattform, APPS } from './karten-proto.mjs';
const t = { art: 'text', text: 'Hauptstr. 5, 12345 Berlin' };
const p = { art: 'punkt', breite: 48.13743, laenge: 11.57549 };
for (const a of Object.keys(APPS)) { console.log(a.padEnd(7), 'KARTE ', karteUrl(a, t)); console.log(' '.repeat(7), 'ROUTE ', routeUrl(a, t)); console.log(' '.repeat(7), 'PUNKT ', karteUrl(a, p)); console.log(' '.repeat(7), 'PROUTE', routeUrl(a, p)); }
// Einschleusung
const boese = 'x&api=2#frag?q=1~adr.Evil=%00\n<script>"\' javascript:alert(1) ‮\uD800 ä€😀';
console.log(JSON.stringify(kodiere(boese)));
for (const a of Object.keys(APPS)) {
  const u = karteUrl(a, { art: 'text', text: boese });
  if (u.startsWith('http')) { const url = new URL(u); console.log(a, url.host, [...url.searchParams.keys()].join(','), url.hash === '' ? 'kein Hash' : 'HASH!'); }
  else console.log(a, u.slice(0, 40));
}
console.log(plattform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36' }),
 plattform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', plattform: 'iPhone' }),
 plattform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', plattform: 'MacIntel', touchPunkte: 5 }),
 plattform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', plattform: 'MacIntel', touchPunkte: 0 }),
 plattform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125', plattform: 'Win32' }));
