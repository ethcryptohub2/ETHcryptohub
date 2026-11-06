import { createHash, randomInt } from 'node:crypto';

export type SubscriptionStatus = 'FREE_TRIAL' | 'PREMIUM_ACTIVE' | 'TRIAL_EXPIRED' | 'PREMIUM_EXPIRED';

export function normalizeLicenseCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function licenseCodeHash(code: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${normalizeLicenseCode(code)}`).digest('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateLicenseCode(): string {
  const characters = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `SMRT-${characters.slice(0, 4).join('')}-${characters.slice(4, 8).join('')}-${characters.slice(8).join('')}`;
}

export function statusFromDates(input: {
  trialExpiresAt: string;
  premiumStartedAt: string | null;
  premiumExpiresAt: string | null;
}, now: number): SubscriptionStatus {
  if (input.premiumExpiresAt && Date.parse(input.premiumExpiresAt) > now) return 'PREMIUM_ACTIVE';
  if (input.premiumStartedAt) return 'PREMIUM_EXPIRED';
  if (Date.parse(input.trialExpiresAt) > now) return 'FREE_TRIAL';
  return 'TRIAL_EXPIRED';
}

export function calculatePremiumExpiry(now: number, currentExpiry: number | null, durationDays: number) {
  const startsAt = currentExpiry !== null && currentExpiry > now ? currentExpiry : now;
  return new Date(startsAt + durationDays * 86_400_000);
}
