import { defineConfig } from 'vitest/config';

/**
 * Config dedicada a las pruebas de humo (red real). `npm run verify` usa
 * el include por defecto de vitest (`*.test.ts`) y nunca entra aquí: las
 * humo corren solo a mano con `npm run smoke:next-url`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.smoke.ts'],
    // 6 páginas por escenario como máximo, 13,001 s entre peticiones:
    // hasta ~156 s + latencia por escenario.
    testTimeout: 300_000,
  },
});
