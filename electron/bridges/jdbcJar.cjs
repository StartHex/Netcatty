"use strict";

/**
 * Reads `META-INF/services/java.sql.Driver` out of a JDBC driver jar so the
 * connection editor can prefill the driver class instead of asking the user to
 * know it. Pure Node: parses the zip central directory and inflates the single
 * entry we care about.
 */

const fs = require("node:fs");
const zlib = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const SERVICE_ENTRY = "META-INF/services/java.sql.Driver";

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readEntryData(buffer, localOffset, compressedSize, method) {
  if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null;
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + compressedSize);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
  return null;
}

/** Returns the driver class names declared by the jar, or an empty array. */
function readDriverClassesFromJar(jarPath) {
  let buffer;
  try {
    buffer = fs.readFileSync(jarPath);
  } catch {
    return [];
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return [];
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  // Some vendor jars ship no service file; fall back to class names ending in
  // "Driver" (the shape every JDBC driver follows) so the editor can still
  // prefill the driver class.
  const driverClasses = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return [];
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === SERVICE_ENTRY) {
      const text = readEntryData(buffer, localOffset, compressedSize, method);
      if (text) {
        const declared = text
          .split(/\r?\n/)
          .map((line) => line.replace(/#.*/, "").trim())
          .filter(Boolean);
        if (declared.length) return declared;
      }
    } else if (name.endsWith("Driver.class") && !name.includes("$")) {
      driverClasses.push(name.slice(0, -".class".length).split("/").join("."));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return driverClasses;
}

module.exports = { readDriverClassesFromJar };
