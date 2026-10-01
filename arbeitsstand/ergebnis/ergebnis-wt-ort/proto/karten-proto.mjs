// Wegwerf-Skizze der URL-Bauer (kommt NICHT ins Repo).
const STEUER = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const MAX_TEXT = 300;
export function bereinigen(text) {
  let t = String(text).replace(STEUER, ' ').replace(/\s+/g, ' ').trim();
  // verwaiste Surrogate (sonst wirft encodeURIComponent)
  t = t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  return [...t].slice(0, MAX_TEXT).join('');
}
/** encodeURIComponent plus die Zeichen, die es durchlässt und die in Karten-Links Bedeutung haben. */
export function kodiere(text) {
  return encodeURIComponent(bereinigen(text)).replace(/[!'()*~]/g, (z) => '%' + z.charCodeAt(0).toString(16).toUpperCase());
}
const zahl = (n) => String(Number(n.toFixed(6)));
function punkt(z) {
  if (!Number.isFinite(z.breite) || !Number.isFinite(z.laenge) || Math.abs(z.breite) > 90 || Math.abs(z.laenge) > 180) throw new Error('Koordinate ausserhalb des Bereichs');
  return `${zahl(z.breite)},${zahl(z.laenge)}`;
}
export const APPS = {
  system: { name: 'Standard-Karten-App', plattformen: ['android'] },
  apple: { name: 'Apple Karten', plattformen: ['ios', 'mac'] },
  google: { name: 'Google Maps', plattformen: ['ios', 'android', 'mac', 'andere'] },
  osm: { name: 'OpenStreetMap', plattformen: ['ios', 'android', 'mac', 'andere'] },
  waze: { name: 'Waze', plattformen: ['ios', 'android', 'mac', 'andere'] },
  bing: { name: 'Bing Karten', plattformen: ['ios', 'android', 'mac', 'andere'] },
};
export function karteUrl(app, ziel) {
  const pt = ziel.art === 'punkt';
  const q = pt ? null : kodiere(ziel.text);
  const ll = pt ? punkt(ziel) : null;
  switch (app) {
    case 'system': return pt ? `geo:${ll}?q=${kodiere(ll)}` : `geo:0,0?q=${q}`;
    case 'apple': return pt ? `https://maps.apple.com/?ll=${kodiere(ll)}&q=${kodiere(ll)}` : `https://maps.apple.com/?q=${q}`;
    case 'google': return `https://www.google.com/maps/search/?api=1&query=${pt ? kodiere(ll) : q}`;
    case 'osm': return pt ? `https://www.openstreetmap.org/?mlat=${zahl(ziel.breite)}&mlon=${zahl(ziel.laenge)}#map=17/${zahl(ziel.breite)}/${zahl(ziel.laenge)}` : `https://www.openstreetmap.org/search?query=${q}`;
    case 'waze': return pt ? `https://waze.com/ul?ll=${kodiere(ll)}` : `https://waze.com/ul?q=${q}`;
    case 'bing': return pt ? `https://bing.com/maps/default.aspx?cp=${zahl(ziel.breite)}~${zahl(ziel.laenge)}&lvl=17&sp=point.${zahl(ziel.breite)}_${zahl(ziel.laenge)}_Ort` : `https://bing.com/maps/default.aspx?where1=${q}`;
  }
}
export function routeUrl(app, ziel) {
  const pt = ziel.art === 'punkt';
  const q = pt ? null : kodiere(ziel.text);
  const ll = pt ? punkt(ziel) : null;
  switch (app) {
    case 'system': return null; // geo: kennt keine Route
    case 'apple': return `https://maps.apple.com/?daddr=${pt ? kodiere(ll) : q}`;
    case 'google': return `https://www.google.com/maps/dir/?api=1&destination=${pt ? kodiere(ll) : q}`;
    case 'osm': return pt ? `https://www.openstreetmap.org/directions?route=%3B${kodiere(ll)}` : null;
    case 'waze': return pt ? `https://waze.com/ul?ll=${kodiere(ll)}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`;
    case 'bing': return pt ? `https://bing.com/maps/default.aspx?rtp=~pos.${zahl(ziel.breite)}_${zahl(ziel.laenge)}` : `https://bing.com/maps/default.aspx?rtp=~adr.${q}`;
  }
}
export function plattform({ userAgent = '', plattform = '', touchPunkte = 0 }) {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Mac/i.test(plattform || userAgent)) return touchPunkte > 1 ? 'ios' : 'mac';
  return 'andere';
}
