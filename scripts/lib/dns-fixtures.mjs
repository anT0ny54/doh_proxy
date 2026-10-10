/**
 * Shared DNS wire-format fixtures for the node:test suites: a minimal valid
 * query for `www.example` (A/IN) and a matching one-record answer.
 */

export function validQuery(id = 0x1234) {
  return Uint8Array.from([
    id >>> 8,
    id & 0xff,
    0x01, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
    3, 119, 119, 119,
    7, 101, 120, 97, 109, 112, 108, 101,
    0,
    0, 1,
    0, 1,
  ]);
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
