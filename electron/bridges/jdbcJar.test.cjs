"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readDriverClassesFromJar } = require("./jdbcJar.cjs");

/** Builds a stored (uncompressed) zip so the parser can be tested without a real jar. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function writeTempJar(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-jdbc-jar-"));
  const file = path.join(dir, "driver.jar");
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

test("reads driver classes from META-INF/services/java.sql.Driver", () => {
  const jar = writeTempJar([
    { name: "com/sitech/dmdb/Driver.class", data: "not a real class" },
    {
      name: "META-INF/services/java.sql.Driver",
      data: "# vendor driver\ncom.sitech.dmdb.Driver\n",
    },
  ]);
  assert.deepEqual(readDriverClassesFromJar(jar), ["com.sitech.dmdb.Driver"]);
});

test("returns an empty list when the service file is missing", () => {
  const jar = writeTempJar([{ name: "README.txt", data: "no drivers here" }]);
  assert.deepEqual(readDriverClassesFromJar(jar), []);
});

test("returns an empty list for unreadable paths", () => {
  assert.deepEqual(readDriverClassesFromJar(path.join(os.tmpdir(), "missing-driver.jar")), []);
  assert.deepEqual(readDriverClassesFromJar("/definitely/not/a/jar"), []);
});
