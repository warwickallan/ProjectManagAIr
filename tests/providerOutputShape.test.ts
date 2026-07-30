import { parseStructuredExtractionOutput } from '../src/extractionProvider';
const row = { client_ref: 'Actions-1', op: 'add', proposed_id: '$ALLOC', target_id: null, title: 'T', summary: 'S', status: null, record_type: null, owner: null, due_date_raw: null, source_ref: 'S1', related_refs: [], supersedes: [], anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: 'a verbatim quote here' }], derivation: 'fact', reasoning: null, confidence: 'high', discharges_markers: [], details: {} };
const coverage = [{ key: '1', status: 'reviewed', itemCount: 1, explanation: null }];
it('accepts nested and flat row shapes identically', () => {
  const nested = parseStructuredExtractionOutput({ rows: [{ registerName: 'Actions', row }], windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' });
  const flat = parseStructuredExtractionOutput({ rows: [{ registerName: 'Actions', ...row }], windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' });
  expect(JSON.stringify(flat)).toBe(JSON.stringify(nested));
});
it('still rejects an unknown field in either shape', () => {
  expect(() => parseStructuredExtractionOutput({ rows: [{ registerName: 'Actions', ...row, bogus: 1 }], windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' })).toThrow(/bogus/);
  expect(() => parseStructuredExtractionOutput({ rows: [{ registerName: 'Actions', row: { ...row, bogus: 1 } }], windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' })).toThrow(/bogus/);
});

it('drops a single malformed row with an explicit record rather than discarding the pass', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ registerName: 'Actions', row: { ...row, client_ref: `Actions-${index}` } }));
  (rows[7] as { row: Record<string, unknown> }).row = { ...row, client_ref: 'Actions-7', topic: 'not a contract key' };
  const parsed = parseStructuredExtractionOutput({ rows, windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' });
  expect(parsed.rows).toHaveLength(19);
  expect(parsed.rejectedRows).toEqual([{ index: 7, registerName: 'Actions', reason: expect.stringContaining('topic') }]);
});

it('still rejects the whole pass when malformation is widespread', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ registerName: 'Actions', row: { ...row, client_ref: `Actions-${index}`, ...(index < 3 ? { topic: 'x' } : {}) } }));
  expect(() => parseStructuredExtractionOutput({ rows, windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' })).toThrow(/topic/);
});

it('never repairs a row: a malformed row is dropped, not stripped of its unknown key', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ registerName: 'Actions', row: { ...row, client_ref: `Actions-${index}` } }));
  (rows[2] as { row: Record<string, unknown> }).row = { ...row, client_ref: 'KEEP-ME', topic: 'x' };
  const parsed = parseStructuredExtractionOutput({ rows, windowCoverage: coverage, categoryCoverage: coverage }, { providerId: 'p' });
  expect(JSON.stringify(parsed.rows)).not.toContain('KEEP-ME');
});
