// CPA Hand-Over Pack — CSV builders + a dependency-free ZIP writer.
//
// The zip uses STORE (no compression): CSVs are small, and a ~70-line pure
// implementation beats a dependency. Any CPA tool, Excel, and QBO import
// read these files directly.

/**
 * CSV-escape a value, and neutralise SPREADSHEET FORMULAS.
 *
 * Quoting alone is not enough. Excel, Sheets and LibreOffice treat a cell
 * beginning = + - @ (or tab/CR) as a formula even when it arrived quoted, so a
 * value typed by an untrusted party becomes executable when the owner or their
 * CPA opens the file. That is a live path here: the PUBLIC booking form
 * (/api/public/intake/[slug]) stores a caller-supplied name verbatim, and that
 * name flows into the account export, the CPA pack, and the journal handed to
 * the accountant.
 *
 * Prefixing with an apostrophe forces text; spreadsheets do not display it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/**
 * A plain number is never a formula, and must NOT be quoted into text —
 * negative money leads with '-', and prefixing it would turn every credit in
 * the CPA pack into a left-aligned string that Excel refuses to sum. Matches
 * what csvDollars() emits (-1234.56) plus integers and exponent-free decimals.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvEscape(v: string | number): string {
  const raw = String(v);
  const s = FORMULA_LEAD.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

/** Cents → "1234.56" (CSV-friendly dollars, no symbols or separators). */
export function csvDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ zip
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string;
}

/** Build a STORE-method zip (RFC-compliant, no compression). */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = enc.encode(e.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // store
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((t, p) => t + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...centralParts, end]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
