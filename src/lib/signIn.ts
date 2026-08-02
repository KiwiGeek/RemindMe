import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getDb } from '~/db/client';
import { type User, users } from '~/db/schema';
import type { Env } from '~/env';
import type { AppConfig } from '~/lib/config';
import { signSession, writeSessionCookie } from '~/lib/session';
import { clearSuppressionForEmail } from '~/lib/suppression';
import { getKv } from '~/platform/getKv';

function otpKvKey(email: string): string {
  return `otp:${email}`;
}

/**
 * Shared post-proof sign-in: create or reactivate the user, clear suppression,
 * issue a session cookie. Used by OTP code verify and OTP email login links.
 */
export async function signInAfterEmailProof(
  env: Env,
  c: Context,
  email: string,
  opts: { sessionSecret: string; registrationMode: AppConfig['registrationMode'] },
): Promise<User | null | 'registration_closed'> {
  const db = getDb(env);
  const kv = getKv(env);
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existing[0];
  if (!user) {
    if (opts.registrationMode === 'closed') {
      return 'registration_closed';
    }
    const inserted = await db.insert(users).values({ email }).returning();
    user = inserted[0];
  } else if (user.status === 'suspended') {
    await db.update(users).set({ status: 'active' }).where(eq(users.id, user.id));
    user = { ...user, status: 'active' };
  }

  if (!user) return null;

  const { syncLegacyAdmins } = await import('~/lib/config');
  await syncLegacyAdmins(env, db);
  const fresh = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
  if (fresh) user = fresh;

  await clearSuppressionForEmail(env, email);
  await kv.delete(otpKvKey(email));

  const token = await signSession(opts.sessionSecret, user.id);
  writeSessionCookie(c, token);

  return user;
}
