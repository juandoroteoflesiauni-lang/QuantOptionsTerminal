import { describe, expect, it } from 'vitest';
import { IOL_PANELS } from '../src/server/iolFeedAdapter.js';

/**
 * Referencia independiente: tabla de rutas válidas de la API v2 de
 * InvertirOnline (documentación oficial), transcrita explícitamente.
 * - `acciones` usa paneles nombrados; `acciones/todas` devuelve HTTP 404.
 * - el mercado de CEDEARs es singular (`cedear`); `cedears/todas` devuelve
 *   HTTP 400.
 */
const DOCUMENTED_IOL_V2_ROUTES: readonly { readonly id: string; readonly path: string }[] = [
  { id: 'acciones', path: '/api/v2/Cotizaciones/acciones/Merval/argentina' },
  { id: 'accionesPanelGeneral', path: '/api/v2/Cotizaciones/acciones/Panel%20General/argentina' },
  { id: 'cedears', path: '/api/v2/Cotizaciones/cedear/todas/argentina' },
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
    expect(paths).not.toContain('/api/v2/Cotizaciones/cedears/todas/argentina');
    for (const path of paths) {
      expect(path.startsWith('/api/v2/Cotizaciones/')).toBe(true);
      expect(path.endsWith('/argentina')).toBe(true);
    }
  });
});
