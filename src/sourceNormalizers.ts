import { inflateRawSync } from 'node:zlib';

/**
 * v2 changes normalisation output in three ways that are stored on every
 * `source_documents` row, so the version moves with them:
 *   - C7: Teams `<v Speaker>` cues now carry the speaker (v1 discarded it).
 *   - B5: `event_date` is derived for every source type from stated evidence,
 *     with an explicit provenance marker, instead of only for email.
 *   - Email bodies and unstructured text are segmented into addressable units
 *     instead of one document-sized segment.
 */
export const SOURCE_NORMALISER_VERSION = 'source-normaliser-v2';

/** Upper bound on an addressable unit of prose, in words. */
export const SEGMENT_MAX_WORDS = 120;

export type SourceKind = 'vtt-transcript' | 'text-note' | 'email-message' | 'word-document';

/**
 * Where an `event_date` came from. `document-header` is evidence the file
 * states about itself; `file-name` is a guess read off the original name; and
 * `none` means no evidence existed. A date is NEVER invented: if nothing here
 * yields one, `date` is null and `confidence` is `'none'`.
 */
export type EventDateSource = 'caller-hint' | 'document-header' | 'file-name' | 'none';

export type EventDateConfidence = 'exact' | 'high' | 'medium' | 'none';

export interface EventDateEvidence {
  /** `YYYY-MM-DD`, or null when no evidence was available. */
  date: string | null;
  source: EventDateSource;
  confidence: EventDateConfidence;
  /** Verbatim evidence, so a reviewer can audit the derivation. Null when `source` is `'none'`. */
  detail: string | null;
}

export interface NormalizedSegment {
  seq: number;
  kind: 'cue' | 'message' | 'paragraph' | 'line';
  speaker: string | null;
  tStartMs: number | null;
  tEndMs: number | null;
  messageId: string | null;
  sender: string | null;
  sentAt: string | null;
  page: number | null;
  section: string | null;
  paraIndex: number | null;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface NormalizedDocument {
  sourceType: SourceKind;
  /** Convenience mirror of `eventDateEvidence.date`; this is what `source_documents.event_date` stores. */
  eventDate: string | null;
  eventDateEvidence: EventDateEvidence;
  durationMs: number | null;
  participants: string[];
  wordCount: number;
  segments: NormalizedSegment[];
}

/** Everything a per-format normaliser knows before the caller hint is applied. */
type NormalizedBody = Omit<NormalizedDocument, 'eventDate' | 'eventDateEvidence'> & {
  documentEventDate: EventDateEvidence | null;
};

const NO_EVENT_DATE: EventDateEvidence = { date: null, source: 'none', confidence: 'none', detail: null };

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripTags(value: string): string {
  return collapse(decodeEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
}

function timestampMs(value: string): number {
  const parts = value.replace(',', '.').split(':');
  const seconds = Number(parts.pop() ?? 0);
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function words(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

/* ------------------------------------------------------------------------- *
 * Event-date evidence (B5)
 *
 * Priority: caller hint, then what the document states about itself, then a
 * date embedded in the original file name, then nothing. Never a wall clock,
 * never a plausible-looking guess.
 * ------------------------------------------------------------------------- */

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

/** True only for a real calendar date inside a range a project source can plausibly carry. */
function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse a free-text date the document states (RFC 822, ISO 8601, or a spelled month). */
function statedDate(raw: string): string | null {
  const value = collapse(raw);
  if (!value) return null;
  const iso = value.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) {
    return calendarDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }
  const named = namedMonthDate(value);
  return named ? named.date : null;
}

/** `10 July 2026`, `10-Jul-2026`, `July 10, 2026` — unambiguous because the month is spelled. */
function namedMonthDate(value: string): { date: string; matched: string } | null {
  const dayFirst = value.match(/(?<![\d])(\d{1,2})[\s._-]*([A-Za-z]{3,9})[\s._,-]*(\d{4})(?!\d)/);
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()];
    const date = month ? calendarDate(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
    if (date) return { date, matched: dayFirst[0] };
  }
  const monthFirst = value.match(/(?<![A-Za-z])([A-Za-z]{3,9})[\s._-]*(\d{1,2})(?:st|nd|rd|th)?[\s._,-]*(\d{4})(?!\d)/);
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()];
    const date = month ? calendarDate(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
    if (date) return { date, matched: monthFirst[0] };
  }
  return null;
}

/**
 * A date embedded in the original file name — the Teams recording convention
 * (`… -20260710_090000-Meeting Recording.vtt`) and the ordinary ISO forms.
 *
 * Deliberately NOT supported: `10-07-2026` and `07-10-2026`. Day-first and
 * month-first are indistinguishable without knowing the exporter's locale, and
 * a 50/50 guess about which month a governed source belongs to is a fabricated
 * date wearing a plausible face.
 */
export function eventDateFromFileName(fileName: string): EventDateEvidence | null {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const separated = base.match(/(?<!\d)(\d{4})[-_.](\d{2})[-_.](\d{2})(?!\d)/);
  if (separated) {
    const date = calendarDate(Number(separated[1]), Number(separated[2]), Number(separated[3]));
    if (date) return { date, source: 'file-name', confidence: 'medium', detail: `file name date token "${separated[0]}"` };
  }
  const named = namedMonthDate(base);
  if (named) return { date: named.date, source: 'file-name', confidence: 'medium', detail: `file name date token "${named.matched}"` };
  const compact = base.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (compact) {
    const date = calendarDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    if (date) return { date, source: 'file-name', confidence: 'medium', detail: `file name date token "${compact[0]}"` };
  }
  return null;
}

function callerHintEvidence(hint: string | null | undefined): EventDateEvidence | null {
  if (!hint) return null;
  const date = statedDate(hint);
  if (!date) return null;
  return { date, source: 'caller-hint', confidence: 'high', detail: `caller-supplied event date hint "${collapse(hint)}"` };
}

function headerEvidence(date: string, detail: string): EventDateEvidence {
  return { date, source: 'document-header', confidence: 'exact', detail };
}

/**
 * Metadata lines a note or transcript header may state about itself. Only
 * key/value forms are honoured; prose is never scanned, because a date spoken
 * inside a meeting is a date the meeting discussed, not the date it happened.
 */
const METADATA_DATE_KEY = /^\s*(recorded(?:\s+on)?|recording\s+date|meeting\s+date|session\s+date|date|held\s+on|start(?:ed)?(?:\s+at)?)\s*[:=]\s*(.+)$/i;

function metadataDate(lines: string[], label: string): EventDateEvidence | null {
  for (const line of lines) {
    const keyed = line.match(METADATA_DATE_KEY);
    if (!keyed) continue;
    const date = statedDate(keyed[2]);
    if (date) return headerEvidence(date, `${label} "${collapse(line)}"`);
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Segmentation of unstructured prose
 * ------------------------------------------------------------------------- */

/** Sentence-ish parts, each retaining its trailing whitespace so concatenation is lossless. */
function sentenceParts(paragraph: string): string[] {
  return paragraph.match(/[^.!?…]+[.!?…]*\s*/g) ?? [paragraph];
}

function hardSplit(value: string, maxWords: number): string[] {
  const tokens = value.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += maxWords) {
    chunks.push(tokens.slice(index, index + maxWords).join(' '));
  }
  return chunks;
}

function splitParagraph(paragraph: string, maxWords: number): string[] {
  if (words(paragraph) <= maxWords) return [paragraph];
  const units: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    const text = current.join('').trim();
    if (text) units.push(text);
    current = [];
    currentWords = 0;
  };
  for (const part of sentenceParts(paragraph)) {
    const partWords = words(part);
    if (partWords === 0) continue;
    if (partWords > maxWords) {
      flush();
      for (const chunk of hardSplit(part, maxWords)) units.push(chunk);
      continue;
    }
    if (currentWords > 0 && currentWords + partWords > maxWords) flush();
    current.push(part);
    currentWords += partWords;
  }
  flush();
  return units.length > 0 ? units : [paragraph];
}

/**
 * Paragraphs first, then sentence groups inside an over-long paragraph, then a
 * word-boundary split for prose that carries no sentence punctuation at all.
 * `paraIndex` stays the paragraph the unit came from, so an anchor can still be
 * traced back to a structural position in the document.
 */
function textUnits(raw: string, maxWords = SEGMENT_MAX_WORDS): Array<{ text: string; paraIndex: number }> {
  const units: Array<{ text: string; paraIndex: number }> = [];
  let paraIndex = 0;
  for (const paragraph of raw.split(/\r?\n\s*\r?\n/)) {
    const collapsed = collapse(paragraph);
    if (!collapsed) continue;
    for (const unit of splitParagraph(collapsed, maxWords)) units.push({ text: unit, paraIndex });
    paraIndex += 1;
  }
  return units;
}

/**
 * The addressing contract: `charStart`/`charEnd` index the normalised document
 * text, which is the segment texts joined by a single newline. Exported so a
 * caller (or a test) can verify the round trip mechanically.
 */
export function normalizedDocumentText(document: Pick<NormalizedDocument, 'segments'>): string {
  return document.segments.map((segment) => segment.text).join('\n');
}

function sequence(): { next: (segment: Omit<NormalizedSegment, 'seq' | 'charStart' | 'charEnd'>) => NormalizedSegment; segments: NormalizedSegment[] } {
  const segments: NormalizedSegment[] = [];
  let cursor = 0;
  return {
    segments,
    next(segment) {
      const charStart = cursor;
      cursor += segment.text.length + 1;
      const built: NormalizedSegment = { ...segment, seq: segments.length + 1, charStart, charEnd: charStart + segment.text.length };
      segments.push(built);
      return built;
    },
  };
}

function emptySegmentFields(): Omit<NormalizedSegment, 'seq' | 'charStart' | 'charEnd' | 'kind' | 'text'> {
  return { speaker: null, tStartMs: null, tEndMs: null, messageId: null, sender: null, sentAt: null, page: null, section: null, paraIndex: null };
}

/* ------------------------------------------------------------------------- *
 * WebVTT (C7)
 * ------------------------------------------------------------------------- */

/**
 * A WebVTT voice span: `<v Speaker>`, with optional cue-class annotations
 * (`<v.loud.first Speaker>`). v1 put the name in a NON-CAPTURING group and
 * threw it away, so every Teams transcript normalised to `speaker: null` and
 * `participants: []`.
 */
const VOICE_OPEN = /<v((?:\.[^\s.>]+)*)(?:[ \t]+([^>]*?))?\s*>/i;

interface CueVoice {
  speaker: string | null;
  /** True when the cue opened a voice span it never closed — the Teams continuation shape. */
  open: boolean;
  taggedVoice: boolean;
}

function cueVoice(payload: string): CueVoice {
  const match = payload.match(VOICE_OPEN);
  if (!match) return { speaker: null, open: false, taggedVoice: false };
  const opens = (payload.match(/<v(?![a-z])/gi) ?? []).length;
  const closes = (payload.match(/<\/v\s*>/gi) ?? []).length;
  const name = collapse(decodeEntities(match[2] ?? '')).replace(/^["']|["']$/g, '').trim();
  return { speaker: name || null, open: opens > closes, taggedVoice: true };
}

/**
 * `Casey: text` — the non-Teams convention, and the one the existing suite
 * pins. Only consulted when the cue carries no voice tag, because a tagged cue
 * whose text merely contains a colon (`<v W>Right: let's go`) would otherwise
 * lose both its real speaker and the first word of what was said.
 */
function colonPrefixSpeaker(text: string): { speaker: string; text: string } | null {
  const prefix = text.match(/^([A-Z][^:]{1,60}):\s+([\s\S]+)$/);
  if (!prefix) return null;
  const name = prefix[1].trim();
  if (/[!?;,]/.test(name) || words(name) > 6) return null;
  return { speaker: name, text: prefix[2].trim() };
}

function vttEventDate(headerLines: string[]): EventDateEvidence | null {
  const keyed = metadataDate(headerLines, 'transcript header metadata');
  if (keyed) return keyed;
  for (const line of headerLines) {
    // A bare timestamp in the header region (a `NOTE`, or the WEBVTT title line)
    // is metadata about the recording. Cue text is never scanned.
    const stamp = line.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?!\d)/);
    if (!stamp) continue;
    const date = calendarDate(Number(stamp[1]), Number(stamp[2]), Number(stamp[3]));
    if (date) return headerEvidence(date, `transcript header metadata "${collapse(line)}"`);
  }
  return null;
}

function normalizeVtt(text: string): NormalizedBody {
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/);
  const { next, segments } = sequence();
  const headerLines: string[] = [];
  let seenCue = false;
  let previousSpeaker: string | null = null;
  let previousOpen = false;

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) {
      if (!seenCue) headerLines.push(...lines.map((line) => line.replace(/^WEBVTT\s*/i, '').replace(/^NOTE\s*/i, '')).filter(Boolean));
      continue;
    }
    const timing = lines[timingIndex].match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/);
    if (!timing) continue;
    seenCue = true;
    const payload = lines.slice(timingIndex + 1).join(' ');
    const voice = cueVoice(payload);
    let speaker = voice.speaker;
    let body = stripTags(payload);
    if (!voice.taggedVoice) {
      const prefixed = colonPrefixSpeaker(body);
      if (prefixed) {
        speaker = prefixed.speaker;
        body = prefixed.text;
      } else if (previousOpen) {
        // Continuation of an unterminated voice span: the previous cue opened a
        // `<v>` it never closed, so this cue is the same person still speaking.
        speaker = previousSpeaker;
      }
    }
    previousOpen = voice.taggedVoice ? voice.open : previousOpen && !/<\/v\s*>/i.test(payload);
    if (speaker) previousSpeaker = speaker;
    if (!body) continue;
    next({
      ...emptySegmentFields(),
      kind: 'cue',
      speaker,
      tStartMs: timestampMs(timing[1]),
      tEndMs: timestampMs(timing[2]),
      text: body,
    });
  }

  const participants = [...new Set(segments.map((segment) => segment.speaker).filter((value): value is string => Boolean(value)))];
  return {
    sourceType: 'vtt-transcript',
    documentEventDate: vttEventDate(headerLines),
    durationMs: segments.length ? Math.max(...segments.map((segment) => segment.tEndMs ?? 0)) : null,
    participants,
    wordCount: segments.reduce((total, segment) => total + words(segment.text), 0),
    segments,
  };
}

/* ------------------------------------------------------------------------- *
 * Plain text
 * ------------------------------------------------------------------------- */

function textEventDate(raw: string): EventDateEvidence | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5);
  const keyed = metadataDate(lines, 'note header metadata');
  if (keyed) return keyed;
  const first = lines[0];
  if (!first) return null;
  // A leading line that is nothing but a date is a stated date, not prose.
  const bare = first.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!bare) return null;
  const date = calendarDate(Number(bare[1]), Number(bare[2]), Number(bare[3]));
  return date ? headerEvidence(date, `note header metadata "${first}"`) : null;
}

function normalizeText(text: string): NormalizedBody {
  const raw = text.replace(/^\uFEFF/, '');
  const units = textUnits(raw);
  const { next, segments } = sequence();
  for (const unit of units) {
    next({ ...emptySegmentFields(), kind: units.length === 1 ? 'line' : 'paragraph', paraIndex: unit.paraIndex, text: unit.text });
  }
  return {
    sourceType: 'text-note',
    documentEventDate: textEventDate(raw),
    durationMs: null,
    participants: [],
    wordCount: segments.reduce((total, segment) => total + words(segment.text), 0),
    segments,
  };
}

/* ------------------------------------------------------------------------- *
 * Email
 * ------------------------------------------------------------------------- */

function decodeQuotedPrintable(value: string): string {
  return value.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function normalizeEmail(text: string): NormalizedBody {
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  const [headerText, ...bodyParts] = unfolded.split(/\r?\n\r?\n/);
  const headers = new Map<string, string>();
  for (const line of headerText.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) headers.set(match[1].toLowerCase(), match[2].trim());
  }
  let body = bodyParts.join('\n\n');
  const transfer = headers.get('content-transfer-encoding')?.toLowerCase();
  if (transfer === 'quoted-printable') body = decodeQuotedPrintable(body);
  if (transfer === 'base64') {
    try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* retain source body */ }
  }
  if (/content-type:\s*text\/html/i.test(headerText)) body = stripTags(body);
  const sender = headers.get('from') ?? null;
  const sentAtRaw = headers.get('date') ?? headers.get('sent') ?? null;
  const sentAtDate = sentAtRaw ? new Date(sentAtRaw) : null;
  const sentAt = sentAtDate && !Number.isNaN(sentAtDate.valueOf()) ? sentAtDate.toISOString() : null;
  const messageId = headers.get('message-id') ?? null;
  const subject = headers.get('subject');

  // One segment per addressable unit, not one segment per message. A ~6,000
  // word email used to normalise to a single segment, which made the +/-1
  // adjacent-segment quote bound meaningless and produced a window that could
  // not fit any per-call budget.
  const identity = { messageId, sender, sentAt };
  const { next, segments } = sequence();
  if (subject) {
    next({ ...emptySegmentFields(), ...identity, kind: 'message', speaker: sender, section: 'subject', paraIndex: null, text: `Subject: ${subject}` });
  }
  for (const unit of textUnits(body)) {
    next({ ...emptySegmentFields(), ...identity, kind: 'paragraph', speaker: sender, section: 'body', paraIndex: unit.paraIndex, text: unit.text });
  }

  const headerDate = sentAtRaw ? statedDate(sentAtRaw) : null;
  return {
    sourceType: 'email-message',
    documentEventDate: headerDate ? headerEvidence(headerDate, `email Date header "${collapse(sentAtRaw!)}"`) : null,
    durationMs: null,
    participants: sender ? [sender] : [],
    wordCount: segments.reduce((total, segment) => total + words(segment.text), 0),
    segments,
  };
}

/* ------------------------------------------------------------------------- *
 * DOCX
 * ------------------------------------------------------------------------- */

function unzipPayload(bytes: Buffer, method: number, start: number, compressedSize: number): Buffer {
  const compressed = bytes.subarray(start, start + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported DOCX compression method ${method}.`);
}

function zipEntry(bytes: Buffer, entryName: string): Buffer {
  const minimumEocd = 22;
  const searchStart = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd >= 0) {
    const entryCount = bytes.readUInt16LE(eocd + 10);
    let offset = bytes.readUInt32LE(eocd + 16);
    for (let index = 0; index < entryCount && offset + 46 <= bytes.length; index += 1) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('DOCX central directory is malformed.');
      const method = bytes.readUInt16LE(offset + 10);
      const compressedSize = bytes.readUInt32LE(offset + 20);
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      const localOffset = bytes.readUInt32LE(offset + 42);
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (name === entryName) {
        if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX local entry header is malformed.');
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        return unzipPayload(bytes, method, dataStart, compressedSize);
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    if ((flags & 0x08) !== 0) break;
    if (name === entryName) return unzipPayload(bytes, method, dataStart, compressedSize);
    offset = dataStart + compressedSize;
  }
  throw new Error(`DOCX entry ${entryName} was not found.`);
}

/** `docProps/core.xml` — the document's own statement about when it was authored. */
function docxEventDate(bytes: Buffer): EventDateEvidence | null {
  let core: string;
  try {
    core = zipEntry(bytes, 'docProps/core.xml').toString('utf8');
  } catch {
    return null;
  }
  for (const property of ['dcterms:created', 'dcterms:modified'] as const) {
    const raw = core.match(new RegExp(`<${property}[^>]*>([^<]+)</${property}>`, 'i'))?.[1];
    if (!raw) continue;
    const date = statedDate(decodeEntities(raw));
    if (date) return headerEvidence(date, `docx ${property} "${collapse(raw)}"`);
  }
  return null;
}

function normalizeDocx(bytes: Buffer): NormalizedBody {
  const xml = zipEntry(bytes, 'word/document.xml').toString('utf8');
  const paragraphXml = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  const { next, segments } = sequence();
  let paraIndex = 0;
  for (const paragraph of paragraphXml) {
    const section = decodeEntities(paragraph.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? 'body');
    const content = collapse([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeEntities(match[1])).join(''));
    if (!content) continue;
    for (const unit of splitParagraph(content, SEGMENT_MAX_WORDS)) {
      next({ ...emptySegmentFields(), kind: 'paragraph', section, paraIndex, text: unit });
    }
    paraIndex += 1;
  }
  return {
    sourceType: 'word-document',
    documentEventDate: docxEventDate(bytes),
    durationMs: null,
    participants: [],
    wordCount: segments.reduce((total, segment) => total + words(segment.text), 0),
    segments,
  };
}

/* ------------------------------------------------------------------------- *
 * Entry point
 * ------------------------------------------------------------------------- */

/**
 * `eventDateHint` is the caller's explicit assertion (an operator, a calendar
 * event, an intake form). It wins over the document's own metadata because the
 * caller may know the meeting date that an exported transcript does not carry;
 * an unparseable hint is ignored rather than guessed at.
 *
 * The return shape is additive against v1: `eventDate` is unchanged and still
 * what `source_documents.event_date` stores. `eventDateEvidence` is new.
 */
export function normalizeSource(fileName: string, bytes: Buffer, eventDateHint?: string | null): NormalizedDocument {
  const extension = fileName.toLowerCase().split('.').pop();
  const body = extension === 'vtt' ? normalizeVtt(bytes.toString('utf8'))
    : extension === 'eml' ? normalizeEmail(bytes.toString('utf8'))
      : extension === 'docx' ? normalizeDocx(bytes)
        : extension === 'txt' ? normalizeText(bytes.toString('utf8'))
          : (() => { throw new Error(`Source type .${extension ?? ''} is not supported by Source Intelligence v1.`); })();
  const evidence = callerHintEvidence(eventDateHint)
    ?? body.documentEventDate
    ?? eventDateFromFileName(fileName)
    ?? NO_EVENT_DATE;
  const { documentEventDate: _documentEventDate, ...rest } = body;
  return { ...rest, eventDate: evidence.date, eventDateEvidence: evidence };
}
