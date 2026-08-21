/**
 * Custom alias rules.
 *
 * An alias occupies the root path namespace (`/docs` is both a plausible alias
 * and a plausible route), so the reserved list is a routing-correctness
 * concern, not a branding one: without it a user could shadow `/api` or
 * `/health` and break the service for everyone.
 */

import { AppError } from './errors.js';

export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 32;

const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Paths the router owns, plus names that would be confusing or abusable as a
 * short link. Matching is case-insensitive because the path namespace is.
 */
export const RESERVED_ALIASES = new Set([
  'api',
  'health',
  'healthz',
  'ready',
  'readyz',
  'live',
  'metrics',
  'admin',
  'static',
  'assets',
  'public',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'account',
  'settings',
  'dashboard',
  'docs',
  'doc',
  'help',
  'support',
  'about',
  'terms',
  'privacy',
  'security',
  'status',
  'null',
  'undefined',
  'new',
  'edit',
  'delete',
]);

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias.toLowerCase());
}

/**
 * Validate a user-supplied alias. Returns it unchanged on success — case is
 * preserved, because short codes are case-sensitive and `/aB` must not collide
 * with `/Ab`.
 */
export function validateAlias(alias: string): string {
  const value = alias.trim();

  if (value.length < ALIAS_MIN_LENGTH || value.length > ALIAS_MAX_LENGTH) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Alias must be between ${ALIAS_MIN_LENGTH} and ${ALIAS_MAX_LENGTH} characters`,
    );
  }

  if (!ALIAS_PATTERN.test(value)) {
    throw new AppError('VALIDATION_FAILED', 'Alias may contain only letters, digits, hyphens, and underscores');
  }

  if (isReservedAlias(value)) {
    throw new AppError('RESERVED_ALIAS', `Alias "${value}" is reserved`, {
      details: { alias: value },
    });
  }

  return value;
}

/** Shape check for a code arriving on the redirect path — cheap rejection before any I/O. */
export function isPlausibleCode(code: string): boolean {
  return (
    code.length > 0 &&
    code.length <= ALIAS_MAX_LENGTH &&
    ALIAS_PATTERN.test(code) &&
    !isReservedAlias(code)
  );
}
