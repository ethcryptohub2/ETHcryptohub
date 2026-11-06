import { describe, expect, it } from 'vitest';
import {
  calculatePremiumExpiry,
  generateLicenseCode,
  licenseCodeHash,
  normalizeLicenseCode,
  statusFromDates,
} from '../../../../lib/subscription-utils.ts';

const now = Date.parse('2026-01-01T00:00:00.000Z');

describe('subscription primitives', () => {
  it('normalizes codes and hashes equivalent formatting consistently', () => {
    expect(normalizeLicenseCode(' smrt-abcd-2345-efgh ')).toBe('SMRTABCD2345EFGH');
    expect(licenseCodeHash('smrt-abcd-2345-efgh', 'test-pepper'))
      .toBe(licenseCodeHash('SMRTABCD2345EFGH', 'test-pepper'));
    expect(licenseCodeHash('SMRTABCD2345EFGH', 'test-pepper'))
      .not.toBe(licenseCodeHash('SMRTABCD2345EFGH', 'different-pepper'));
  });

  it('generates formatted activation codes without ambiguous alphabet characters', () => {
    const code = generateLicenseCode();
    expect(code).toMatch(/^SMRT-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('calculates trial and premium access from server timestamps', () => {
    const trial = { trialExpiresAt: new Date(now + 1).toISOString(), premiumStartedAt: null, premiumExpiresAt: null };
    expect(statusFromDates(trial, now)).toBe('FREE_TRIAL');
    expect(statusFromDates(trial, now + 1)).toBe('TRIAL_EXPIRED');
    expect(statusFromDates({ ...trial, premiumStartedAt: new Date(now - 1000).toISOString() }, now)).toBe('PREMIUM_EXPIRED');
    expect(statusFromDates({
      ...trial,
      premiumStartedAt: new Date(now - 1000).toISOString(),
      premiumExpiresAt: new Date(now + 1).toISOString(),
    }, now)).toBe('PREMIUM_ACTIVE');
  });

  it('extends an active premium period and starts expired access from now', () => {
    const currentExpiry = now + 10 * 86_400_000;
    expect(calculatePremiumExpiry(now, currentExpiry, 30).getTime())
      .toBe(now + 40 * 86_400_000);
    expect(calculatePremiumExpiry(now, now - 1, 30).getTime())
      .toBe(now + 30 * 86_400_000);
  });
});
