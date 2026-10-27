/**
 * Regression tests for RR-type-aware RDATA validation (src/lib/dns.ts).
 * Compression pointers may target only bytes validated as genuine domain
 * names; opaque RDATA (A/AAAA/TXT/...) contributes no targets, and
 * name-bearing RDATA (NS/CNAME/PTR/DNAME/MX/SOA/SRV/SVCB/HTTPS) must be
 * structurally exact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery, encodeName } from "./lib/dns-fixtures.mjs";
import { importSource } from "./lib/transpile-source.mjs";

const { isValidDnsResponse, parseQuery } = await importSource("lib/dns.ts");

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

/** <character-string>: length byte + bytes. */
function characterString(text) {
  return Buffer.from([text.length, ...Buffer.from(text)]);
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

const QUERY = Buffer.from(buildQuery(0x1234, "example.com"));
const PARSED = parseQuery(QUERY);
assert.ok(PARSED, "fixture query must be valid");
/** Response validation against the fixture query. */
const valid = (response) => isValidDnsResponse(response, PARSED);

const PTR_QUESTION = Buffer.from([0xc0, 0x0c]);

test("valid CNAME chain with an uncompressed target name is accepted", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, encodeName("target.example.net"));
  const a = resourceRecord(PTR_QUESTION, 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [cname, a]);
  assert.equal(valid(response), true);
});

test("CNAME RDATA as a bare compression pointer still validates", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, PTR_QUESTION); // -> example.com
  const response = buildResponse(QUERY, [cname]);
  assert.equal(valid(response), true);
});

test("later compression pointers may target an earlier pointer suffix", () => {
  // edge.example.com is encoded as a literal `edge` label and then a pointer
  // to example.com. That pointer byte is itself a valid name-suffix target.
  const cnameRdata = Buffer.from([4, ...Buffer.from("edge"), 0xc0, 0x0c]);
  const cname = resourceRecord(PTR_QUESTION, 5, cnameRdata);
  const suffixPointerOffset = answerStart(QUERY) + PTR_QUESTION.length + 10 + 5;
  const ownerPointer = Buffer.from([0xc0 | (suffixPointerOffset >> 8), suffixPointerOffset & 0xff]);
  const a = resourceRecord(ownerPointer, 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [cname, a]);
  assert.equal(valid(response), true);
});

test("MX exchange name bytes become valid compression targets", () => {
  const mxOwner = encodeName("example.com");
  const mx = resourceRecord(mxOwner, 15, Buffer.concat([u16(10), encodeName("mail.example.com")]));
  // Offset of the exchange name inside the MX RDATA, computed from the wire
  // layout: answer start + owner + type/class/ttl/rdlength + preference.
  const mailNameOffset = answerStart(QUERY) + mxOwner.length + 10 + 2;
  const a = resourceRecord(Buffer.from([0xc0, mailNameOffset]), 1, Buffer.from([5, 6, 7, 8]));
  const response = buildResponse(QUERY, [mx, a]);
  assert.equal(valid(response), true);
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
  assert.equal(valid(response), true);
});

test("SRV with a 6-byte prefix and target name filling the rest is accepted", () => {
  const srv = resourceRecord(
    "_sip._tcp.example.com",
    33,
    Buffer.concat([u16(0), u16(5), u16(5060), encodeName("sip.example.com")]),
  );
  const response = buildResponse(QUERY, [srv]);
  assert.equal(valid(response), true);
});

test("A-record RDATA bytes are NOT compression targets", () => {
  // First answer: an A record whose RDATA starts with pointer-looking bytes.
  // The RDATA itself is opaque and must not invalidate the message...
  const a = resourceRecord(PTR_QUESTION, 1, Buffer.from([0xc0, 0x0c, 1, 2]));
  const alone = buildResponse(QUERY, [a]);
  assert.equal(valid(alone), true);

  // ...but a later owner-name pointer into those RDATA bytes must be rejected.
  const aRdataOffset = answerStart(QUERY) + 2 + 10; // owner pointer + fixed RR fields
  const evil = resourceRecord(Buffer.from([0xc0, aRdataOffset]), 1, Buffer.from([9, 9, 9, 9]));
  const response = buildResponse(QUERY, [a, evil]);
  assert.equal(valid(response), false);
});

test("CNAME RDATA with trailing junk after the name is rejected", () => {
  const cname = resourceRecord(PTR_QUESTION, 5, Buffer.concat([encodeName("a.example"), Buffer.from([0xde, 0xad])]));
  const response = buildResponse(QUERY, [cname]);
  assert.equal(valid(response), false);
});

test("MX with a truncated exchange-name pointer is rejected", () => {
  const mx = resourceRecord("example.com", 15, Buffer.concat([u16(10), Buffer.from([0xc0])]));
  const response = buildResponse(QUERY, [mx]);
  assert.equal(valid(response), false);
});

test("SOA with a short fixed tail is rejected", () => {
  const soa = resourceRecord(
    "example.com",
    6,
    Buffer.concat([encodeName("ns.example.com"), encodeName("hostmaster.example.com"), u32(1), u32(2)]),
  );
  const response = buildResponse(QUERY, [soa]);
  assert.equal(valid(response), false);
});

test("HTTPS/SVCB target name must end inside the RDATA", () => {
  const good = resourceRecord(
    "example.com",
    65,
    Buffer.concat([u16(1), encodeName("cdn.example.com"), u16(0), u16(0)]),
  );
  assert.equal(valid(buildResponse(QUERY, [good])), true);

  // Declared RDLENGTH stops before the name's label bytes do.
  const bad = resourceRecord("example.com", 65, Buffer.concat([u16(1), Buffer.from([7])]));
  assert.equal(valid(buildResponse(QUERY, [bad])), false);
});

test("compressed SVCB/HTTPS target name is rejected (RFC 9460 section 2.2)", () => {
  // Bare compression pointer into the question section as the target name.
  for (const type of [64, 65]) {
    const rr = resourceRecord("example.com", type, Buffer.concat([u16(1), Buffer.from([0xc0, 0x0c])]));
    const response = buildResponse(QUERY, [rr]);
    assert.equal(valid(response), false, `type ${type} with pointer target`);
  }

  // Pointer after a leading label is also rejected.
  for (const type of [64, 65]) {
    const rr = resourceRecord("example.com", type, Buffer.concat([u16(0), Buffer.from([3, 99, 100, 110, 0xc0, 0x0c])]));
    const response = buildResponse(QUERY, [rr]);
    assert.equal(valid(response), false, `type ${type} with mid-name pointer`);
  }

  // Sanity: uncompressed targets with SvcParams still validate.
  for (const type of [64, 65]) {
    const rr = resourceRecord(
      "example.com",
      type,
      Buffer.concat([u16(1), encodeName("cdn.example.com"), u16(0), u16(0)]),
    );
    const response = buildResponse(QUERY, [rr]);
    assert.equal(valid(response), true, `type ${type} with uncompressed target`);
  }
});

test("compression cycle inside MX exchange name is rejected", () => {
  const mxOwner = encodeName("example.com");
  const nameOffset = answerStart(QUERY) + mxOwner.length + 10 + 2;
  const selfPointer = Buffer.from([0xc0 | (nameOffset >> 8), nameOffset & 0xff]);
  const mx = resourceRecord(mxOwner, 15, Buffer.concat([u16(10), selfPointer]));
  const response = buildResponse(QUERY, [mx]);
  assert.equal(valid(response), false);
});

test("pointer into the DNS header is rejected", () => {
  const a = resourceRecord(Buffer.from([0xc0, 0x05]), 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [a]);
  assert.equal(valid(response), false);
});

test("RFC 3597 name-bearing types (MINFO, RP, AFSDB, RT, PX, KX, NAPTR) become compression targets", () => {
  const owner = encodeName("example.com");
  const cases = [
    [14, [encodeName("rmail.example.com"), encodeName("email.example.com")], 0], // MINFO
    [17, [encodeName("admin.example.com"), encodeName("txt.example.com")], 0], // RP
    [18, [u16(1), encodeName("afs.example.com")], 2], // AFSDB
    [21, [u16(1), encodeName("rt.example.com")], 2], // RT
    [26, [u16(1), encodeName("map822.example.com"), encodeName("mapx400.example.com")], 2], // PX
    [36, [u16(1), encodeName("kx.example.com")], 2], // KX
    [35, [u16(100), u16(10), characterString("u"), characterString("E2U+sip"), characterString(""), encodeName("sip.example.com")], 4 + 2 + 8 + 1], // NAPTR
  ];
  for (const [type, parts, nameOffsetInRdata] of cases) {
    const rr = resourceRecord(owner, type, Buffer.concat(parts));
    const nameOffset = answerStart(QUERY) + owner.length + 10 + nameOffsetInRdata;
    const a = resourceRecord(Buffer.from([0xc0, nameOffset]), 1, Buffer.from([1, 2, 3, 4]));
    assert.equal(valid(buildResponse(QUERY, [rr, a])), true, `type ${type}: pointer into its RDATA name`);
  }
});

test("NAPTR with a character-string running past RDLENGTH is rejected", () => {
  const rdata = Buffer.concat([u16(100), u16(10), Buffer.from([40, 1, 2])]);
  const rr = resourceRecord("example.com", 35, rdata);
  assert.equal(valid(buildResponse(QUERY, [rr])), false);
});
