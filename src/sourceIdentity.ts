/**
 * What makes a source THE SAME source — computed from content and provenance,
 * never from the filename and never from the meeting date.
 *
 * The case that motivated this: two real Teams exports whose filenames differ
 * only by " (2)" are different meetings, while one of them was already in the
 * database under a completely different name. Filename matching would have got
 * both answers wrong. Content hashing gets both right.
 *
 * Three layers, cheapest first, all deterministic and all computed BEFORE any
 * provider call:
 *
 *   1. raw SHA-256 — byte identity. Catches the same file re-dropped.
 *   2. canonical fingerprint — SHA-256 of the transcript reduced to speaker and
 *      dialogue content. Catches the same meeting re-exported with different
 *      line endings, cue numbering or timestamp formatting.
 *   3. chunk fingerprints — deterministic fixed-size windows over the canonical
 *      content. Catches a partial transcript that overlaps a known one, which
 *      neither hash above can see.
 *
 * No model is involved at any layer.
 */
import { createHash } from 'node:crypto';

/**
 * Lines of dialogue per fingerprinted chunk.
 *
 * Three consecutive utterances, verbatim and in order, is a strong signal —
 * strong enough that two unrelated meetings essentially never share one, and
 * small enough that a short partial transcript still produces several. A larger
 * window made short transcripts collapse into a single chunk, which hid overlap
 * entirely.
 */
export const CHUNK_LINES = 3;
/** Chunks advance one line at a time, so a partial transcript starting mid-meeting still aligns with the full transcript's chunks. */
export const CHUNK_STRIDE = 1;
/** Containment at or above this is reported as a possible partial overlap for human confirmation. */
export const OVERLAP_REVIEW_THRESHOLD = 0.25;
/** Containment at or above this means one transcript essentially contains the other. */
export const OVERLAP_CONTAINMENT_THRESHOLD = 0.9;
/** Filename similarity at or above this is "similar filename" — a display hint only, never identity. */
export const FILENAME_SIMILARITY_THRESHOLD = 0.7;

const WEBVTT_HEADER = /^WEBVTT\b.*$/i;
const NOTE_BLOCK = /^NOTE\b/i;
const TIMESTAMP_CUE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?/;
/** A bare cue identifier: a number, or a UUID-ish token Teams emits, alone on its line. */
const CUE_IDENTIFIER = /^\s*(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/\d+-\d+)?)\s*$/i;
/**
 * A WebVTT voice span, `<v Alex>` or `<v.loud Alex>`, which carries the SPEAKER
 * NAME inside the tag. It is rewritten to `Alex: ` rather than stripped:
 * exporters differ on whether they use a voice tag or a plain `Alex:` prefix,
 * and the two must canonicalise identically or every re-export would look like
 * a different meeting.
 */
const VOICE_TAG = /<v(?:\.[^>\s]+)*\s+([^>]+)>/gi;
/** Remaining inline cue styling, which carries no content and is simply removed. */
const INLINE_TAGS = /<\/?[cvbiu](?:\.[^>\s]+)*(?:\s[^>]*)?>/gi;

/**
 * Reduce a VTT (or plain transcript) to the speech it records.
 *
 * Removes: the WEBVTT header, NOTE blocks, cue identifiers, cue timing lines,
 * inline cue tags, and all formatting whitespace. Normalises: Unicode to NFC,
 * every line-ending convention to `\n`, typographic quotes and dashes to their
 * ASCII equivalents, and runs of whitespace to a single space. Retains: speaker
 * labels and dialogue, in order.
 *
 * Deliberately NOT lowercased and NOT punctuation-stripped. Two different
 * meetings about the same subject share a great deal of vocabulary, and
 * flattening further would start reporting genuinely distinct meetings as the
 * same transcript — the exact failure the near-identical filenames already
 * threaten.
 */
export function canonicaliseTranscript(text: string): string[] {
  const normalised = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // Zero-width and BOM characters survive a re-export invisibly and would
    // otherwise make an identical transcript hash differently.
    .replace(/[​-‍﻿]/g, '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');

  const lines: string[] = [];
  let inNote = false;
  for (const rawLine of normalised.split('\n')) {
    const line = rawLine.replace(VOICE_TAG, '$1: ').replace(INLINE_TAGS, '').trim();
    if (line === '') { inNote = false; continue; }
    if (inNote) continue;
    if (NOTE_BLOCK.test(line)) { inNote = true; continue; }
    if (WEBVTT_HEADER.test(line)) continue;
    if (TIMESTAMP_CUE.test(line)) continue;
    if (CUE_IDENTIFIER.test(line)) continue;
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (collapsed === '') continue;
    lines.push(collapsed);
  }
  return lines;
}

/** SHA-256 over the canonical dialogue. Identical for two harmlessly re-exported copies of one meeting. */
export function canonicalFingerprint(text: string): string {
  return createHash('sha256').update(canonicaliseTranscript(text).join('\n'), 'utf8').digest('hex');
}

/**
 * Overlapping fixed-size windows over the canonical dialogue.
 *
 * Overlapping rather than adjacent (stride < size) so that a partial transcript
 * starting midway through a meeting still produces chunks that align with the
 * full transcript's chunks. With adjacent chunks a half-line offset would make
 * two copies of the same conversation share nothing at all.
 */
export function chunkFingerprints(text: string): string[] {
  const lines = canonicaliseTranscript(text);
  if (lines.length === 0) return [];
  if (lines.length <= CHUNK_LINES) {
    return [createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')];
  }
  const chunks: string[] = [];
  for (let start = 0; start + CHUNK_LINES <= lines.length; start += CHUNK_STRIDE) {
    chunks.push(createHash('sha256').update(lines.slice(start, start + CHUNK_LINES).join('\n'), 'utf8').digest('hex'));
  }
  // Always fingerprint the tail, so content in the final partial window is not
  // invisible to overlap detection.
  const tail = lines.slice(Math.max(0, lines.length - CHUNK_LINES));
  const tailHash = createHash('sha256').update(tail.join('\n'), 'utf8').digest('hex');
  if (chunks.at(-1) !== tailHash) chunks.push(tailHash);
  return chunks;
}

/**
 * Containment of the smaller chunk set within the larger, not symmetric Jaccard.
 *
 * A 200-line partial transcript fully contained in a 2,000-line meeting has a
 * Jaccard index around 0.1 — indistinguishable from noise — but a containment of
 * 1.0, which is exactly the signal a consultant needs. Reported against the
 * SMALLER set so "how much of the shorter transcript already exists" is what the
 * number means.
 */
export function overlapRatio(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [smaller, larger] = a.length <= b.length ? [a, b] : [b, a];
  const largerSet = new Set(larger);
  let shared = 0;
  for (const fingerprint of new Set(smaller)) if (largerSet.has(fingerprint)) shared += 1;
  return shared / new Set(smaller).size;
}

/** Normalise a filename for comparison: drop the extension, the copy suffix and the punctuation exporters vary. */
export function filenameTokens(name: string): string[] {
  return name
    .normalize('NFC')
    .replace(/\.[A-Za-z0-9]{1,6}$/, '')
    .replace(/\((\d+)\)\s*$/, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** Dice coefficient over filename tokens. A display hint only — it never establishes or refutes identity. */
export function filenameSimilarity(a: string, b: string): number {
  const left = new Set(filenameTokens(a));
  const right = new Set(filenameTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export type SourceClassification =
  | 'exact-duplicate'
  | 'normalised-duplicate'
  | 'possible-overlap'
  | 'similar-filename-different-content'
  | 'previously-voided-duplicate'
  | 'cross-project-match'
  | 'apparently-new';

/** Classifications that must never reach a provider without a human decision. */
export const BLOCKING_CLASSIFICATIONS: readonly SourceClassification[] = ['exact-duplicate', 'normalised-duplicate', 'previously-voided-duplicate'];
/** Classifications that are held for human confirmation but are not automatically refused. */
export const HELD_CLASSIFICATIONS: readonly SourceClassification[] = ['possible-overlap'];

export interface ComparisonCandidate {
  sourceId: string;
  projectId: string;
  intakeSourceId: string | null;
  fileName: string;
  contentHash: string;
  canonicalFingerprint: string | null;
  chunkFingerprints: readonly string[];
  lifecycleState: string;
  processingStatus: string | null;
  meetingSubject: string | null;
  chronologyLabel: string | null;
}

export interface ComparisonSubject {
  projectId: string;
  fileName: string;
  contentHash: string;
  canonicalFingerprint: string;
  chunkFingerprints: readonly string[];
}

export interface SourceComparison {
  classification: SourceClassification;
  matchedSourceId: string | null;
  matchedProjectId: string | null;
  rawHashMatch: boolean;
  canonicalMatch: boolean;
  overlapRatio: number;
  filenameSimilarity: number;
  /** True when this verdict must stop the pipeline before any provider call. */
  blocksExtraction: boolean;
  /** True when a human must decide before the pipeline continues. */
  requiresDecision: boolean;
  detail: string;
}

/** Ranked worst-first, so the strongest verdict across all candidates is the one reported. */
const SEVERITY: Record<SourceClassification, number> = {
  'exact-duplicate': 6,
  'previously-voided-duplicate': 5,
  'normalised-duplicate': 4,
  'possible-overlap': 3,
  'cross-project-match': 2,
  'similar-filename-different-content': 1,
  'apparently-new': 0,
};

function compareOne(subject: ComparisonSubject, candidate: ComparisonCandidate): SourceComparison | null {
  const rawHashMatch = candidate.contentHash === subject.contentHash;
  const canonicalMatch = Boolean(candidate.canonicalFingerprint) && candidate.canonicalFingerprint === subject.canonicalFingerprint;
  const similarity = filenameSimilarity(subject.fileName, candidate.fileName);
  const ratio = rawHashMatch || canonicalMatch ? 1 : overlapRatio(subject.chunkFingerprints, candidate.chunkFingerprints);

  const base = {
    matchedSourceId: candidate.sourceId,
    matchedProjectId: candidate.projectId,
    rawHashMatch,
    canonicalMatch,
    overlapRatio: Math.round(ratio * 1000) / 1000,
    filenameSimilarity: Math.round(similarity * 1000) / 1000,
  };

  // A different project holding the same content is a legitimate situation — one
  // meeting can genuinely concern two projects — so it warns and never blocks.
  if (candidate.projectId !== subject.projectId) {
    if (!rawHashMatch && !canonicalMatch) return null;
    return {
      ...base, classification: 'cross-project-match', blocksExtraction: false, requiresDecision: false,
      detail: `The same content is already registered on another project as ${candidate.sourceId}. One source can legitimately relate to more than one project, so this is a warning, not a block.`,
    };
  }

  if (candidate.lifecycleState === 'voided' && (rawHashMatch || canonicalMatch)) {
    return {
      ...base, classification: 'previously-voided-duplicate', blocksExtraction: true, requiresDecision: true,
      detail: `This content was previously registered as ${candidate.sourceId} and then voided. Re-ingesting it needs an explicit decision, because the void was a deliberate act.`,
    };
  }
  if (rawHashMatch) {
    return {
      ...base, classification: 'exact-duplicate', blocksExtraction: true, requiresDecision: true,
      detail: `Byte-for-byte identical to ${candidate.sourceId}${candidate.fileName === subject.fileName ? '' : `, which arrived as "${candidate.fileName}"`}. No extraction is run.`,
    };
  }
  if (canonicalMatch) {
    return {
      ...base, classification: 'normalised-duplicate', blocksExtraction: true, requiresDecision: true,
      detail: `The same transcript as ${candidate.sourceId}, re-exported with different formatting — the dialogue is identical once headers, cue numbering and timestamps are removed. No extraction is run.`,
    };
  }
  if (ratio >= OVERLAP_REVIEW_THRESHOLD) {
    return {
      ...base, classification: 'possible-overlap', blocksExtraction: false, requiresDecision: true,
      detail: ratio >= OVERLAP_CONTAINMENT_THRESHOLD
        ? `${Math.round(ratio * 100)}% of the shorter transcript already exists in ${candidate.sourceId}; this looks like a partial or extended copy of the same meeting.`
        : `${Math.round(ratio * 100)}% of the shorter transcript overlaps ${candidate.sourceId}. Confirm whether this is the same meeting before extracting it.`,
    };
  }
  if (similarity >= FILENAME_SIMILARITY_THRESHOLD) {
    return {
      ...base, classification: 'similar-filename-different-content', blocksExtraction: false, requiresDecision: false,
      detail: `The filename closely resembles ${candidate.sourceId} ("${candidate.fileName}") but the content is different, so these are different meetings. A similar filename never establishes duplication.`,
    };
  }
  return null;
}

/**
 * Classify one incoming source against everything already known.
 *
 * Pure: the caller supplies the candidates. Returns the single strongest verdict
 * plus every individual match, so the Inbox can show the comparison rather than
 * only its conclusion.
 */
export function classifySource(subject: ComparisonSubject, candidates: readonly ComparisonCandidate[]): { verdict: SourceComparison; matches: SourceComparison[] } {
  const matches: SourceComparison[] = [];
  for (const candidate of candidates) {
    const comparison = compareOne(subject, candidate);
    if (comparison) matches.push(comparison);
  }
  matches.sort((a, b) => SEVERITY[b.classification] - SEVERITY[a.classification] || b.overlapRatio - a.overlapRatio || String(a.matchedSourceId).localeCompare(String(b.matchedSourceId)));
  const verdict = matches[0] ?? {
    classification: 'apparently-new' as const,
    matchedSourceId: null, matchedProjectId: null, rawHashMatch: false, canonicalMatch: false,
    overlapRatio: 0, filenameSimilarity: 0, blocksExtraction: false, requiresDecision: false,
    detail: 'No existing source shares this content. Treated as a new meeting.',
  };
  return { verdict, matches };
}

/** Consultant-facing label for a classification, used in the Inbox chip and the source detail panel. */
export const CLASSIFICATION_LABELS: Record<SourceClassification, string> = {
  'exact-duplicate': 'Exact duplicate',
  'normalised-duplicate': 'Duplicate (re-export)',
  'possible-overlap': 'Possible overlap',
  'similar-filename-different-content': 'Similar name, different meeting',
  'previously-voided-duplicate': 'Previously voided duplicate',
  'cross-project-match': 'Also on another project',
  'apparently-new': 'Apparently new',
};
