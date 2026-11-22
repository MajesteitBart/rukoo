// The lock on sign-ins and recovery (PROTOCOL.md, POST /v1/login): ten failed attempts with an address within 15
// minutes of the first lock that address for 15 minutes. The registry keeps it (Registry.lockAttempt), under a hash of
// the address made with PEPPER, whether or not the address has an account. A lock kept by the account itself would only
// ever answer 429 for an address with an account, which told anyone who tried ten wrong passwords that it had one.
//
// It counts what it locks the same as before: one address, as typed, which is also the one account it can hold. Each
// attempt is let in before the account compares the password, and attempts still running count toward the ten, so
// attempts sent at once get no more than ten tries between them. Only wrong ones start the lock, and one whose client
// goes away counts as wrong after a minute. A right one resets the count, as it always did.
//
// A server without the registry binding leaves the lock to the account, as before (account.js, #check).

import { hmac, toBase64url } from './bytes.js';
import { registryObject } from './config.js';

const MINUTE = 60 * 1000;
export const LOCK_RULES = { max: 10, window: 15 * MINUTE, lockTime: 15 * MINUTE };

// Runs a sign-in or recovery attempt under the lock. run gets the options the account object takes: unlocked, so it
// leaves its own lock alone. Answers what run answered, or 429 locked while the address is locked and for the attempt
// that locks it.
export async function guarded(env, email, run) {
  const registry = registryObject(env);
  if (!registry) return run({});
  const address = toBase64url(await hmac(env.PEPPER, `sign-in lock\n${email}`));
  const attempt = await registry.lockAttempt(address, LOCK_RULES);
  if (attempt.result === 'locked') return locked(attempt.retryAfter);
  const result = await run({ unlocked: true });
  // Anything but a right or a wrong secret, such as an error, stays running, and counts as wrong once a minute is up,
  // like an attempt that never came back.
  if (result?.status !== 200 && result?.status !== 401) return result;
  const settled = await registry.lockSettle(address, attempt.ticket, result.status === 200, LOCK_RULES);
  return settled.result === 'locked' ? locked(settled.retryAfter) : result;
}

// The same answer the account object gives while it is locked (account.js, locked).
function locked(retryAfter) {
  return {
    status: 429,
    body: { error: 'locked', message: 'Too many failed attempts. Try again later.' },
    headers: { 'retry-after': String(retryAfter) }
  };
}
