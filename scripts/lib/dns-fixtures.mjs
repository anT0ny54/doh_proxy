/**
 * Shared DNS wire-format fixtures for the node:test suites.
 */

/** Wire-format name: "www.example" -> [3,w,w,w,7,e,x,a,m,p,l,e,0]. Empty -> root. */
export function encodeName(name) {
  if (!name) return Buffer.from([0]);
  const labels = name.split(".").flatMap((label) => [label.length, ...Buffer.from(label)]);
  return Buffer.from([...labels, 0]);
}

/** A standard query (RD set) for `name` with one IN question of `type`. */
export function buildQuery(id = 0x1234, name = "www.example", type = 1) {
  return Uint8Array.from([
    id >>> 8, id & 0xff,
    0x01, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
    ...encodeName(name),
    type >>> 8, type & 0xff,
    0x00, 0x01,
  ]);
}

/** A minimal valid query for `www.example` (A/IN). */
export function validQuery(id = 0x1234) {
  return buildQuery(id);
}

/** Answer to `query`: same ID and question, one A record (1.2.3.4, TTL 60). */
export function validResponse(query = validQuery()) {
  return Uint8Array.from([
    query[0], query[1],
    0x81, 0x80,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    ...query.slice(12),
    0xc0, 0x0c,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00, 0x00, 0x3c,
    0x00, 0x04, 1, 2, 3, 4,
  ]);
}

/**
 * Answer to `query` carrying 17 maximum-size TXT records (over 4 KiB), the kind
 * of DNSSEC/TXT-heavy response that must be relayed although a query may not
 * be that large.
 */
export function oversizedResponse(query = validQuery()) {
  const records = [];
  for (let i = 0; i < 17; i += 1) {
    const rdata = [255, ...new Uint8Array(255).fill(97)];
    records.push(0xc0, 0x0c, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, rdata.length >> 8, rdata.length & 0xff, ...rdata);
  }
  return Uint8Array.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 17, 0, 0, 0, 0, ...query.slice(12), ...records]);
}

export const DNS_MESSAGE = "application/dns-message";

/** Response init for a successful mocked upstream answer. */
export function dnsAnswer(body = validResponse(), headers = {}) {
  return new Response(body, { status: 200, headers: { "content-type": DNS_MESSAGE, ...headers } });
}
