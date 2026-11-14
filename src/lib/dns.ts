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

// RDATA layouts for record types with known structured fields. A positive number
// is a fixed-size field (bytes); the negative markers are variable fields.
const NAME = -1; // domain name, compression allowed
const NAME_UNCOMPRESSED = -2; // domain name, compression forbidden
const CHARACTER_STRING = -3; // length-prefixed <character-string>

interface RdataLayout {
  readonly fields: readonly number[];
  /** True when signature bytes may follow the final name (SIG/RRSIG). */
  readonly opaqueTail?: boolean;
}

const SINGLE_NAME: RdataLayout = { fields: [NAME] };
const SINGLE_NAME_UNCOMPRESSED: RdataLayout = { fields: [NAME_UNCOMPRESSED] };
const TWO_NAMES: RdataLayout = { fields: [NAME, NAME] };
const PREFERENCE_NAME: RdataLayout = { fields: [2, NAME] };
const PREFERENCE_NAME_UNCOMPRESSED: RdataLayout = { fields: [2, NAME_UNCOMPRESSED] };
const TALINK_LAYOUT: RdataLayout = { fields: [NAME_UNCOMPRESSED, NAME_UNCOMPRESSED] };
// RFC 4034: RRSIG has an 18-byte fixed prefix and an uncompressed Signer's Name.
const RRSIG_LAYOUT: RdataLayout = { fields: [18, NAME_UNCOMPRESSED], opaqueTail: true };

/**
 * Compression is accepted for the RFC 1035 types and for legacy types that
 * RFC 3597, section 4 says receivers SHOULD decompress (RP, AFSDB, RT, SIG,
 * PX, NXT, NAPTR, SRV). Some records have conditional layouts and are handled
 * separately below. Unknown RDATA remains opaque by design.
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
  [23, { fields: [CHARACTER_STRING] }], // NSAP-PTR: historical RDATA is one character-string (RFC 1348)
  [15, PREFERENCE_NAME], // MX
  [17, TWO_NAMES], // RP
  [18, PREFERENCE_NAME], // AFSDB
  [21, PREFERENCE_NAME], // RT
  [24, { fields: [18, NAME], opaqueTail: true }], // SIG: fixed fields, signer name, signature
  [26, { fields: [2, NAME, NAME] }], // PX
  [33, { fields: [6, NAME] }], // SRV: priority, weight, port, target
  [35, { fields: [4, CHARACTER_STRING, CHARACTER_STRING, CHARACTER_STRING, NAME] }], // NAPTR
  [36, PREFERENCE_NAME_UNCOMPRESSED], // KX (RFC 2230: RDATA MUST NOT be compressed)
  [39, SINGLE_NAME_UNCOMPRESSED], // DNAME (RFC 6672: target MUST be uncompressed)
  [46, RRSIG_LAYOUT], // RRSIG (RFC 4034: Signer's Name MUST be uncompressed)
  [58, TALINK_LAYOUT], // TALINK: both linked names are uncompressed
  [64, { fields: [2, NAME_UNCOMPRESSED] }], // SVCB; SvcParams parsed separately
  [65, { fields: [2, NAME_UNCOMPRESSED] }], // HTTPS; SvcParams parsed separately
  [66, { fields: [5, NAME_UNCOMPRESSED] }], // DSYNC (RFC 9859)
  [107, PREFERENCE_NAME_UNCOMPRESSED], // LP
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
 * `suffixLengths` stores expanded lengths only for suffixes of fully
 * uncompressed names. A non-zero entry therefore marks a safe literal-label
 * compression target and supplies its expanded wire length. Names containing
 * a pointer are deliberately not added as targets: this rejects nested
 * compression pointers (RFC 9267 section 2) without following pointer chains.
 */
const MAX_NAME_LABELS = 127;
const NAME_LABEL_OFFSETS = new Uint16Array(MAX_NAME_LABELS);
const NAME_LABEL_LENGTHS = new Uint8Array(MAX_NAME_LABELS);

function skipName(
  message: Uint8Array,
  start: number,
  allowCompression: boolean,
  suffixLengths: Uint8Array,
): number | null {
  let offset = start;
  let labelCount = 0;
  let suffixLength = 0;
  let nextOffset = 0;
  let uncompressed = false;

  while (offset < message.byteLength) {
    const lengthOffset = offset;
    const length = message[offset];

    if (length === 0) {
      suffixLength = 1; // The root label occupies one wire octet.
      suffixLengths[lengthOffset] = suffixLength;
      nextOffset = offset + 1;
      uncompressed = true;
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      if (!allowCompression || offset + 1 >= message.byteLength) return null;

      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      // Targets must be earlier literal-label offsets in a previously
      // validated, fully uncompressed suffix. This prevents cycles, pointers
      // into arbitrary fields and nested pointer chains.
      if (pointer < 12 || pointer >= offset || suffixLengths[pointer] === 0) return null;

      suffixLength = suffixLengths[pointer];
      nextOffset = offset + 2;
      break;
    }

    // Not a pointer and not 0b00 (0x40/0x80 are reserved label types). After
    // this check `length` is at most 63.
    if ((length & 0xc0) !== 0 || offset + 1 + length > message.byteLength) return null;
    if (labelCount === MAX_NAME_LABELS) return null;

    NAME_LABEL_OFFSETS[labelCount] = lengthOffset;
    NAME_LABEL_LENGTHS[labelCount] = length + 1; // Label length octet + contents.
    labelCount += 1;
    offset += 1 + length;
  }

  if (nextOffset === 0) return null; // No root label or compression pointer.

  // Work backward from the root or cached literal suffix. The longest legal
  // encoded name is 255 octets, so at most 127 non-empty labels can be present.
  // Only root-terminated names may become targets; a name ending in a pointer
  // is valid here but is not safe as a target for another compression pointer.
  for (let i = labelCount - 1; i >= 0; i -= 1) {
    suffixLength += NAME_LABEL_LENGTHS[i];
    if (suffixLength > 255) return null;
    if (uncompressed) suffixLengths[NAME_LABEL_OFFSETS[i]] = suffixLength;
  }

  return nextOffset;
}

interface QuestionRange {
  readonly end: number;
  readonly typeOffset: number;
  /** False only for QDCOUNT=0 responses, which carry no question to match. */
  readonly present: boolean;
}

function validateNsecBitmap(message: Uint8Array, start: number, end: number): boolean {
  let offset = start;
  let previousWindow = -1;

  // RFC 4034 section 4.1.2 defines one or more ordered window blocks.
  while (offset < end) {
    if (offset + 2 > end) return false;
    const window = message[offset];
    const length = message[offset + 1];
    offset += 2;

    if (window <= previousWindow || length === 0 || length > 32 || offset + length > end) return false;
    // Trailing zero octets are forbidden; the last byte must carry a bit.
    if (message[offset + length - 1] === 0) return false;
    offset += length;
    previousWindow = window;
  }

  return offset === end && previousWindow >= 0;
}

function validateNxtBitmap(message: Uint8Array, start: number, end: number): boolean {
  // Legacy RFC 2535 NXT uses a flat bitmap. Its own type bit (30) must be set,
  // type zero must be clear, the bitmap is at least four octets, and trailing
  // zero octets are not permitted.
  const length = end - start;
  return length >= 4 && length <= 16 &&
    (message[start] & 0x80) === 0 &&
    (message[start + 3] & 0x02) !== 0 &&
    message[end - 1] !== 0;
}

type TlvValueValidator = (
  message: Uint8Array,
  key: number,
  valueStart: number,
  valueEnd: number,
  suffixLengths: Uint8Array,
) => boolean;

function validateOrderedTlvList(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
  validateValue: TlvValueValidator,
): boolean {
  let offset = start;
  let previousKey = -1;
  let mandatoryKeys: number[] | null = null;
  let nextMandatoryKey = 0;

  while (offset < end) {
    if (offset + 4 > end) return false;
    const key = readUint16(message, offset);
    const length = readUint16(message, offset + 2);
    offset += 4;
    const valueEnd = offset + length;
    if (key <= previousKey || valueEnd > end ||
        !validateValue(message, key, offset, valueEnd, suffixLengths)) return false;

    if (key === 0) {
      // The mandatory key is a non-empty, strictly increasing uint16 list.
      // It cannot include itself, and every listed key must occur in this RR.
      if (length < 2 || length % 2 !== 0) return false;
      mandatoryKeys = [];
      let previousMandatoryKey = 0;
      for (let valueOffset = offset; valueOffset < valueEnd; valueOffset += 2) {
        const mandatoryKey = readUint16(message, valueOffset);
        if (mandatoryKey === 0 || mandatoryKey <= previousMandatoryKey) return false;
        mandatoryKeys.push(mandatoryKey);
        previousMandatoryKey = mandatoryKey;
      }
    } else if (mandatoryKeys !== null && nextMandatoryKey < mandatoryKeys.length) {
      const requiredKey = mandatoryKeys[nextMandatoryKey];
      if (requiredKey < key) return false;
      if (requiredKey === key) nextMandatoryKey += 1;
    }

    offset = valueEnd;
    previousKey = key;
  }

  return offset === end && (mandatoryKeys === null || nextMandatoryKey === mandatoryKeys.length);
}

function validateDelegInfoValue(
  message: Uint8Array,
  key: number,
  valueStart: number,
  valueEnd: number,
  suffixLengths: Uint8Array,
): boolean {
  const length = valueEnd - valueStart;

  if (key === 1) return length > 0 && length % 4 === 0; // server-ipv4
  if (key === 2) return length > 0 && length % 16 === 0; // server-ipv6

  if (key === 3 || key === 4) {
    // server-name and include-delegparam are concatenated, uncompressed names.
    if (length === 0) return false;
    let offset = valueStart;
    while (offset < valueEnd) {
      const next = skipName(message, offset, false, suffixLengths);
      if (next === null || next > valueEnd) return false;
      offset = next;
    }
    return offset === valueEnd;
  }

  // Future DelegInfoKeys are opaque until their value formats are registered.
  return true;
}

function validateDelegInfos(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  // DELEG/DELEGPARAM reuse ordered key/length/value framing. Keys 3 and 4
  // contain uncompressed names; every non-empty list must also select exactly
  // one server-information set (IPv4, IPv6, both, server-name, or include).
  let hasIpv4 = false;
  let hasIpv6 = false;
  let hasServerName = false;
  let hasIncludeDelegparam = false;
  const valid = validateOrderedTlvList(
    message,
    start,
    end,
    suffixLengths,
    (data, key, valueStart, valueEnd, suffixes) => {
      if (key === 1) hasIpv4 = true;
      else if (key === 2) hasIpv6 = true;
      else if (key === 3) hasServerName = true;
      else if (key === 4) hasIncludeDelegparam = true;
      return validateDelegInfoValue(data, key, valueStart, valueEnd, suffixes);
    },
  );
  if (!valid || start === end) return valid;

  const hasAddressInfo = hasIpv4 || hasIpv6;
  const hasNameInfo = hasServerName || hasIncludeDelegparam;
  if (hasAddressInfo) return !hasNameInfo;
  return hasServerName !== hasIncludeDelegparam;
}

function validateA6Rdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  if (start >= end) return false;
  const prefixLength = message[start];
  if (prefixLength > 128) return false;

  const suffixBytes = Math.ceil((128 - prefixLength) / 8);
  const nameStart = start + 1 + suffixBytes;
  if (nameStart > end) return false;
  if (prefixLength === 0) return nameStart === end;

  const nameEnd = skipName(message, nameStart, false, suffixLengths);
  return nameEnd === end;
}

function validateIpsecKeyRdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  if (start + 3 > end) return false;
  const gatewayType = message[start + 1];
  let offset = start + 3;

  if (gatewayType === 1) offset += 4;
  else if (gatewayType === 2) offset += 16;
  else if (gatewayType === 3) {
    const nameEnd = skipName(message, offset, false, suffixLengths);
    if (nameEnd === null || nameEnd > end) return false;
    offset = nameEnd;
  } else if (gatewayType !== 0) {
    return false;
  }

  // The remaining public-key bytes are algorithm-specific opaque data.
  return offset <= end;
}

function validateHipRdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  if (start + 4 > end) return false;
  const hitLength = message[start];
  const publicKeyLength = readUint16(message, start + 2);
  let offset = start + 4 + hitLength + publicKeyLength;
  if (offset > end) return false;

  // The RVS field is optional; when present it is a sequence of uncompressed
  // domain names (RFC 8005 section 5.6).
  while (offset < end) {
    const nameEnd = skipName(message, offset, false, suffixLengths);
    if (nameEnd === null || nameEnd > end) return false;
    offset = nameEnd;
  }
  return offset === end;
}

function validateTkeyRdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  const algorithmEnd = skipName(message, start, false, suffixLengths);
  if (algorithmEnd === null || algorithmEnd + 16 > end) return false;

  // Inception(4), expiration(4), mode(2), error(2), key size(2).
  let offset = algorithmEnd + 12;
  const keyLength = readUint16(message, offset);
  offset += 2 + keyLength;
  if (offset + 2 > end) return false;
  const otherLength = readUint16(message, offset);
  offset += 2;
  return offset + otherLength === end;
}

function validateTsigRdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  const algorithmEnd = skipName(message, start, false, suffixLengths);
  if (algorithmEnd === null || algorithmEnd + 10 > end) return false;

  // Time Signed(6), Fudge(2), MAC Size(2), MAC, Original ID(2),
  // Error(2), Other Len(2), Other Data.
  const macLength = readUint16(message, algorithmEnd + 8);
  let offset = algorithmEnd + 10 + macLength;
  if (offset + 6 > end) return false;
  const otherLength = readUint16(message, offset + 4);
  offset += 6;
  return offset + otherLength === end;
}

function validateAmtrelayRdata(
  message: Uint8Array,
  start: number,
  end: number,
  suffixLengths: Uint8Array,
): boolean {
  if (start + 2 > end) return false;
  const relayType = message[start + 1] & 0x7f;
  const relayStart = start + 2;
  if (relayType === 0) return relayStart === end;
  if (relayType === 1) return relayStart + 4 === end;
  if (relayType === 2) return relayStart + 16 === end;
  if (relayType === 3) {
    const nameEnd = skipName(message, relayStart, false, suffixLengths);
    return nameEnd === end;
  }
  // Undefined relay types have no standardized shape; preserve their opaque
  // payload rather than interpreting arbitrary bytes as a domain name.
  return true;
}

/**
 * Validates the domain names and selected variable-length field framing in
 * RDATA for RR types with known wire layouts. Only suffixes of fully
 * uncompressed names become eligible compression targets. Unknown RDATA is
 * deliberately opaque and never contributes compression targets.
 */
function validateRdataNames(
  message: Uint8Array,
  type: number,
  rdataStart: number,
  rdLength: number,
  suffixLengths: Uint8Array,
): boolean {
  const end = rdataStart + rdLength;

  // Records with conditional fields are clearer and safer as explicit parsers.
  if (type === 38) return validateA6Rdata(message, rdataStart, end, suffixLengths);
  if (type === 45) return validateIpsecKeyRdata(message, rdataStart, end, suffixLengths);
  if (type === 54 || type === 61440) return validateDelegInfos(message, rdataStart, end, suffixLengths);
  if (type === 55) return validateHipRdata(message, rdataStart, end, suffixLengths);
  if (type === 249) return validateTkeyRdata(message, rdataStart, end, suffixLengths);
  if (type === 250) return validateTsigRdata(message, rdataStart, end, suffixLengths);
  if (type === 260) return validateAmtrelayRdata(message, rdataStart, end, suffixLengths);

  if (type === 47 || type === 30) {
    const nameEnd = skipName(message, rdataStart, type === 30, suffixLengths);
    if (nameEnd === null || nameEnd > end) return false;
    return type === 47
      ? validateNsecBitmap(message, nameEnd, end)
      : validateNxtBitmap(message, nameEnd, end);
  }

  const layout = RDATA_LAYOUTS.get(type);
  if (!layout) return true;

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
      const next = skipName(message, offset, field === NAME, suffixLengths);
      if (next === null || next > end) return false;
      offset = next;
    }
  }

  if ((type === 24 || type === 46) && offset === end) return false; // SIG/RRSIG needs signature bytes.
  // RFC 9460 section 2.2: SvcParam keys are strictly increasing and values are
  // bounded. Individual SvcParam value semantics are key-specific and remain
  // the responsibility of an SVCB-aware client, so values are accepted as-is.
  if (type === 64 || type === 65) return validateOrderedTlvList(message, offset, end, suffixLengths, () => true);
  return layout.opaqueTail ? offset <= end : offset === end;
}

function parseResourceRecord(message: Uint8Array, start: number, suffixLengths: Uint8Array): number | null {
  let offset = skipName(message, start, true, suffixLengths);
  if (offset === null || offset + 10 > message.byteLength) return null;

  const type = readUint16(message, offset);
  offset += 8; // type (2) + class (2) + ttl (4)
  const rdLength = readUint16(message, offset);
  offset += 2;

  const end = offset + rdLength;
  if (end > message.byteLength) return null;

  // Only suffixes of fully uncompressed decoded names become compression
  // targets; opaque RDATA and compressed names contribute none.
  if (!validateRdataNames(message, type, offset, rdLength, suffixLengths)) return null;
  return end;
}

// Validation is synchronous, so one scratch suffix-length table sized for the
// largest accepted response is reused instead of allocating up to 64 KiB per
// message. Each entry is zero for an invalid target or 1–255 for a validated
// suffix's expanded wire length.
const SCRATCH_SUFFIX_LENGTHS = new Uint8Array(MAX_DNS_RESPONSE_SIZE);

/** A zeroed compression-suffix table for a message of `length` bytes. */
function compressionSuffixLengths(length: number): Uint8Array {
  if (length > SCRATCH_SUFFIX_LENGTHS.byteLength) return new Uint8Array(length);
  const suffixLengths = SCRATCH_SUFFIX_LENGTHS.subarray(0, length);
  suffixLengths.fill(0);
  return suffixLengths;
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

  const suffixLengths = compressionSuffixLengths(message.byteLength);
  let question: QuestionRange;
  if (counts.questions === 1) {
    // Question QNAME compression stays rejected: a response question is the
    // first name in the message, so there is no earlier name to point at.
    const questionNameEnd = skipName(message, 12, false, suffixLengths);
    if (questionNameEnd === null || questionNameEnd + 4 > message.byteLength) return null;
    question = { end: questionNameEnd + 4, typeOffset: questionNameEnd, present: true };
  } else {
    question = { end: 12, typeOffset: 12, present: false };
  }

  let offset = question.end;

  const recordCount = counts.answers + counts.authorities + counts.additionals;
  for (let i = 0; i < recordCount; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, suffixLengths);
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
