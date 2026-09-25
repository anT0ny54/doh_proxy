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
 * permits as compression targets. RDATA regions are conservatively marked in
 * full because the parser does not decode every RR-specific RDATA format, while
 * still requiring the target to be in already-parsed bytes.
 */
function skipName(
  message: Uint8Array,
  start: number,
  allowCompression: boolean,
  targets?: Uint8Array,
): number | null {
  let offset = start;
  let nextOffset = start;
  let jumped = false;
  let jumps = 0;
  let expandedNameLength = 0;
  let totalBytesWalked = 0;
  const maxBytesWalked = message.byteLength * 4;

  if (targets) targets[start] = 1;

  while (offset < message.byteLength) {
    // Hard cap on total bytes walked to prevent O(n²) attacks via compression pointers
    if (++totalBytesWalked > maxBytesWalked) return null;

    const lengthOffset = offset;
    const length = message[offset];

    if (length === 0) {
      expandedNameLength += 1;
      if (expandedNameLength > 255) return null;
      if (targets) targets[offset] = 1;
      return jumped ? nextOffset : offset + 1;
    }

    if ((length & 0xc0) === 0xc0) {
      if (!allowCompression || offset + 1 >= message.byteLength) return null;

      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      // A pointer must target an earlier byte that has already been parsed as
      // part of a DNS domain name. This prevents pointers into unrelated
      // header/type/class/RDATA bytes that merely happen to look name-like.
      if (
        pointer < 12 ||
        pointer >= message.byteLength ||
        pointer >= offset ||
        (targets && targets[pointer] === 0) ||
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

    if ((length & 0xc0) !== 0 || length > 63 || offset + 1 + length > message.byteLength) return null;
    if (targets) targets[lengthOffset] = 1;
    expandedNameLength += 1 + length;
    if (expandedNameLength > 255) return null;
    offset += 1 + length;
  }

  return null;
}

interface QuestionRange {
  readonly end: number;
  readonly typeOffset: number;
}

function parseResourceRecord(message: Uint8Array, start: number, targets: Uint8Array): number | null {
  let offset = skipName(message, start, true, targets);
  if (offset === null || offset + 10 > message.byteLength) return null;

  offset += 8;
  const rdLength = readUint16(message, offset);
  offset += 2;

  const end = offset + rdLength;
  if (end > message.byteLength) return null;

  // Names embedded in RDATA are valid compression targets for later records.
  targets.fill(1, offset, end);
  return end;
}

function validateStructure(message: Uint8Array, expectedResponse: boolean): QuestionRange | null {
  const counts = readCounts(message);
  const maxSize = expectedResponse ? MAX_DNS_RESPONSE_SIZE : MAX_DNS_MESSAGE_SIZE;
  if (!counts || message.byteLength > maxSize) return null;

  const flags = readUint16(message, 2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >>> 11) & 0x0f;

  if (isResponse !== expectedResponse || opcode !== 0) return null;
  if (counts.questions !== 1) return null;

  const targets = new Uint8Array(message.byteLength);
  const questionNameStart = 12;
  const questionNameEnd = skipName(message, questionNameStart, false, targets);
  if (questionNameEnd === null || questionNameEnd + 4 > message.byteLength) return null;
  const question = { end: questionNameEnd + 4, typeOffset: questionNameEnd };

  let offset = question.end;

  const recordCount = counts.answers + counts.authorities + counts.additionals;
  for (let i = 0; i < recordCount; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, targets);
    if (nextOffset === null) return null;
    offset = nextOffset;
  }

  return offset === message.byteLength ? question : null;
}

export function isValidDnsQuery(message: Uint8Array): boolean {
  return validateStructure(message, false) !== null;
}

function questionKey(message: Uint8Array, range: QuestionRange): Uint8Array {
  const key = message.slice(12, range.end);
  const qnameEnd = range.typeOffset - 12;

  // DNS names are case-insensitive. Only ASCII letters have DNS case-folding;
  // leave length/type/class bytes and non-ASCII octets untouched.
  for (let i = 0; i < qnameEnd; i += 1) {
    const value = key[i];
    if (value >= 0x41 && value <= 0x5a) key[i] = value + 0x20;
  }

  return key;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isValidDnsResponse(message: Uint8Array, query?: Uint8Array): boolean {
  const responseQuestion = validateStructure(message, true);
  if (responseQuestion === null) return false;
  if (!query) return true;

  const queryQuestion = validateStructure(query, false);
  if (queryQuestion === null || message.byteLength < 2 || query.byteLength < 2) return false;
  if (readUint16(message, 0) !== readUint16(query, 0)) return false;

  const responseKey = questionKey(message, responseQuestion);
  const queryKey = questionKey(query, queryQuestion);

  return bytesEqual(responseKey, queryKey);
}
