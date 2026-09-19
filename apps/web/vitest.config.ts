import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    /*
     * Unit-Tests liegen neben dem Code; e2e/ gehört Playwright.
     *
     * `scripts/` ist dazugekommen, als der Bausatz für die App-Symbole entstand
     * (`marke.mjs`). Er enthält einen PNG-Decoder, und der geht auf eine Art
     * kaputt, die man dem Ergebnis nicht ansieht – ein falsch gerechneter
     * Zeilenfilter liefert kein Fehlerbild, sondern ein verschmiertes.
     */
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
