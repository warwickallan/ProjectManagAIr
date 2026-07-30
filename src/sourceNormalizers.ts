import { inflateRawSync } from 'node:zlib';

export const SOURCE_NORMALISER_VERSION = 'source-normaliser-v1';

export type SourceKind = 'vtt-transcript' | 'text-note' | 'email-message' | 'word-document';

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
  eventDate: string | null;
  durationMs: number | null;
  participants: string[];
  wordCount: number;
  segments: NormalizedSegment[];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
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

function extractSpeaker(value: string): { speaker: string | null; text: string } {
  const voice = value.match(/^<v(?:\s+[^>]*)?>([\s\S]*)$/i);
  const cleaned = voice ? stripTags(voice[1]) : stripTags(value);
  const prefix = cleaned.match(/^([A-Z][^:]{1,60}):\s+([\s\S]+)$/);
  if (!prefix) return { speaker: null, text: cleaned };
  return { speaker: prefix[1].trim(), text: prefix[2].trim() };
}

function normalizeVtt(text: string): NormalizedDocument {
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/);
  const segments: NormalizedSegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/);
    if (!timing) continue;
    const spoken = extractSpeaker(lines.slice(timingIndex + 1).join(' '));
    if (!spoken.text) continue;
    const start = cursor;
    cursor += spoken.text.length;
    segments.push({
      seq: segments.length + 1, kind: 'cue', speaker: spoken.speaker,
      tStartMs: timestampMs(timing[1]), tEndMs: timestampMs(timing[2]),
      messageId: null, sender: null, sentAt: null, page: null, section: null, paraIndex: null,
      charStart: start, charEnd: cursor, text: spoken.text,
    });
    cursor += 1;
  }
  const participants = [...new Set(segments.map((segment) => segment.speaker).filter((value): value is string => Boolean(value)))];
  return {
    sourceType: 'vtt-transcript',
    eventDate: null,
    durationMs: segments.length ? Math.max(...segments.map((segment) => segment.tEndMs ?? 0)) : null,
    participants,
    wordCount: segments.reduce((total, segment) => total + words(segment.text), 0),
    segments,
  };
}

function normalizeText(text: string): NormalizedDocument {
  const chunks = text.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/).map((chunk) => chunk.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let cursor = 0;
  const segments = chunks.map((chunk, index): NormalizedSegment => {
    const start = cursor;
    cursor += chunk.length + 1;
    return { seq: index + 1, kind: chunks.length === 1 ? 'line' : 'paragraph', speaker: null, tStartMs: null, tEndMs: null, messageId: null, sender: null, sentAt: null, page: null, section: null, paraIndex: index, charStart: start, charEnd: start + chunk.length, text: chunk };
  });
  return { sourceType: 'text-note', eventDate: null, durationMs: null, participants: [], wordCount: segments.reduce((total, segment) => total + words(segment.text), 0), segments };
}

function decodeQuotedPrintable(value: string): string {
  return value.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function normalizeEmail(text: string): NormalizedDocument {
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
  const sentAtRaw = headers.get('date');
  const sentAtDate = sentAtRaw ? new Date(sentAtRaw) : null;
  const sentAt = sentAtDate && !Number.isNaN(sentAtDate.valueOf()) ? sentAtDate.toISOString() : null;
  const messageId = headers.get('message-id') ?? null;
  const subject = headers.get('subject');
  const combined = [subject ? `Subject: ${subject}` : '', body.trim()].filter(Boolean).join('\n\n');
  const segments: NormalizedSegment[] = combined ? [{
    seq: 1, kind: 'message', speaker: sender, tStartMs: null, tEndMs: null, messageId,
    sender, sentAt, page: null, section: 'body', paraIndex: 0, charStart: 0, charEnd: combined.length, text: combined,
  }] : [];
  return { sourceType: 'email-message', eventDate: sentAt?.slice(0, 10) ?? null, durationMs: null, participants: sender ? [sender] : [], wordCount: words(combined), segments };
}

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
function normalizeDocx(bytes: Buffer): NormalizedDocument {
  const xml = zipEntry(bytes, 'word/document.xml').toString('utf8');
  const paragraphXml = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  let cursor = 0;
  const segments: NormalizedSegment[] = [];
  for (const paragraph of paragraphXml) {
    const section = decodeEntities((paragraph.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? 'body'));
    const content = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeEntities(match[1])).join('').trim();
    if (!content) continue;
    const start = cursor;
    cursor += content.length + 1;
    segments.push({ seq: segments.length + 1, kind: 'paragraph', speaker: null, tStartMs: null, tEndMs: null, messageId: null, sender: null, sentAt: null, page: null, section, paraIndex: segments.length, charStart: start, charEnd: start + content.length, text: content });
  }
  return { sourceType: 'word-document', eventDate: null, durationMs: null, participants: [], wordCount: segments.reduce((total, segment) => total + words(segment.text), 0), segments };
}

export function normalizeSource(fileName: string, bytes: Buffer, eventDate?: string | null): NormalizedDocument {
  const extension = fileName.toLowerCase().split('.').pop();
  const document = extension === 'vtt' ? normalizeVtt(bytes.toString('utf8'))
    : extension === 'eml' ? normalizeEmail(bytes.toString('utf8'))
      : extension === 'docx' ? normalizeDocx(bytes)
        : extension === 'txt' ? normalizeText(bytes.toString('utf8'))
          : (() => { throw new Error(`Source type .${extension ?? ''} is not supported by Source Intelligence v1.`); })();
  return { ...document, eventDate: document.eventDate ?? eventDate ?? null };
}
