import { constants, inflateSync } from "node:zlib";

/**
 * Minimal PDF text extraction with no dependency: inflate every FlateDecode stream and collect
 * the literal strings drawn by Tj / TJ operators. Good enough for CBSL press releases (simple
 * Latin text). Spacing is unreliable (PDFs position glyphs, not words), so callers should match
 * against `compact()` text with all whitespace removed.
 */
export function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  const parts: string[] = [];
  const streamRe = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    streamRe.lastIndex = end + "endstream".length;
    let content: string;
    try {
      content = inflateSync(buf.subarray(start, end), { finishFlush: constants.Z_SYNC_FLUSH }).toString("latin1");
    } catch {
      continue; // not a Flate stream (images, fonts, ...)
    }
    for (const op of content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj/g)) {
      if (op[1] !== undefined) {
        parts.push([...op[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)].map((x) => unescapePdf(x[1])).join(""));
      } else {
        parts.push(unescapePdf(op[2]));
      }
    }
  }
  return parts.join(" ");
}

function unescapePdf(x: string): string {
  return x.replace(/\\([0-7]{1,3}|.)/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
  });
}

/** Text with all whitespace removed, for spacing-insensitive matching. */
export const compact = (t: string) => t.replace(/\s+/g, "");
