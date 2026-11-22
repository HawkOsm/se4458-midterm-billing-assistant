// Queries for the documentation index (schema `docs`, migration 008).
import type { GuideChunk, ParsedGuide } from "../mcp/guideParser";
import type { Db } from "./db";

// Any fixed number: while one MCP server rebuilds the index, another one starting at the
// same moment waits instead of rebuilding too (released at the end of the transaction).
const INDEX_LOCK_ID = 4459;

export async function lockIndex(db: Db): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock($1)", [INDEX_LOCK_ID]);
}

export async function getSourceHash(db: Db, documentId: string): Promise<string | null> {
  const { rows } = await db.query<{ source_hash: string }>(
    "SELECT source_hash FROM docs.documents WHERE document_id = $1",
    [documentId],
  );
  return rows[0]?.source_hash ?? null;
}

// Replaces the document's chunks (stale sections must disappear, not linger).
export async function replaceDocument(db: Db, guide: ParsedGuide, fileName: string, sourceHash: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO docs.documents (document_id, file_name, title, version, source_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (document_id) DO UPDATE
       SET file_name = EXCLUDED.file_name, title = EXCLUDED.title, version = EXCLUDED.version,
           source_hash = EXCLUDED.source_hash, indexed_at = now()
     RETURNING id`,
    [guide.documentId, fileName, guide.title, guide.version, sourceHash],
  );
  const id = rows[0]!.id;
  await db.query("DELETE FROM docs.chunks WHERE document_id = $1", [id]);
  for (const chunk of guide.chunks) {
    await db.query(
      "INSERT INTO docs.chunks (document_id, ordinal, section, heading, text) VALUES ($1, $2, $3, $4, $5)",
      [id, chunk.ordinal, chunk.section, chunk.heading, chunk.text],
    );
  }
}

export interface SearchHit extends Omit<GuideChunk, "ordinal"> {
  fileName: string;
  documentId: string;
}

// Ranked full-text search over all indexed documents. `terms` must be plain words (letters
// and digits only, see docsService): they are joined with "or", so a chunk needs only one
// of them, and websearch_to_tsquery never fails on its input. English stemming and stop
// words come from the 'english' configuration.
// Order: first by how many DIFFERENT query words a section contains, then ts_rank_cd
// (heading matches, weight A, above body matches, weight B). Measured: without the first
// key, a word found in almost every section ("bill") let §4.4 "Bill generation" outrank
// the exact answer, e.g. §8.3 for "Can I pay only part of my bill?".
export async function searchChunks(db: Db, terms: string[], limit: number): Promise<SearchHit[]> {
  const { rows } = await db.query<{
    file_name: string;
    document_id: string;
    section: string;
    heading: string;
    text: string;
  }>(
    `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)
     SELECT d.file_name, d.document_id, c.section, c.heading, c.text
       FROM docs.chunks c
       JOIN docs.documents d ON d.id = c.document_id, q
      WHERE c.search_vector @@ q.query
      ORDER BY (SELECT count(*) FROM unnest($3::text[]) AS t(term)
                 WHERE c.search_vector @@ plainto_tsquery('english', t.term)) DESC,
               ts_rank_cd(c.search_vector, q.query) DESC,
               c.ordinal
      LIMIT $2`,
    [terms.join(" or "), limit, terms],
  );
  return rows.map((r) => ({
    fileName: r.file_name,
    documentId: r.document_id,
    section: r.section,
    heading: r.heading,
    text: r.text,
  }));
}
