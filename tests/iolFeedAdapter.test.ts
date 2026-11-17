import { describe, expect, it, vi } from 'vitest';
import {
  IOL_CEDEARS_FALLBACK_PATH,
  IOL_PANELS,
  IolFeedAdapter,
  type IolHttpResponse,
} from '../src/server/iolFeedAdapter.js';

/**
 * Referencia independiente: tabla de rutas válidas de la API v2 de
 * InvertirOnline, transcrita explícitamente del comportamiento observado de la
 * API de producción:
 * - `acciones` usa paneles nombrados; `acciones/todas` devuelve HTTP 404.
 * - CEDEARs exige el nombre de panel `CEDEARs`; `cedear/todas` y
 *   `cedears/todas` devuelven HTTP 400.
 * - La ruta primaria de CEDEARs tiene fallback a `acciones/CEDEARs`
 *   (`IOL_CEDEARS_FALLBACK_PATH`) ante HTTP 400/404.
 */
const DOCUMENTED_IOL_V2_ROUTES: readonly { readonly id: string; readonly path: string }[] = [
  { id: 'acciones', path: '/api/v2/Cotizaciones/acciones/Merval/argentina' },
  { id: 'accionesPanelGeneral', path: '/api/v2/Cotizaciones/acciones/Panel%20General/argentina' },
  { id: 'cedears', path: '/api/v2/Cotizaciones/cedears/CEDEARs/argentina' },
  { id: 'bonos', path: '/api/v2/Cotizaciones/bonos/todas/argentina' },
  { id: 'letras', path: '/api/v2/Cotizaciones/letras/todas/argentina' },
  { id: 'obligacionesNegociables', path: '/api/v2/Cotizaciones/obligacionesNegociables/todas/argentina' },
  { id: 'cauciones', path: '/api/v2/Cotizaciones/cauciones/todas/argentina' },
];

describe('IOL REST v2 — rutas de panel válidas (hotfix producción)', () => {
  it('los paneles coinciden 1:1 con las rutas documentadas de IOL v2', () => {
    expect(IOL_PANELS.map((panel) => ({ id: panel.id, path: panel.path }))).toEqual(
      DOCUMENTED_IOL_V2_ROUTES,
    );
  });

  it('no queda ninguna ruta inválida conocida (404/400 en producción)', () => {
    const paths = IOL_PANELS.map((panel) => panel.path);
    expect(paths).not.toContain('/api/v2/Cotizaciones/acciones/todas/argentina');
    expect(paths).not.toContain('/api/v2/Cotizaciones/cedear/todas/argentina');
    expect(paths).not.toContain('/api/v2/Cotizaciones/cedears/todas/argentina');
    for (const path of paths) {
      expect(path.startsWith('/api/v2/Cotizaciones/')).toBe(true);
      expect(path.endsWith('/argentina')).toBe(true);
    }
  });

  it('exporta el fallback de CEDEARs con la ruta acciones/CEDEARs exacta', () => {
    expect(IOL_CEDEARS_FALLBACK_PATH).toBe('/api/v2/Cotizaciones/acciones/CEDEARs/argentina');
  });

  it('ante HTTP 400 en la ruta CEDEARs primaria cae al fallback acciones/CEDEARs y publica las cotizaciones', async () => {
    const requestedPaths: string[] = [];
    // Lunes 16/11/2026 15:00 UTC == 12:00 ART => en sesión BYMA (sin DST).
    const nowMs = Date.UTC(2026, 10, 16, 15, 0, 0);
    const fetchFn = (url: string): Promise<IolHttpResponse> => {
      const path = url.replace(/^https:\/\/[^/]+/, '');
      requestedPaths.push(path);
      if (path === '/token') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 900 }),
        });
      }
      if (path === '/api/v2/Cotizaciones/cedears/CEDEARs/argentina') {
        return Promise.resolve({ ok: false, status: 400, text: JSON.stringify({ message: 'panel invalido' }) });
      }
      if (path === IOL_CEDEARS_FALLBACK_PATH) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            titulos: [
              {
                simbolo: 'AAPL',
                ultimoPrecio: 123.4,
                ultimoCierre: 120,
                variacionPorcentual: 2.833333333333333,
                moneda: 'Dolar EEUU',
                minimo: 121,
                maximo: 125,
                volumen: 1000,
                montoOperado: 123400,
                fecha: '2026-11-16T12:00:00-03:00',
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ titulos: [] }) });
    };
    const adapter = new IolFeedAdapter({
      env: { IOL_USERNAME: 'user', IOL_PASSWORD: 'pass' },
      fetchFn,
      nowMsFn: () => nowMs,
      baseUrl: 'https://api.invertironline.test',
    });
    adapter.start();
    try {
      await vi.waitFor(() => {
        expect(adapter.getQuotes().map((quote) => quote.symbol)).toContain('AAPL');
      });
      expect(requestedPaths).toContain('/api/v2/Cotizaciones/cedears/CEDEARs/argentina');
      expect(requestedPaths).toContain(IOL_CEDEARS_FALLBACK_PATH);
      expect(requestedPaths.indexOf('/api/v2/Cotizaciones/cedears/CEDEARs/argentina')).toBeLessThan(
        requestedPaths.indexOf(IOL_CEDEARS_FALLBACK_PATH),
      );
      const quote = adapter.getQuotes().find((entry) => entry.symbol === 'AAPL');
      expect(quote?.kind).toBe('stock');
      expect(quote?.source).toBe('IOL_REST');
      expect(quote?.price).toBe(123.4);
    } finally {
      adapter.stop();
    }
  });
});
