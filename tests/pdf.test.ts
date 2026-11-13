import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { compact, pdfText } from "@/lib/sources/pdf";

/** A minimal PDF-like file: each content string becomes one FlateDecode stream object. */
function fakePdf(...contents: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  contents.forEach((c, i) => {
    const body = typeof c === "string" ? deflateSync(Buffer.from(c, "latin1")) : c;
    parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\r\n`, "latin1"));
    parts.push(body);
    parts.push(Buffer.from("\r\nendstream\nendobj\n", "latin1"));
  });
  parts.push(Buffer.from("%%EOF", "latin1"));
  return Buffer.concat(parts);
}

test("pdfText reads Tj and TJ strings from Flate streams", () => {
  const pdf = fakePdf("BT /F1 12 Tf (Hello) Tj [(Wor) -20 (ld)] TJ ET");
  assert.equal(pdfText(pdf), "Hello World");
});

test("pdfText handles escapes: parentheses, backslash, octal", () => {
  const pdf = fakePdf("BT (a\\(b\\)) Tj (c\\\\d) Tj (\\101\\102) Tj ET");
  assert.equal(pdfText(pdf), "a(b) c\\d AB");
});

test("pdfText joins several streams and skips ones that are not Flate data", () => {
  const pdf = fakePdf("BT (one) Tj ET", Buffer.from("this is not deflate data"), "BT (two) Tj ET");
  assert.equal(pdfText(pdf), "one two");
});

test("pdfText returns an empty string when there is no text", () => {
  assert.equal(pdfText(Buffer.from("not a pdf at all")), "");
  assert.equal(pdfText(fakePdf("0 0 595 842 re W n")), "");
});

test("compact removes all whitespace so spaced-out glyphs still match", () => {
  const pdf = fakePdf("BT [(2) 30 (0 ) 10 ( Nove) -5 (mber 2026)] TJ ET");
  assert.equal(compact(pdfText(pdf)), "20November2026");
  assert.equal(compact(" a \n b\tc "), "abc");
});
