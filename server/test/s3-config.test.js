// Which file store a server uses (src/filestore.js): the R2 binding when there is one, else S3 with all five
// WORKSPACE_FILES_S3_* settings, else none. Some of the S3 settings without the rest leave files off and log one error
// that names the missing settings and none of the values.

import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3_SETTINGS, fileStore, s3Settings } from '../src/filestore.js';
import { FAKE_S3, s3Vars } from './fixtures/fake-s3.js';
import { api, askDownload, fileRequest, newWorkspace, reserve } from './workspace-helpers.js';

const VALUES = Object.values(s3Vars());
const without = (...names) => Object.fromEntries(Object.entries(s3Vars()).map(([name, value]) => [name, names.includes(name) ? '' : value]));
const fakeR2 = { put() {}, get() {}, delete() {}, list() {} };

afterEach(() => vi.restoreAllMocks());

describe('choosing the store', () => {
  it('uses S3 with all five settings, R2 when the binding is there as well, and none without either', () => {
    expect(fileStore(s3Vars()).batch).toBe(40);
    expect(fileStore({ ...s3Vars(), WORKSPACE_FILES: fakeR2 }).batch).toBe(1000);
    expect(fileStore({ WORKSPACE_FILES: fakeR2 }).batch).toBe(1000);
    expect(fileStore({})).toBeNull();
    expect(fileStore(without(...S3_SETTINGS))).toBeNull();
    expect(s3Settings({})).toEqual({});
  });

  it('turns files off with part of the S3 settings, and logs one error naming what is missing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const partial = without('WORKSPACE_FILES_S3_SECRET_ACCESS_KEY');
    expect(fileStore(partial)).toBeNull();
    expect(fileStore(partial)).toBeNull();
    expect(fileStore(partial)).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    const [message] = errors.mock.calls[0];
    expect(message).toBe(
      'Files in team chat are off: an S3 store needs all five WORKSPACE_FILES_S3_* settings, and WORKSPACE_FILES_S3_SECRET_ACCESS_KEY is not set.'
    );
    for (const value of VALUES) expect(message).not.toContain(value);

    const two = without('WORKSPACE_FILES_S3_ENDPOINT', 'WORKSPACE_FILES_S3_ACCESS_KEY_ID');
    expect(fileStore(two)).toBeNull();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[1][0]).toContain('WORKSPACE_FILES_S3_ENDPOINT and WORKSPACE_FILES_S3_ACCESS_KEY_ID are not set');
    // Blank counts as missing.
    expect(s3Settings({ ...s3Vars(), WORKSPACE_FILES_S3_REGION: '   ' }).problem).toContain('WORKSPACE_FILES_S3_REGION is not set');
    // With the binding there, R2 is used and nothing is logged.
    expect(fileStore({ ...partial, WORKSPACE_FILES: fakeR2 }).batch).toBe(1000);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('turns files off for an endpoint, bucket or region that is no such thing, without saying the value', () => {
    const problem = (vars) => s3Settings({ ...s3Vars(), ...vars }).problem;
    const endpoint = 'WORKSPACE_FILES_S3_ENDPOINT must be an https address';
    expect(problem({ WORKSPACE_FILES_S3_ENDPOINT: 'http://objects.example.com' })).toContain(endpoint);
    expect(problem({ WORKSPACE_FILES_S3_ENDPOINT: 'https://objects.example.com/?x=1' })).toContain(endpoint);
    expect(problem({ WORKSPACE_FILES_S3_ENDPOINT: 'https://user:pass@objects.example.com' })).toContain(endpoint);
    expect(problem({ WORKSPACE_FILES_S3_ENDPOINT: 'objects.example.com' })).toContain(endpoint);
    expect(problem({ WORKSPACE_FILES_S3_BUCKET: 'Has_Capitals' })).toContain('WORKSPACE_FILES_S3_BUCKET');
    expect(problem({ WORKSPACE_FILES_S3_REGION: 'eu west' })).toContain('WORKSPACE_FILES_S3_REGION');
    expect(problem({ WORKSPACE_FILES_S3_ENDPOINT: 'http://storage.private.test' })).not.toContain('storage.private.test');
    // A local stand-in may use http; a path on the endpoint goes in front of the bucket.
    expect(s3Settings({ ...s3Vars(), WORKSPACE_FILES_S3_ENDPOINT: 'http://127.0.0.1:9000' }).settings).toMatchObject({ origin: 'http://127.0.0.1:9000', basePath: '' });
    expect(s3Settings({ ...s3Vars(), WORKSPACE_FILES_S3_ENDPOINT: 'https://objects.example.com/s3/' }).settings).toMatchObject({ host: 'objects.example.com', basePath: '/s3' });
    expect(s3Settings({ ...s3Vars(), WORKSPACE_FILES_S3_ENDPOINT: FAKE_S3.endpoint }).settings.bucket).toBe(FAKE_S3.bucket);
  });
});

describe('a server with part of the S3 settings', () => {
  it('offers no files and answers files_off on the file routes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(env.WORKSPACE_FILES).toBeUndefined();
    const OFF = { WORKSPACE_FILES_S3_SECRET_ACCESS_KEY: '' };
    const info = await api('GET', '/v1/info', { vars: OFF });
    expect(info.body.workspace.capabilities).not.toContain('files');
    expect(info.body.workspace).not.toHaveProperty('files');
    expect((await api('GET', '/v1/info')).body.workspace.capabilities).toContain('files');

    const ws = await newWorkspace();
    const res = await reserve(ws.person, ws.id, ws.general, {}, OFF);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('files_off');
    // A link made while files were on leads nowhere once they are off.
    const reserved = (await reserve(ws.person, ws.id, ws.general)).body;
    const off = async (pending) => {
      const answer = await pending;
      expect(answer.status).toBe(403);
      expect(answer.body.error).toBe('files_off');
    };
    await off(fileRequest(reserved.put.url, { method: 'PUT', body: new TextEncoder().encode('hello'), vars: OFF }));
    await off(askDownload(ws.person, ws.id, ws.general, reserved.upload.id, OFF));
  });
});
