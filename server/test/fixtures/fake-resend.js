// Resend in memory, for the tests of codes by email (test/email-codes.test.js). installFakeResend() points the
// runtime's fetch at it for requests to api.resend.com and lets every other request through, so no test reaches the
// real Resend. The Worker, the Durable Objects and the tests share one isolate, so the server's own requests reach it.
// It checks the key and the fields Resend needs and keeps every message it took. status set to an error fails every
// request; failNext() fails only the next ones, the way Resend answers its own limits.

export const RESEND_ORIGIN = 'https://api.resend.com';

// The settings that turn mail on, as the Worker reads them. Neither is a credential.
export const MAIL_VARS = { RESEND_API_KEY: 're_test_not_a_real_key', MAIL_FROM: 'Rukoo test <codes@example.com>' };

export class FakeResend {
  constructor() {
    this.reset();
  }

  reset() {
    this.sent = [];
    this.status = 200;
    this.queue = [];
    // The Idempotency-Key of every request, also the ones that failed.
    this.keys = [];
  }

  // The next answers, in order: { status, name, retryAfter } each.
  failNext(...answers) {
    this.queue.push(...answers);
  }

  async handle(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/emails') {
      return Response.json({ name: 'not_found' }, { status: 404 });
    }
    if (request.headers.get('authorization') !== `Bearer ${MAIL_VARS.RESEND_API_KEY}`) {
      return Response.json({ statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }, { status: 401 });
    }
    this.keys.push(request.headers.get('idempotency-key'));
    const body = await request.json();
    const complete =
      typeof body.from === 'string' &&
      Array.isArray(body.to) &&
      body.to.length === 1 &&
      typeof body.subject === 'string' &&
      typeof body.text === 'string' &&
      typeof body.html === 'string';
    if (!complete) return Response.json({ statusCode: 422, name: 'validation_error', message: 'Invalid body' }, { status: 422 });
    const failure = this.queue.shift() ?? (this.status !== 200 ? { status: this.status, name: 'application_error' } : null);
    if (failure) {
      const headers = failure.retryAfter === undefined ? {} : { 'retry-after': String(failure.retryAfter) };
      // Resend's errors can name the recipient; the server must not log this message.
      return Response.json(
        { statusCode: failure.status, name: failure.name, message: `Could not send to ${body.to[0]}` },
        { status: failure.status, headers }
      );
    }
    this.sent.push(body);
    return Response.json({ id: crypto.randomUUID() });
  }

  to(address) {
    return this.sent.filter((message) => message.to.includes(address));
  }

  // The six digits in the last message to an address, or null.
  code(address) {
    return this.to(address).at(-1)?.text.match(/^\d{6}$/m)?.[0] ?? null;
  }

  // The long code in the last message to an address, or null.
  token(address) {
    return this.to(address).at(-1)?.text.match(/^[A-Za-z0-9_-]{43}$/m)?.[0] ?? null;
  }
}

export function installFakeResend(fake) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(address).origin === RESEND_ORIGIN) return fake.handle(new Request(input, init));
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}
