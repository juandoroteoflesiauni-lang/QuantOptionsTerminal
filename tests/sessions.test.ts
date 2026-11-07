import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getFormatterCacheSizeForTests,
  getMarketParts,
  isNewMonth,
  isNewSession,
  isNewWeek,
  isNewYear,
  isRth,
  monthKey,
  sessionKey,
  weekKey,
  yearKey,
  type Market,
  type MarketParts,
} from '../src/core/sessions.js';

interface FixtureExpected {
  parts: MarketParts;
  sessionKey: string;
  weekKey: string;
  monthKey: number;
  yearKey: number;
  isRth: boolean | null;
}

interface FixtureCase {
  description: string;
  time: number;
  market: Market;
  expectError?: boolean;
  expected?: FixtureExpected;
}

interface SweepPoint {
  time: number;
  dateKey: string;
  weekKey: string;
  monthKey: number;
  yearKey: number;
  isRth: boolean;
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: string;
    timeZoneEquity: string;
    timeZoneCrypto: string;
  };
  cases: Record<string, FixtureCase>;
  sweep: {
    startUtc: string;
    endUtc: string;
    stepSeconds: number;
    totalGridPoints: number;
    sampledPoints: number;
    sampling: string;
    points: SweepPoint[];
  };
}

function utcSeconds(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

const fixturePath = resolve(process.cwd(), 'fixtures/sessions_reference.json');
const fixtureContent = readFileSync(fixturePath, 'utf-8');
const fixture = JSON.parse(fixtureContent) as FixtureFile;

describe('Gestor de sesiones (SPEC punto 3)', () => {
  describe('Referencia independiente (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(fixture.cases)) {
      it(`verifica contra fixture independiente: ${caseName} (${caseData.description})`, () => {
        if (caseData.expectError === true) {
          expect(() => getMarketParts(caseData.time, caseData.market)).toThrow();
          expect(() => sessionKey(caseData.time, caseData.market)).toThrow();
          expect(() => isRth(caseData.time)).toThrow();
          return;
        }

        const expected = caseData.expected;
        if (expected === undefined) {
          throw new Error(`Caso ${caseName} sin expected ni expectError`);
        }

        const parts = getMarketParts(caseData.time, caseData.market);
        expect(parts.year).toBe(expected.parts.year);
        expect(parts.month).toBe(expected.parts.month);
        expect(parts.day).toBe(expected.parts.day);
        expect(parts.hour).toBe(expected.parts.hour);
        expect(parts.minute).toBe(expected.parts.minute);
        expect(parts.weekday).toBe(expected.parts.weekday);
        expect(parts.dateKey).toBe(expected.parts.dateKey);
        expect(parts.minutesOfDay).toBe(expected.parts.minutesOfDay);

        expect(sessionKey(caseData.time, caseData.market)).toBe(
          expected.sessionKey,
        );
        expect(weekKey(caseData.time, caseData.market)).toBe(expected.weekKey);
        expect(monthKey(caseData.time, caseData.market)).toBe(expected.monthKey);
        expect(yearKey(caseData.time, caseData.market)).toBe(expected.yearKey);

        if (expected.isRth === null) {
          expect(caseData.market).toBe('CRYPTO');
        } else {
          expect(caseData.market).toBe('EQUITY');
          expect(isRth(caseData.time)).toBe(expected.isRth);
        }
      });
    }
  });

  describe('Barrido de 5 minutos (2025-01-01 a 2026-12-31)', () => {
    it(`coincide con Python en los ${fixture.sweep.sampledPoints.toString()} puntos muestreados`, () => {
      expect(fixture.sweep.points).toHaveLength(fixture.sweep.sampledPoints);
      expect(fixture.sweep.totalGridPoints).toBe(210240);
      expect(fixture.sweep.stepSeconds).toBe(300);

      for (const point of fixture.sweep.points) {
        const parts = getMarketParts(point.time, 'EQUITY');

        expect(sessionKey(point.time, 'EQUITY')).toBe(point.dateKey);
        expect(parts.dateKey).toBe(point.dateKey);
        expect(weekKey(point.time, 'EQUITY')).toBe(point.weekKey);
        expect(monthKey(point.time, 'EQUITY')).toBe(point.monthKey);
        expect(yearKey(point.time, 'EQUITY')).toBe(point.yearKey);
        expect(isRth(point.time)).toBe(point.isRth);
      }

      console.log(
        `[Sessions Sweep] ${fixture.sweep.sampledPoints.toString()} puntos de ${fixture.sweep.totalGridPoints.toString()} verificados contra Python (${fixture.sweep.startUtc} a ${fixture.sweep.endUtc})`,
      );
    });
  });

  describe('Claves y detección de cambios', () => {
    it('la barra de 20:00 ET de fin de mes no cambia sesión, mes ni año', () => {
      const beforeClose = utcSeconds(2025, 1, 31, 20, 59, 59);
      const at2000Et = utcSeconds(2025, 2, 1, 1, 0, 0);

      expect(sessionKey(beforeClose, 'EQUITY')).toBe('2025-01-31');
      expect(sessionKey(at2000Et, 'EQUITY')).toBe('2025-01-31');
      expect(isNewSession(beforeClose, at2000Et, 'EQUITY')).toBe(false);
      expect(isNewMonth(beforeClose, at2000Et, 'EQUITY')).toBe(false);
      expect(isNewYear(beforeClose, at2000Et, 'EQUITY')).toBe(false);
    });

    it('la barra de 20:00 ET del 31 de diciembre no cambia año', () => {
      const beforeClose = utcSeconds(2025, 12, 31, 20, 59, 59);
      const at2000Et = utcSeconds(2026, 1, 1, 1, 0, 0);

      expect(sessionKey(beforeClose, 'EQUITY')).toBe('2025-12-31');
      expect(sessionKey(at2000Et, 'EQUITY')).toBe('2025-12-31');
      expect(isNewYear(beforeClose, at2000Et, 'EQUITY')).toBe(false);
      expect(isNewMonth(beforeClose, at2000Et, 'EQUITY')).toBe(false);

      const nextSession = utcSeconds(2026, 1, 2, 14, 30, 0);
      expect(isNewSession(at2000Et, nextSession, 'EQUITY')).toBe(true);
      expect(isNewMonth(at2000Et, nextSession, 'EQUITY')).toBe(true);
      expect(isNewYear(at2000Et, nextSession, 'EQUITY')).toBe(true);
    });

    it('la semana del lunes feriado se identifica igual y no cambia desde el domingo', () => {
      const saturday = utcSeconds(2025, 1, 18, 17, 0, 0);
      const sunday = utcSeconds(2025, 1, 19, 17, 0, 0);
      const holidayMonday = utcSeconds(2025, 1, 20, 17, 0, 0);

      expect(weekKey(saturday, 'EQUITY')).toBe('2025-01-13');
      expect(weekKey(sunday, 'EQUITY')).toBe('2025-01-13');
      expect(weekKey(holidayMonday, 'EQUITY')).toBe('2025-01-20');
      expect(isNewWeek(saturday, sunday, 'EQUITY')).toBe(false);
      expect(isNewWeek(sunday, holidayMonday, 'EQUITY')).toBe(true);

      // isRth no modela feriados: el lunes MLK a las 12:00 ET cae en RTH.
      expect(isRth(holidayMonday)).toBe(true);
    });

    it('en cripto la medianoche UTC cambia sesión, mes y año, pero no la semana', () => {
      const beforeMidnight = utcSeconds(2024, 12, 31, 23, 59, 59);
      const midnight = utcSeconds(2025, 1, 1, 0, 0, 0);

      expect(sessionKey(beforeMidnight, 'CRYPTO')).toBe('2024-12-31');
      expect(sessionKey(midnight, 'CRYPTO')).toBe('2025-01-01');
      expect(weekKey(beforeMidnight, 'CRYPTO')).toBe('2024-12-30');
      expect(weekKey(midnight, 'CRYPTO')).toBe('2024-12-30');

      expect(isNewSession(beforeMidnight, midnight, 'CRYPTO')).toBe(true);
      expect(isNewWeek(beforeMidnight, midnight, 'CRYPTO')).toBe(false);
      expect(isNewMonth(beforeMidnight, midnight, 'CRYPTO')).toBe(true);
      expect(isNewYear(beforeMidnight, midnight, 'CRYPTO')).toBe(true);
    });

    it('el salto de horario de verano no provoca un cambio falso de sesión', () => {
      const beforeSpring = utcSeconds(2025, 3, 9, 6, 59, 59);
      const afterSpring = utcSeconds(2025, 3, 9, 7, 0, 0);

      expect(getMarketParts(beforeSpring, 'EQUITY').hour).toBe(1);
      expect(getMarketParts(afterSpring, 'EQUITY').hour).toBe(3);
      expect(dateKeyOf(beforeSpring)).toBe('2025-03-09');
      expect(dateKeyOf(afterSpring)).toBe('2025-03-09');
      expect(isNewSession(beforeSpring, afterSpring, 'EQUITY')).toBe(false);
      expect(isNewWeek(beforeSpring, afterSpring, 'EQUITY')).toBe(false);
      expect(isNewMonth(beforeSpring, afterSpring, 'EQUITY')).toBe(false);
      expect(isNewYear(beforeSpring, afterSpring, 'EQUITY')).toBe(false);

      const beforeFall = utcSeconds(2025, 11, 2, 5, 59, 59);
      const afterFall = utcSeconds(2025, 11, 2, 6, 0, 0);
      expect(getMarketParts(beforeFall, 'EQUITY').hour).toBe(1);
      expect(getMarketParts(afterFall, 'EQUITY').hour).toBe(1);
      expect(dateKeyOf(beforeFall)).toBe('2025-11-02');
      expect(dateKeyOf(afterFall)).toBe('2025-11-02');
      expect(isNewSession(beforeFall, afterFall, 'EQUITY')).toBe(false);
    });
  });

  describe('Validación de entrada', () => {
    it('rechaza tiempos que no son segundos enteros finitos o parecen milisegundos', () => {
      const invalidTimes = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        1.5,
        100000000001,
        1741503600000,
      ];

      for (const time of invalidTimes) {
        expect(() => getMarketParts(time, 'EQUITY')).toThrow();
        expect(() => sessionKey(time, 'EQUITY')).toThrow();
        expect(() => weekKey(time, 'EQUITY')).toThrow();
        expect(() => monthKey(time, 'EQUITY')).toThrow();
        expect(() => yearKey(time, 'EQUITY')).toThrow();
        expect(() => isRth(time)).toThrow();
        expect(() => isNewSession(time, time, 'EQUITY')).toThrow();
      }
    });

    it('rechaza un mercado desconocido', () => {
      const invalidMarket = 'FOREX' as Market;

      expect(() => getMarketParts(1700000000, invalidMarket)).toThrow();
      expect(() => sessionKey(1700000000, invalidMarket)).toThrow();
      expect(() => isNewWeek(1700000000, 1700000300, invalidMarket)).toThrow();
    });
  });

  describe('Caché de Intl.DateTimeFormat', () => {
    it('10.000 llamadas no crean 10.000 formateadores', () => {
      // Calienta ambas zonas para que el contador no suba por la primera creación.
      getMarketParts(1700000000, 'EQUITY');
      getMarketParts(1700000000, 'CRYPTO');

      const before = getFormatterCacheSizeForTests();
      for (let index = 0; index < 10000; index++) {
        getMarketParts(
          1700000000 + index * 300,
          index % 2 === 0 ? 'EQUITY' : 'CRYPTO',
        );
      }
      const after = getFormatterCacheSizeForTests();

      console.log(
        `[Sessions Formatter Cache] formateadores antes=${before.toString()}, después=${after.toString()}`,
      );
      expect(after).toBe(before);
      expect(after).toBeLessThanOrEqual(2);
    });
  });

  describe('Rendimiento', () => {
    it('mide 10.000 llamadas a getMarketParts y reporta el tiempo', () => {
      const startTime = performance.now();
      let lastMinutesOfDay = 0;

      for (let index = 0; index < 10000; index++) {
        const parts = getMarketParts(
          1700000000 + index * 300,
          index % 2 === 0 ? 'EQUITY' : 'CRYPTO',
        );
        lastMinutesOfDay = parts.minutesOfDay;
      }

      const elapsed = performance.now() - startTime;
      expect(Number.isInteger(lastMinutesOfDay)).toBe(true);

      console.log(
        `[Sessions Performance Benchmark] 10.000 llamadas a getMarketParts en ${elapsed.toFixed(3)} ms`,
      );
    });
  });
});

function dateKeyOf(time: number): string {
  return getMarketParts(time, 'EQUITY').dateKey;
}
