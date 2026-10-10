/**
 * Regression tests for RR-type-aware RDATA validation (src/lib/dns.ts).
 * Compression pointers may target only bytes validated as genuine domain
 * names; opaque RDATA (A/AAAA/TXT/...) contributes no targets, and
 * name-bearing RDATA (NS/CNAME/PTR/DNAME/MX/SOA/SRV/SVCB/HTTPS) must be
 * structurally exact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { importTypeScript } from "./lib/transpile-source.mjs";

const dns = await importTypeScript("../src/lib/dns.ts", import.meta.url);
const { isValidDnsResponse, parseQuery } = dns;

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function encodeName(name) {
  if (!name) return Buffer.from([0]);
  const labels = name.split(".").flatMap((label) => [label.length, ...Buffer.from(label)]);
  return Buffer.from([...labels, 0]);
}

function buildQuery(id = 0x1234, name = "example.com") {
  const qname = encodeName(name);
  const message = Buffer.alloc(12 + qname.length + 4);
  message.writeUInt16BE(id, 0);
  message.writeUInt16BE(0x0000, 2); // standard query
  message.writeUInt16BE(1, 4); // QDCOUNT
  qname.copy(message, 12);
  message.writeUInt16BE(1, 12 + qname.length); // QTYPE A
  message.writeUInt16BE(1, 12 + qname.length + 2); // QCLASS IN
  return message;
}

/** A resource record. Pass a Buffer for an encoded/compressed owner name. */
function resourceRecord(ownerName, type, rdata) {
  const owner = typeof ownerName === "string" ? encodeName(ownerName) : ownerName;
  return Buffer.concat([owner, u16(type), u16(1), u32(60), u16(rdata.length), rdata]);
}

function buildResponse(query, records) {
  // Locate the end of the question section.
  let offset = 12;
  while (query[offset] !== 0) offset += 1 + query[offset];
  const questionEnd = offset + 5; // root label + qtype + qclass

  const message = Buffer.alloc(questionEnd + records.reduce((sum, rr) => sum + rr.length, 0));
  query.copy(message, 0, 0, 12);
  message.writeUInt16BE(0x8180, 2); // QR + RD + RA, no error
  message.writeUInt16BE(1, 4);
  message.writeUInt16BE(records.length, 6);
  query.copy(message, 12, 12, questionEnd);
  let cursor = questionEnd;
  for (const rr of records) {
    rr.copy(message, cursor);
    cursor += rr.length;
  }
  return message;
}

/** Offset of the question-section end (start of the answer section). */
function answerStart(query) {
  let offset = 12;
  while (query[offset] !== 0) offset += 1 + query[offset];
  return offset + 5;
}

const QUERY = buildQuery();
assert.ok(parseQuery(QUERY), "fixture query must be valid");

const PTR_QUESTION = Buffer.from([0xc0, 0x0c]);

test("valid CNAME chain with an uncompressed target name is accepted", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, encodeName("target.example.net"));
  const a = resourceRecord(PTR_QUESTION, 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [cname, a]);
  assert.equal(isValidDnsResponse(response, QUERY), true);
});

test("CNAME RDATA as a bare compression pointer still validates", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, PTR_QUESTION); // -> example.com
  const response = buildResponse(QUERY, [cname]);
  assert.equal(isValidDnsResponse(response, QUERY), true);
});

test("MX exchange name bytes become valid compression targets", () => {
  const mxOwner = encodeName("example.com");
  const mx = resourceRecord(mxOwner, 15, Buffer.concat([u16(10), encodeName("mail.example.com")]));
  // Offset of the exchange name inside the MX RDATA, computed from the wire
  // layout: answer start + owner + type/class/ttl/rdlength + preference.
  const mailNameOffset = answerStart(QUERY) + mxOwner.length + 10 + 2;
  const a = resourceRecord(Buffer.from([0xc0, mailNameOffset]), 1, Buffer.from([5, 6, 7, 8]));
  const response = buildResponse(QUERY, [mx, a]);
  assert.equal(isValidDnsResponse(response, QUERY), true);
});

test("SOA with two names and an exact 20-byte fixed tail is accepted", () => {
  const soa = resourceRecord(
    "example.com",
    6,
    Buffer.concat([
      encodeName("ns.example.com"),
      encodeName("hostmaster.example.com"),
      u32(1), u32(2), u32(3), u32(4), u32(5),
    ]),
  );
  const response = buildResponse(QUERY, [soa]);
  assert.equal(isValidDnsResponse(response, QUERY), true);
});

test("SRV with a 6-byte prefix and target name filling the rest is accepted", () => {
  const srv = resourceRecord(
    "_sip._tcp.example.com",
    33,
    Buffer.concat([u16(0), u16(5), u16(5060), encodeName("sip.example.com")]),
  );
  const response = buildResponse(QUERY, [srv]);
  assert.equal(isValidDnsResponse(response, QUERY), true);
});

test("A-record RDATA bytes are NOT compression targets", () => {
  // First answer: an A record whose RDATA starts with pointer-looking bytes.
  // The RDATA itself is opaque and must not invalidate the message...
  const a = resourceRecord(PTR_QUESTION, 1, Buffer.from([0xc0, 0x0c, 1, 2]));
  const alone = buildResponse(QUERY, [a]);
  assert.equal(isValidDnsResponse(alone, QUERY), true);

  // ...but a later owner-name pointer into those RDATA bytes must be rejected.
  const aRdataOffset = answerStart(QUERY) + 2 + 10; // owner pointer + fixed RR fields
  const evil = resourceRecord(Buffer.from([0xc0, aRdataOffset]), 1, Buffer.from([9, 9, 9, 9]));
  const response = buildResponse(QUERY, [a, evil]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});

test("CNAME RDATA with trailing junk after the name is rejected", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, Buffer.concat([encodeName("a.example"), Buffer.from([0xde, 0xad])]));
  const response = buildResponse(QUERY, [cname]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});

test("MX with a truncated exchange-name pointer is rejected", () => {
  const mx = resourceRecord("example.com", 15, Buffer.concat([u16(10), Buffer.from([0xc0])]));
  const response = buildResponse(QUERY, [mx]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});

test("SOA with a short fixed tail is rejected", () => {
  const soa = resourceRecord(
    "example.com",
    6,
    Buffer.concat([encodeName("ns.example.com"), encodeName("hostmaster.example.com"), u32(1), u32(2)]),
  );
  const response = buildResponse(QUERY, [soa]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});

test("HTTPS/SVCB target name must end inside the RDATA", () => {
  const good = resourceRecord(
    "example.com",
    65,
    Buffer.concat([u16(1), encodeName("cdn.example.com"), u16(0), u16(0)]),
  );
  assert.equal(isValidDnsResponse(buildResponse(QUERY, [good]), QUERY), true);

  // Declared RDLENGTH stops before the name's label bytes do.
  const bad = resourceRecord("example.com", 65, Buffer.concat([u16(1), Buffer.from([7])]));
  assert.equal(isValidDnsResponse(buildResponse(QUERY, [bad]), QUERY), false);
});

test("compression cycle inside MX exchange name is rejected", () => {
  const mxOwner = encodeName("example.com");
  const nameOffset = answerStart(QUERY) + mxOwner.length + 10 + 2;
  const selfPointer = Buffer.from([0xc0 | (nameOffset >> 8), nameOffset & 0xff]);
  const mx = resourceRecord(mxOwner, 15, Buffer.concat([u16(10), selfPointer]));
  const response = buildResponse(QUERY, [mx]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});

test("pointer into the DNS header is rejected", () => {
  const a = resourceRecord(Buffer.from([0xc0, 0x05]), 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [a]);
  assert.equal(isValidDnsResponse(response, QUERY), false);
});
