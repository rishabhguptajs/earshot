import { describe, expect, test } from 'bun:test';
import { parseCuriosity, parseMaxCost } from '../src/budget.ts';

describe('--curiosity', () => {
  test('accepts the three levels and nothing else', () => {
    expect(parseCuriosity('low')).toBe('low');
    expect(parseCuriosity('high')).toBe('high');
    expect(parseCuriosity(undefined)).toBeUndefined();
    expect(parseCuriosity('maximum')).toBe('invalid');
    // A bare `--curiosity` parses as a boolean, which is not a level.
    expect(parseCuriosity(true)).toBe('invalid');
  });
});

describe('--max-cost', () => {
  test('reads dollars, with or without the sign', () => {
    expect(parseMaxCost('2.50')).toBe(2.5);
    expect(parseMaxCost('$2.50')).toBe(2.5);
  });

  test('treats zero as "no budget" rather than "spend nothing"', () => {
    // Zero has to mean something usable: it is how a flag turns off a limit a
    // settings file set, and a session that may spend nothing cannot run.
    expect(parseMaxCost('0')).toBe(0);
  });

  test('refuses anything that is not an amount', () => {
    expect(parseMaxCost('lots')).toBe('invalid');
    expect(parseMaxCost('-1')).toBe('invalid');
    expect(parseMaxCost(true)).toBe('invalid');
    expect(parseMaxCost(undefined)).toBeUndefined();
  });
});
