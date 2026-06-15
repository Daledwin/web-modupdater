// Minimal ZIP/JAR reader: extract a single named entry from an in-memory buffer.
// Uses only Node's built-in zlib. Handles the common case (no ZIP64); errors clearly otherwise.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDH_SIG = 0x02014b50; // Central Directory file Header
const LFH_SIG = 0x04034b50; // Local File Header

function findEOCD(buf) {
  // EOCD is at the very end, possibly followed by a comment (<= 65535 bytes).
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      // Verify the comment length is consistent with this being the real EOCD.
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  return -1;
}

/**
 * Return the raw (decompressed) bytes of `entryName`, or null if not found.
 * @param {Buffer} buf - jar/zip bytes
 * @param {string} entryName - exact entry path, e.g. "fabric.mod.json"
 * @returns {Buffer|null}
 */
export function readZipEntry(buf, entryName) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('Not a valid zip/jar (too small).');
  }
  const eocd = findEOCD(buf);
  if (eocd < 0) {
    throw new Error('Not a valid zip/jar: End-Of-Central-Directory record not found.');
  }

  const total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    throw new Error('ZIP64 archives are not supported by this reader.');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('Corrupt zip/jar: central directory out of bounds.');
  }

  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) {
      throw new Error('Corrupt zip/jar: bad central directory header.');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === entryName) {
      return inflateLocal(buf, localOffset, method, compSize);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function inflateLocal(buf, localOffset, method, compSize) {
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
    throw new Error('Corrupt zip/jar: bad local file header.');
  }
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const dataEnd = dataStart + compSize;
  if (dataEnd > buf.length) {
    throw new Error('Corrupt zip/jar: entry data out of bounds.');
  }
  const raw = buf.subarray(dataStart, dataEnd);

  if (method === 0) return Buffer.from(raw); // stored
  if (method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`Unsupported zip compression method ${method} for entry.`);
}

/** Convenience: read an entry and decode as UTF-8 text. */
export function readZipText(buf, entryName) {
  const bytes = readZipEntry(buf, entryName);
  return bytes === null ? null : bytes.toString('utf8');
}
