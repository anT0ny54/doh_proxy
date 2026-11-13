/**
 * Regression tests for RR-type-aware RDATA validation (src/lib/dns.ts).
 * Compression pointers may target only bytes validated as genuine domain
 * names; opaque RDATA (A/AAAA/TXT/...) contributes no targets, and
 * name-bearing RDATA (including DNSSEC, SVCB/HTTPS, DSYNC and DELEG names)
 * must follow the RR-specific compression and framing rules.
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

test("nested compression pointers are rejected as targets", () => {
  // The CNAME name starts with a literal label but ends in a pointer. A later
  // RR must not target that first label because its suffix still contains a pointer.
  const cnameRdata = Buffer.from([4, ...Buffer.from("edge"), 0xc0, 0x0c]);
  const cname = resourceRecord(PTR_QUESTION, 5, cnameRdata);
  const compressedNameOffset = answerStart(QUERY) + PTR_QUESTION.length + 10;
  const ownerPointer = Buffer.from([0xc0 | (compressedNameOffset >> 8), compressedNameOffset & 0xff]);
  const a = resourceRecord(ownerPointer, 1, Buffer.from([1, 2, 3, 4]));
  const response = buildResponse(QUERY, [cname, a]);
  assert.equal(valid(response), false);
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
    Buffer.concat([u16(1), encodeName("cdn.example.com")]),
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
      Buffer.concat([u16(1), encodeName("cdn.example.com")]),
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

test("legacy name-bearing types (MINFO, RP, AFSDB, RT, SIG, PX, NXT, NAPTR) become compression targets", () => {
  const owner = encodeName("example.com");
  const cases = [
    [14, [encodeName("rmail.example.com"), encodeName("email.example.com")], 0], // MINFO
    [17, [encodeName("admin.example.com"), encodeName("txt.example.com")], 0], // RP
    [18, [u16(1), encodeName("afs.example.com")], 2], // AFSDB
    [21, [u16(1), encodeName("rt.example.com")], 2], // RT
    [24, [Buffer.alloc(18), encodeName("sig.example.com"), Buffer.from([0xaa])], 18], // SIG
    [26, [u16(1), encodeName("map822.example.com"), encodeName("mapx400.example.com")], 2], // PX
    [30, [encodeName("next.example.com"), Buffer.from([0x00, 0x00, 0x00, 0x02])], 0], // NXT
    [35, [u16(100), u16(10), characterString("u"), characterString("E2U+sip"), characterString(""), encodeName("sip.example.com")], 4 + 2 + 8 + 1], // NAPTR
  ];
  for (const [type, parts, nameOffsetInRdata] of cases) {
    const rr = resourceRecord(owner, type, Buffer.concat(parts));
    const nameOffset = answerStart(QUERY) + owner.length + 10 + nameOffsetInRdata;
    const a = resourceRecord(Buffer.from([0xc0, nameOffset]), 1, Buffer.from([1, 2, 3, 4]));
    assert.equal(valid(buildResponse(QUERY, [rr, a])), true, `type ${type}: pointer into its RDATA name`);
  }
});


test("DNAME and KX RDATA names must be uncompressed", () => {
  const uncompressedCases = [
    [39, encodeName("target.example.net")], // DNAME target
    [36, Buffer.concat([u16(10), encodeName("kx.example.net")])], // KX exchanger
  ];
  for (const [type, rdata] of uncompressedCases) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", type, rdata)])), true,
      `type ${type} with an uncompressed RDATA name`);
  }

  const compressedCases = [
    [39, PTR_QUESTION], // DNAME target is a bare pointer
    [36, Buffer.concat([u16(10), PTR_QUESTION])], // KX exchanger is a bare pointer
    [39, Buffer.from([3, 99, 100, 110, 0xc0, 0x0c])], // DNAME target has a pointer suffix
    [36, Buffer.concat([u16(10), Buffer.from([3, 99, 100, 110, 0xc0, 0x0c])])], // KX exchanger has a pointer suffix
  ];
  for (const [type, rdata] of compressedCases) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", type, rdata)])), false,
      `type ${type} with a compressed RDATA name`);
  }
});


test("RRSIG signer names and NSEC next-domain names become compression targets", () => {
  const owner = encodeName("example.com");
  const cases = [
    [46, Buffer.concat([Buffer.alloc(18), encodeName("signer.example.net"), Buffer.from([0xaa])]), 18],
    [47, Buffer.concat([encodeName("next.example.net"), Buffer.from([0x00, 0x01, 0x40])]), 0],
  ];

  for (const [type, rdata, nameOffsetInRdata] of cases) {
    const rr = resourceRecord(owner, type, rdata);
    const nameOffset = answerStart(QUERY) + owner.length + 10 + nameOffsetInRdata;
    const ownerPointer = Buffer.from([0xc0 | (nameOffset >> 8), nameOffset & 0xff]);
    const a = resourceRecord(ownerPointer, 1, Buffer.from([1, 2, 3, 4]));
    assert.equal(valid(buildResponse(QUERY, [rr, a])), true, `type ${type}: pointer into its RDATA name`);
  }
});

test("RRSIG and NSEC embedded names reject compression and truncation", () => {
  const cases = [
    [46, Buffer.alloc(18), Buffer.from([0xaa])], // RRSIG: fixed prefix, name, signature
    [47, Buffer.alloc(0), Buffer.from([0x00, 0x01, 0x40])], // NSEC: name, type bitmap
  ];

  for (const [type, prefix, suffix] of cases) {
    // A bare pointer and a literal label followed by a pointer are both illegal.
    for (const name of [PTR_QUESTION, Buffer.from([3, 99, 100, 110, 0xc0, 0x0c])]) {
      const rr = resourceRecord("example.com", type, Buffer.concat([prefix, name, suffix]));
      assert.equal(valid(buildResponse(QUERY, [rr])), false, `type ${type}: compressed embedded name`);
    }

    const truncated = resourceRecord(
      "example.com",
      type,
      Buffer.concat([prefix, Buffer.from([3, 97])]),
    );
    assert.equal(valid(buildResponse(QUERY, [truncated])), false, `type ${type}: truncated embedded name`);
  }
});

test("NAPTR with a character-string running past RDLENGTH is rejected", () => {
  const rdata = Buffer.concat([u16(100), u16(10), Buffer.from([40, 1, 2])]);
  const rr = resourceRecord("example.com", 35, rdata);
  assert.equal(valid(buildResponse(QUERY, [rr])), false);
});


test("A6 records parse their conditional uncompressed prefix name", () => {
  const noPrefix = Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0x11)]);
  const withPrefix = Buffer.concat([Buffer.from([64]), Buffer.alloc(8, 0x22), encodeName("prefix.example.net")]);
  const fullPrefix = Buffer.concat([Buffer.from([128]), encodeName("prefix.example.net")]);
  for (const rdata of [noPrefix, withPrefix, fullPrefix]) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 38, rdata)])), true);
  }

  const compressed = Buffer.concat([Buffer.from([64]), Buffer.alloc(8), PTR_QUESTION]);
  const tooShort = Buffer.concat([Buffer.from([64]), Buffer.alloc(7), encodeName("prefix.example.net")]);
  for (const rdata of [Buffer.from([129]), compressed, tooShort]) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 38, rdata)])), false);
  }
});

test("IPSECKEY validates gateway-type-specific lengths and uncompressed gateway names", () => {
  const cases = [
    Buffer.from([10, 0, 2, 1, 2, 3]), // no gateway, opaque public key
    Buffer.from([10, 1, 2, 192, 0, 2, 1, 0xaa]), // IPv4 gateway
    Buffer.concat([Buffer.from([10, 2, 2]), Buffer.alloc(16, 0x20), Buffer.from([0xaa])]), // IPv6 gateway
    Buffer.concat([Buffer.from([10, 3, 2]), encodeName("gw.example.net"), Buffer.from([0xaa])]), // DNS gateway
  ];
  for (const rdata of cases) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 45, rdata)])), true);
  }

  const compressedName = Buffer.concat([Buffer.from([10, 3, 2]), PTR_QUESTION]);
  const shortIpv4 = Buffer.from([10, 1, 2, 192, 0, 2]);
  const unknownGateway = Buffer.from([10, 4, 2]);
  for (const rdata of [compressedName, shortIpv4, unknownGateway, Buffer.from([10, 3])]) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 45, rdata)])), false);
  }
});

test("HIP validates its fixed lengths and optional uncompressed RVS names", () => {
  const header = Buffer.from([16, 2, 0, 2]); // HIT length, algorithm, public-key length
  const fixed = Buffer.concat([header, Buffer.alloc(16, 0x44), Buffer.from([0xaa, 0xbb])]);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 55, fixed)])), true);

  const withRvs = Buffer.concat([fixed, encodeName("rvs.example.net"), encodeName("backup.example.net")]);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 55, withRvs)])), true);

  const compressedRvs = Buffer.concat([fixed, PTR_QUESTION]);
  const truncatedHit = Buffer.concat([Buffer.from([16, 2, 0, 2]), Buffer.alloc(15), Buffer.from([1, 2])]);
  const truncatedKey = Buffer.concat([Buffer.from([16, 2, 0, 4]), Buffer.alloc(16), Buffer.from([1, 2])]);
  for (const rdata of [compressedRvs, truncatedHit, truncatedKey]) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 55, rdata)])), false);
  }
});

test("LP and TALINK names are uncompressed", () => {
  const lp = resourceRecord("example.com", 107, Buffer.concat([u16(10), encodeName("locator.example.net")]));
  const talink = resourceRecord("example.com", 58, Buffer.concat([
    encodeName("previous.example.net"),
    encodeName("next.example.net"),
  ]));
  assert.equal(valid(buildResponse(QUERY, [lp, talink])), true);

  const compressedLp = resourceRecord("example.com", 107, Buffer.concat([u16(10), PTR_QUESTION]));
  const compressedTalink = resourceRecord("example.com", 58, Buffer.concat([
    encodeName("previous.example.net"), PTR_QUESTION,
  ]));
  assert.equal(valid(buildResponse(QUERY, [compressedLp])), false);
  assert.equal(valid(buildResponse(QUERY, [compressedTalink])), false);
});

test("TKEY and TSIG algorithm names are uncompressed and variable fields are bounded", () => {
  const tkey = Buffer.concat([
    encodeName("gss-tsig"),
    u32(1), u32(2), u16(3), u16(0),
    u16(2), Buffer.from([0xaa, 0xbb]),
    u16(1), Buffer.from([0xcc]),
  ]);
  const tsig = Buffer.concat([
    encodeName("hmac-sha256"),
    Buffer.alloc(6), u16(300),
    u16(3), Buffer.from([0xaa, 0xbb, 0xcc]),
    u16(0x1234), u16(0), u16(2), Buffer.from([0xdd, 0xee]),
  ]);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 249, tkey)])), true);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 250, tsig)])), true);

  const compressedTkey = Buffer.concat([PTR_QUESTION, tkey.subarray(encodeName("gss-tsig").length)]);
  const compressedTsig = Buffer.concat([PTR_QUESTION, tsig.subarray(encodeName("hmac-sha256").length)]);
  const truncatedTkey = tkey.subarray(0, tkey.length - 1);
  const truncatedTsig = tsig.subarray(0, tsig.length - 1);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 249, compressedTkey)])), false);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 250, compressedTsig)])), false);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 249, truncatedTkey)])), false);
  assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 250, truncatedTsig)])), false);
});

test("AMTRELAY validates relay type and uncompressed DNS relay names", () => {
  const cases = [
    Buffer.from([10, 0]), // no relay
    Buffer.from([10, 1, 192, 0, 2, 1]), // IPv4 relay
    Buffer.concat([Buffer.from([10, 2]), Buffer.alloc(16, 0x20)]), // IPv6 relay
    Buffer.concat([Buffer.from([10, 3]), encodeName("relay.example.net")]), // DNS relay
  ];
  for (const rdata of cases) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 260, rdata)])), true);
  }

  const compressed = Buffer.from([10, 3, ...PTR_QUESTION]);
  const badIpv4 = Buffer.from([10, 1, 192, 0, 2]);
  const badIpv6 = Buffer.concat([Buffer.from([10, 2]), Buffer.alloc(15)]);
  for (const rdata of [compressed, badIpv4, badIpv6, Buffer.from([10])]) {
    assert.equal(valid(buildResponse(QUERY, [resourceRecord("example.com", 260, rdata)])), false);
  }
});

test("NSEC bitmap window framing and ordering are validated", () => {
  const makeNsec = (bitmap) => resourceRecord("example.com", 47,
    Buffer.concat([encodeName("next.example.net"), bitmap]));
  const validBitmap = Buffer.from([0, 1, 0x40, 2, 1, 0x80]);
  assert.equal(valid(buildResponse(QUERY, [makeNsec(validBitmap)])), true);

  const invalidBitmaps = [
    Buffer.alloc(0), // at least one window is required
    Buffer.from([0]), // truncated window header
    Buffer.from([0, 0]), // zero length
    Buffer.from([0, 33, ...Buffer.alloc(33, 1)]), // length > 32
    Buffer.from([0, 2, 0x40]), // truncated bitmap
    Buffer.from([1, 1, 0x40, 0, 1, 0x40]), // decreasing windows
    Buffer.from([0, 1, 0]), // trailing zero octet
  ];
  for (const bitmap of invalidBitmaps) {
    assert.equal(valid(buildResponse(QUERY, [makeNsec(bitmap)])), false);
  }
});

test("SVCB and HTTPS parameter TLVs are bounded and strictly ordered", () => {
  const makeSvcb = (type, params) => resourceRecord("example.com", type,
    Buffer.concat([u16(1), encodeName("cdn.example.net"), params]));
  const validParams = Buffer.concat([u16(1), u16(3), Buffer.from([1, 2, 3]), u16(3), u16(2), u16(443)]);
  const mandatoryParams = Buffer.concat([
    u16(0), u16(4), u16(1), u16(3), validParams,
  ]);
  for (const type of [64, 65]) {
    assert.equal(valid(buildResponse(QUERY, [makeSvcb(type, validParams)])), true);
    assert.equal(valid(buildResponse(QUERY, [makeSvcb(type, mandatoryParams)])), true);
    assert.equal(valid(buildResponse(QUERY, [makeSvcb(type, Buffer.alloc(0))])), true);
    for (const bad of [
      Buffer.from([0]), // truncated parameter header
      Buffer.concat([u16(1), u16(3), Buffer.from([1, 2])]), // truncated value
      Buffer.concat([u16(3), u16(0), u16(1), u16(0)]), // decreasing keys
      Buffer.concat([u16(1), u16(0), u16(1), u16(0)]), // duplicate keys
      Buffer.concat([u16(0), u16(2), u16(9), validParams]), // mandatory key is absent
      Buffer.concat([u16(0), u16(4), u16(3), u16(1), validParams]), // unsorted mandatory list
    ]) {
      assert.equal(valid(buildResponse(QUERY, [makeSvcb(type, bad)])), false,
        `type ${type}: malformed SvcParams`);
    }
  }
});

test("legacy NXT bitmap framing rejects truncated and noncanonical bitmaps", () => {
  const makeNxt = (bitmap) => resourceRecord("example.com", 30,
    Buffer.concat([encodeName("next.example.net"), bitmap]));
  assert.equal(valid(buildResponse(QUERY, [makeNxt(Buffer.from([0, 0, 0, 2]))])), true);
  for (const bitmap of [
    Buffer.from([0, 0, 2]), // shorter than four bytes
    Buffer.from([0, 0, 0, 0]), // NXT bit missing and trailing zero
    Buffer.from([0x80, 0, 0, 2]), // reserved type-zero bit set
    Buffer.from([0, 0, 0, 2, 0]), // trailing zero octet
    Buffer.alloc(17, 0xff), // exceeds the legacy flat bitmap
  ]) {
    assert.equal(valid(buildResponse(QUERY, [makeNxt(bitmap)])), false);
  }
});


test("NSAP-PTR uses its historical character-string RDATA, while DSYNC names stay uncompressed", () => {
  const nsapPtr = resourceRecord("example.com", 23, characterString("4444333322221111"));
  const nsapStringOffset = answerStart(QUERY) + encodeName("example.com").length + 10 + 1;
  const nsapStringPointer = Buffer.from([0xc0 | (nsapStringOffset >> 8), nsapStringOffset & 0xff]);
  const pointerIntoString = resourceRecord(nsapStringPointer, 1, Buffer.from([192, 0, 2, 53]));
  assert.equal(valid(buildResponse(QUERY, [nsapPtr])), true);
  assert.equal(valid(buildResponse(QUERY, [nsapPtr, pointerIntoString])), false,
    "character-string contents must not become DNS compression targets");

  const dsync = resourceRecord("example.com", 66,
    Buffer.concat([u16(59), Buffer.from([1]), u16(5359), encodeName("notify.example.net")]));
  const dsyncTargetOffset = answerStart(QUERY) + encodeName("example.com").length + 10 + 5;
  const dsyncTargetPointer = Buffer.from([0xc0 | (dsyncTargetOffset >> 8), dsyncTargetOffset & 0xff]);
  const followup = resourceRecord(dsyncTargetPointer, 1, Buffer.from([192, 0, 2, 53]));
  assert.equal(valid(buildResponse(QUERY, [dsync, followup])), true);

  const truncatedNsapPtr = resourceRecord("example.com", 23, Buffer.from([5, 0x31, 0x32]));
  const compressedDsync = resourceRecord("example.com", 66,
    Buffer.concat([u16(59), Buffer.from([1]), u16(5359), PTR_QUESTION]));
  const shortDsync = resourceRecord("example.com", 66,
    Buffer.concat([u16(59), Buffer.from([1]), u16(5359), Buffer.from([3, 97])]));
  assert.equal(valid(buildResponse(QUERY, [truncatedNsapPtr])), false);
  assert.equal(valid(buildResponse(QUERY, [compressedDsync])), false);
  assert.equal(valid(buildResponse(QUERY, [shortDsync])), false);
});

test("DELEGPARAM and DELEG enforce ordered fields, uncompressed names, and server-info sets", () => {
  const tlv = (key, value) => Buffer.concat([u16(key), u16(value.length), value]);
  const addressInfo = tlv(1, Buffer.from([192, 0, 2, 1]));
  const ipv6Info = tlv(2, Buffer.alloc(16, 0x20));
  const nameInfo = tlv(3, Buffer.concat([encodeName("ns1.example.net"), encodeName("ns2.example.net")]));
  const includeInfo = tlv(4, encodeName("shared.example.net"));
  const mandatoryIpv4 = tlv(0, u16(1));
  const mandatoryName = tlv(0, u16(3));

  for (const type of [54, 61440]) {
    const makeRecord = (value) => resourceRecord("example.com", type, value);
    assert.equal(valid(buildResponse(QUERY, [makeRecord(Buffer.alloc(0))])), true);
    for (const validInfo of [
      Buffer.concat([mandatoryIpv4, addressInfo]),
      ipv6Info,
      Buffer.concat([addressInfo, ipv6Info]),
      Buffer.concat([mandatoryName, nameInfo]),
      includeInfo,
    ]) {
      assert.equal(valid(buildResponse(QUERY, [makeRecord(validInfo)])), true,
        `type ${type}: valid server-information set`);
    }

    const nameTargetOffset = answerStart(QUERY) + encodeName("example.com").length + 10 + 4;
    const nameTargetPointer = Buffer.from([0xc0 | (nameTargetOffset >> 8), nameTargetOffset & 0xff]);
    const followup = resourceRecord(nameTargetPointer, 1, Buffer.from([192, 0, 2, 54]));
    assert.equal(valid(buildResponse(QUERY, [makeRecord(nameInfo), followup])), true,
      `type ${type}: uncompressed embedded names are valid compression targets`);

    const badOrder = Buffer.concat([nameInfo, addressInfo]);
    const duplicate = Buffer.concat([addressInfo, addressInfo]);
    const truncated = Buffer.concat([u16(3), u16(10), encodeName("ns.example.net")]);
    const compressedName = tlv(3, PTR_QUESTION);
    const badMandatory = tlv(0, u16(0));
    const unsortedMandatory = tlv(0, Buffer.concat([u16(3), u16(1)]));
    const missingMandatoryTarget = Buffer.concat([mandatoryIpv4, ipv6Info]);
    const badIpv4Length = tlv(1, Buffer.from([192, 0, 2]));
    const mixedAddressAndName = Buffer.concat([addressInfo, nameInfo]);
    const mixedNameAndInclude = Buffer.concat([nameInfo, includeInfo]);
    const mixedAddressAndInclude = Buffer.concat([addressInfo, includeInfo]);
    const unknownOnly = tlv(100, Buffer.alloc(0));
    for (const bad of [badOrder, duplicate, truncated, compressedName, badMandatory,
      unsortedMandatory, missingMandatoryTarget, badIpv4Length, mixedAddressAndName,
      mixedNameAndInclude, mixedAddressAndInclude, unknownOnly]) {
      assert.equal(valid(buildResponse(QUERY, [makeRecord(bad)])), false,
        `type ${type}: malformed or incompatible DelegInfos`);
    }
  }
});
