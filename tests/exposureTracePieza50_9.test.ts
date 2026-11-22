/**
 * Pieza 50.9 (Bloque A) — trazabilidad de exposición US/AR.
 *
 * Referencia independiente: `tools/gen_exposure_trace_pieza50_9.py`
 * (`fixtures/exposure_trace_pieza50_9_reference.json`). Cubre tiempos mixtos,
 * faltantes/inválidos/futuros, referencias EOD excluidas del rango, overlay
 * parcial, cobertura completa/parcial/desconocida y metadatos de rangos.
 * Además verifica la representación: DTO legacy sin traza = cobertura
 * desconocida, Zero-Gamma solo con `unique`, estados de cruce y que un tick
 * live no dependa de los niveles.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExposureTraceMetadata,
  resolveExposureCoverage,
  summarizeQuoteTimes,
  type ExposureCoverageEvidence,
  type QuoteTimeEntry,
} from '../src/core/exposureTrace.js';

interface QuoteCase {
  readonly name: string;
  readonly entries: readonly QuoteTimeEntry[];
  readonly asOfUtcSec: number;
  readonly expected: ReturnType<typeof summarizeQuoteTimes>;
}

interface CoverageCase {
  readonly name: string;
  readonly evidence: ExposureCoverageEvidence;
  readonly expected: string;
}

interface MetadataCase {
  readonly name: string;
  readonly input: Parameters<typeof buildExposureTraceMetadata>[0];
  readonly expected: ReturnType<typeof buildExposureTraceMetadata>;
}

interface Fixture {
  readonly quoteCases: readonly QuoteCase[];
  readonly coverageCases: readonly CoverageCase[];
  readonly metadataCases: readonly MetadataCase[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'exposure_trace_pieza50_9_reference.json'), 'utf-8'),
) as Fixture;

describe('Pieza 50.9 Bloque A — resumen de tiempos de cotización', () => {
  it('coincide con la referencia en extremos, recuentos y edades', () => {
    for (const item of fixture.quoteCases) {
      const actual = summarizeQuoteTimes(item.entries, item.asOfUtcSec);
      expect(actual, item.name).toEqual(item.expected);
    }
  });

  it('excluye faltantes, inválidos, futuros y referencias EOD del rango verifiable', () => {
    const eod = fixture.quoteCases.find((c) => c.name === 'eod_referencia');
    expect(eod?.expected.minUpdatedAtSec).toBe(1_699_999_980);
    expect(eod?.expected.maxUpdatedAtSec).toBe(1_699_999_980);
    expect(eod?.expected.eodReferenceCount).toBe(1);
    expect(eod?.expected.minUpdatedAtSec).not.toBe(1_699_999_990);
    const boundary = fixture.quoteCases.find((c) => c.name === 'borde_evaluacion');
    expect(boundary?.expected.knownCount).toBe(1);
    expect(boundary?.expected.newestAgeSec).toBe(0);
    const future = fixture.quoteCases.find((c) => c.name === 'futuro');
    expect(future?.expected.knownCount).toBe(0);
    expect(future?.expected.maxUpdatedAtSec).toBeNull();
    const invalid = fixture.quoteCases.find((c) => c.name === 'invalido');
    expect(invalid?.expected.unknownCount).toBe(3);
  });

  it('registra la procedencia del overlay sin acreditar tiempos ajenos', () => {
    const partial = fixture.quoteCases.find((c) => c.name === 'overlay_parcial');
    expect(partial?.expected.overlayQuoteCount).toBe(1);
    expect(partial?.expected.knownCount).toBe(2);
  });
});

describe('Pieza 50.9 Bloque A — cobertura y metadatos', () => {
  it('coincide con la referencia en el estado de cobertura', () => {
    for (const item of fixture.coverageCases) {
      expect(resolveExposureCoverage(item.evidence), item.name).toBe(item.expected);
    }
  });

  it('ensambla rangos, recuentos y nulos igual que la referencia', () => {
    for (const item of fixture.metadataCases) {
      expect(buildExposureTraceMetadata(item.input), item.name).toEqual(item.expected);
    }
  });

  it('una respuesta legacy sin traza queda en cobertura desconocida y sin tiempos', () => {
    expect(resolveExposureCoverage({ evidenced: false, engineInputs: 0, skippedContracts: 0, chainTruncated: false })).toBe('unknown');
    expect(summarizeQuoteTimes([], 1_700_000_000)).toEqual({
      knownCount: 0,
      unknownCount: 0,
      minUpdatedAtSec: null,
      maxUpdatedAtSec: null,
      newestAgeSec: null,
      oldestAgeSec: null,
      overlayQuoteCount: 0,
      eodReferenceCount: 0,
    });
  });
});

describe('Pieza 50.9 Bloque A — representación en Stock Detail', () => {
  it('solo un cruce único dibuja Zero-Gamma y se distinguen los cuatro estados', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src.split("exposure?.gammaFlipStatus === 'unique'").length - 1).toBe(2);
    expect(src).toContain("status === 'multiple_crossings'");
    expect(src).toContain("status === 'no_crossing'");
    expect(src).toContain("status === 'indeterminate'");
    expect(src).toContain('REST elige el más cercano');
    expect(src).toContain('calls +1 · puts −1 (modelo teórico)');
    // La traza muestra cobertura desconocida cuando no hay metadatos.
    expect(src).toContain("trace?.coverage ?? 'unknown'");
    expect(src).toContain('cobertura desconocida');
  });

  it('el tick live no participa de los niveles ni del spot de valuación', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    // La traza/niveles solo dependen de exposiciones REST, no del precio live.
    expect(src).toContain('}, [arOptions?.exposureSummary, isArMarket, usSnap?.exposureSummary]);');
    expect(src).not.toContain('exposureTraceInfo = useMemo(() => {\n    const liveQuote');
    expect(src).toContain('const exposure = isArMarket ? arOptions?.exposureSummary : usSnap?.exposureSummary;');
  });
});
