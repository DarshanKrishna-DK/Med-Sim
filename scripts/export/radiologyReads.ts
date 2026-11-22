/**
 * Exports Radiologist Vikram's own reading of every film:
 *   backend/data/radiology_reads.json
 *
 * His process reads this file and nothing else from the reading room, so the
 * second read never depends on what the request says the answer is.
 * Run `node scripts/export/radiologyReads.ts` after editing src/data/radiologyCases.json.
 * scripts/test/radiology-reads.test.ts fails when the file is out of date.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = resolve(ROOT, 'src/data/radiologyCases.json');
export const READS_PATH = resolve(ROOT, 'backend/data/radiology_reads.json');

interface SourceFinding {
  id: string;
  label: string;
  keywords?: string[];
  critical?: boolean;
}

interface SourceCase {
  id: string;
  study: string;
  findings: SourceFinding[];
  diagnosis: string;
  distractors?: string[];
  diagnosisKeywords?: string[];
  diagnosisExclude?: string[];
}

export interface Read {
  study: string;
  diagnosis: string;
  keywords: string[];
  exclude: string[];
  /** Other answers the film is offered with: never a match for the diagnosis. */
  distractors: string[];
  findings: Array<{ id: string; label: string; critical: boolean; call: boolean; keywords: string[] }>;
}

export interface Reads {
  v: 1;
  films: Record<string, Read>;
}

/** A key finding that is the absence of something is never telephoned to the ward. */
const REASSURING = /^(?:no\b|both lung fields clear|heart size normal|adequate\b|normal\b)/i;

export function buildReads(): Reads {
  const cases = (JSON.parse(readFileSync(SOURCE, 'utf8')) as { cases: SourceCase[] }).cases;
  const films: Record<string, Read> = {};
  for (const c of cases) {
    films[c.id] = {
      study: c.study,
      diagnosis: c.diagnosis,
      keywords: c.diagnosisKeywords ?? [],
      exclude: c.diagnosisExclude ?? [],
      distractors: c.distractors ?? [],
      findings: c.findings.map((f) => ({
        id: f.id,
        label: f.label,
        critical: !!f.critical,
        call: !!f.critical && !REASSURING.test(f.label),
        keywords: f.keywords ?? [],
      })),
    };
  }
  return { v: 1, films };
}

export function renderReads(r: Reads): string {
  const body = Object.entries(r.films)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',\n');
  return `{"v":${r.v},"films":{\n${body}\n}}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reads = buildReads();
  writeFileSync(READS_PATH, renderReads(reads));
  console.log(`radiology_reads.json: ${Object.keys(reads.films).length} films`);
}
