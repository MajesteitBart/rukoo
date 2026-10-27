import { describe, expect, it } from 'vitest';
import { LIMIT_MESSAGES } from '../src/api.js';
import { LANGUAGES, TEXT, html, params, text } from '../src/booking-text.js';
import { LOCATION_KINDS } from '../src/input.js';

describe('booking-text', () => {
  it('has the same keys with the same placeholders in English and Dutch', () => {
    expect(LANGUAGES).toEqual(['en', 'nl']);
    const en = Object.keys(TEXT.en).sort();
    expect(Object.keys(TEXT.nl).sort()).toEqual(en);
    for (const key of en) {
      expect(params(TEXT.nl[key]), key).toEqual(params(TEXT.en[key]));
      for (const lang of LANGUAGES) expect(TEXT[lang][key].trim(), `${lang} ${key}`).not.toBe('');
    }
  });

  it('is Dutch where it should be, not English copied over', () => {
    // A few names are the same in both languages; everything else must differ.
    const same = Object.keys(TEXT.en).filter((k) => TEXT.en[k] === TEXT.nl[k]);
    expect(same.sort()).toEqual(['form.utc', 'page.privacy', 'type.location.googleMeet', 'type.minutes']);
  });

  it('has a text for every limit, location kind and booking status the server can give', () => {
    for (const limit of Object.keys(LIMIT_MESSAGES)) expect(TEXT.en[`error.limit.${limit}`], limit).toBeDefined();
    expect(Object.keys(LIMIT_MESSAGES)).toContain('stale');
    for (const kind of LOCATION_KINDS.filter((k) => k !== 'none')) expect(TEXT.en[`type.location.${kind}`], kind).toBeDefined();
    for (const status of ['confirmed', 'pending', 'cancelled', 'declined', 'expired']) expect(TEXT.en[`manage.status.${status}`]).toBeDefined();
  });

  it('fills in values as text, and escapes its own text but not the values in html()', () => {
    expect(text('nl', 'off.host', { host: 'Bart' })).toBe('Bart neemt via deze pagina nu geen afspraken aan.');
    expect(text('en', 'off.host', {})).toBe('{host} isn’t taking bookings through this page right now.');
    expect(text('xx', 'booker.change')).toBe('Change');
    expect(() => text('en', 'no.such.key')).toThrow();
    expect(html('en', 'page.moved', { url: '<a href="/x">/x</a>' })).toBe('This page moved to <a href="/x">/x</a>.');
    expect(html('en', 'form.privacy', { host: '&lt;b&gt;', operator: 'Op' })).toContain('go to &lt;b&gt;. Op keeps');
  });
});
