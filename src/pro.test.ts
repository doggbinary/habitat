import { describe, expect, it } from 'vitest';
import { buyPro, isPro, proPrice } from './pro';

describe('Pro off the iPad', () => {
  it('leaves Export open on the web copy, which has no store', async () => {
    expect(await isPro()).toBe(true);
  });

  it('shows the list price and reports the store as unavailable', async () => {
    expect(await proPrice()).toBe('$14.99');
    expect(await buyPro()).toBe('unavailable');
  });
});
