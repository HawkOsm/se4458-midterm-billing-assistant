// The MCP server's logic: keep the index current, and search it. Knows nothing about MCP.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withTransaction, type Db } from "../db/db";
import * as docsDbContext from "../db/docsDbContext";
import { parseGuide, type ParsedGuide } from "./guideParser";

// From src/mcp (tsx) and dist/mcp (compiled), the repository root is two levels up.
export const GUIDE_PATH = path.join(__dirname, "..", "..", "documents", "Mobile_Provider_Billing_Guide.md");

export interface IndexResult {
  documentId: string;
  rebuilt: boolean;
  chunks: number;
}

// A fingerprint of exactly what gets stored: the parsed sections, not the raw file. So a
// rebuild happens when the guide changes AND when a parser change cuts different chunks,
// with no version label anyone has to remember to bump; a change that produces the same
// chunks rebuilds nothing.
export function indexHash(guide: ParsedGuide, fileName: string): string {
  const stored = { fileName, ...guide }; // documentId, title, version, chunks
  return createHash("sha256").update(JSON.stringify(stored)).digest("hex");
}

// Builds the index once and rebuilds it only when its sections changed, so it is ready
// before the first question and never rebuilt per question (assignment line 11). Safe to
// call from several servers at once (advisory lock). `parse` is replaceable for tests.
export async function ensureIndexed(
  db: Db,
  filePath = GUIDE_PATH,
  parse: (source: string) => ParsedGuide = parseGuide,
): Promise<IndexResult> {
  const guide = parse(readFileSync(filePath, "utf8"));
  const hash = indexHash(guide, path.basename(filePath));

  return withTransaction(db, async (tx) => {
    await docsDbContext.lockIndex(tx);
    if ((await docsDbContext.getSourceHash(tx, guide.documentId)) === hash) {
      return { documentId: guide.documentId, rebuilt: false, chunks: guide.chunks.length };
    }
    await docsDbContext.replaceDocument(tx, guide, path.basename(filePath), hash);
    return { documentId: guide.documentId, rebuilt: true, chunks: guide.chunks.length };
  });
}

export interface SearchResult {
  query: string;
  matches: { document: string; documentId: string; section: string; heading: string; text: string }[];
  note: string;
}

// Words only (letters and digits, any language), lower-cased, de-duplicated. Everything
// else is dropped, so a query can never be read as search syntax.
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, 30);
}

export async function searchDocumentation(db: Db, query: string, limit = 3): Promise<SearchResult> {
  const terms = searchTerms(query);
  const hits = terms.length === 0 ? [] : await docsDbContext.searchChunks(db, terms, limit);
  return {
    query,
    matches: hits.map((h) => ({
      document: h.fileName,
      documentId: h.documentId,
      section: h.section,
      heading: h.heading,
      text: h.text,
    })),
    note:
      hits.length === 0
        ? "No matching section. Try other words (for example 'partial payment' or 'extra internet')."
        : "Ranked keyword search (best first), not exhaustive. Cite the section numbers you use.",
  };
}
