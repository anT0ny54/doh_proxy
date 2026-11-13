import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, oversizedResponse, validQuery as makeValidQuery, validResponse as makeValidResponse } from "./lib/dns-fixtures.mjs";
import { importSource } from "./lib/transpile-source.mjs";

const dns = await importSource("lib/dns.ts");
const isValidDnsQuery = (message) => dns.parseQuery(message) !== null;
/** Response validation against a raw query (parsed the way doh.ts does). */
const matches = (response, query) => dns.isValidDnsResponse(response, dns.parseQuery(query));
// id=1 keeps the transaction-ID expectations below unchanged.
const validQuery = makeValidQuery(1);
const validResponse = (query = validQuery) => makeValidResponse(query);

/** Query whose QNAME is the given raw label bytes (root label appended). */
function queryWithName(nameBytes, id = 1) {
  const query = buildQuery(id, "");
  return Uint8Array.from([...query.slice(0, 12), ...nameBytes, ...query.slice(12)]);
}

test("accepts a normal DNS query", () => {
  assert.equal(isValidDnsQuery(validQuery), true);
});

test("rejects a response presented as a query", () => {
  const response = Uint8Array.from(validQuery);
  response[2] |= 0x80;
  assert.equal(isValidDnsQuery(response), false);
});

test("rejects a compressed first-question QNAME without a prior name", () => {
  const query = Uint8Array.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
  assert.equal(isValidDnsQuery(query), false);
});

test("accepts backward compression in a resource-record owner name", () => {
  assert.equal(matches(validResponse(), validQuery), true);
});

test("accepts backward compression pointers to previously validated root suffixes", () => {
  const rootQuery = queryWithName([]);
  assert.equal(matches(validResponse(rootQuery), rootQuery), true, "root QNAME is a valid compression target");

  const namedQuery = validQuery;
  const response = validResponse(namedQuery);
  const rootLabelOffset = namedQuery.length - 5; // QTYPE + QCLASS follow the root label.
  const answerOwnerOffset = namedQuery.length;
  response[answerOwnerOffset] = 0xc0 | (rootLabelOffset >> 8);
  response[answerOwnerOffset + 1] = rootLabelOffset & 0xff;
  assert.equal(matches(response, namedQuery), true, "a non-root QNAME's terminal root suffix is also a valid target");
});

test("rejects a pointer to a previously compressed owner name", () => {
  const depth = 2;
  const response = Buffer.alloc(validQuery.length + depth * 16);
  response.set(validQuery);
  response.writeUInt16BE(0x8180, 2); // QR + RD + RA
  response.writeUInt16BE(depth, 6);

  let previousNameOffset = 12; // The first pointer targets the uncompressed question QNAME.
  let offset = validQuery.length;
  for (let i = 0; i < depth; i += 1) {
    response[offset] = 0xc0 | (previousNameOffset >> 8);
    response[offset + 1] = previousNameOffset & 0xff;
    response.writeUInt16BE(1, offset + 2); // A
    response.writeUInt16BE(1, offset + 4); // IN
    response.writeUInt32BE(60, offset + 6);
    response.writeUInt16BE(4, offset + 10);
    response.set([192, 0, 2, i], offset + 12);
    previousNameOffset = offset;
    offset += 16;
  }

  assert.equal(matches(response, validQuery), false);
});

test("rejects forward compression pointers", () => {
  const response = validResponse();
  const answerNameOffset = validQuery.length;
  response[answerNameOffset] = 0xc0;
  response[answerNameOffset + 1] = response.length - 1;
  assert.equal(dns.isValidDnsResponse(response), false);
});

test("rejects compression pointers into unrelated question fields", () => {
  const response = validResponse();
  const answerNameOffset = validQuery.length;
  // Offset 26 is the first byte of QTYPE, not the start of a domain name.
  response[answerNameOffset] = 0xc0;
  response[answerNameOffset + 1] = 26;
  assert.equal(matches(response, validQuery), false);
});

test("rejects compression pointers that point before the DNS message", () => {
  const response = Uint8Array.from([
    0, 1, 0x80, 0, 0, 1, 0, 1, 0, 0, 0, 0, // header: QR, QDCOUNT=1, ANCOUNT=1
    3, 119, 119, 119, 0, 0, 1, 0, 1, // question www. A IN
    0xc0, 0x00, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4, // owner points into the header
  ]);
  assert.equal(dns.isValidDnsResponse(response), false);
});

test("accepts the maximum 255-octet name and rejects a longer name", () => {
  // 127 one-character labels occupy 254 octets plus the root label.
  const maximum = Array.from({ length: 127 }, () => [1, 97]).flat();
  assert.equal(isValidDnsQuery(queryWithName(maximum)), true);

  const tooLong = [...maximum, 1, 97];
  assert.equal(isValidDnsQuery(queryWithName(tooLong)), false);
});

test("accepts a structurally valid DNS response", () => {
  assert.equal(dns.isValidDnsResponse(validResponse()), true);
});

test("matches response transaction ID and question", () => {
  const query = validQuery;
  const response = validResponse(query);
  assert.equal(matches(response, query), true);

  const wrongId = validResponse(Uint8Array.from(query));
  wrongId[0] = 0x12;
  wrongId[1] = 0x34;
  assert.equal(matches(wrongId, query), false);

  const differentName = queryWithName([3, 119, 101, 98, 7, 101, 120, 97, 109, 112, 108, 101]);
  assert.equal(matches(validResponse(differentName), query), false);
});

test("DNS question name matching is case-insensitive", () => {
  const response = validResponse();
  const qnameStart = 12;
  response[qnameStart + 1] = 87;
  response[qnameStart + 2] = 87;
  assert.equal(matches(response, validQuery), true);
});

test("accepts a CNAME chain whose next owner name points into earlier RDATA", () => {
  const name = (...labels) => [...labels.flatMap((l) => [l.length, ...Buffer.from(l)]), 0];
  const question = [...name("www", "example", "com"), 0, 1, 0, 1];
  const query = Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...question]);
  const rdata = name("edge", "example", "net");
  const rdataOffset = 12 + question.length + 12;
  const cname = [0xc0, 0x0c, 0, 5, 0, 1, 0, 0, 0, 60, 0, rdata.length, ...rdata];
  const a = [0xc0 | (rdataOffset >> 8), rdataOffset & 0xff, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4];
  const response = Uint8Array.from([0, 1, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0, ...question, ...cname, ...a]);
  assert.equal(matches(response, query), true);
});

test("rejects a compressed name whose expanded form exceeds 255 octets", () => {
  const label = (length, value = 97) => [length, ...new Uint8Array(length).fill(value)];
  const longName = [...label(62), ...label(62), ...label(62), ...label(62), 0];
  const query = Uint8Array.from([
    0x12, 0x34,
    0x01, 0x00,
    0, 1,
    0, 0,
    0, 0,
    0, 0,
    ...longName,
    0, 1, 0, 1,
  ]);
  const question = query.slice(12);
  const answerName = [3, 101, 100, 103, 0xc0, 0x0c];
  const answer = [
    ...answerName,
    0, 1,
    0, 1,
    0, 0, 0, 60,
    0, 4,
    1, 2, 3, 4,
  ];
  const response = Uint8Array.from([
    query[0], query[1],
    0x81, 0x80,
    0, 1,
    0, 1,
    0, 0,
    0, 0,
    ...question,
    ...answer,
  ]);
  assert.equal(matches(response, query), false);
});

test("responses may exceed 4 KiB but queries may not", () => {
  const big = oversizedResponse(validQuery);
  assert.ok(big.byteLength > 4_096);
  assert.equal(matches(big, validQuery), true);

  // Structurally valid query (EDNS0 padding option) that only violates the size cap.
  const padded = (padLength) => {
    const rdata = [0, 12, padLength >> 8, padLength & 0xff, ...new Uint8Array(padLength)];
    const opt = [0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, rdata.length >> 8, rdata.length & 0xff, ...rdata];
    return Uint8Array.from([...validQuery.slice(0, 10), 0, 1, ...validQuery.slice(12), ...opt]);
  };
  assert.equal(isValidDnsQuery(padded(100)), true);
  assert.equal(isValidDnsQuery(padded(4_100)), false);
});

test("parseQuery never modifies its input, even for Buffer views", () => {
  // Mixed-case QNAME (0x20 encoding) so that case-folding would change bytes.
  const mixed = Uint8Array.from(validQuery);
  mixed[13] = 87; // 'W'
  mixed[17] = 69; // 'E'
  const asBuffer = Buffer.from(mixed);
  const snapshot = Buffer.from(asBuffer);

  const parsed = dns.parseQuery(asBuffer);
  assert.ok(parsed);
  assert.deepEqual(asBuffer, snapshot, "input bytes must be left untouched");
  assert.equal(parsed.key[1], 119, "the match key is lower-cased");
  assert.equal(dns.isValidDnsResponse(validResponse(mixed), parsed), true);
});

test("accepts a legal QDCOUNT=0 response when the transaction ID matches", () => {
  // Header with QDCOUNT=0, ANCOUNT=1, followed by one A record whose owner
  // name is uncompressed (a question section exists in neither message).
  const owner = [3, 119, 119, 119, 7, 101, 120, 97, 109, 112, 108, 101, 0];
  const answer = [...owner, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4];
  const header = [validQuery[0], validQuery[1], 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0];
  const qd0 = Uint8Array.from([...header, ...answer]);
  assert.equal(matches(qd0, validQuery), true, "ID match is enough without a question section");
  const wrongId = Uint8Array.from(qd0);
  wrongId[0] = 0x12;
  wrongId[1] = 0x34;
  assert.equal(matches(wrongId, validQuery), false, "transaction ID still enforced");
});

test("still rejects responses with more than one question", () => {
  const response = validResponse();
  response[5] = 2; // QDCOUNT = 2 is never legal
  assert.equal(matches(response, validQuery), false);
});
