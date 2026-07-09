/**
 * RB-BOX uses synthetic emails so Supabase Auth works with just a username.
 * The user never sees or types the email.
 */

const DOMAIN =
  process.env.NEXT_PUBLIC_SYNTHETIC_EMAIL_DOMAIN || 'rbbox.local';

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${DOMAIN}`;
}

export function emailToUsername(email: string): string {
  return email.split('@')[0];
}

export function isValidUsername(u: string): boolean {
  // 3–32 chars, lowercase letters/numbers/dot/underscore/dash
  return /^[a-z0-9._-]{3,32}$/.test(u);
}
