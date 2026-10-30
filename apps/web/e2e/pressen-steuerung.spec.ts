import { expect, test, type Page } from '@playwright/test';
import { credentials, signUp, spiegelStarten } from './pressenHilfen.js';

/**
 * Pressen: Wo die Bedienelemente stehen.
 *
 * Überall gleich – Normalansicht, Vollbild, iPhone-Rückfall (Überlagerung ohne
 * Fullscreen-API), Hoch- und Querformat: das Steuerkreuz (vier Pfeile) auf der
 * LINKEN, „Neigen“ auf der RECHTEN Seite des Bildschirms, je mindestens 44 px
 * groß, mit Abstand zu den Rändern. Im Querformat sitzen sie links und rechts
 * der Bühne (je ein Daumen), nicht darüber oder daneben gestapelt.
 *
 * Gemessen wird relativ zur Fensterbreite, nicht in Pixeln eines Geräts.
 */

interface Kasten {
  links: number;
  rechts: number;
  oben: number;
  unten: number;
  breite: number;
  hoehe: number;
}

async function kaesten(page: Page) {
  return page.evaluate(() => {
    const kasten = (el: Element | null): Kasten | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        links: r.left,
        rechts: r.right,
        oben: r.top,
        unten: r.bottom,
        breite: r.width,
        hoehe: r.height,
      };
    };
    const taste = (name: string) =>
      kasten(document.querySelector(`.pressen-taste.pressen-${name}`));
    return {
      fenster: { breite: window.innerWidth, hoehe: window.innerHeight },
      hoch: taste('hoch'),
      links: taste('links'),
      rechts: taste('rechts'),
      runter: taste('runter'),
      neigen: taste('neigen'),
      feld: kasten(document.querySelector('[data-testid="pressen-feld"]')),
      brett: document.querySelector('[data-testid="pressen-brett"]')?.getAttribute('data-vollbild'),
    };
  });
}

type Gemessen = Awaited<ReturnType<typeof kaesten>>;

/** Gemeinsame Regeln, egal in welcher Ansicht. */
function pruefeAnordnung(m: Gemessen, kante: number, imFenster: boolean) {
  const { fenster: f } = m;
  const kreuz = [m.hoch, m.links, m.rechts, m.runter].map((k) => k!);
  const neigen = m.neigen!;
  const kreuzLinks = Math.min(...kreuz.map((k) => k.links));
  const kreuzRechts = Math.max(...kreuz.map((k) => k.rechts));
  // Das Kreuz sitzt links, Neigen rechts – das Kreuz liegt ganz links von Neigen.
  expect(kreuzRechts, 'Kreuz liegt links von Neigen').toBeLessThanOrEqual(neigen.links);
  expect((kreuzLinks + kreuzRechts) / 2, 'Kreuz in der linken Hälfte').toBeLessThan(f.breite / 2);
  expect((neigen.links + neigen.rechts) / 2, 'Neigen in der rechten Hälfte').toBeGreaterThan(
    f.breite / 2,
  );
  // Innerhalb des Fensters, mit Abstand zu den Rändern.
  expect(kreuzLinks).toBeGreaterThanOrEqual(kante);
  expect(neigen.rechts).toBeLessThanOrEqual(f.breite - kante);
  for (const k of [...kreuz, neigen]) {
    // Im Vollbild passt alles ins Fenster; die Normalansicht ist eine Seite, die scrollt.
    if (imFenster) expect(k.unten).toBeLessThanOrEqual(f.hoehe - kante + 1);
    expect(k.breite).toBeGreaterThanOrEqual(44);
    expect(k.hoehe).toBeGreaterThanOrEqual(44);
  }
  // Die vier Pfeile bilden ein Kreuz: hoch über runter, links vor rechts.
  expect(m.hoch!.unten).toBeLessThanOrEqual(m.runter!.oben + 1);
  expect(m.links!.rechts).toBeLessThanOrEqual(m.rechts!.links + 1);
}

/** Beginnt einen Lauf (Anstoßen) und wartet, bis die Steuerung da ist. */
async function laufStarten(page: Page) {
  await page.getByTestId('pressen-anstossen').click();
  await expect(page.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
    timeout: 2000,
  });
  await expect(page.getByRole('button', { name: /Glas neigen/ })).toBeVisible();
}

async function ohneFullscreenApi(page: Page) {
  await page.context().addInitScript(() => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.requestFullscreen = undefined;
    proto.webkitRequestFullscreen = undefined;
  });
}

const ANSICHTEN: {
  name: string;
  breite: number;
  hoehe: number;
  touch: boolean;
  /** Ohne Fullscreen-API (iPhone-Safari): Überlagerung statt echtem Vollbild. */
  iphone: boolean;
  vollbild: boolean;
  /** Im Vollbild-Querformat hängen die Tasten an den Fensterrändern, die Bühne steht dazwischen. */
  amRand: boolean;
}[] = [
  {
    name: 'Normalansicht Desktop',
    breite: 1280,
    hoehe: 800,
    touch: false,
    iphone: false,
    vollbild: false,
    amRand: false,
  },
  {
    name: 'Normalansicht Handy hoch',
    breite: 390,
    hoehe: 844,
    touch: true,
    iphone: false,
    vollbild: false,
    amRand: false,
  },
  {
    name: 'Normalansicht Handy quer',
    breite: 844,
    hoehe: 390,
    touch: true,
    iphone: false,
    vollbild: false,
    amRand: false,
  },
  {
    name: 'Vollbild Desktop quer',
    breite: 1280,
    hoehe: 720,
    touch: false,
    iphone: false,
    vollbild: true,
    amRand: true,
  },
  {
    name: 'Vollbild Handy hoch',
    breite: 390,
    hoehe: 844,
    touch: true,
    iphone: false,
    vollbild: true,
    amRand: false,
  },
  {
    name: 'Vollbild Handy quer',
    breite: 844,
    hoehe: 390,
    touch: true,
    iphone: false,
    vollbild: true,
    amRand: true,
  },
  {
    name: 'iPhone-Rückfall hoch',
    breite: 390,
    hoehe: 844,
    touch: true,
    iphone: true,
    vollbild: true,
    amRand: false,
  },
  {
    name: 'iPhone-Rückfall quer',
    breite: 844,
    hoehe: 390,
    touch: true,
    iphone: true,
    vollbild: true,
    amRand: true,
  },
  {
    name: 'iPhone-Rückfall klein quer (SE)',
    breite: 667,
    hoehe: 375,
    touch: true,
    iphone: true,
    vollbild: true,
    amRand: true,
  },
];

for (const ansicht of ANSICHTEN) {
  test(`Steuerkreuz links, Neigen rechts: ${ansicht.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: ansicht.breite, height: ansicht.hoehe },
      hasTouch: ansicht.touch,
    });
    const page = await context.newPage();
    if (ansicht.iphone) await ohneFullscreenApi(page);
    // Anmelden wie in den anderen Tests, aber in diesem Kontext.
    const user = credentials('lage');
    await page.goto('/');
    await page.getByRole('button', { name: /Noch kein Konto/ }).click();
    await page.getByLabel('Benutzername').fill(user.username);
    await page.getByLabel('Anzeigename').fill(user.displayName);
    await page.getByLabel('Passwort', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Konto erstellen' }).click();
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await spiegelStarten(page);

    await laufStarten(page);
    const brett = page.getByTestId('pressen-brett');
    if (ansicht.vollbild) {
      await expect(brett).not.toHaveAttribute('data-vollbild', 'aus');
    } else {
      // „Vollbild beenden“: der Lauf geht weiter, die Normalansicht kommt zurück.
      await page.getByTestId('pressen-vollbild').click();
      await expect(brett).toHaveAttribute('data-vollbild', 'aus');
    }
    // Kurz warten, bis die Anordnung steht (Layout nach dem Umschalten).
    await page.waitForTimeout(250);

    const m = await kaesten(page);
    pruefeAnordnung(m, 8, ansicht.vollbild);

    if (ansicht.vollbild && ansicht.amRand) {
      // Quer im Vollbild: die Tasten hängen an den Rändern, die Bühne steht dazwischen.
      const f = m.fenster.breite;
      const kreuzRechts = Math.max(
        m.hoch!.rechts,
        m.links!.rechts,
        m.rechts!.rechts,
        m.runter!.rechts,
      );
      expect(Math.min(m.links!.links, m.hoch!.links)).toBeLessThan(f * 0.12);
      expect(m.neigen!.rechts).toBeGreaterThan(f * 0.88);
      expect(m.feld!.links).toBeGreaterThanOrEqual(kreuzRechts - 1);
      expect(m.feld!.rechts).toBeLessThanOrEqual(m.neigen!.links + 1);
    }
    if (ansicht.vollbild && !ansicht.amRand) {
      // Hoch im Vollbild: Kreuz ganz links, Neigen ganz rechts, unter der Bühne.
      expect(m.links!.links).toBeLessThan(m.fenster.breite * 0.12);
      expect(m.neigen!.rechts).toBeGreaterThan(m.fenster.breite * 0.88);
      expect(Math.min(m.hoch!.oben, m.neigen!.oben)).toBeGreaterThanOrEqual(m.feld!.unten - 1);
    }

    // Die Tastatur bleibt unverändert: Pfeil rechts schiebt das Glas nach rechts.
    const feld = page.getByTestId('pressen-feld');
    const vorher = Number(await feld.getAttribute('data-glas-x'));
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowRight');
    expect(Number(await feld.getAttribute('data-glas-x'))).toBeGreaterThan(vorher);

    // Und ein Touch auf Neigen wirkt (Zeiger gedrückt halten → Neigung > 0).
    const neigen = page.getByRole('button', { name: /Glas neigen/ });
    // Die Normalansicht ist eine Seite: Auf einem flachen Querformat liegt Neigen unter dem Rand.
    await neigen.scrollIntoViewIfNeeded();
    const box = (await neigen.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    expect(Number(await feld.getAttribute('data-neigung'))).toBeGreaterThan(0);
    await page.mouse.up();

    await context.close();
  });
}
