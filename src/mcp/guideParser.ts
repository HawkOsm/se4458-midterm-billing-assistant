// Splits the billing guide (Markdown) into one chunk per numbered section, the unit the
// guide's own §9 asks answers to cite: "section ID, heading, document ID, and text".
//   ## 1. Scope and terminology        -> chunk "1"   (a top-level section without subsections)
//   ### 3.2 Additional internet blocks -> chunk "3.2"
// A top-level section that has subsections becomes a chunk only if it has its own text
// before the first subsection (none in this guide, but kept so nothing is ever dropped).

export interface GuideChunk {
  ordinal: number;
  section: string;
  heading: string;
  text: string;
}

export interface ParsedGuide {
  documentId: string; // "MOB-BILLING-2026-01"
  title: string;
  version: string;
  chunks: GuideChunk[];
}

const HEADING = /^(#{2,3})\s+(\d+(?:\.\d+)?)\.?\s+(.+?)\s*$/;

function field(source: string, name: string): string {
  const match = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, "m").exec(source);
  if (!match?.[1]) throw new Error(`The guide has no "**${name}:**" line`);
  return match[1];
}

export function parseGuide(source: string): ParsedGuide {
  const title = /^#\s+(.+?)\s*$/m.exec(source)?.[1];
  if (!title) throw new Error('The guide has no "# Title" line');

  const sections: { section: string; heading: string; lines: string[] }[] = [];
  for (const line of source.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      sections.push({ section: heading[2]!, heading: heading[3]!, lines: [] });
    } else {
      sections.at(-1)?.lines.push(line); // text before the first "##" (title block) is skipped
    }
  }
  if (sections.length === 0) throw new Error('The guide has no "## N." or "### N.M" sections');

  const chunks = sections
    .map((s) => ({ section: s.section, heading: s.heading, text: s.lines.join("\n").trim() }))
    .filter((s) => s.text !== "") // a "## N." that only introduces its "### N.M" subsections
    .map((s, i) => ({ ordinal: i + 1, ...s }));

  return { documentId: field(source, "Document ID"), title, version: field(source, "Version"), chunks };
}
