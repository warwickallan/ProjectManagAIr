import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';

/* ------------------------------------------------------------------------- *
 * N7 — HIGH-marker detection for date commitments.
 *
 * The `explicit-date` detector used to veto a whole segment whenever any
 * past-tense word appeared anywhere in it (`finished`, `completed`, `closed`,
 * `did`, `was`, `had`, `already`). Those words are the ordinary vocabulary of
 * forward-looking commitments — "I'll have the permit mapping COMPLETED by
 * Friday" — so five of six realistic date commitments raised no marker at all.
 *
 * The failure direction is what makes it serious. A HIGH marker is a mandatory
 * discharge obligation (§7.1.6) and a per-window recall checklist entry, so a
 * missed marker does not add noise: it silently REMOVES an obligation, and the
 * gate reports a clean packet that never accounted for the commitment.
 *
 * This file is the whole trade-off in one table: the design's ten §7.3 HIGH
 * examples, the six realistic date commitments the reviewer measured, and the
 * three false-positive cases the veto exists to catch. Every row is scored
 * through the real ingest path — normalisation, folding, `preScan`, the
 * `source_markers` table — with both straight and curly apostrophes, because
 * Teams and Word emit U+2019.
 * ------------------------------------------------------------------------- */

const STRAIGHT = "'";
const CURLY = '’';

interface MarkerCase {
  /** Where the case comes from, so a regression is traceable to its source. */
  origin: 'design-7.3' | 'date-commitment' | 'false-positive';
  label: string;
  text: string;
  /** Whether this segment must raise at least one HIGH marker. */
  high: boolean;
  /** Why the rendering differs from the design's bare phrase, where it does. */
  note?: string;
}

const MARKER_CASES: MarkerCase[] = [
  /* --- the design's ten §7.3 HIGH examples, verbatim where they stand alone -- */
  { origin: 'design-7.3', label: "that's an action", text: "Right, that's an action.", high: true },
  { origin: 'design-7.3', label: 'an action on me', text: 'That is an action on me.', high: true },
  { origin: 'design-7.3', label: 'action for yourselves', text: 'That one is an action for yourselves.', high: true },
  { origin: 'design-7.3', label: 'capture that for the decision log', text: 'Can you capture that for the decision log.', high: true },
  { origin: 'design-7.3', label: 'AI note for development', text: 'AI note for development, the suppression flag needs a label.', high: true },
  { origin: 'design-7.3', label: "I'll suppress that", text: "I'll suppress that.", high: true },
  { origin: 'design-7.3', label: "I've just added", text: "I've just added it.", high: true },
  { origin: 'design-7.3', label: 'let me tick that', text: 'Let me tick that.', high: true },
  {
    origin: 'design-7.3',
    label: 'by the end of the week',
    text: "We'll have the permit mapping done by the end of the week.",
    high: true,
    note: 'The design lists the bare date phrase; a date is only a commitment once somebody commits to it, so the phrase is rendered with a committing subject.',
  },
  { origin: 'design-7.3', label: "Wednesday the 15th, ten o'clock", text: "Wednesday the 15th, ten o'clock.", high: true },

  /* --- the six realistic date commitments the reviewer measured ------------- */
  { origin: 'date-commitment', label: 'completed by Friday', text: "I'll have the permit mapping completed by Friday.", high: true },
  { origin: 'date-commitment', label: 'closed by the end of the week', text: 'we need to get the register closed by the end of the week.', high: true },
  { origin: 'date-commitment', label: 'finished by the end of the month', text: 'we will get that finished by the end of the month.', high: true },
  { origin: 'date-commitment', label: 'was clear that we must deliver', text: 'Tony was clear that we must deliver the counts by Monday.', high: true },
  { origin: 'date-commitment', label: 'already promised, by next Wednesday', text: 'I have already promised the customer the plan by next Wednesday.', high: true },
  { origin: 'date-commitment', label: 'please send by Friday', text: 'please send the revised counts by Friday.', high: true },

  /* --- the three cases the veto exists for ---------------------------------- */
  { origin: 'false-positive', label: 'calendar information', text: 'next Wednesday is a bank holiday for everyone here.', high: false },
  { origin: 'false-positive', label: 'completed past work', text: 'we finished that by Friday last month without any fuss.', high: false },
  { origin: 'false-positive', label: 'irrelevant change of mind', text: "I'll change my mind about the sandwich before lunch.", high: false },

  /* --- further past/future discriminations the narrowed veto must keep ------ */
  {
    origin: 'false-positive',
    label: 'recollection with an explicit past-time expression',
    text: 'we sent the counts by Monday last week, so that one is done.',
    high: false,
    note: 'Past-time expression in the same clause as the date, and no future modal.',
  },
  {
    origin: 'false-positive',
    label: 'counterfactual',
    text: 'we would have closed that by the end of the month if the licences had arrived.',
    high: false,
  },
  {
    origin: 'date-commitment',
    label: 'commitment beside an unrelated recollection',
    text: "I'll send the counts by Friday, we finished the last batch three weeks ago.",
    high: true,
    note: 'The veto is scoped to the clause holding the date; a recollection in a later clause must not cancel the commitment.',
  },
];

/* ------------------------------- plumbing -------------------------------- */

function tempDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'marker-detection-'));
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 'test.db'));
  return { dir, root, context };
}

async function createSyntheticProject(db: DatabaseSync, root: string, code: string) {
  await updateStorageSettings(db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  await verifyStorageRoot(db, true);
  return createProject(db, { code, name: 'Synthetic Delivery', customer: 'Fictional Customer', description: 'Synthetic marker detection fixture.', status: 'active', owner: 'Casey' });
}

function stamp(totalSeconds: number): string {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${[hours, minutes, seconds].join(':')}.000`;
}

function vttBytes(lines: string[]): Buffer {
  const blocks: string[] = [['WEB', 'VTT'].join('')];
  lines.forEach((text, index) => {
    blocks.push([`${stamp(index * 10)} --> ${stamp(index * 10 + 8)}`, `Casey: ${text}`].join('\n'));
  });
  return Buffer.from(blocks.join('\n\n'), 'utf8');
}

/** Segment sequence numbers that raised at least one HIGH marker, and their types. */
async function scanHighMarkers(apostrophe: string) {
  const { dir, root, context } = tempDatabase();
  const db = context.db;
  try {
    const project = await createSyntheticProject(db, root, 'MARK');
    const lines = MARKER_CASES.map((entry) => entry.text.split(STRAIGHT).join(apostrophe));
    const intake = await intakeProjectSource(db, project.projectId, { name: `marker-table-${apostrophe === STRAIGHT ? 'plain' : 'curly'}.vtt`, dataBase64: vttBytes(lines).toString('base64') });
    const sourceId = String(intake.sourceId);
    const segments = db.prepare('SELECT count(*) AS count FROM source_segments WHERE source_id = ?').get(sourceId) as { count: number };
    expect(segments.count, 'every case must normalise to exactly one segment').toBe(MARKER_CASES.length);
    const markers = db.prepare("SELECT segment_seq, marker_type FROM source_markers WHERE source_id = ? AND confidence = 'high' ORDER BY segment_seq, marker_type").all(sourceId) as Array<{ segment_seq: number; marker_type: string }>;
    const bySegment = new Map<number, string[]>();
    for (const marker of markers) bySegment.set(marker.segment_seq, [...(bySegment.get(marker.segment_seq) ?? []), marker.marker_type]);
    return bySegment;
  } finally {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------- table --------------------------------- */

describe('N7 — HIGH-marker detection over the design examples, real date commitments and known false positives', () => {
  for (const apostrophe of [STRAIGHT, CURLY]) {
    const label = apostrophe === STRAIGHT ? 'straight apostrophes' : 'curly apostrophes';

    it(`classifies every case in the table with ${label}`, async () => {
      const bySegment = await scanHighMarkers(apostrophe);
      // Reported as a whole table rather than one assertion per row, so a change
      // to the detector shows its full trade-off in one failure message.
      const outcome = MARKER_CASES.map((entry, index) => ({
        origin: entry.origin,
        label: entry.label,
        expected: entry.high ? 'HIGH' : 'not HIGH',
        actual: bySegment.has(index + 1) ? 'HIGH' : 'not HIGH',
        markerTypes: bySegment.get(index + 1) ?? [],
      }));
      const failures = outcome.filter((row) => row.expected !== row.actual)
        .map((row) => `${row.origin} · ${row.label}: expected ${row.expected}, got ${row.actual}`);
      expect(failures).toEqual([]);
    });

    it(`raises no missed date commitment and no false positive with ${label}`, async () => {
      const bySegment = await scanHighMarkers(apostrophe);
      const truePositives = MARKER_CASES.filter((entry, index) => entry.high && bySegment.has(index + 1)).length;
      const falseNegatives = MARKER_CASES.filter((entry, index) => entry.high && !bySegment.has(index + 1)).length;
      const falsePositives = MARKER_CASES.filter((entry, index) => !entry.high && bySegment.has(index + 1)).length;
      const trueNegatives = MARKER_CASES.filter((entry, index) => !entry.high && !bySegment.has(index + 1)).length;
      expect({ truePositives, falseNegatives, falsePositives, trueNegatives })
        .toEqual({ truePositives: MARKER_CASES.filter((entry) => entry.high).length, falseNegatives: 0, falsePositives: 0, trueNegatives: MARKER_CASES.filter((entry) => !entry.high).length });
    });
  }

  it('reaches every date commitment through the explicit-date or scheduled-time detector, not by accident', async () => {
    const bySegment = await scanHighMarkers(STRAIGHT);
    // Without this, a commitment could pass the table above because some
    // unrelated detector happened to fire, leaving the date rule still broken.
    for (const [index, entry] of MARKER_CASES.entries()) {
      if (entry.origin !== 'date-commitment') continue;
      expect(bySegment.get(index + 1) ?? [], `${entry.label} must be raised as a date commitment`).toContain('explicit-date');
    }
  });

  it('covers all ten of the designs §7.3 HIGH examples, the six measured commitments and the three false-positive cases', () => {
    expect(MARKER_CASES.filter((entry) => entry.origin === 'design-7.3')).toHaveLength(10);
    expect(MARKER_CASES.filter((entry) => entry.origin === 'date-commitment' && entry.high)).toHaveLength(7);
    expect(MARKER_CASES.filter((entry) => !entry.high)).toHaveLength(5);
  });
});
