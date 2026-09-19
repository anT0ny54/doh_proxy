import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/dns.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const dns = await import(moduleUrl);

function queryWithName(nameBytes, id = 1) {
  return Uint8Array.from([
    id >>> 8,
    id & 0xff,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...nameBytes,
    0,
    0,
    1,
    0,
    1,
  ]);
}

const validQuery = Uint8Array.from([
  0,
  1,
  1,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  3,
  119,
  119,
  119,
  7,
  101,
  120,
  97,
  109,
  112,
  108,
  101,
  0,
  0,
  1,
  0,
  1,
]);

function validResponse(query = validQuery) {
  const question = query.slice(12);
  return Uint8Array.from([
    query[0],
    query[1],
    0x81,
    0x80,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...question,
    0xc0,
    0x0c,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x3c,
    0x00,
    0x04,
    1,
    2,
    3,
    4,
  ]);
}

await test("accepts a normal DNS query", () => {
  assert.equal(dns.isValidDnsQuery(validQuery), true);
});

await test("rejects a response presented as a query", () => {
  const response = Uint8Array.from(validQuery);
  response[2] |= 0x80;
  assert.equal(dns.isValidDnsQuery(response), false);
});

await test("rejects a compressed first-question QNAME without a prior name", () => {
  const query = Uint8Array.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
  assert.equal(dns.isValidDnsQuery(query), false);
});

await test("accepts backward compression in a resource-record owner name", () => {
  assert.equal(dns.isValidDnsResponse(validResponse(), validQuery), true);
});

await test("rejects forward compression pointers", () => {
  const response = validResponse();
  const answerNameOffset = validQuery.length;
  response[answerNameOffset] = 0xc0;
  response[answerNameOffset + 1] = response.length - 1;
  assert.equal(dns.isValidDnsResponse(response), false);
});

await test("rejects compression pointers into unrelated question fields", () => {
  const response = validResponse();
  const answerNameOffset = validQuery.length;
  // Offset 26 is the first byte of QTYPE, not the start of a domain name.
  response[answerNameOffset] = 0xc0;
  response[answerNameOffset + 1] = 26;
  assert.equal(dns.isValidDnsResponse(response, validQuery), false);
});

await test("rejects compression pointers that point before the DNS message", () => {
  const response = Uint8Array.from([
    0,
    1,
    0x80,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    3,
    119,
    119,
    119,
    0,
    0,
    1,
    0,
    1,
    0xc0,
    0x00,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    4,
    1,
    2,
    3,
    4,
  ]);
  assert.equal(dns.isValidDnsResponse(response), false);
});

await test("rejects names longer than 255 octets", () => {
  const labels = [];
  let remaining = 256;
  while (remaining > 0) {
    const length = Math.min(63, remaining - 1);
    labels.push(length, ...new Array(length).fill(97));
    remaining -= length + 1;
  }
  assert.equal(dns.isValidDnsQuery(queryWithName(labels)), false);
});

await test("accepts a structurally valid DNS response", () => {
  assert.equal(dns.isValidDnsResponse(validResponse()), true);
});

await test("matches response transaction ID and question", () => {
  const query = validQuery;
  const response = validResponse(query);
  assert.equal(dns.isValidDnsResponse(response, query), true);

  const wrongId = validResponse(Uint8Array.from(query));
  wrongId[0] = 0x12;
  wrongId[1] = 0x34;
  assert.equal(dns.isValidDnsResponse(wrongId, query), false);

  const differentName = queryWithName([3, 119, 101, 98, 7, 101, 120, 97, 109, 112, 108, 101]);
  assert.equal(dns.isValidDnsResponse(validResponse(differentName), query), false);
});

await test("DNS question name matching is case-insensitive", () => {
  const response = validResponse();
  const qnameStart = 12;
  response[qnameStart + 1] = 87;
  response[qnameStart + 2] = 87;
  assert.equal(dns.isValidDnsResponse(response, validQuery), true);
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
  assert.equal(dns.isValidDnsResponse(response, query), true);
});
