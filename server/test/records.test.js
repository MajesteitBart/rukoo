import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toBase64url } from '../src/bytes.js';
import { accountStub, call, pull, push, recordId, sealed, sealedBytes, signup } from './helpers.js';

function many(count, length = 40) {
  return Array.from({ length: count }, () => ({ id: recordId(), data: sealed(length) }));
}

async function usage(person) {
  return (await call('GET', '/v1/account', { token: person.token })).body.usage;
}

describe('pushing and pulling', () => {
  it('starts empty', async () => {
    const person = await signup();
    const res = await pull(person.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], seq: 0, more: false });
  });

  it('stores records with rising seqs and returns them oldest first', async () => {
    const person = await signup();
    const records = many(3);
    const res = await push(person.token, records);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: records.map((r, i) => ({ id: r.id, seq: i + 1, stored: true })),
      seq: 3
    });
    const pulled = await pull(person.token);
    expect(pulled.body).toEqual({
      records: records.map((r, i) => ({ id: r.id, seq: i + 1, data: r.data })),
      seq: 3,
      more: false
    });
    expect(await usage(person)).toEqual({ records: 3, bytes: 120 });

    const since = await pull(person.token, '?since=2');
    expect(since.body.records.map((r) => r.id)).toEqual([records[2].id]);
    expect(since.body.seq).toBe(3);
  });

  it('keeps each account to itself', async () => {
    const one = await signup();
    const two = await signup();
    await push(one.token, many(2));
    expect((await pull(two.token)).body).toEqual({ records: [], seq: 0, more: false });
  });

  it('replaces a record under the same id with a new seq', async () => {
    const person = await signup();
    const id = recordId();
    await push(person.token, [{ id, data: sealed(50) }, ...many(1)]);
    const next = sealed(80);
    const res = await push(person.token, [{ id, data: next }]);
    expect(res.body).toEqual({ results: [{ id, seq: 3, stored: true }], seq: 3 });
    const all = await pull(person.token);
    expect(all.body.records.map((r) => [r.id, r.seq])).toEqual([
      [all.body.records[0].id, 2],
      [id, 3]
    ]);
    expect(all.body.records[1].data).toBe(next);
    expect(await usage(person)).toEqual({ records: 2, bytes: 120 });
  });

  it('pages with more until every record has come', async () => {
    const person = await signup();
    await push(person.token, many(25));
    const seen = [];
    let since = 0;
    let more = true;
    let pages = 0;
    while (more) {
      const res = await pull(person.token, `?since=${since}&limit=10`);
      expect(res.body.seq).toBe(25);
      seen.push(...res.body.records.map((r) => r.seq));
      more = res.body.more;
      since = res.body.records.at(-1)?.seq ?? since;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('returns at most 1000 records a page, also when asked for more', async () => {
    const person = await signup();
    for (let i = 0; i < 3; i++) await push(person.token, many(i < 2 ? 500 : 1, 29));
    const first = await pull(person.token, '?limit=5000');
    expect(first.body.records).toHaveLength(1000);
    expect(first.body.more).toBe(true);
    const byDefault = await pull(person.token);
    expect(byDefault.body.records).toHaveLength(1000);
    const rest = await pull(person.token, `?since=${first.body.records.at(-1).seq}`);
    expect(rest.body.records).toHaveLength(1);
    expect(rest.body.more).toBe(false);
  });

  it('stops a page early when it would hold too much data', async () => {
    const person = await signup();
    // 400 records of 16 KiB are 6.4 MiB, more than one page holds.
    for (let i = 0; i < 2; i++) await push(person.token, many(200, 16384));
    const first = await pull(person.token);
    expect(first.body.more).toBe(true);
    expect(first.body.records.length).toBeLessThan(400);
    const rest = await pull(person.token, `?since=${first.body.records.at(-1).seq}`);
    expect(first.body.records.length + rest.body.records.length).toBe(400);
    expect(rest.body.more).toBe(false);
  });
});

describe('ifAbsent', () => {
  it('stores only when there is no live record, and reports the one kept', async () => {
    const person = await signup();
    const id = recordId();
    const first = sealed();
    const stored = await push(person.token, [{ id, data: first, ifAbsent: true }]);
    expect(stored.body.results).toEqual([{ id, seq: 1, stored: true }]);

    const refused = await push(person.token, [{ id, data: sealed(), ifAbsent: true }, ...many(1)]);
    expect(refused.body.results[0]).toEqual({ id, seq: 1, stored: false });
    expect(refused.body.results[1].seq).toBe(2);
    expect(refused.body.seq).toBe(2);
    expect((await pull(person.token)).body.records[0].data).toBe(first);

    // A deleted record is not live, so ifAbsent writes over its tombstone.
    await push(person.token, [{ id, data: null }]);
    const again = sealed();
    const revived = await push(person.token, [{ id, data: again, ifAbsent: true }]);
    expect(revived.body.results).toEqual([{ id, seq: 4, stored: true }]);
    expect((await pull(person.token, '?since=3')).body.records).toEqual([{ id, seq: 4, data: again }]);
  });

  it('applies within one push too', async () => {
    const person = await signup();
    const id = recordId();
    const res = await push(person.token, [
      { id, data: sealed(), ifAbsent: true },
      { id, data: sealed(), ifAbsent: true }
    ]);
    expect(res.body.results).toEqual([
      { id, seq: 1, stored: true },
      { id, seq: 1, stored: false }
    ]);
  });
});

describe('tombstones', () => {
  it('keeps a deleted record as a tombstone with a new seq so other devices learn of it', async () => {
    const person = await signup();
    const [a, b] = many(2, 100);
    await push(person.token, [a, b]);
    const res = await push(person.token, [{ id: a.id, data: null }]);
    expect(res.body).toEqual({ results: [{ id: a.id, seq: 3, stored: true }], seq: 3 });

    const later = await pull(person.token, '?since=2');
    expect(later.body.records).toEqual([{ id: a.id, seq: 3, data: null }]);
    const all = await pull(person.token);
    expect(all.body.records.map((r) => [r.id, r.data === null])).toEqual([
      [b.id, false],
      [a.id, true]
    ]);
    expect(await usage(person)).toEqual({ records: 1, bytes: 100 });
  });
});

describe('deleting nothing', () => {
  it('stores no row and takes no seq for an id that was never stored or is already deleted', async () => {
    const person = await signup();
    const [a] = many(1);
    await push(person.token, [a]);
    await push(person.token, [{ id: a.id, data: null }]);
    const unknown = recordId();
    const res = await push(person.token, [
      { id: unknown, data: null },
      { id: a.id, data: null }
    ]);
    expect(res.body).toEqual({
      results: [
        { id: unknown, seq: 2, stored: true },
        { id: a.id, seq: 2, stored: true }
      ],
      seq: 2
    });
    expect((await pull(person.token)).body.records).toEqual([{ id: a.id, seq: 2, data: null }]);
  });
});

describe('limits', () => {
  it('refuses a push that would go over the record quota, storing none of it', async () => {
    const person = await signup();
    const vars = { MAX_RECORDS: 3 };
    expect((await push(person.token, many(2), vars)).status).toBe(200);
    const res = await push(person.token, many(2), vars);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('quota');
    expect((await pull(person.token)).body.seq).toBe(2);
    expect(await usage(person)).toEqual({ records: 2, bytes: 80 });

    // Deleting in the same push makes room.
    const first = (await pull(person.token)).body.records[0];
    const swap = await push(person.token, [{ id: first.id, data: null }, ...many(2)], vars);
    expect(swap.status).toBe(200);
    expect(await usage(person)).toEqual({ records: 3, bytes: 120 });
  });

  it('refuses a push that would go over the byte quota', async () => {
    const person = await signup();
    const vars = { MAX_BYTES: 100 };
    expect((await push(person.token, many(1, 60), vars)).status).toBe(200);
    const res = await push(person.token, many(1, 60), vars);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('quota');
    // Replacing a record with a smaller one is fine.
    const [record] = (await pull(person.token)).body.records;
    expect((await push(person.token, [{ id: record.id, data: sealed(30) }], vars)).status).toBe(200);
  });

  it('lets an account over its quota delete and shrink records', async () => {
    const person = await signup();
    await push(person.token, many(5));
    const ids = (await pull(person.token)).body.records.map((r) => r.id);
    const vars = { MAX_RECORDS: 2 };
    expect((await push(person.token, [{ id: ids[0], data: null }], vars)).status).toBe(200);
    expect((await push(person.token, [{ id: ids[1], data: sealed(29) }], vars)).status).toBe(200);
    expect((await push(person.token, many(1), vars)).status).toBe(413);
  });

  it('limits tombstones to as many as records', async () => {
    const person = await signup();
    const vars = { MAX_RECORDS: 3 };
    const records = many(3);
    await push(person.token, records, vars);
    // Three deletes make three tombstones: at the limit, still fine.
    expect((await push(person.token, records.map((r) => ({ id: r.id, data: null })), vars)).status).toBe(200);
    // A fourth record and its delete would make a fourth tombstone.
    const [extra] = many(1);
    expect((await push(person.token, [extra], vars)).status).toBe(200);
    const res = await push(person.token, [{ id: extra.id, data: null }], vars);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('quota');
    // Bringing a deleted record back frees its tombstone.
    expect((await push(person.token, [{ id: records[0].id, data: sealed() }], vars)).status).toBe(200);
    expect((await push(person.token, [{ id: extra.id, data: null }], vars)).status).toBe(200);
  });

  it('takes records up to 16 KiB and refuses bigger ones', async () => {
    const person = await signup();
    const largest = toBase64url(sealedBytes(16384));
    expect((await push(person.token, [{ id: recordId(), data: largest }])).status).toBe(200);
    const res = await push(person.token, [{ id: recordId(), data: toBase64url(sealedBytes(16385)) }]);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_large');
  });

  it('takes 500 records in one push and refuses 501', async () => {
    const person = await signup();
    expect((await push(person.token, many(500, 29))).status).toBe(200);
    const res = await push(person.token, many(501, 29));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_large');
    expect((await pull(person.token, '?limit=1')).body.seq).toBe(500);
  });
});

describe('malformed pushes and pulls', () => {
  it('refuses records that are not well formed, storing none of the push', async () => {
    const person = await signup();
    const good = many(1)[0];
    const bad = [
      { id: recordId().slice(1), data: sealed() },
      { id: `${recordId()}A`, data: sealed() },
      { id: recordId().replace(/^./, '+'), data: sealed() },
      { id: toBase64url(new Uint8Array(32)).replace(/A$/, 'B'), data: sealed() },
      { id: 42, data: sealed() },
      { id: recordId() },
      { id: recordId(), data: 12 },
      { id: recordId(), data: toBase64url(Uint8Array.from([2, ...new Uint8Array(40)])) },
      { id: recordId(), data: sealed(28) },
      { id: recordId(), data: `${sealed()}=` },
      { id: recordId(), data: sealed(), ifAbsent: 'yes' },
      'record'
    ];
    for (const record of bad) {
      const res = await push(person.token, [good, record]);
      expect(res.status, JSON.stringify(record)).toBe(400);
      expect(res.body.error).toBe('invalid');
    }
    for (const body of [{}, { records: 'all' }, { records: { id: recordId() } }]) {
      const res = await call('POST', '/v1/records', { token: person.token, body });
      expect(res.status).toBe(400);
    }
    expect((await pull(person.token)).body.seq).toBe(0);
  });

  it('takes an empty push', async () => {
    const person = await signup();
    expect((await push(person.token, [])).body).toEqual({ results: [], seq: 0 });
  });

  it('refuses a bad since or limit', async () => {
    const person = await signup();
    for (const query of [
      '?since=-1',
      '?since=abc',
      '?since=1.5',
      '?limit=0',
      '?limit=ten',
      '?since=99999999999999999'
    ]) {
      const res = await pull(person.token, query);
      expect(res.status, query).toBe(400);
      expect(res.body.error).toBe('invalid');
    }
  });

  it('needs a session', async () => {
    expect((await call('GET', '/v1/records')).status).toBe(401);
    expect((await call('POST', '/v1/records', { body: { records: [] } })).status).toBe(401);
  });
});

describe('counters', () => {
  it('match the records table after a mix of writes', async () => {
    const person = await signup();
    const records = many(10, 64);
    await push(person.token, records);
    await push(person.token, [
      { id: records[0].id, data: null },
      { id: records[1].id, data: sealed(200) },
      { id: records[2].id, data: null },
      { id: records[2].id, data: sealed(31) },
      { id: recordId(), data: null },
      { id: records[3].id, data: sealed(), ifAbsent: true }
    ]);
    const { counted, meta, tombstones } = await runInDurableObject(await accountStub(person.email), (instance, state) => ({
      counted: state.storage.sql
        .exec(
          'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(data)), 0) AS bytes, MAX(seq) AS seq FROM records WHERE data IS NOT NULL'
        )
        .one(),
      meta: state.storage.sql.exec('SELECT seq, records, bytes, tombstones FROM meta').one(),
      tombstones: state.storage.sql.exec('SELECT COUNT(*) AS n FROM records WHERE data IS NULL').one().n
    }));
    expect(meta.records).toBe(counted.records);
    expect(meta.bytes).toBe(counted.bytes);
    expect(meta.records).toBe(9);
    expect(meta.bytes).toBe(64 * 7 + 200 + 31);
    // The delete of an id that was never stored took no seq.
    expect(meta.seq).toBe(14);
    expect(meta.tombstones).toBe(1);
    expect(tombstones).toBe(1);
    expect(await usage(person)).toEqual({ records: 9, bytes: 64 * 7 + 200 + 31 });
  });
});

describe('upgrading', () => {
  it('counts the tombstones of an account made before they were counted, and serves it as before', async () => {
    const person = await signup();
    const records = many(3);
    await push(person.token, records);
    await push(person.token, [{ id: records[0].id, data: null }]);
    // The tables as the first version made them: no tombstones column.
    await runInDurableObject(await accountStub(person.email), (instance, state) => {
      state.storage.sql.exec('ALTER TABLE meta DROP COLUMN tombstones');
      instance.migrate();
      instance.migrate();
      expect(state.storage.sql.exec('SELECT tombstones FROM meta').one().tombstones).toBe(1);
    });
    const pulled = await pull(person.token);
    expect(pulled.status).toBe(200);
    expect(pulled.body.records).toHaveLength(3);
    expect((await push(person.token, [{ id: records[1].id, data: null }])).status).toBe(200);
    expect(await usage(person)).toEqual({ records: 1, bytes: 40 });
  });
});
