import { inflateRawSync } from "node:zlib";

/**
 * A minimal, read-only ZIP reader, used only to open OOXML containers (a .docx
 * or .xlsx is a ZIP of XML parts).
 *
 * It is written here rather than pulled from a package because the threat model
 * is specific: the input is an untrusted upload. Three properties matter and are
 * enforced rather than assumed:
 *
 *  - Nothing is written to disk. Entries are inflated in memory only, so a
 *    crafted entry name cannot escape a directory (the classic zip-slip) because
 *    there is no directory to escape into.
 *  - Total inflated size and the per-entry expansion ratio are capped, so a
 *    compression bomb fails with a clear error instead of exhausting memory.
 *  - Only the entries the caller names are inflated. A document with thousands
 *    of unrelated parts costs nothing.
 *
 * Unsupported containers (ZIP64, encrypted entries, unexpected compression
 * methods) are reported as such rather than mis-parsed.
 */

export class ZipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/** Ceiling on the sum of all inflated bytes across requested entries. */
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024; // 64 MB
/** Ceiling on any single entry. A single XML part larger than this is not a document. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024; // 32 MB
/** Refuse an entry whose compressed form expands by more than this factor. */
const MAX_COMPRESSION_RATIO = 200;
/** A well-formed OOXML container has tens of parts, not tens of thousands. */
const MAX_ENTRIES = 4096;

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const ZIP64_SENTINEL = 0xffffffff;

interface CentralEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
}

function readUInt16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUInt32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Locates the End Of Central Directory record by scanning back over any comment. */
function findEndOfCentralDirectory(view: DataView, length: number): number {
  const maxComment = 0xffff;
  const start = Math.max(0, length - EOCD_MIN_BYTES - maxComment);
  for (let offset = length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (readUInt32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("not_a_zip", "The file is not a ZIP archive (no end-of-directory record).");
}

function readCentralDirectory(view: DataView, bytes: Uint8Array): CentralEntry[] {
  const length = bytes.length;
  const eocd = findEndOfCentralDirectory(view, length);

  const totalEntries = readUInt16(view, eocd + 10);
  const cdSize = readUInt32(view, eocd + 12);
  const cdOffset = readUInt32(view, eocd + 16);

  if (cdOffset === ZIP64_SENTINEL || cdSize === ZIP64_SENTINEL || totalEntries === 0xffff) {
    throw new ZipError(
      "zip64_unsupported",
      "The archive uses ZIP64, which this reader does not support.",
    );
  }
  if (totalEntries > MAX_ENTRIES) {
    throw new ZipError(
      "too_many_entries",
      `The archive declares ${totalEntries} entries, above the ${MAX_ENTRIES} limit.`,
    );
  }
  if (cdOffset + cdSize > length) {
    throw new ZipError("corrupt_zip", "The central directory points outside the file.");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: CentralEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > length || readUInt32(view, cursor) !== CD_SIGNATURE) {
      throw new ZipError("corrupt_zip", "The central directory is truncated or malformed.");
    }
    const flags = readUInt16(view, cursor + 8);
    const compressionMethod = readUInt16(view, cursor + 10);
    const compressedSize = readUInt32(view, cursor + 20);
    const uncompressedSize = readUInt32(view, cursor + 24);
    const nameLength = readUInt16(view, cursor + 28);
    const extraLength = readUInt16(view, cursor + 30);
    const commentLength = readUInt16(view, cursor + 32);
    const localHeaderOffset = readUInt32(view, cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > length) {
      throw new ZipError("corrupt_zip", "A central directory entry overruns the file.");
    }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      flags,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface ZipArchive {
  /** Entry names in the archive, in central-directory order. */
  names: string[];
  /** Inflates one entry by name. Throws ZipError if it is missing or unsafe. */
  read: (name: string) => Uint8Array;
  /** Reads an entry as UTF-8 text. */
  readText: (name: string) => string;
}

/**
 * Opens a ZIP archive held in memory. `budget` is shared across every `read`
 * call on the returned archive, so reading many entries cannot exceed the cap.
 */
export function openZip(data: Uint8Array): ZipArchive {
  if (data.length < EOCD_MIN_BYTES) {
    throw new ZipError("not_a_zip", "The file is too small to be a ZIP archive.");
  }
  // A DataView needs its own offset handling; the buffer may be a subarray.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = readCentralDirectory(view, data);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  let remainingBudget = MAX_TOTAL_INFLATED_BYTES;

  const read = (name: string): Uint8Array => {
    const entry = byName.get(name);
    if (!entry) {
      throw new ZipError("entry_missing", `The archive does not contain "${name}".`);
    }
    if (entry.flags & 0x1) {
      throw new ZipError("encrypted_entry", "The archive entry is encrypted.");
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(
        "entry_too_large",
        `The entry "${name}" is ${entry.uncompressedSize} bytes, above the per-entry limit.`,
      );
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new ZipError(
        "compression_ratio_exceeded",
        `The entry "${name}" expands beyond the allowed ratio, so it was not read.`,
      );
    }
    if (entry.uncompressedSize > remainingBudget) {
      throw new ZipError(
        "archive_budget_exceeded",
        "Reading this entry would exceed the total uncompressed-size budget.",
      );
    }

    const headerOffset = entry.localHeaderOffset;
    if (headerOffset + 30 > data.length || readUInt32(view, headerOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError("corrupt_zip", `The local header for "${name}" is missing.`);
    }
    const localNameLength = readUInt16(view, headerOffset + 26);
    const localExtraLength = readUInt16(view, headerOffset + 28);
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > data.length) {
      throw new ZipError("corrupt_zip", `The compressed data for "${name}" overruns the file.`);
    }
    const compressed = data.subarray(dataStart, dataEnd);

    let output: Uint8Array;
    if (entry.compressionMethod === 0) {
      output = compressed;
    } else if (entry.compressionMethod === 8) {
      try {
        output = new Uint8Array(inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES }));
      } catch (error) {
        throw new ZipError(
          "inflate_failed",
          `The entry "${name}" could not be decompressed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      throw new ZipError(
        "unsupported_compression",
        `The entry "${name}" uses compression method ${entry.compressionMethod}, which is not supported.`,
      );
    }

    if (output.length > entry.uncompressedSize && entry.uncompressedSize !== 0) {
      // The declared size is a second bomb guard; trust the smaller of the two.
      output = output.subarray(0, entry.uncompressedSize);
    }
    remainingBudget -= output.length;
    return output;
  };

  const readText = (name: string): string => new TextDecoder("utf-8").decode(read(name));

  return { names: entries.map((entry) => entry.name), read, readText };
}

/**
 * Builds a ZIP archive in memory from a set of named entries.
 *
 * Used to produce a .docx export (a .docx is a ZIP of XML parts). Entries are
 * stored uncompressed: the parts are small XML documents, so compression would
 * save little and storing them keeps the writer simple and the output
 * deterministic, which makes the export byte-stable for a given report.
 */
export function writeZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (data: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const crc = crc32(content);

    const local = new Uint8Array(30 + nameBytes.length + content.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc, true);
    localView.setUint32(18, content.length, true);
    localView.setUint32(22, content.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(content, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CD_SIGNATURE, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true); // stored
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, content.length, true);
    centralView.setUint32(24, content.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(EOCD_MIN_BYTES);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...localParts, ...centralParts, eocd];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
