import { BSON, type Document } from "mongodb";

/** 库里的字符串按原码读出。半个表情是 UTF-16 的一个码，标准 UTF-8 不认，这里保留这个码，不换成替换符。 */
export function decodeStoredText(bytes: Uint8Array): string {
  const parts: string[] = [];
  let index = 0;
  while (index < bytes.length) {
    const surrogate = readSurrogate(bytes, index);
    if (surrogate) {
      parts.push(surrogate.text);
      index += surrogate.size;
      continue;
    }
    const width = validUtf8Width(bytes, index);
    if (width > 0) {
      parts.push(Buffer.from(bytes.subarray(index, index + width)).toString("utf8"));
      index += width;
      continue;
    }
    parts.push(String.fromCharCode(bytes[index] ?? 0));
    index += 1;
  }
  return parts.join("");
}

export function decodeDocument(value: Uint8Array): Document {
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return readDocument(buffer, 0).value as Document;
}

function readSurrogate(bytes: Uint8Array, index: number): { text: string; size: number } | undefined {
  const unit = surrogateUnit(bytes, index);
  if (unit == null) {
    return undefined;
  }
  const low = unit < 0xdc00 ? surrogateUnit(bytes, index + 3) : undefined;
  if (low != null && low >= 0xdc00) {
    return { text: String.fromCharCode(unit, low), size: 6 };
  }
  return { text: String.fromCharCode(unit), size: 3 };
}

function surrogateUnit(bytes: Uint8Array, index: number): number | undefined {
  const first = bytes[index];
  const second = bytes[index + 1];
  const third = bytes[index + 2];
  if (first !== 0xed || second == null || third == null || second < 0xa0 || second > 0xbf || (third & 0xc0) !== 0x80) {
    return undefined;
  }
  return 0xd000 + ((second & 0x3f) << 6) + (third & 0x3f);
}

function validUtf8Width(bytes: Uint8Array, index: number): number {
  const first = bytes[index] ?? 0;
  const need = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 0;
  if (need === 0 || index + need > bytes.length) {
    return 0;
  }
  if (need === 2 && first < 0xc2) {
    return 0;
  }
  if (first === 0xed && (bytes[index + 1] ?? 0) >= 0xa0) {
    return 0;
  }
  if (first === 0xf0 && (bytes[index + 1] ?? 0) < 0x90) {
    return 0;
  }
  if (first === 0xf4 && (bytes[index + 1] ?? 0) > 0x8f) {
    return 0;
  }
  if (first > 0xf4) {
    return 0;
  }
  for (let offset = 1; offset < need; offset += 1) {
    if (((bytes[index + offset] ?? 0) & 0xc0) !== 0x80) {
      return 0;
    }
  }
  return need;
}

function readDocument(buffer: Buffer, start: number, isArray = false): { value: Document | unknown[]; next: number } {
  const size = buffer.readInt32LE(start);
  const end = start + size;
  let index = start + 4;
  const object: Document = {};
  const array: unknown[] = [];
  while (index < end - 1) {
    const type = buffer[index];
    index += 1;
    if (type === 0) {
      break;
    }
    const nameStart = index;
    while (index < end && buffer[index] !== 0) {
      index += 1;
    }
    const name = decodeStoredText(buffer.subarray(nameStart, index));
    index += 1;
    if (type === 0x02 || type === 0x0d || type === 0x0e) {
      const length = buffer.readInt32LE(index);
      const text = decodeStoredText(buffer.subarray(index + 4, index + 4 + length - 1));
      put(isArray, array, object, name, text);
      index += 4 + length;
      continue;
    }
    if (type === 0x03 || type === 0x04) {
      const nested = readDocument(buffer, index, type === 0x04);
      put(isArray, array, object, name, nested.value);
      index = nested.next;
      continue;
    }
    const valueEnd = endOfValue(buffer, type, index);
    put(isArray, array, object, name, decodeOpaque(buffer, type, index, valueEnd));
    index = valueEnd;
  }
  return { value: isArray ? array : object, next: end };
}

function put(isArray: boolean, array: unknown[], object: Document, name: string, value: unknown): void {
  if (isArray) {
    array[Number(name)] = value;
    return;
  }
  object[name] = value;
}

function decodeOpaque(buffer: Buffer, type: number, valueStart: number, valueEnd: number): unknown {
  const valueLength = valueEnd - valueStart;
  const size = 4 + 1 + 2 + valueLength + 1;
  const document = Buffer.alloc(size);
  document.writeInt32LE(size, 0);
  document[4] = type;
  document[5] = 0x76;
  document[6] = 0;
  buffer.copy(document, 7, valueStart, valueEnd);
  document[size - 1] = 0;
  return BSON.deserialize(document).v;
}

function endOfValue(buffer: Buffer, type: number, valueStart: number): number {
  if (type === 0x01 || type === 0x09 || type === 0x11 || type === 0x12) {
    return valueStart + 8;
  }
  if (type === 0x10) {
    return valueStart + 4;
  }
  if (type === 0x08) {
    return valueStart + 1;
  }
  if (type === 0x0a || type === 0xff || type === 0x7f || type === 0x06) {
    return valueStart;
  }
  if (type === 0x07) {
    return valueStart + 12;
  }
  if (type === 0x13) {
    return valueStart + 16;
  }
  if (type === 0x05) {
    return valueStart + 5 + buffer.readInt32LE(valueStart);
  }
  if (type === 0x03 || type === 0x04 || type === 0x0f) {
    return valueStart + buffer.readInt32LE(valueStart);
  }
  if (type === 0x02 || type === 0x0d || type === 0x0e) {
    return valueStart + 4 + buffer.readInt32LE(valueStart);
  }
  if (type === 0x0b) {
    let index = valueStart;
    while (buffer[index] !== 0) {
      index += 1;
    }
    index += 1;
    while (buffer[index] !== 0) {
      index += 1;
    }
    return index + 1;
  }
  throw new Error(`不认识的 BSON 类型 ${type}`);
}
