import { describe, expect, it } from 'vitest';
import { pathRole } from './autotile';

describe('path pieces', () => {
  it('uses the centre when the path continues on every side', () => {
    expect(pathRole(true, true, true, true)).toBe(0);
  });

  it('uses a straight piece for a one-square-wide road', () => {
    expect(pathRole(false, true, false, true)).toBe(9);
    expect(pathRole(true, false, true, false)).toBe(10);
  });

  it('uses a bend where the road turns', () => {
    expect(pathRole(false, false, true, true)).toBe(5);
    expect(pathRole(false, true, true, false)).toBe(8);
  });
});
