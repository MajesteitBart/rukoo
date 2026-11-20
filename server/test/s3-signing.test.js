// AWS Signature Version 4 (src/sigv4.js) against fixed vectors. The first three are the examples in AWS's S3
// documentation ("Signature Calculations for the Authorization Header", example key AKIAIOSFODNN7EXAMPLE); the last two
// are path-style requests as the S3 store sends them. Every canonical request, string to sign and signature here was
// computed apart from this code, with Node's crypto module, and the three AWS signatures match the ones AWS publishes.

import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, amzDate, canonicalQuery, encodeRfc3986, sign } from '../src/sigv4.js';

const AWS = {
  host: 'examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  time: Date.parse('2013-05-24T00:00:00Z')
};

// Stand-ins, not credentials.
const PATH_STYLE = {
  host: 'objects.example.test',
  region: 'europe-2',
  accessKeyId: 'TESTACCESSKEYID0001',
  secretAccessKey: 'test-secret-access-key-not-real-0001',
  time: Date.parse('2026-11-20T09:30:00Z')
};

const lines = (...parts) => parts.join('\n');

describe('Signature Version 4', () => {
  it('signs a GET of an object with a Range header', async () => {
    const signed = await sign({ ...AWS, method: 'GET', path: '/test.txt', headers: { Range: 'bytes=0-9' } });
    expect(signed.canonicalRequest).toBe(
      lines(
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256
      )
    );
    expect(signed.stringToSign).toBe(
      lines('AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972')
    );
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(signed.headers).toEqual({
      range: 'bytes=0-9',
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY_SHA256,
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    });
  });

  it('signs a PUT with its payload hash and a key that needs encoding', async () => {
    const payloadHash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const signed = await sign({
      ...AWS,
      method: 'PUT',
      path: `/${encodeRfc3986('test$file.text')}`,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash
    });
    expect(signed.canonicalRequest).toBe(
      lines(
        'PUT',
        '/test%24file.text',
        '',
        'date:Fri, 24 May 2013 00:00:00 GMT',
        'host:examplebucket.s3.amazonaws.com',
        `x-amz-content-sha256:${payloadHash}`,
        'x-amz-date:20130524T000000Z',
        'x-amz-storage-class:REDUCED_REDUNDANCY',
        '',
        'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
        payloadHash
      )
    );
    expect(signed.stringToSign).toBe(
      lines('AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d')
    );
    expect(signed.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('signs a listing with its query sorted and encoded', async () => {
    const signed = await sign({ ...AWS, method: 'GET', path: '/', query: [['prefix', 'J'], ['max-keys', '2']] });
    expect(signed.query).toBe('max-keys=2&prefix=J');
    expect(signed.stringToSign).toBe(
      lines('AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', 'df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7')
    );
    expect(signed.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('signs a path-style PUT of a file with its name as metadata', async () => {
    const payloadHash = '117daa58eef0fdcd88aecdba71267cd32855370e1a58cb3908e32752fa902e1a';
    const signed = await sign({
      ...PATH_STYLE,
      method: 'PUT',
      path: `/rukoo-test-bucket/ws/W1/${encodeRfc3986('résumé (1).txt')}`,
      headers: { 'content-type': 'text/plain', 'x-amz-meta-name': encodeURIComponent('résumé (1).txt') },
      payloadHash
    });
    expect(signed.canonicalRequest).toBe(
      lines(
        'PUT',
        '/rukoo-test-bucket/ws/W1/r%C3%A9sum%C3%A9%20%281%29.txt',
        '',
        'content-type:text/plain',
        'host:objects.example.test',
        `x-amz-content-sha256:${payloadHash}`,
        'x-amz-date:20261120T093000Z',
        'x-amz-meta-name:r%C3%A9sum%C3%A9%20(1).txt',
        '',
        'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-name',
        payloadHash
      )
    );
    expect(signed.stringToSign).toBe(
      lines('AWS4-HMAC-SHA256', '20261120T093000Z', '20261120/europe-2/s3/aws4_request', '4d330467042a8742bb22bfef743c2b622cef2e0f2fea6e2dd1e636ed145b30f6')
    );
    expect(signed.signature).toBe('b6610ada8476ce6143db5d69ea86e4720046ddc9a0174e6bb3c1624d812a0a3d');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=TESTACCESSKEYID0001/20261120/europe-2/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-name, Signature=b6610ada8476ce6143db5d69ea86e4720046ddc9a0174e6bb3c1624d812a0a3d'
    );
  });

  it('signs a path-style ListObjectsV2 page with a continuation token', async () => {
    const signed = await sign({
      ...PATH_STYLE,
      method: 'GET',
      path: '/rukoo-test-bucket',
      query: [
        ['list-type', '2'],
        ['prefix', 'ws/W1/'],
        ['max-keys', '2'],
        ['continuation-token', '1/abc==']
      ]
    });
    expect(signed.query).toBe('continuation-token=1%2Fabc%3D%3D&list-type=2&max-keys=2&prefix=ws%2FW1%2F');
    expect(signed.stringToSign).toBe(
      lines('AWS4-HMAC-SHA256', '20261120T093000Z', '20261120/europe-2/s3/aws4_request', 'b6d6f2258a29bff94c55a8b4d0e5de05cb0ae9e9f17d32c0910bbbbbd5af97d4')
    );
    expect(signed.signature).toBe('5a94b5c6676e69b84775384654c9cf3c92bac0d79cb8884d19a098dcf6f182c0');
  });

  it('encodes as S3 expects, and writes the date as AWS does', () => {
    expect(encodeRfc3986("a b+c/é!'()*~-._")).toBe('a%20b%2Bc%2F%C3%A9%21%27%28%29%2A~-._');
    expect(canonicalQuery([['b', ''], ['a', '2'], ['a', '1']])).toBe('a=1&a=2&b=');
    expect(amzDate(Date.parse('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });

  it('keeps the secret out of everything it returns', async () => {
    const signed = await sign({ ...PATH_STYLE, method: 'GET', path: '/rukoo-test-bucket' });
    expect(JSON.stringify(signed)).not.toContain(PATH_STYLE.secretAccessKey);
  });
});
