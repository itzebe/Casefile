import type { ExtractedPassage, ExtractionResult } from "./extraction.js";
import { ZipError, openZip } from "./zip.js";

/**
 * OOXML text extraction (DOCX and XLSX).
 *
 * A .docx and a .xlsx are ZIP archives of XML parts. This module opens only the
 * parts it needs and pulls the text out, preserving the structure that makes a
 * citation checkable:
 *
 *  - DOCX: one passage per paragraph, with table cells rendered row by row, so a
 *    quote resolves to a paragraph a reviewer can find. DOCX has no page
 *    numbers (pagination is a rendering concern), so passages are located by
 *    paragraph and table row rather than by a page number that would be a lie.
 *  - XLSX: one passage per spreadsheet row, labelled with its sheet name and row
 *    number, so a citation says "Sheet1 row 42" and means the row a reviewer
 *    will see in the spreadsheet.
 *
 * Only text is read. Formulas are not evaluated, macros and embedded objects are
 * ignored, and external relationships are never followed.
 */

const MAX_DOCX_PARAGRAPHS = 20_000;
const MAX_SHEET_ROWS = 5000;
const MAX_CELLS_PER_ROW = 256;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the five XML entities plus numeric character references. */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Collects the concatenated text of every occurrence of `tag` in `xml`. Written
 * as a scan rather than a full XML parse because the input is untrusted and a
 * general parser would accept constructs (DTDs, external entities) that this
 * reader must not honour.
 */
function collectTagText(xml: string, tag: string): string {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
  const close = `</${tag}>`;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index + match[0].length;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    parts.push(xml.slice(start, end));
    open.lastIndex = end + close.length;
  }
  return parts.join("");
}

/** Splits an XML document into the inner text of each `tag` block, non-nested. */
function splitBlocks(xml: string, tag: string): string[] {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
  const close = `</${tag}>`;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index + match[0].length;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    blocks.push(xml.slice(start, end));
    open.lastIndex = end + close.length;
  }
  return blocks;
}

/**
 * Like `splitBlocks`, but keeps each block's opening tag. Spreadsheet rows and
 * cells carry the data the extractor needs (`r="A1"`, `t="inlineStr"`) as
 * attributes on the opening tag, not inside the element, so those callers need
 * the tag as well as the body.
 */
function splitElementBlocks(
  xml: string,
  tag: string,
): Array<{ openTag: string; inner: string }> {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
  const close = `</${tag}>`;
  const blocks: Array<{ openTag: string; inner: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index + match[0].length;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    blocks.push({ openTag: match[0], inner: xml.slice(start, end) });
    open.lastIndex = end + close.length;
  }
  return blocks;
}

/** The visible text of one DOCX paragraph, with tabs and breaks flattened. */
function paragraphText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t");
  return decodeXmlEntities(collectTagText(withBreaks, "w:t"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface TaggedBlock {
  tag: string;
  inner: string;
}

/**
 * Splits a fragment into its immediate child element blocks, so a table's inner
 * paragraphs are not also emitted as body paragraphs. Depth counting keeps a
 * table nested inside a cell from ending its parent early.
 */
function splitTopLevel(xml: string): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  const tagRe = /<(w:tbl|w:p)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const tag = match[1]!;
    const close = `</${tag}>`;
    const innerStart = match.index + match[0].length;
    let depth = 1;
    let cursor = innerStart;
    const nested = new RegExp(`<${tag}(?:\\s[^>]*)?>|${close}`, "g");
    nested.lastIndex = innerStart;
    let nestedMatch: RegExpExecArray | null;
    let closed = false;
    while ((nestedMatch = nested.exec(xml)) !== null) {
      if (nestedMatch[0] === close) depth -= 1;
      else depth += 1;
      if (depth === 0) {
        blocks.push({ tag, inner: xml.slice(innerStart, nestedMatch.index) });
        cursor = nestedMatch.index + close.length;
        closed = true;
        break;
      }
    }
    tagRe.lastIndex = closed ? cursor : innerStart;
  }
  return blocks;
}

export function extractDocx(data: Uint8Array): ExtractionResult {
  let zip;
  try {
    zip = openZip(data);
  } catch (error) {
    if (error instanceof ZipError) return { status: "failed", passages: [], error: error.message };
    throw error;
  }

  let documentXml: string;
  try {
    documentXml = zip.readText("word/document.xml");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", passages: [], error: `Not a readable Word document: ${message}` };
  }

  // The body holds the document text; header/footer parts are skipped because a
  // running header is not evidence about the case.
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml);
  const body = bodyMatch?.[1] ?? documentXml;

  const passages: ExtractedPassage[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;

  for (const block of splitTopLevel(body)) {
    if (block.tag === "w:tbl") {
      tableIndex += 1;
      const rows = splitBlocks(block.inner, "w:tr");
      rows.forEach((rowXml, rowIndex) => {
        const cells = splitBlocks(rowXml, "w:tc").map((cell) => paragraphText(cell));
        const rendered = cells.filter((cell) => cell.length > 0).join(" | ");
        if (!rendered) return;
        passages.push({
          locatorType: "row",
          locatorValue: rowIndex + 1,
          ref: `table ${tableIndex} row ${rowIndex + 1}`,
          text: rendered,
        });
      });
      continue;
    }
    if (block.tag === "w:p") {
      const text = paragraphText(block.inner);
      if (!text) continue;
      paragraphIndex += 1;
      passages.push({
        locatorType: "chunk",
        locatorValue: paragraphIndex,
        ref: `paragraph ${paragraphIndex}`,
        text,
      });
      if (paragraphIndex >= MAX_DOCX_PARAGRAPHS) break;
    }
  }

  if (passages.length === 0) {
    return {
      status: "unsupported",
      passages: [],
      limitation: "The Word document contains no readable paragraph text.",
    };
  }
  return { status: "complete", passages };
}

/**
 * Collects the opening tags of elements named `tag`, whether they are written
 * as a paired element (`<x ...>…</x>`) or self-closing (`<x ... />`). OOXML uses
 * self-closing form for exactly the parts that carry metadata in attributes
 * (sheet definitions, relationships), so a paired-only reader would silently
 * find nothing there.
 */
function collectOpenTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?/?>`, "g");
  return [...xml.matchAll(re)].map((match) => match[0]);
}

/** Reads the shared string table an XLSX uses for its string cells. */
function readSharedStrings(zip: ReturnType<typeof openZip>): string[] {
  let xml: string;
  try {
    xml = zip.readText("xl/sharedStrings.xml");
  } catch {
    return [];
  }
  return splitBlocks(xml, "si").map((block) => decodeXmlEntities(collectTagText(block, "t")).trim());
}

/** Maps a worksheet part path to its display name via the workbook part. */
function readSheetNames(zip: ReturnType<typeof openZip>): Map<string, string> {
  const resolved = new Map<string, string>();
  let workbookXml: string;
  try {
    workbookXml = zip.readText("xl/workbook.xml");
  } catch {
    return resolved;
  }
  const byRid = new Map<string, string>();
  collectOpenTags(workbookXml, "sheet").forEach((tag, index) => {
    const nameMatch = /name="([^"]*)"/.exec(tag);
    const ridMatch = /r:id="([^"]*)"/.exec(tag);
    if (!ridMatch) return;
    byRid.set(ridMatch[1]!, nameMatch ? decodeXmlEntities(nameMatch[1]!) : `Sheet${index + 1}`);
  });

  let relsXml: string;
  try {
    relsXml = zip.readText("xl/_rels/workbook.xml.rels");
  } catch {
    return resolved;
  }
  for (const tag of collectOpenTags(relsXml, "Relationship")) {
    const idMatch = /Id="([^"]*)"/.exec(tag);
    const targetMatch = /Target="([^"]*)"/.exec(tag);
    if (!idMatch || !targetMatch) continue;
    const display = byRid.get(idMatch[1]!);
    if (!display) continue;
    const target = targetMatch[1]!.replace(/^\/?xl\//, "").replace(/^\//, "");
    resolved.set(`xl/${target}`, display);
  }
  return resolved;
}

function columnLetter(ref: string): string {
  const match = /^([A-Z]+)/i.exec(ref);
  return match ? match[1]!.toUpperCase() : "?";
}

export function extractXlsx(data: Uint8Array): ExtractionResult {
  let zip;
  try {
    zip = openZip(data);
  } catch (error) {
    if (error instanceof ZipError) return { status: "failed", passages: [], error: error.message };
    throw error;
  }

  const shared = readSharedStrings(zip);
  const sheetNames = readSheetNames(zip);
  const sheetParts = zip.names
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();

  if (sheetParts.length === 0) {
    return {
      status: "failed",
      passages: [],
      error: "Not a readable workbook: no worksheet parts were found.",
    };
  }

  const passages: ExtractedPassage[] = [];
  for (const part of sheetParts) {
    const sheetName =
      sheetNames.get(part) ?? part.replace(/^xl\/worksheets\//, "").replace(/\.xml$/, "");
    let sheetXml: string;
    try {
      sheetXml = zip.readText(part);
    } catch {
      continue;
    }
    for (const row of splitElementBlocks(sheetXml, "row")) {
      const rowNumberMatch = /r="(\d+)"/.exec(row.openTag);
      const rowNumber = rowNumberMatch ? Number(rowNumberMatch[1]) : passages.length + 1;
      if (rowNumber > MAX_SHEET_ROWS) break;

      const cells = splitElementBlocks(row.inner, "c").slice(0, MAX_CELLS_PER_ROW);
      const rendered: string[] = [];
      for (const cell of cells) {
        const refMatch = /r="([A-Z]+\d+)"/i.exec(cell.openTag);
        const typeMatch = /t="([^"]+)"/.exec(cell.openTag);
        const type = typeMatch?.[1] ?? "n";
        let value = "";
        if (type === "s") {
          const indexMatch = /<v>(\d+)<\/v>/.exec(cell.inner);
          const index = indexMatch ? Number(indexMatch[1]) : -1;
          value = shared[index] ?? "";
        } else if (type === "inlineStr") {
          value = decodeXmlEntities(collectTagText(cell.inner, "t")).trim();
        } else {
          const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(cell.inner);
          value = valueMatch ? decodeXmlEntities(valueMatch[1]!).trim() : "";
        }
        if (!value) continue;
        const column = refMatch ? columnLetter(refMatch[1]!) : "?";
        rendered.push(`${column}: ${value}`);
      }
      if (rendered.length === 0) continue;
      passages.push({
        locatorType: "row",
        locatorValue: rowNumber,
        ref: `${sheetName} row ${rowNumber}`,
        text: rendered.join("\n"),
      });
    }
  }

  if (passages.length === 0) {
    return {
      status: "unsupported",
      passages: [],
      limitation: "The workbook contains no readable cell values.",
    };
  }
  return { status: "complete", passages };
}

/**
 * Splits Markdown on headings so a citation points at a named section rather
 * than an anonymous chunk. A document with no headings becomes one passage.
 */
export function extractMarkdown(data: Uint8Array): ExtractionResult {
  const text = new TextDecoder("utf-8").decode(data).replace(/\r\n?/g, "\n").trim();
  if (!text) return { status: "failed", passages: [], error: "File contains no readable text." };

  const lines = text.split("\n");
  const passages: ExtractedPassage[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let index = 0;

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    index += 1;
    passages.push({
      locatorType: "chunk",
      locatorValue: index,
      ref: heading ? `section ${index}: ${heading.slice(0, 60)}` : `part ${index}`,
      text: body,
    });
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
    }
    buffer.push(line);
  }
  flush();
  return { status: "complete", passages };
}
