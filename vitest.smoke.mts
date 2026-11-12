import { defineConfig } from 'vitest/config';

/**
 * Config dedicada a las pruebas de humo (red real). `npm run verify` usa
 * el include por defecto de vitest (`*.test.ts`) y nunca entra aquí: las
 * humo corren solo a mano con `npm run smoke:next-url`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.smoke.ts'],
    testTimeout: 120_000,
  },
});
