import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getDb } from '~/db/client';
import { type User, users } from '~/db/schema';
import type { Env } from '~/env';
import { signSession, writeSessionCookie } from '~/lib/session';
import { clearSuppressionForEmail } from '~/lib/suppression';

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
): Promise<User | null> {
  const db = getDb(env);
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existing[0];
  if (!user) {
    const inserted = await db.insert(users).values({ email }).returning();
    user = inserted[0];
  } else if (user.status === 'suspended') {
    await db.update(users).set({ status: 'active' }).where(eq(users.id, user.id));
    user = { ...user, status: 'active' };
  }

  if (!user) return null;

  await clearSuppressionForEmail(env, email);
  await env.KV.delete(otpKvKey(email));

  const token = await signSession(env.SESSION_SECRET, user.id);
  writeSessionCookie(c, token);

  return user;
}
