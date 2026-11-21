// Resend in memory, for the tests of codes by email (test/email-codes.test.js). installFakeResend() points the
// runtime's fetch at it for requests to api.resend.com and lets every other request through, so no test reaches the
// real Resend. The Worker, the Durable Objects and the tests share one isolate, so the server's own requests reach it.
// It checks the key and the fields Resend needs, keeps every message it took, and answers with status when that is
// set to an error.

export const RESEND_ORIGIN = 'https://api.resend.com';

// The settings that turn mail on, as the Worker reads them. Neither is a credential.
export const MAIL_VARS = { RESEND_API_KEY: 're_test_not_a_real_key', MAIL_FROM: 'Rukoo test <codes@example.com>' };

export class FakeResend {
  constructor() {
    this.sent = [];
    this.status = 200;
  }

  async handle(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/emails') {
      return Response.json({ name: 'not_found' }, { status: 404 });
    }
    if (request.headers.get('authorization') !== `Bearer ${MAIL_VARS.RESEND_API_KEY}`) {
      return Response.json({ statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }, { status: 401 });
    }
    const body = await request.json();
    const complete =
      typeof body.from === 'string' &&
      Array.isArray(body.to) &&
      body.to.length === 1 &&
      typeof body.subject === 'string' &&
      typeof body.text === 'string' &&
      typeof body.html === 'string';
    if (!complete) return Response.json({ statusCode: 422, name: 'validation_error', message: 'Invalid body' }, { status: 422 });
    if (this.status !== 200) {
      // Resend's errors can name the recipient; the server must not log this message.
      return Response.json({ statusCode: this.status, name: 'application_error', message: `Could not send to ${body.to[0]}` }, { status: this.status });
    }
    this.sent.push(body);
    return Response.json({ id: crypto.randomUUID() });
  }

  to(address) {
    return this.sent.filter((message) => message.to.includes(address));
  }

  // The six digits in the last message to an address, or null.
  code(address) {
    const last = this.to(address).at(-1);
    return last?.text.match(/^\d{6}$/m)?.[0] ?? null;
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
