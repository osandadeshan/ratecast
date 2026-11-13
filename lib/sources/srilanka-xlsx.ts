import { inflateRawSync } from "node:zlib";

/**
 * Minimal .xlsx reader with no dependency: an .xlsx is a ZIP of XML files. We read the ZIP central
 * directory, inflate the parts we need (node:zlib) and pull cell values out with regexes. Enough
 * for CBSL's simple statistical tables (one value per cell, no formulas we care about).
 */

/** Unzip the named entries of a ZIP archive (stored or deflated). Missing names are skipped. */
export function unzipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory record: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("xlsx: not a ZIP file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name) || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");

const textOf = (xml: string) => decodeXml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

/** One worksheet row: column letters ("B", "AA") → trimmed cell text. Empty cells are absent. */
export type SheetRow = Record<string, string>;

/**
 * Rows of one worksheet (1-based index in workbook order of the sheetN.xml files; default first).
 * Numbers come back as their stored text ("7.93", "8.0299999999999994").
 */
export function readXlsxSheet(buf: Buffer, sheetNumber = 1): SheetRow[] {
  const sheetName = `xl/worksheets/sheet${sheetNumber}.xml`;
  const parts = unzipEntries(buf, (n) => n === sheetName || n === "xl/sharedStrings.xml");
  const sheet = parts.get(sheetName)?.toString("utf8");
  if (!sheet) throw new Error(`xlsx: ${sheetName} not found`);
  const shared = [...(parts.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => textOf(m[1]),
  );

  const rows: SheetRow[] = [];
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: SheetRow = {};
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1].match(/r="([A-Z]+)\d+"/)?.[1];
      const body = c[2] ?? "";
      if (!col) continue;
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const type = c[1].match(/t="(\w+)"/)?.[1];
      const text = v === undefined ? textOf(body) : type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
      if (text.trim() !== "") row[col] = text.trim();
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}
