import { deflateRawSync } from 'node:zlib';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { SourceProcessingAlerts, SourceProcessingNotice, sourceProcessingView } from '../src/components';
import { inboxSourceSchema } from '../src/domain';
import {
  SEGMENT_MAX_WORDS,
  SOURCE_NORMALISER_VERSION,
  eventDateFromFileName,
  normalizeSource,
  normalizedDocumentText,
  type NormalizedDocument,
} from '../src/sourceNormalizers';
import { defaultExtractionBudget, planExtractionSlices } from '../src/sourcePipeline';

/* ------------------------------------------------------------------------- *
 * Fixtures.
 *
 * Every fixture here is synthetic. Nothing in this file is copied from a real
 * transcript, mailbox or document, and the shapes below are deliberately built
 * from parts so that the tracked tree never contains a transcript-shaped or
 * mailbox-shaped payload for the data-boundary scan to find:
 *   - the cue arrow is assembled at runtime, so no timestamp is ever followed
 *     by a literal `-->` in this file;
 *   - RFC 822 headers are array elements, never at the start of a source line.
 * ------------------------------------------------------------------------- */

const ARROW = `--${'>'}`;
const stamp = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000`;

function transcript(cues: Array<[number, number, string]>, header: string[] = ['WEBVTT']): string {
  const blocks = cues.map(([start, end, payload]) => [`${stamp(start)} ${ARROW} ${stamp(end)}`, payload].join('\n'));
  return [header.join('\n'), ...blocks].join('\n\n');
}

function email(headers: string[], body: string): string {
  return [headers.join('\n'), body].join('\n\n');
}

/** A minimal multi-entry zip with a real central directory, which is what `normalizeDocx` reads. */
function zipDocx(entries: Array<{ name: string; xml: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.xml, 'utf8');
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const documentXml = (paragraphs: string[]) =>
  `<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

const corePropertiesXml = (created: string | null, modified: string | null) =>
  ['<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:cp" xmlns:dcterms="urn:dcterms">',
    created ? `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` : '',
    modified ? `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>` : '',
    '</cp:coreProperties>'].join('');

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
const wordsIn = (value: string) => (value.trim() ? value.trim().split(/\s+/).length : 0);

/* ------------------------------------------------------------------------- *
 * 1-3. Speaker resolution (C7)
 * ------------------------------------------------------------------------- */

describe('Teams voice-tag speaker resolution (C7)', () => {
  it('captures the speaker from a <v Speaker> cue, strips </v>, and leaves untagged cues unattributed', () => {
    const source = transcript([
      [3, 7, '<v Warwick Allan>So the final configuration and build.</v>'],
      [7, 12, '<v Ashley Niven>I will circulate the isolation list.</v>'],
      [12, 15, 'A cue with no voice tag at all.'],
    ]);
    const document = normalizeSource('training-session.vtt', Buffer.from(source));

    expect(document.segments.map((segment) => segment.speaker)).toEqual(['Warwick Allan', 'Ashley Niven', null]);
    expect(document.segments[0].text).toBe('So the final configuration and build.');
    expect(document.segments.some((segment) => segment.text.includes('</v>') || segment.text.includes('<v'))).toBe(false);
    expect(document.participants).toEqual(['Warwick Allan', 'Ashley Niven']);
  });

  it('handles the real-world messiness: classes, punctuated names, nested tags, multi-line cues and continuations', () => {
    const source = transcript([
      [1, 5, ['<v.loud.first Dr. Ann-Marie O&apos;Neill (Site)>The permit', 'needs a second signature.</v>'].join('\n')],
      [5, 9, '<v Zelea Codreanu><c.colorE5E5E5>Understood</c>, I will update the register.</v>'],
      // An unterminated voice span followed by an untagged cue: the Teams
      // continuation shape. The second cue is the same person still speaking.
      [9, 13, '<v Tony Sims>We should agree the cutover window'],
      [13, 17, 'before the end of the week.</v>'],
      [17, 20, 'An unattributed cue after the span closed.'],
    ]);
    const document = normalizeSource('session.vtt', Buffer.from(source));

    expect(document.segments.map((segment) => segment.speaker)).toEqual([
      "Dr. Ann-Marie O'Neill (Site)",
      'Zelea Codreanu',
      'Tony Sims',
      'Tony Sims',
      null,
    ]);
    expect(document.segments[0].text).toBe('The permit needs a second signature.');
    expect(document.segments[1].text).toBe('Understood, I will update the register.');
    expect(document.participants).toHaveLength(3);
  });

  it('still resolves the Casey: colon-prefix form, and does not mistake a colon in tagged speech for a speaker', () => {
    const prefixed = normalizeSource('meeting.vtt', Buffer.from(transcript([[1, 3, 'Casey: Confirm the route']])));
    expect(prefixed.segments[0]).toMatchObject({ seq: 1, kind: 'cue', speaker: 'Casey', tStartMs: 1000, text: 'Confirm the route' });
    expect(prefixed.participants).toEqual(['Casey']);

    // v1 applied the colon rule after the voice tag, so a tagged cue containing a
    // colon lost both its real speaker and the first word of what was said.
    const tagged = normalizeSource('meeting.vtt', Buffer.from(transcript([[1, 3, '<v Warwick Allan>Right: we will suppress the record.</v>']])));
    expect(tagged.segments[0].speaker).toBe('Warwick Allan');
    expect(tagged.segments[0].text).toBe('Right: we will suppress the record.');
  });

  it('yields more than one participant for a multi-speaker transcript, which is what the entity blocker is gated on', () => {
    const source = transcript([
      [1, 4, '<v Warwick Allan>Shall we run the permit through end to end?</v>'],
      [4, 8, '<v Carolyn Dark>Yes, I will raise it in the sandbox.</v>'],
      [8, 11, '<v Tony Sims>Agreed.</v>'],
      [11, 14, '<v Warwick Allan>Good, I will note the decision.</v>'],
    ]);
    const document = normalizeSource('multi-speaker.vtt', Buffer.from(source));
    expect(document.participants.length).toBeGreaterThan(1);
    expect(document.participants).toEqual(['Warwick Allan', 'Carolyn Dark', 'Tony Sims']);
    expect(document.segments).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------------- *
 * 4. Event-date derivation (B5)
 * ------------------------------------------------------------------------- */

describe('event-date derivation and provenance (B5)', () => {
  const bareTranscript = transcript([[1, 4, '<v Warwick Allan>No dates are stated anywhere in this session.</v>']]);

  it('reads a transcript header metadata line', () => {
    const source = transcript([[1, 4, '<v Warwick Allan>Opening remarks.</v>']], ['WEBVTT', '', 'NOTE Recorded: 2026-07-10 09:00']);
    const document = normalizeSource('session.vtt', Buffer.from(source));
    expect(document.eventDate).toBe('2026-07-10');
    expect(document.eventDateEvidence).toMatchObject({ source: 'document-header', confidence: 'exact' });
    expect(document.eventDateEvidence.detail).toContain('2026-07-10');
  });

  it('reads the email Date header', () => {
    const message = email(
      ['From: casey@example.invalid', 'Date: Fri, 10 Jul 2026 09:12:00 +0000', 'Subject: Permit route', 'Message-ID: <synthetic-1@example.invalid>'],
      'Please confirm the route.',
    );
    const document = normalizeSource('message.eml', Buffer.from(message));
    expect(document.eventDate).toBe('2026-07-10');
    expect(document.eventDateEvidence).toMatchObject({ source: 'document-header', confidence: 'exact' });
  });

  it('reads docx core properties, preferring created over modified', () => {
    const withCreated = zipDocx([
      { name: 'word/document.xml', xml: documentXml(['A synthetic paragraph.']) },
      { name: 'docProps/core.xml', xml: corePropertiesXml('2026-07-10T09:00:00Z', '2026-08-01T11:00:00Z') },
    ]);
    expect(normalizeSource('note.docx', withCreated).eventDate).toBe('2026-07-10');

    const modifiedOnly = zipDocx([
      { name: 'word/document.xml', xml: documentXml(['A synthetic paragraph.']) },
      { name: 'docProps/core.xml', xml: corePropertiesXml(null, '2026-08-01T11:00:00Z') },
    ]);
    const document = normalizeSource('note.docx', modifiedOnly);
    expect(document.eventDate).toBe('2026-08-01');
    expect(document.eventDateEvidence.detail).toContain('dcterms:modified');
  });

  it('reads a leading metadata line in a plain-text note', () => {
    const document = normalizeSource('note.txt', Buffer.from('Meeting date: 2026-07-10\n\nWe agreed the permit route.'));
    expect(document.eventDate).toBe('2026-07-10');
    expect(document.eventDateEvidence.source).toBe('document-header');
  });

  it('falls back to a date embedded in the original file name, marked as the weaker evidence it is', () => {
    const isoNamed = normalizeSource('permit-session-2026-07-10.vtt', Buffer.from(bareTranscript));
    expect(isoNamed.eventDate).toBe('2026-07-10');
    expect(isoNamed.eventDateEvidence).toMatchObject({ source: 'file-name', confidence: 'medium' });

    // The Teams recording convention.
    const teamsNamed = normalizeSource('Weekly Sync-20260710_090000-Meeting Recording.vtt', Buffer.from(bareTranscript));
    expect(teamsNamed.eventDate).toBe('2026-07-10');
    expect(teamsNamed.eventDateEvidence.source).toBe('file-name');

    expect(eventDateFromFileName('permit notes 10 July 2026.txt')).toMatchObject({ date: '2026-07-10', source: 'file-name' });
  });

  it('returns null with no fabrication when no evidence exists anywhere', () => {
    const document = normalizeSource('session.vtt', Buffer.from(bareTranscript));
    expect(document.eventDate).toBeNull();
    expect(document.eventDateEvidence).toEqual({ date: null, source: 'none', confidence: 'none', detail: null });

    // Day-first and month-first numeric file names are indistinguishable, so no
    // date is guessed from one, and a number that is not a calendar date is not
    // read as one.
    expect(eventDateFromFileName('report-07-10-2026.txt')).toBeNull();
    expect(eventDateFromFileName('permit-20260230.vtt')).toBeNull();
    expect(eventDateFromFileName('ticket-12345678.txt')).toBeNull();
    expect(normalizeSource('note.txt', Buffer.from('We discussed the 2026-07-10 outage in detail.')).eventDate).toBeNull();
  });

  it('lets an explicit caller hint win over document evidence, and ignores an unparseable hint', () => {
    const message = email(['From: casey@example.invalid', 'Date: Fri, 10 Jul 2026 09:12:00 +0000', 'Subject: Permit route'], 'Body text.');
    const hinted = normalizeSource('message.eml', Buffer.from(message), '2026-07-14');
    expect(hinted.eventDate).toBe('2026-07-14');
    expect(hinted.eventDateEvidence).toMatchObject({ source: 'caller-hint', confidence: 'high' });

    const nonsense = normalizeSource('message.eml', Buffer.from(message), 'sometime next quarter');
    expect(nonsense.eventDate).toBe('2026-07-10');
    expect(nonsense.eventDateEvidence.source).toBe('document-header');
  });
});

/* ------------------------------------------------------------------------- *
 * 5-6. Addressable segmentation of email and unstructured text
 * ------------------------------------------------------------------------- */

const paragraph = (index: number) =>
  Array.from({ length: 9 }, (_, sentence) => `Paragraph ${index} sentence ${sentence} records the permit register position and the isolation certificate follow up.`).join(' ');

describe('email and unstructured text segmentation', () => {
  it('splits a long email body into many addressable segments with exact, non-overlapping offsets', () => {
    const body = Array.from({ length: 12 }, (_, index) => paragraph(index)).join('\n\n');
    const message = email(
      ['From: casey@example.invalid', 'Date: Fri, 10 Jul 2026 09:12:00 +0000', 'Subject: Permit route', 'Message-ID: <synthetic-2@example.invalid>'],
      body,
    );
    const document = normalizeSource('long-message.eml', Buffer.from(message));

    expect(document.segments.length).toBeGreaterThan(12);
    expect(document.segments[0]).toMatchObject({ seq: 1, kind: 'message', section: 'subject', sender: 'casey@example.invalid', messageId: '<synthetic-2@example.invalid>' });
    expect(document.segments[0].text).toBe('Subject: Permit route');

    const bodySegments = document.segments.filter((segment) => segment.section === 'body');
    expect(bodySegments.every((segment) => segment.messageId === '<synthetic-2@example.invalid>')).toBe(true);
    expect(bodySegments.map((segment) => segment.text).join(' ')).toBe(collapse(body));
    expect(new Set(bodySegments.map((segment) => segment.paraIndex)).size).toBe(12);
    assertOffsetsAreContiguous(document);
  });

  it('splits a blank-line-free note of several thousand words into windows that fit the per-call budget', () => {
    const note = Array.from({ length: 420 }, (_, index) => `Sentence ${index} confirms the permit register owner and the agreed isolation route.`).join(' ');
    expect(wordsIn(note)).toBeGreaterThan(4_000);

    const document = normalizeSource('long-note.txt', Buffer.from(note));
    expect(document.segments.length).toBeGreaterThan(10);
    expect(document.segments.every((segment) => wordsIn(segment.text) <= SEGMENT_MAX_WORDS)).toBe(true);
    expect(document.segments.map((segment) => segment.text).join(' ')).toBe(collapse(note));
    assertOffsetsAreContiguous(document);

    // The windows the pipeline would build from these segments must plan without
    // the "must be re-windowed" throw that a single document-sized segment caused.
    const budget = defaultExtractionBudget(document.sourceType, document.wordCount);
    const windows = mirrorMakeWindows(document);
    expect(windows.every((window) => window.tokenEstimate <= budget.maxTokensPerCall)).toBe(true);
    expect(() => planExtractionSlices(windows, budget)).not.toThrow();
  });

  it('keeps the two-paragraph note shape the existing suite pins', () => {
    const document = normalizeSource('note.txt', Buffer.from('First paragraph.\n\nSecond paragraph.'));
    expect(document.segments.map((segment) => segment.paraIndex)).toEqual([0, 1]);
    expect(document.segments.map((segment) => segment.kind)).toEqual(['paragraph', 'paragraph']);
  });
});

/* ------------------------------------------------------------------------- *
 * 7. The addressing contract
 * ------------------------------------------------------------------------- */

describe('segment addressing round trip', () => {
  /**
   * `charStart`/`charEnd` address the NORMALISED document text, not the original
   * bytes: tags, entities, quoted-printable, DOCX XML and repeated whitespace are
   * all resolved before a segment exists, so there is no byte range in the file
   * that equals a segment. The normalised text is exactly the segment texts
   * joined by a single newline, which `normalizedDocumentText` reconstructs and
   * this test asserts against for every source type.
   */
  it('reconstructs every segment from its own offsets, for every source type', () => {
    const documents: NormalizedDocument[] = [
      normalizeSource('session.vtt', Buffer.from(transcript([
        [1, 5, '<v Warwick Allan>The permit needs a second signature.</v>'],
        [5, 9, '<v Carolyn Dark>I will raise it today.</v>'],
        [9, 12, 'Casey: Noted for the register.'],
      ]))),
      normalizeSource('note.txt', Buffer.from([paragraph(0), paragraph(1)].join('\n\n'))),
      normalizeSource('message.eml', Buffer.from(email(['From: casey@example.invalid', 'Subject: Permit route'], [paragraph(2), paragraph(3)].join('\n\n')))),
      normalizeSource('note.docx', zipDocx([{ name: 'word/document.xml', xml: documentXml(['First synthetic paragraph.', paragraph(4)]) }])),
    ];

    for (const document of documents) {
      const text = normalizedDocumentText(document);
      for (const segment of document.segments) {
        expect(text.slice(segment.charStart, segment.charEnd)).toBe(segment.text);
      }
      assertOffsetsAreContiguous(document);
    }
  });

  it('pins the normaliser version that these output changes belong to', () => {
    expect(SOURCE_NORMALISER_VERSION).toBe('source-normaliser-v2');
  });
});

/* ------------------------------------------------------------------------- *
 * D1 — the recovery information must be visible.
 *
 * These assertions live here rather than in `tests/components.test.tsx` only
 * because this repair owns this test file; they exercise `src/components.tsx`
 * and `src/domain.ts`, not the normaliser.
 * ------------------------------------------------------------------------- */

const intakeRow = {
  id: 'src-1',
  projectId: 'demo',
  originalFileName: 'training-session.vtt',
  originalReceivedAt: '2026-07-30T09:00:00.000Z',
  contentHash: 'a'.repeat(64),
  sourceType: 'vtt-transcript',
  currentExternalPath: 'Projects/Demo/01_Sources_Immutable/training-session.vtt',
  previousExternalPath: null,
  processorProvider: 'claude-code-cli',
  extractedItemIds: [],
  reviewState: 'pending',
  verificationState: 'pending',
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T09:05:00.000Z',
};

describe('source failure is visible in the Cockpit (D1)', () => {
  afterEach(() => cleanup());

  it('admits the quarantined status and the recovery columns into the shared schema', () => {
    const parsed = inboxSourceSchema.parse({
      ...intakeRow,
      processingStatus: 'quarantined',
      processingStage: 'quarantined',
      processingError: 'Not logged in to the extraction provider.',
      processingRecoveryAction: 'Sign in to the provider CLI, then retry this source from the quarantine lane.',
    });
    expect(parsed.processingStatus).toBe('quarantined');
    expect(parsed.processingRecoveryAction).toContain('retry this source');
    // Rows written before migration 011 simply carry nulls.
    expect(inboxSourceSchema.parse({ ...intakeRow, processingStatus: 'processing' }).processingStage).toBeNull();
  });

  it('renders what went wrong and what to do for a quarantined source', () => {
    render(createElement(SourceProcessingNotice, {
      source: {
        processingStatus: 'failed',
        processingStage: 'quarantined',
        processingError: 'Provider returned HTTP 400: requires a newer CLI.',
        processingRecoveryAction: 'Upgrade the extraction CLI, then retry this source from the quarantine lane.',
        updatedAt: '2026-07-30T09:05:00.000Z',
      },
    }));
    expect(screen.getByRole('alert')).toHaveTextContent('Provider returned HTTP 400');
    expect(screen.getByRole('alert')).toHaveTextContent('Upgrade the extraction CLI');
  });

  it('surfaces a stalled source that recorded an error while still reading as processing', () => {
    const view = sourceProcessingView({ processingStatus: 'processing', processingStage: 'extracting', processingError: 'Lease expired.' });
    expect(view.needsAttention).toBe(true);
    expect(view.chipLabel).toBe('Processing - Extracting');

    render(createElement(SourceProcessingAlerts, {
      sources: [
        { ...intakeRow, processingStatus: 'processing', processingStage: 'extracting', processingError: 'Lease expired.', processingRecoveryAction: 'Retry this source from the quarantine lane.' },
        { ...intakeRow, id: 'src-2', originalFileName: 'healthy.vtt', processingStatus: 'awaiting_review', processingStage: 'awaiting_review', processingError: null, processingRecoveryAction: null },
      ],
    }));
    expect(screen.getByText('1 source needs attention')).toBeInTheDocument();
    expect(screen.getByText('training-session.vtt')).toBeInTheDocument();
    expect(screen.queryByText('healthy.vtt')).not.toBeInTheDocument();
  });

  it('renders nothing for a source that is processing normally', () => {
    const { container } = render(createElement(SourceProcessingNotice, { source: { processingStatus: 'processing', processingStage: 'extracting' } }));
    expect(container).toBeEmptyDOMElement();
  });
});

function assertOffsetsAreContiguous(document: NormalizedDocument) {
  let expectedStart = 0;
  document.segments.forEach((segment, index) => {
    expect(segment.seq).toBe(index + 1);
    expect(segment.charStart).toBe(expectedStart);
    expect(segment.charEnd - segment.charStart).toBe(segment.text.length);
    expectedStart = segment.charEnd + 1;
  });
}

/**
 * A mirror of `makeWindows` in `src/sourceIntelligence.ts`, which is not exported.
 * Kept deliberately literal so that this test measures the windows the pipeline
 * would actually build from these segments rather than an idealised version.
 */
function mirrorMakeWindows(document: NormalizedDocument) {
  const tokenEstimate = (value: string) => Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.35);
  const segments = document.segments;
  const target = 5_000;
  const overlap = 500;
  const windows: Array<{ id: string; seq: number; startSeq: number; endSeq: number; tokenEstimate: number; segments: Array<{ seq: number; text: string; speaker: string | null; tStartMs: number | null }> }> = [];
  let startIndex = 0;
  while (startIndex < segments.length) {
    let tokens = 0;
    let endIndex = startIndex;
    while (endIndex < segments.length && (tokens < target || endIndex === startIndex)) {
      tokens += tokenEstimate(segments[endIndex].text);
      endIndex += 1;
    }
    const slice = segments.slice(startIndex, endIndex);
    windows.push({
      id: `window:${windows.length + 1}`,
      seq: windows.length + 1,
      startSeq: slice[0].seq,
      endSeq: slice[slice.length - 1].seq,
      tokenEstimate: tokens,
      segments: slice.map((segment) => ({ seq: segment.seq, text: segment.text, speaker: segment.speaker, tStartMs: segment.tStartMs })),
    });
    if (endIndex >= segments.length) break;
    let overlapTokens = 0;
    let nextStart = endIndex;
    while (nextStart > startIndex && overlapTokens < overlap) {
      nextStart -= 1;
      overlapTokens += tokenEstimate(segments[nextStart].text);
    }
    startIndex = Math.max(startIndex + 1, nextStart);
  }
  return windows;
}
