import assert from 'node:assert/strict';
import test from 'node:test';

import { buildXlsx, columnLetter, crc32, sanitizeSheetName, zipStore } from './xlsx';

const decoder = new TextDecoder();

/** Stored ZIP entries are searchable as plain text, which keeps this test simple. */
function contains(bytes: Uint8Array, needle: string): boolean {
  return decoder.decode(bytes).includes(needle);
}

test('crc32 matches the well-known check value', () => {
  // "123456789" → 0xCBF43926 is the standard CRC-32 test vector.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zipStore writes a local header and an end-of-central-directory record', () => {
  const zip = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hi') }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.ok(contains(zip, 'a.txt'));
  assert.ok(contains(zip, 'hi'));
});

test('columnLetter and sanitizeSheetName follow spreadsheet rules', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.equal(columnLetter(702), 'AAA');
  assert.equal(sanitizeSheetName('a/b:c*?[]'), 'a b c');
  assert.equal(sanitizeSheetName(''), 'Results');
  assert.equal(sanitizeSheetName('x'.repeat(40)).length, 31);
});

test('buildXlsx embeds the header, numbers and escaped text', () => {
  const bytes = buildXlsx({
    name: 'Result',
    columns: [{ name: 'id' }, { name: 'name' }, { name: 'flag' }],
    rows: [
      [1, '中文 & <xml>', null],
      [2.5, 'line\nbreak', true],
    ],
  });

  assert.equal(bytes[0], 0x50); // 'P'
  assert.equal(bytes[1], 0x4b); // 'K'
  assert.ok(contains(bytes, 'xl/worksheets/sheet1.xml'));
  assert.ok(contains(bytes, '<t xml:space="preserve">中文 &amp; &lt;xml&gt;</t>'));
  assert.ok(contains(bytes, '<c r="A2"><v>1</v></c>'));
  assert.ok(contains(bytes, '<c r="A3"><v>2.5</v></c>'));
  assert.ok(contains(bytes, '<c r="C3" t="b"><v>1</v></c>'));
  // NULL cells are omitted rather than written as empty strings.
  assert.ok(!contains(bytes, 'r="C2"'));
});
