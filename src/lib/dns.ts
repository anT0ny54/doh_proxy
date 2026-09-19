export const DNS_MESSAGE = "application/dns-message";
export const MAX_DNS_MESSAGE_SIZE = 4_096;

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
 */
function skipName(
  message: Uint8Array,
  start: number,
  allowCompression: boolean,
  nameStarts?: Set<number>,
): number | null {
  let offset = start;
  let nextOffset = start;
  let jumped = false;
  let jumps = 0;
  let nameLength = 0;

  if (nameStarts) nameStarts.add(start);

  while (offset < message.byteLength) {
    const lengthOffset = offset;
    const length = message[offset];

    if (length === 0) {
      if (nameLength + 1 > 255) return null;
      if (nameStarts) nameStarts.add(offset);
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
        (nameStarts && !nameStarts.has(pointer)) ||
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
    if (nameStarts) nameStarts.add(lengthOffset);
    nameLength += 1 + length;
    if (nameLength > 255) return null;
    offset += 1 + length;
  }

  return null;
}

interface QuestionRange {
  readonly end: number;
  readonly typeOffset: number;
}

function parseResourceRecord(message: Uint8Array, start: number, nameStarts: Set<number>): number | null {
  let offset = skipName(message, start, true, nameStarts);
  if (offset === null || offset + 10 > message.byteLength) return null;

  offset += 8;
  const rdLength = readUint16(message, offset);
  offset += 2;

  if (offset + rdLength > message.byteLength) return null;
  return offset + rdLength;
}

function validateStructure(message: Uint8Array, expectedResponse: boolean): QuestionRange | null {
  const counts = readCounts(message);
  if (!counts || message.byteLength > MAX_DNS_MESSAGE_SIZE) return null;

  const flags = readUint16(message, 2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >>> 11) & 0x0f;

  if (isResponse !== expectedResponse || opcode !== 0) return null;
  if (counts.questions !== 1) return null;

  const nameStarts = new Set<number>();
  const questionNameStart = 12;
  const questionNameEnd = skipName(message, questionNameStart, false, nameStarts);
  if (questionNameEnd === null || questionNameEnd + 4 > message.byteLength) return null;
  const question = { end: questionNameEnd + 4, typeOffset: questionNameEnd };

  let offset = question.end;

  for (let i = 0; i < counts.answers; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, nameStarts);
    if (nextOffset === null) return null;
    offset = nextOffset;
  }

  for (let i = 0; i < counts.authorities; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, nameStarts);
    if (nextOffset === null) return null;
    offset = nextOffset;
  }

  for (let i = 0; i < counts.additionals; i += 1) {
    const nextOffset = parseResourceRecord(message, offset, nameStarts);
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

export function isValidDnsResponse(message: Uint8Array, query?: Uint8Array): boolean {
  const responseQuestion = validateStructure(message, true);
  if (responseQuestion === null) return false;
  if (!query) return true;

  const queryQuestion = validateStructure(query, false);
  if (queryQuestion === null || message.byteLength < 2 || query.byteLength < 2) return false;
  if (readUint16(message, 0) !== readUint16(query, 0)) return false;

  const responseKey = questionKey(message, responseQuestion);
  const queryKey = questionKey(query, queryQuestion);
  if (responseKey.byteLength !== queryKey.byteLength) return false;

  for (let i = 0; i < queryKey.byteLength; i += 1) {
    if (responseKey[i] !== queryKey[i]) return false;
  }

  return true;
}
