import { expect, test } from '@playwright/test';

/**
 * Die mitgelieferten Schriften – kommen sie wirklich bis auf die Leinwand?
 *
 * # Warum das im Browser geprüft werden muss
 *
 * Weil zwischen „die Datei liegt in public/“ und „der Buchstabe steht im
 * Bild“ vier Stellen liegen, die jede für sich still versagen können: die
 * `@font-face`-Regel, die Auslieferungsregel (`font-src 'self'`), das Laden
 * über `document.fonts` und das Rastern selbst. Keine davon meldet einen
 * Fehler – der Browser nimmt einfach die nächstbeste Schrift, und man sieht
 * es erst an einem Bild, das auf einem anderen Gerät anders aussieht.
 */

test('jede mitgelieferte Schrift lädt und zeichnet anders als die Ersatzschrift', async ({
  page,
}) => {
  const fehler: string[] = [];
  page.on('response', (antwort) => {
    if (antwort.url().includes('/schriften/') && !antwort.ok()) {
      fehler.push(`${antwort.status()} ${antwort.url()}`);
    }
  });

  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    const ladeSchriften = '/src/lib/schriften.ts';
    const schriften = (await import(
      /* @vite-ignore */ ladeSchriften
    )) as typeof import('../src/lib/schriften.js');

    await schriften.alleSchriftenBereit(15_000);

    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 120;
    const ctx = c.getContext('2d');
    if (!ctx) return { fehler: 'keine Leinwand' };

    /*
     * Gemessen wird die BREITE derselben Zeichenfolge.
     *
     * Ein Vergleich der Bildpunkte wäre genauer und viel zerbrechlicher – ein
     * Punkt Unterschied in der Kantenglättung, und der Test schlägt an, ohne
     * dass etwas kaputt ist. Die Breite sagt genau das, was zählt: Es ist
     * eine ANDERE Schrift als die Ersatzschrift.
     */
    const probe = 'Handgloves 123';
    const breite = (stack: string, gewicht: number) => {
      ctx.font = `${gewicht} 48px ${stack}`;
      return ctx.measureText(probe).width;
    };

    // Der Bezugswert: eine Schrift, die es garantiert nicht gibt. Der Browser
    // nimmt dafür seine Ersatzschrift.
    const ersatz = breite('"Gibt Es Nicht 12345", sans-serif', 400);

    const gemessen: { key: string; label: string; breite: number; geladen: boolean }[] = [];
    for (const art of schriften.SCHRIFTEN) {
      if (art.schnitte.length === 0) continue;
      const name = art.stack.split(',')[0].trim();
      gemessen.push({
        key: art.key,
        label: art.label,
        // NUR den eigenen Namen, ohne Rückfallkette: Sonst misst man die
        // Systemschrift und hält sie für die mitgelieferte.
        breite: breite(name, art.schnitte[0].gewicht),
        geladen: document.fonts.check(`${art.schnitte[0].gewicht} 48px ${name}`),
      });
    }
    return { ersatz, gemessen };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(fehler, `Schriftdateien nicht ausgeliefert: ${fehler.join(', ')}`).toEqual([]);

  const gemessen = ergebnis.gemessen ?? [];
  expect(gemessen.length, 'es werden gar keine Schriften mitgeliefert').toBeGreaterThanOrEqual(8);

  for (const art of gemessen) {
    expect(art.geladen, `„${art.label}“ ist nicht geladen`).toBe(true);
    /*
     * Und sie zeichnet anders als die Ersatzschrift. Ohne diese Zeile
     * bestünde der Test auch dann, wenn `fonts.check` zwar wahr meldet, die
     * Leinwand aber trotzdem die Systemschrift nimmt.
     */
    expect(
      Math.abs(art.breite - (ergebnis.ersatz ?? 0)),
      `„${art.label}“ misst wie die Ersatzschrift – sie kommt nicht auf die Leinwand`,
    ).toBeGreaterThan(1);
  }

  /*
   * Und sie sind untereinander verschieden. Acht Knöpfe, die dasselbe tun,
   * waren genau der Zustand vorher: „Schmal“ landete auf Android bei Roboto
   * und war von „Normal“ nicht zu unterscheiden.
   */
  const breiten = gemessen.map((a) => Math.round(a.breite));
  expect(new Set(breiten).size, `zwei Schriften messen gleich: ${breiten.join(', ')}`).toBe(
    breiten.length,
  );
});
