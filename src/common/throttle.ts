/**
 * Rate limit budgets.
 *
 * These live in a module rather than inline in each `@Throttle` decorator for
 * two reasons: every limit is visible in one place, and each can be overridden
 * by environment variable. That override exists so an end-to-end test can run
 * the real auth flows without waiting out a 15 minute window; it is not meant
 * to be used to weaken production.
 *
 * Read at import time, because decorators are evaluated when the module loads
 * and cannot reach the Nest config container.
 */

const MINUTE = 60_000;

function budget(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Sign in, register, refresh. Keyed per IP. */
export const AUTH_THROTTLE = {
  register: { limit: budget('THROTTLE_REGISTER', 5), ttl: 15 * MINUTE },
  login: { limit: budget('THROTTLE_LOGIN', 10), ttl: 15 * MINUTE },
  refresh: { limit: budget('THROTTLE_REFRESH', 30), ttl: 15 * MINUTE },
  /** Deliberately tight: this one sends email. */
  forgotPassword: {
    limit: budget('THROTTLE_FORGOT_PASSWORD', 3),
    ttl: 15 * MINUTE,
  },
  /** Higher than forgot-password, because a person mistyping a code is normal. */
  verifyResetCode: {
    limit: budget('THROTTLE_VERIFY_CODE', 10),
    ttl: 15 * MINUTE,
  },
  resetPassword: {
    limit: budget('THROTTLE_RESET_PASSWORD', 5),
    ttl: 15 * MINUTE,
  },
} as const;

/** Writes that cost money, storage or somebody's attention. */
export const WRITE_THROTTLE = {
  serviceRequest: {
    limit: budget('THROTTLE_SERVICE_REQUEST', 10),
    ttl: 60 * MINUTE,
  },
  review: { limit: budget('THROTTLE_REVIEW', 20), ttl: 60 * MINUTE },
  report: { limit: budget('THROTTLE_REPORT', 10), ttl: 60 * MINUTE },
  upload: { limit: budget('THROTTLE_UPLOAD', 20), ttl: 60 * MINUTE },
  serviceImage: {
    limit: budget('THROTTLE_SERVICE_IMAGE', 60),
    ttl: 60 * MINUTE,
  },
} as const;

export const MESSAGING_THROTTLE = {
  send: { limit: budget('THROTTLE_MESSAGE', 60), ttl: MINUTE },
} as const;
