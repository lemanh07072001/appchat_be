// Read-only capability probe. Never prints credentials or transaction values.
const { createHmac } = require('node:crypto');
const { inspect } = require('node:util');
require('dotenv').config({ quiet: true });

function describe(value, depth = 0) {
  if (depth > 6) return '[depth limit]';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [describe(value[0], depth + 1)] : [];
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describe(item, depth + 1)]));
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Binance returned non-JSON data (HTTP ${response.status}).`); }
  if (!response.ok) {
    const code = typeof body.code === 'number' || /^-?\d+$/.test(String(body.code)) ? body.code : 'unknown';
    throw new Error(`Binance HTTP ${response.status}, code ${code}. Check API permissions, IP allowlist, time and rate limits. Response details suppressed.`);
  }
  return body;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const assert = require('node:assert/strict');
    const sample = { transactionId: 'private-id', payerInfo: { email: 'private@example.com' }, note: 'NAPSECRET', amount: '12.5' };
    const output = JSON.stringify(describe(sample));
    for (const value of ['private-id', 'private@example.com', 'NAPSECRET', '12.5']) assert(!output.includes(value));
    assert.equal(describe(sample).note, 'string');
    console.log('PASS: transaction values are not included in the diagnostic schema.');
    return;
  }
  const key = process.env.BINANCE_READ_API_KEY;
  const secret = process.env.BINANCE_READ_API_SECRET;
  if (!key || !secret) throw new Error('Missing BINANCE_READ_API_KEY / BINANCE_READ_API_SECRET in backend/.env. Use a dedicated read-only key; never send secrets in chat.');
  const hours = Number(process.env.BINANCE_PROBE_HOURS || 24);
  if (!Number.isFinite(hours) || hours < 1 || hours > 2160) throw new Error('BINANCE_PROBE_HOURS must be between 1 and 2160.');
  const base = 'https://api.binance.com';
  const clock = await getJson(`${base}/api/v3/time`);
  if (!Number.isSafeInteger(clock.serverTime)) throw new Error('Invalid Binance server time.');
  const params = new URLSearchParams({
    startTime: String(clock.serverTime - Math.floor(hours * 3600000)),
    endTime: String(clock.serverTime), limit: '100', recvWindow: '5000', timestamp: String(clock.serverTime),
  });
  const signature = createHmac('sha256', secret).update(params.toString()).digest('hex');
  const result = await getJson(`${base}/sapi/v1/pay/transactions?${params}&signature=${signature}`, { 'X-MBX-APIKEY': key });
  if (result.success !== true || String(result.code) !== '000000' || !Array.isArray(result.data)) throw new Error('Unexpected Binance history response. No financial processing performed.');
  console.log(`Read-only probe successful. Window: ${hours} hours. Records: ${result.data.length}.`);
  console.log('Field names and types only (values are never printed):');
  const schemas = new Map(result.data.map(row => [JSON.stringify(describe(row)), describe(row)]));
  console.log(inspect([...schemas.values()], { depth: 10, colors: false }));
  if (!result.data.length) console.log('No records: cannot determine whether transfer messages are available.');
  if (result.data.length === 100) console.log('Result reached 100 records; this probe is not a complete reconciliation scan.');
  console.log('Field presence does not prove message meaning, final settlement or ownership. Compare locally against a known received transfer before enabling automatic credit.');
}

main().catch(error => {
  // Never emit fetch URLs, headers, signed requests or raw API responses.
  const message = error instanceof Error ? error.message : '';
  console.error(message.startsWith('Missing ') || message.startsWith('BINANCE_PROBE_') || message.startsWith('Binance ') || message.startsWith('Invalid Binance') || message.startsWith('Unexpected Binance')
    ? message : 'Probe failed (network/timeout or local error). Sensitive details suppressed.');
  process.exitCode = 1;
});
