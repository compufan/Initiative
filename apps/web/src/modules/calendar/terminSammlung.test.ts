import { describe, expect, it, vi } from 'vitest';
import type {
  AccessLevel,
  CalendarEventDto,
  CollectionDto,
  CollectionGrantDto,
  ConversationDto,
  MemberLevel,
} from '@initiative/shared';
import { ApiError } from '../../lib/api.js';
import {
  erbtVon,
  istEndgueltig,
  istUnklar,
  nochmalVerknuepfen,
  sammlungAnlegenUndVerknuepfen,
  standardName,
  verwerfen,
  zugriffSatz,
  zugriffsLage,
  zusammenfassung,
  type KettenGlied,
  type TerminSammlungDienste,
  type TerminSammlungPlan,
} from './terminSammlung.js';

const angelegt = { id: 'neu', name: 'Hütte' } as CollectionDto;
const termin = { id: 'termin', collectionId: 'neu' } as CalendarEventDto;

const bodo = { id: 'bodo', name: 'Bodo' };
const cleo = { id: 'cleo', name: 'Cleo' };
const dora = { id: 'dora', name: 'Dora' };

function plan(aenderung: Partial<TerminSammlungPlan> = {}): TerminSammlungPlan {
  return {
    terminId: 'termin',
    name: '  Hütte  ',
    parentId: 'familie',
    stufe: 'edit',
    personen: [bodo, cleo, dora],
    ...aenderung,
  };
}

/** Dienste, die alle gelingen – einzelne werden je Test überschrieben. */
function dienste(
  ueberschrieben: Partial<{ [K in keyof TerminSammlungDienste]: unknown }> = {},
): TerminSammlungDienste & { aufrufe: string[] } {
  const aufrufe: string[] = [];
  const mach = (name: string, ergebnis: unknown) =>
    vi.fn(async (...argumente: unknown[]) => {
      aufrufe.push(name + ':' + argumente.filter((a) => typeof a === 'string').join(','));
      if (ergebnis instanceof Error) throw ergebnis;
      return ergebnis;
    });
  const ersatz = (name: keyof TerminSammlungDienste, standard: unknown) =>
    name in ueberschrieben ? ueberschrieben[name] : standard;
  return {
    aufrufe,
    anlegen: mach('anlegen', ersatz('anlegen', angelegt)) as TerminSammlungDienste['anlegen'],
    verknuepfen: mach(
      'verknuepfen',
      ersatz('verknuepfen', termin),
    ) as TerminSammlungDienste['verknuepfen'],
    freigeben: mach('freigeben', ersatz('freigeben', {})) as TerminSammlungDienste['freigeben'],
    verwerfen: mach(
      'verwerfen',
      ersatz('verwerfen', undefined),
    ) as TerminSammlungDienste['verwerfen'],
  };
}

const fehler = (status: number, text = 'Nein') => new ApiError(status, 'x', text);

describe('Anlegen und verknüpfen', () => {
  it('geht der Reihe nach: anlegen, verknüpfen, je Person freigeben', async () => {
    const d = dienste();
    const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);

    expect(d.aufrufe).toEqual([
      'anlegen:',
      'verknuepfen:termin,neu',
      'freigeben:neu,bodo,edit',
      'freigeben:neu,cleo,edit',
      'freigeben:neu,dora,edit',
    ]);
    expect(ergebnis).toEqual({
      art: 'fertig',
      sammlung: angelegt,
      termin,
      nichtFreigegeben: [],
    });
  });

  it('legt mit getrimmtem Namen, Ordner und ohne Chat an', async () => {
    const d = dienste();
    await sammlungAnlegenUndVerknuepfen(plan(), d);
    // Kein `conversationId`: Rechte gehen an Personen, nicht an den Chat.
    expect(d.anlegen).toHaveBeenCalledWith({
      name: 'Hütte',
      parentId: 'familie',
      memberLevel: 'none',
    });
    const oben = dienste();
    await sammlungAnlegenUndVerknuepfen(plan({ parentId: null }), oben);
    expect(oben.anlegen).toHaveBeenCalledWith({ name: 'Hütte', memberLevel: 'none' });
    expect(Object.keys(vi.mocked(oben.anlegen).mock.calls[0]?.[0] ?? {})).not.toContain('parentId');
  });

  it('gibt genau den Gewählten frei, mit der gewählten Stufe', async () => {
    const d = dienste();
    await sammlungAnlegenUndVerknuepfen(plan({ stufe: 'view', personen: [cleo] }), d);
    expect(d.freigeben).toHaveBeenCalledTimes(1);
    expect(d.freigeben).toHaveBeenCalledWith('neu', 'cleo', 'view');
  });

  it('meldet den Fortschritt je Schritt', async () => {
    const stand: string[] = [];
    await sammlungAnlegenUndVerknuepfen(plan({ personen: [bodo, cleo] }), dienste(), (s) =>
      stand.push(`${s.schritt} ${s.erledigt}/${s.gesamt}`),
    );
    expect(stand).toEqual(['anlegen 0/1', 'verknuepfen 0/1', 'freigeben 0/2', 'freigeben 1/2']);
  });

  it.each([
    ['400 (zu tief)', fehler(400, 'Mehr als 8 Ebenen sind nicht vorgesehen')],
    ['403', fehler(403)],
    ['kein Netz', fehler(0, 'Keine Verbindung')],
  ])('legt bei %s nichts an und räumt nichts', async (_name, ursache) => {
    const d = dienste({ anlegen: ursache });
    const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);
    expect(ergebnis).toEqual({ art: 'nichtAngelegt', fehler: ursache });
    expect(d.verknuepfen).not.toHaveBeenCalled();
    expect(d.verwerfen).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409])(
    'räumt bei einem endgültigen %i beim Verknüpfen genau einmal auf',
    async (status) => {
      const ursache = fehler(status);
      const d = dienste({ verknuepfen: ursache });
      const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);
      expect(ergebnis).toEqual({
        art: 'nichtVerknuepft',
        sammlung: angelegt,
        fehler: ursache,
        endgueltig: true,
        aufgeraeumt: true,
      });
      expect(d.verwerfen).toHaveBeenCalledTimes(1);
      expect(d.verwerfen).toHaveBeenCalledWith('neu');
      // Wer nicht verknüpft ist, bekommt auch nichts freigegeben.
      expect(d.freigeben).not.toHaveBeenCalled();
    },
  );

  it('sagt, wenn auch das Aufräumen scheitert', async () => {
    const d = dienste({ verknuepfen: fehler(403), verwerfen: fehler(500) });
    const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);
    expect(ergebnis).toMatchObject({
      art: 'nichtVerknuepft',
      endgueltig: true,
      aufgeraeumt: false,
    });
    expect(d.verwerfen).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['kein Netz', 0],
    ['500', 500],
    ['503', 503],
    ['408', 408],
    ['429', 429],
  ])('räumt bei %s nicht auf – der Server hat vielleicht doch verknüpft', async (_name, status) => {
    const d = dienste({ verknuepfen: fehler(status) });
    const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);
    expect(ergebnis).toMatchObject({
      art: 'nichtVerknuepft',
      sammlung: angelegt,
      endgueltig: false,
      aufgeraeumt: false,
    });
    expect(d.verwerfen).not.toHaveBeenCalled();
  });

  it('legt beim erneuten Verknüpfen nichts zweites an und gibt dann frei', async () => {
    const d = dienste();
    const ergebnis = await nochmalVerknuepfen(plan({ personen: [bodo] }), angelegt, d);
    expect(d.anlegen).not.toHaveBeenCalled();
    expect(d.aufrufe).toEqual(['verknuepfen:termin,neu', 'freigeben:neu,bodo,edit']);
    expect(ergebnis).toMatchObject({ art: 'fertig', nichtFreigegeben: [] });
  });

  it('räumt auch nach einem erneuten Versuch auf, wenn der Server endgültig ablehnt', async () => {
    const d = dienste({ verknuepfen: fehler(404) });
    const ergebnis = await nochmalVerknuepfen(plan(), angelegt, d);
    expect(ergebnis).toMatchObject({ art: 'nichtVerknuepft', aufgeraeumt: true });
  });

  it('versucht nach einem Fehler bei der zweiten von drei Personen auch die dritte', async () => {
    const freigeben = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(fehler(500))
      .mockResolvedValueOnce({});
    const d = { ...dienste(), freigeben } as TerminSammlungDienste;
    const ergebnis = await sammlungAnlegenUndVerknuepfen(plan(), d);
    expect(freigeben).toHaveBeenCalledTimes(3);
    expect(ergebnis).toMatchObject({ art: 'fertig', nichtFreigegeben: [cleo] });
  });

  it('verwerfen meldet, ob es gelang', async () => {
    expect(await verwerfen(angelegt, dienste())).toBe(true);
    expect(await verwerfen(angelegt, dienste({ verwerfen: fehler(500) }))).toBe(false);
  });
});

describe('Standardname', () => {
  it('kürzt 160 auf 120 Zeichen', () => {
    expect(standardName('x'.repeat(160))).toHaveLength(120);
  });

  it('schneidet kein Zeichen in der Mitte durch', () => {
    const name = standardName('😀'.repeat(130));
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith('😀')).toBe(true);
  });

  it('trimmt und fällt bei leerem Titel auf „Neue Sammlung“ zurück', () => {
    expect(standardName('  Hüttenwochenende  ')).toBe('Hüttenwochenende');
    expect(standardName('')).toBe('Neue Sammlung');
    expect(standardName('   ')).toBe('Neue Sammlung');
  });
});

describe('Unklarer Ausgang', () => {
  it('ist nur die Zeitüberschreitung – die Anfrage ist hinausgegangen', () => {
    const zeit = new ApiError(
      0,
      'offline',
      'Der Server antwortet nicht',
      new DOMException('x', 'TimeoutError'),
    );
    expect(istUnklar(zeit)).toBe(true);
    expect(
      istUnklar(new ApiError(0, 'offline', 'Keine Verbindung zum Server', new TypeError('x'))),
    ).toBe(false);
    expect(istUnklar(fehler(500))).toBe(false);
  });
});

describe('Endgültige Ablehnung', () => {
  it.each([400, 403, 404, 409])('%i ist endgültig', (status) => {
    expect(istEndgueltig(fehler(status))).toBe(true);
  });

  it.each([0, 408, 429, 500, 503])('%i ist es nicht', (status) => {
    expect(istEndgueltig(fehler(status))).toBe(false);
  });

  it('kein Fehler des Servers ist es auch nicht', () => {
    expect(istEndgueltig(new Error('x'))).toBe(false);
    expect(istEndgueltig(undefined)).toBe(false);
  });
});

function ordner(id: string, aenderung: Partial<CollectionDto> = {}): KettenGlied['sammlung'] {
  return { id, createdBy: 'anna', conversationId: null, memberLevel: 'none', ...aenderung };
}

function recht(aenderung: Partial<CollectionGrantDto>): CollectionGrantDto {
  return {
    id: Math.random().toString(36),
    collectionId: 'x',
    itemId: null,
    userId: null,
    conversationId: null,
    level: 'view',
    grantedBy: 'anna',
    createdAt: '2026-01-01T00:00:00Z',
    ...aenderung,
  };
}

function chat(id: string, mitglieder: string[]): Pick<ConversationDto, 'id' | 'members'> {
  return {
    id,
    members: mitglieder.map((userId) => ({ userId })) as ConversationDto['members'],
  };
}

function lage(
  kette: KettenGlied[],
  chats: ReturnType<typeof chat>[] = [],
  personen = ['bodo', 'cleo'],
) {
  return zugriffsLage({ personen, ich: 'anna', kette, chats });
}

describe('Zugriffslage', () => {
  it('kennt niemanden, wo nichts vergeben ist', () => {
    const ergebnis = lage([{ sammlung: ordner('a'), grants: [] }]);
    expect(ergebnis.fehlend).toEqual(['bodo', 'cleo']);
    expect(ergebnis.stufen.get('bodo')).toBe('none');
  });

  it('zählt den Ersteller als Besitzer', () => {
    const ergebnis = lage([{ sammlung: ordner('a', { createdBy: 'bodo' }), grants: [] }]);
    expect(ergebnis.stufen.get('bodo')).toBe('own');
    expect(ergebnis.fehlend).toEqual(['cleo']);
  });

  it('zählt ein Recht an die Person', () => {
    const ergebnis = lage([
      { sammlung: ordner('a'), grants: [recht({ userId: 'cleo', level: 'edit' })] },
    ]);
    expect(ergebnis.stufen.get('cleo')).toBe('edit');
    expect(ergebnis.fehlend).toEqual(['bodo']);
  });

  it('zählt ein Recht an einen Chat nur, wenn der Chat bekannt ist und die Person darin steht', () => {
    const kette = [{ sammlung: ordner('a'), grants: [recht({ conversationId: 'gruppe' })] }];
    expect(lage(kette, [chat('gruppe', ['anna', 'bodo'])]).fehlend).toEqual(['cleo']);
    // Unbekannter Chat: Die Rechnung irrt sich nur in Richtung „fehlt“.
    expect(lage(kette, []).fehlend).toEqual(['bodo', 'cleo']);
  });

  it('zählt die Stufe für den Herkunftschat, aber nicht „none“', () => {
    const chats = [chat('gruppe', ['bodo', 'cleo'])];
    const mit = (memberLevel: MemberLevel) =>
      lage(
        [{ sammlung: ordner('a', { conversationId: 'gruppe', memberLevel }), grants: [] }],
        chats,
      );
    expect(mit('edit').fehlend).toEqual([]);
    expect(mit('edit').stufen.get('bodo')).toBe('edit');
    expect(mit('view').stufen.get('cleo')).toBe('view');
    expect(mit('none').fehlend).toEqual(['bodo', 'cleo']);
  });

  it('zählt ein Recht am Elternordner', () => {
    const kette: KettenGlied[] = [
      { sammlung: ordner('eltern'), grants: [recht({ userId: 'bodo', level: 'view' })] },
      { sammlung: ordner('kind'), grants: [] },
    ];
    expect(lage(kette).stufen.get('bodo')).toBe('view');
  });

  it('lässt die höchste Stufe gewinnen', () => {
    const kette: KettenGlied[] = [
      { sammlung: ordner('eltern'), grants: [recht({ userId: 'bodo', level: 'own' })] },
      { sammlung: ordner('kind'), grants: [recht({ userId: 'bodo', level: 'view' })] },
    ];
    expect(lage(kette).stufen.get('bodo')).toBe('own');
  });

  it('übergeht Rechte an einzelnen Dateien und Rechte, die nicht zu laden waren', () => {
    const kette: KettenGlied[] = [
      { sammlung: ordner('a'), grants: [recht({ userId: 'bodo', itemId: 'datei' })] },
      { sammlung: ordner('b'), grants: null },
    ];
    expect(lage(kette).fehlend).toEqual(['bodo', 'cleo']);
  });

  it('lässt einen selbst nie fehlen', () => {
    const ergebnis = lage([{ sammlung: ordner('a'), grants: [] }], [], ['anna', 'bodo']);
    expect(ergebnis.stufen.has('anna')).toBe(false);
    expect(ergebnis.fehlend).toEqual(['bodo']);
  });
});

describe('Erbe aus der Kette', () => {
  it('nennt Personen und Chats mit der höchsten Stufe, ohne Dateirechte', () => {
    const kette: KettenGlied[] = [
      {
        sammlung: ordner('eltern', { createdBy: 'anna' }),
        grants: [
          recht({ userId: 'cleo', level: 'view' }),
          recht({ conversationId: 'gruppe', level: 'edit' }),
          recht({ userId: 'dora', itemId: 'datei' }),
        ],
      },
      {
        sammlung: ordner('kind', { createdBy: 'anna' }),
        grants: [recht({ userId: 'cleo', level: 'edit' })],
      },
    ];
    expect(erbtVon(kette)).toEqual([
      { art: 'person', userId: 'anna', stufe: 'own' },
      { art: 'person', userId: 'cleo', stufe: 'edit' },
      { art: 'chat', conversationId: 'gruppe', stufe: 'edit' },
    ]);
  });

  it('nimmt den Herkunftschat mit seiner Stufe dazu, außer bei „none“', () => {
    const mit = (memberLevel: MemberLevel): AccessLevel[] =>
      erbtVon([
        {
          sammlung: ordner('a', { createdBy: null, conversationId: 'g', memberLevel }),
          grants: [],
        },
      ]).map((eintrag) => eintrag.stufe);
    expect(mit('view')).toEqual(['view']);
    expect(mit('none')).toEqual([]);
  });
});

describe('Sätze', () => {
  it('fasst die Freigabe im Blatt zusammen', () => {
    expect(zusammenfassung({ eingeladene: 0, gewaehlt: [], stufe: 'edit' })).toBe(
      'Sonst ist noch niemand eingeladen.',
    );
    expect(zusammenfassung({ eingeladene: 3, gewaehlt: [], stufe: 'edit' })).toBe(
      'Nur du hast Zugriff. Die Eingeladenen sehen den Link, kommen aber nicht hinein.',
    );
    expect(zusammenfassung({ eingeladene: 3, gewaehlt: [bodo], stufe: 'view' })).toBe(
      'Ausser dir bekommt 1 Person Zugriff (ansehen): Bodo.',
    );
    expect(zusammenfassung({ eingeladene: 3, gewaehlt: [bodo, cleo], stufe: 'edit' })).toBe(
      'Ausser dir bekommen 2 Personen Zugriff (ansehen und ändern): Bodo, Cleo.',
    );
  });

  it('sagt, wer hineinkommt', () => {
    expect(zugriffSatz(0, [])).toBe('Ausser dir ist niemand eingeladen.');
    expect(zugriffSatz(5, [])).toBe('Alle 5 Eingeladenen kommen hinein.');
    expect(zugriffSatz(1, [])).toBe('Die eingeladene Person kommt hinein.');
    expect(zugriffSatz(5, ['Cleo', 'Dora'])).toBe(
      '2 von 5 Eingeladenen kommen nicht hinein: Cleo, Dora.',
    );
    expect(zugriffSatz(2, ['Cleo', 'Dora'])).toBe(
      'Keiner der 2 Eingeladenen kommt hinein: Cleo, Dora.',
    );
    expect(zugriffSatz(1, ['Bodo'])).toBe('Die eingeladene Person kommt nicht hinein: Bodo.');
  });
});
