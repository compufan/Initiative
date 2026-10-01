import { test } from '@playwright/test';
import {
  abschnitteDazu, auswerten, editorOeffnen, pruefvideoSchreiben, schreiberEinsetzen, seiteLaden, speicherWarten, sprungSetzen, zugAufzeichnen,
} from '../../wt-wisch/apps/web/e2e/wischenHilfe';

test('debug', async ({ page }) => {
  test.setTimeout(400_000);
  await page.setViewportSize({ width: 412, height: 880 });
  await seiteLaden(page);
  await pruefvideoSchreiben(page, 'film', { gop: 100 });
  const editor = await editorOeffnen(page, 'film');
  await abschnitteDazu(editor);
  await schreiberEinsetzen(page, { strichcode: false });
  const cdp = await page.context().newCDPSession(page);
  await speicherWarten(page, 4, 200_000);
  await sprungSetzen(page, 250);
  const roh = await zugAufzeichnen(page, cdp, 'schnell', { sprungMs: 250, bilder: 300, s: 40 });
  const a = auswerten(roh, 2)!;
  console.log(JSON.stringify(a));
  const t0 = roh.ev.find((e) => e.a === 'd')!.t;
  const zeilen = roh.pr.filter((p) => (p.t as number) > t0 - 20 && (p.zk as number) !== (p.k as number) && p.aus === 'speicher').slice(0, 25);
  console.log('Abweichungen', zeilen.length, JSON.stringify(zeilen.map((p) => ({ t: Math.round((p.t as number) - t0), g: p.g, k: p.k, zk: p.zk }))));
  const alle = roh.pr.filter((p) => (p.t as number) > t0 - 20 && p.aus === 'speicher').slice(0, 30);
  console.log('Alle', JSON.stringify(alle.map((p) => ({ t: Math.round((p.t as number) - t0), g: p.g, k: p.k, zk: p.zk }))));
  console.log('Ereignisse', JSON.stringify(roh.ev.slice(0, 12).map((e) => ({ a: e.a, t: Math.round(e.t - t0), x: Math.round(e.x) }))));
});
