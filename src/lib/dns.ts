export const DNS_MESSAGE = "application/dns-message";
/** Cap for client queries. Real queries are tiny; 4 KiB is generous. */
export const MAX_DNS_MESSAGE_SIZE = 4_096;
/**
 * Cap for upstream responses. RFC 8484 allows up to 65535 bytes, and DNSSEC
 * (DO bit) answers, large TXT sets and DNSKEY/RRSIG chains routinely exceed
 * 4 KiB. Rejecting them made otherwise valid lookups fail with a 502 after
 * burning every upstream in the failover list.
 */
export const MAX_DNS_RESPONSE_SIZE = 65_535;

// RDATA layouts of the record types that embed domain names. A positive number
// is a fixed-size field (bytes); the negative markers are variable fields.
const NAME = -1; // domain name, compression allowed
const NAME_UNCOMPRESSED = -2; // domain name, compression forbidden
const CHARACTER_STRING = -3; // length-prefixed <character-string>

interface RdataLayout {
  readonly fields: readonly number[];
  /** True when opaque data may follow the last field (SVCB/HTTPS SvcParams). */
  readonly opaqueTail?: boolean;
}

const SINGLE_NAME: RdataLayout = { fields: [NAME] };
const TWO_NAMES: RdataLayout = { fields: [NAME, NAME] };
const PREFERENCE_NAME: RdataLayout = { fields: [2, NAME] };
// RFC 9460, section 2.2: "Compression pointers MUST NOT be used in the target name".
const SVCB_LAYOUT: RdataLayout = { fields: [2, NAME_UNCOMPRESSED], opaqueTail: true };

/**
 * Compression is accepted for the RFC 1035 types and for the types that
 * RFC 3597, section 4 says receivers SHOULD decompress (RP, AFSDB, RT, PX,
 * SRV, NAPTR). Types not listed carry no domain names: their RDATA is opaque.
 */
const RDATA_LAYOUTS: ReadonlyMap<number, RdataLayout> = new Map([
  [2, SINGLE_NAME], // NS
  [3, SINGLE_NAME], // MD
  [4, SINGLE_NAME], // MF
  [5, SINGLE_NAME], // CNAME
  [6, { fields: [NAME, NAME, 20] }], // SOA: mname, rname, 5 x uint32
  [7, SINGLE_NAME], // MB
  [8, SINGLE_NAME], // MG
  [9, SINGLE_NAME], // MR
  [12, SINGLE_NAME], // PTR
  [14, TWO_NAMES], // MINFO
  [15, PREFERENCE_NAME], // MX
  [17, TWO_NAMES], // RP
  [18, PREFERENCE_NAME], // AFSDB
  [21, PREFERENCE_NAME], // RT
  [26, { fields: [2, NAME, NAME] }], // PX
  [33, { fields: [6, NAME] }], // SRV: priority, weight, port, target
  [35, { fields: [4, CHARACTER_STRING, CHARACTER_STRING, CHARACTER_STRING, NAME] }], // NAPTR
  [36, PREFERENCE_NAME], // KX
  [39, SINGLE_NAME], // DNAME
  [64, SVCB_LAYOUT], // SVCB
  [65, SVCB_LAYOUT], // HTTPS
]);

interface DnsCounts {
  readonly questions: number;
  readonly answers: number;
  readonly authorities: number;
  readonly additionals: number;
}

function readUint16(message: Uint8Array, offset: number): number {
  return (message[offset] << 8) | message[offset + 1];
}

function readCounts(message: Uint8Array): DnsCounts | null {
  if (message.byteLength < 12) return null;

  return {
    questions: readUint16(message, 4),
    answers: readUint16(message, 6),
    authorities: readUint16(message, 8),
    additionals: readUint16(message, 10),
  };
}

/**
 * Advances over a DNS name. Compression pointers may reference only earlier
 * bytes in the same DNS message, matching DNS backward-pointer semantics.
 *
 * `targets` is a per-message bitmap of offsets that this structural parser
 * permits as compression targets. Only bytes validated as part of a domain
 * name (question section, RR owner names, and RR-type-decoded RDATA names)
 * are marked; opaque RDATA contributes no targets, so a pointer cannot
 * reference arbitrary header/ttl/RDATA bytes that merely look name-like.
 */
function skipName(
  message: Uint8Array,
  start: number,
  allowCompression: boolean,
  targets: Uint8Array,
): number | null {
  let offset = start;
  let nextOffset = start;
  let jumped = false;
  let jumps = 0;
  let expandedNameLength = 0;

  targets[start] = 1;

  // Work is bounded without a separate step counter: an expanded name is capped
  // at 255 bytes (at most ~127 labels) and pointer jumps are capped at 16.
  while (offset < message.byteLength) {
    const lengthOffset = offset;
    const length = message[offset];

    if (length === 0) {
      expandedNameLength += 1;
      if (expandedNameLength > 255) return null;
      targets[offset] = 1;
      return jumped ? nextOffset : offset + 1;
    }

    if ((length & 0xc0) === 0xc0) {
      if (!allowCompression || offset + 1 >= message.byteLength) return null;

      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      // A pointer must target an earlier byte that has already been parsed as
      // part of a DNS domain name. This prevents pointers into unrelated
      // header/type/class/RDATA bytes that merely happen to look name-like.
      // `pointer < offset < byteLength`, so no separate upper-bound check is needed.
      if (
        pointer < 12 ||
        pointer >= offset ||
        targets[pointer] === 0 ||
        ++jumps > 16
      ) {
        return null;
      }
      if (!jumped) {
        nextOffset = offset + 2;
        jumped = true;
      }
      offset = pointer;
      continue;
    }

    // Not a pointer and not 0b00 (0x40/0x80 are reserved label types). After
    // this check `length` is at most 63.
    if ((length & 0xc0) !== 0 || offset + 1 + length > message.byteLength) return null;
    targets[lengthOffset] = 1;
    expandedNameLength += 1 + length;
    if (expandedNameLength > 255) return null;
    offset += 1 + length;
  }

  return null;
}

interface QuestionRange {
  readonly end: number;
  readonly typeOffset: number;
  /** False only for QDCOUNT=0 responses, which carry no question to match. */
  readonly present: boolean;
}

/**
 * Validates the domain names embedded in RDATA for the record types listed in
 * RDATA_LAYOUTS, marking only the validated name bytes as compression targets.
 * Returns false when name-bearing RDATA is malformed; returns true for types
 * whose RDATA carries no names (their bytes stay opaque and never become
 * compression targets).
 */
function validateRdataNames(
  message: Uint8Array,
  type: number,
  rdataStart: number,
  rdLength: number,
  targets: Uint8Array,
): boolean {
  const layout = RDATA_LAYOUTS.get(type);
  if (!layout) return true;

  const end = rdataStart + rdLength;
  let offset = rdataStart;
  for (const field of layout.fields) {
    if (field > 0) {
      offset += field;
      if (offset > end) return false;
    } else if (field === CHARACTER_STRING) {
      if (offset >= end) return false;
      offset += 1 + message[offset];
      if (offset > end) return false;
    } else {
      if (offset >= end) return false;
      const next = skipName(message, offset, field === NAME, targets);
      if (next === null || next > end) return false;
      offset = next;
    }
  }
  return layout.opaqueTail ? offset <= end : offset === end;
}

function parseResourceRecord(message: Uint8Array, start: number, targets: Uint8Array): number | null {
  let offset = skipName(message, start, true, targets);
  if (offset === null || offset + 10 > message.byteLength) return null;

  const type = readUint16(message, offset);
  offset += 8; // type (2) + class (2) + ttl (4)
  const rdLength = readUint16(message, offset);
  offset += 2;

  const end = offset + rdLength;
  if (end > message.byteLength) return null;

  // Only bytes decoded as genuine domain names become compression targets;
  // never the RDATA region as a whole.
  if (!validateRdataNames(message, type, offset, rdLength, targets)) return null;
  return end;
}

// Validation is synchronous, so one scratch bitmap sized for the largest
// accepted response is reused instead of allocating up to 64 KiB per message.
const SCRATCH_TARGETS = new Uint8Array(MAX_DNS_RESPONSE_SIZE);

/** A zeroed compression-target bitmap for a message of `length` bytes. */
function compressionTargets(length: number): Uint8Array {
  if (length > SCRATCH_TARGETS.byteLength) return new Uint8Array(length);
  const targets = SCRATCH_TARGETS.subarray(0, length);
  targets.fill(0);
  return targets;
}

function validateStructure(message: Uint8Array, expectedResponse: boolean): QuestionRange | null {
  // Responses are size-capped while they are read (see readResponseBody in
  // doh.ts); parseQuery is the only gate for the query cap.
  if (!expectedResponse && message.byteLength > MAX_DNS_MESSAGE_SIZE) return null;

  const counts = readCounts(message);
  if (!counts) return null;

  const flags = readUint16(message, 2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >>> 11) & 0x0f;

  if (isResponse !== expectedResponse || opcode !== 0) return null;
  // Queries must carry exactly one uncompressed question. Responses with
  // QDCOUNT=0 are rare but legal (some upstreams omit the question section);
  // relaying for them must not 502 across the whole failover list.
  if (expectedResponse ? counts.questions > 1 : counts.questions !== 1) return null;

  const targets = compressionTargets(message.byteLength);
  let question: QuestionRange;
  if (counts.questions === 1) {
    // Question QNAME compression stays rejected: a response question is the
    // first name in the message, so there is no earlier name to point at.
    const questionNameEnd = skipName(message, 12, false, targets);
    if (questionNameEnd === null || questionNameEnd + 4 > message.byteLength) return null;
    question = { end: questionNameEnd + 4, typeOffset: questionNameEnd, present: true };
  } else {
    question = { end: 12, typeOffset: 12, present: false };
  }

  let offset = question.end;

  const recordCount = counts.answers + counts.authorities + counts.additionals;
  for (let i = 0; i < recordCount; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, targets);
    if (nextOffset === null) return null;
    offset = nextOffset;
  }

  return offset === message.byteLength ? question : null;
}

/**
 * A validated query reduced to what response matching needs. Build it once per
 * request with {@link parseQuery} and reuse it for every upstream attempt
 * instead of re-parsing the query each time.
 */
export interface ParsedQuery {
  readonly id: number;
  /** Question section (QNAME, QTYPE, QCLASS) with ASCII letters in QNAME lower-cased. */
  readonly key: Uint8Array;
  readonly nameLength: number;
}

/** Validates a client query and returns its match data, or null if invalid. */
export function parseQuery(message: Uint8Array): ParsedQuery | null {
  const range = validateStructure(message, false);
  if (range === null) return null;

  // Always copy: Buffer#slice (the GET path passes a Buffer) returns a view, and
  // the case-folding below would otherwise rewrite the caller's bytes in place.
  const key = new Uint8Array(range.end - 12);
  key.set(message.subarray(12, range.end));
  const nameLength = range.typeOffset - 12;
  // DNS names are case-insensitive. Only ASCII letters have DNS case-folding;
  // leave length/type/class bytes and non-ASCII octets untouched.
  for (let i = 0; i < nameLength; i += 1) {
    const value = key[i];
    if (value >= 0x41 && value <= 0x5a) key[i] = value + 0x20;
  }

  return { id: readUint16(message, 0), key, nameLength };
}

/** Compares the response question to the query key without allocating. */
function questionMatches(message: Uint8Array, range: QuestionRange, query: ParsedQuery): boolean {
  const length = range.end - 12;
  // Same total length is not enough: the name/type boundary must line up too,
  // otherwise type/class bytes could be case-folded as if they were name bytes.
  if (length !== query.key.byteLength || range.typeOffset - 12 !== query.nameLength) return false;

  for (let i = 0; i < length; i += 1) {
    let value = message[12 + i];
    if (i < query.nameLength && value >= 0x41 && value <= 0x5a) value += 0x20;
    if (value !== query.key[i]) return false;
  }
  return true;
}

/**
 * Validates an upstream response structurally and, when a parsed query is
 * given, that it answers that query (transaction ID and Question section).
 */
export function isValidDnsResponse(message: Uint8Array, query?: ParsedQuery): boolean {
  const responseQuestion = validateStructure(message, true);
  if (responseQuestion === null) return false;
  if (!query) return true;

  if (readUint16(message, 0) !== query.id) return false;
  // A QDCOUNT=0 response has no question section; the transaction ID is the
  // only match available.
  if (!responseQuestion.present) return true;

  return questionMatches(message, responseQuestion, query);
}
