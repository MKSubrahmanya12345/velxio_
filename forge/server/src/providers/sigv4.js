// Forge — AWS SigV4 signer (zero dependencies, node:crypto only).
//
// Used by the Bedrock planner to sign requests to bedrock-runtime without
// pulling in the AWS SDK. Verified against the official AWS SigV4 test
// vector (see scripts/smoke.mjs).

import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/**
 * Sign a request with SigV4. Returns the full header set to send
 * (host, x-amz-date, optional x-amz-security-token, Authorization).
 *
 * @param {object} o
 * @param {string} o.method        HTTP method
 * @param {string} o.url           full request URL
 * @param {string} o.region        AWS region
 * @param {string} o.service       AWS service name (e.g. "bedrock")
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} [o.sessionToken]
 * @param {string} [o.payload]     request body (signed as-is)
 * @param {object} [o.headers]     extra headers to sign
 * @param {string} [fixedAmzDate]  inject a fixed "YYYYMMDD'T'HHMMSS'Z'" (tests)
 */
export function signV4(o, fixedAmzDate) {
  const u = new URL(o.url);
  const amzDate = fixedAmzDate || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = { host: u.host, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = String(v);
  if (o.sessionToken) headers['x-amz-security-token'] = String(o.sessionToken);

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    o.method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256hex(o.payload ?? ''),
  ].join('\n');

  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${o.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, o.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
