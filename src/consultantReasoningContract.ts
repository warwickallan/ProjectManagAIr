/**
 * The Consultant Reasoning output contract, and the deterministic validator
 * that decides whether a reasoning run may be shown to the consultant.
 *
 * This module is pure: no database, no provider, no filesystem. It takes the
 * parsed provider output plus the set of register IDs that were actually
 * supplied to the model, and returns either an accepted result or a list of
 * violations. That separation is what lets the same validator run against
 * synthetic fixtures in tests and against a real provider response in
 * production, with no path where a failure is repaired by re-prompting.
 *
 * The governing rule, from the skill's own doctrine: a revision may change
 * what the AI is asked to do, but it must never weaken what Project ManagAIr
 * accepts. Everything below is therefore enforced here in code, not in the
 * prompt.
 */

export const CONSULTANT_REASONING_SKILL_ID = 'consultant-reasoning';
export const CONSULTANT_REASONING_CONTRACT_VERSION = 1;

export const BRIEF_MODES = ['meeting', 'needs-consultant', 'status', 'handover'] as const;
export type BriefMode = typeof BRIEF_MODES[number];

export const CLASSIFICATIONS = [
  'safety_or_compliance', 'delivery_blocker', 'decision_required', 'customer_dependency',
  'consultant_action', 'shared_action', 'open_question', 'contradiction', 'recent_change', 'watch_item',
] as const;
export type Classification = typeof CLASSIFICATIONS[number];

export const PRIORITIES = ['critical', 'high', 'medium'] as const;
export type Priority = typeof PRIORITIES[number];

export const STATES = ['confirmed_current', 'stale_needs_confirmation', 'conflicted', 'weakly_supported'] as const;
export type MatterState = typeof STATES[number];

export const OWNER_CLASSES = ['consultant', 'customer', 'shared', 'unowned', 'not_applicable'] as const;
export type OwnerClass = typeof OWNER_CLASSES[number];

export const EVIDENCE_STRENGTHS = ['strong', 'mixed', 'weak'] as const;
export type ReasoningEvidenceStrength = typeof EVIDENCE_STRENGTHS[number];

export const MAX_MATTERS = 25;
export const MAX_MEETING_ORDER = 10;
export const MIN_EXECUTIVE_SUMMARY = 2;
export const MAX_EXECUTIVE_SUMMARY = 5;

/** The section arrays, all of which contain matter IDs and nothing else. */
export const SECTION_KEYS = [
  'meeting_order', 'decisions_required', 'customer_dependencies', 'consultant_next_actions',
  'risks_and_blockers', 'unanswered_questions', 'contradictions_and_state_conflicts',
  'recent_changes', 'confirmation_warnings',
] as const;
export type SectionKey = typeof SECTION_KEYS[number];

export interface ReasoningSummaryPoint {
  text: string;
  supporting_register_ids: string[];
}

/** A state observation names itself `observation`, not `text`. */
export interface ReasoningStateObservation {
  observation: string;
  supporting_register_ids: string[];
}

export interface ReasoningMatter {
  matter_id: string;
  title: string;
  situation: string;
  why_it_matters: string;
  recommended_move: string;
  classification: Classification;
  priority: Priority;
  state: MatterState;
  owner_class: OwnerClass;
  evidence_strength: ReasoningEvidenceStrength;
  supporting_register_ids: string[];
  reasoning: string;
  related_matter_ids: string[];
}

export interface ReasoningOutput {
  brief_type: BriefMode;
  executive_summary: ReasoningSummaryPoint[];
  matters: ReasoningMatter[];
  meeting_order: string[];
  decisions_required: string[];
  customer_dependencies: string[];
  consultant_next_actions: string[];
  risks_and_blockers: string[];
  unanswered_questions: string[];
  contradictions_and_state_conflicts: string[];
  recent_changes: string[];
  confirmation_warnings: string[];
  state_observations: ReasoningStateObservation[];
  limitations: ReasoningSummaryPoint[];
}

const TOP_LEVEL_KEYS = new Set<string>([
  'brief_type', 'executive_summary', 'matters', ...SECTION_KEYS, 'state_observations', 'limitations',
]);

const MATTER_KEYS = new Set<string>([
  'matter_id', 'title', 'situation', 'why_it_matters', 'recommended_move', 'classification',
  'priority', 'state', 'owner_class', 'evidence_strength', 'supporting_register_ids',
  'reasoning', 'related_matter_ids',
]);

export type ViolationCode =
  | 'malformed'
  | 'unknown_field'
  | 'missing_field'
  | 'invalid_enum'
  | 'invalid_mode'
  | 'unknown_register_id'
  | 'missing_citation'
  | 'duplicate_matter_id'
  | 'invalid_matter_id'
  | 'unknown_matter_reference'
  | 'limit_exceeded'
  | 'customer_dependency_unsupported'
  | 'consultant_action_unsupported'
  | 'weak_evidence_unwarned';

export interface Violation {
  code: ViolationCode;
  path: string;
  detail: string;
}

export interface ValidationSuccess {
  ok: true;
  output: ReasoningOutput;
  /** Every register ID the accepted output cites, deduped and sorted. */
  citedRegisterIds: string[];
  violations: [];
}

export interface ValidationFailure {
  ok: false;
  output: null;
  citedRegisterIds: string[];
  violations: Violation[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ValidateOptions {
  /** Register IDs supplied to the model. Anything else is invented. */
  allowedRegisterIds: Iterable<string>;
  /** The mode Project ManagAIr requested; `brief_type` must equal it. */
  requestedMode: string;
}

const MATTER_ID_PATTERN = /^MAT-\d{2,3}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validate a parsed reasoning output.
 *
 * Returns every violation found rather than throwing on the first: a run that
 * fails is preserved and reported, and the operator deserves the whole list of
 * reasons rather than a trickle of one per retry. There are deliberately no
 * retries anywhere in this path — a completed provider response that fails
 * validation is surfaced, not re-bought.
 */
export function validateReasoningOutput(parsed: unknown, options: ValidateOptions): ValidationResult {
  const violations: Violation[] = [];
  const allowed = new Set(options.allowedRegisterIds);
  const cited = new Set<string>();

  const fail = (code: ViolationCode, path: string, detail: string) => violations.push({ code, path, detail });

  if (!isPlainObject(parsed)) {
    return { ok: false, output: null, citedRegisterIds: [], violations: [{ code: 'malformed', path: '$', detail: 'Output is not a JSON object.' }] };
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail('unknown_field', `$.${key}`, `Unknown top-level field "${key}"; the contract rejects unknown keys.`);
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in parsed)) fail('missing_field', `$.${key}`, `Required field "${key}" is absent.`);
  }

  /* ---------------------------------------------------------- brief_type */
  if (parsed.brief_type !== options.requestedMode) {
    fail('invalid_mode', '$.brief_type', `brief_type "${String(parsed.brief_type)}" does not equal the requested mode "${options.requestedMode}".`);
  }
  if (!BRIEF_MODES.includes(parsed.brief_type as BriefMode)) {
    fail('invalid_enum', '$.brief_type', `brief_type "${String(parsed.brief_type)}" is not a supported mode.`);
  }

  /* --------------------------------------------- cited-id helper */
  const checkIds = (value: unknown, path: string, options_: { required: boolean }): string[] => {
    if (!isStringArray(value)) {
      fail('malformed', path, 'Expected an array of register ID strings.');
      return [];
    }
    if (options_.required && value.length === 0) {
      fail('missing_citation', path, 'At least one supporting register ID is required.');
    }
    for (const id of value) {
      if (!allowed.has(id)) {
        fail('unknown_register_id', path, `Register ID "${id}" was not supplied to the model; the output cites a record that does not exist.`);
      } else {
        cited.add(id);
      }
    }
    return value;
  };

  /* ------------------------------------------------- executive_summary */
  const summary = parsed.executive_summary;
  if (!Array.isArray(summary)) {
    fail('malformed', '$.executive_summary', 'Expected an array.');
  } else {
    if (summary.length < MIN_EXECUTIVE_SUMMARY || summary.length > MAX_EXECUTIVE_SUMMARY) {
      fail('limit_exceeded', '$.executive_summary', `Expected ${MIN_EXECUTIVE_SUMMARY}–${MAX_EXECUTIVE_SUMMARY} points, found ${summary.length}.`);
    }
    summary.forEach((point, index) => {
      const path = `$.executive_summary[${index}]`;
      if (!isPlainObject(point)) { fail('malformed', path, 'Expected an object.'); return; }
      for (const key of Object.keys(point)) {
        if (!['text', 'supporting_register_ids'].includes(key)) fail('unknown_field', `${path}.${key}`, `Unknown field "${key}".`);
      }
      if (!isNonEmptyString(point.text)) fail('missing_field', `${path}.text`, 'A summary point needs text.');
      checkIds(point.supporting_register_ids, `${path}.supporting_register_ids`, { required: true });
    });
  }

  /* ------------------------------- state_observations and limitations */
  //
  // These carry citations too, and an invented register ID here is exactly the
  // hallucinated-citation failure the contract exists to stop — it was simply
  // wearing a different key. They are validated with the same rules as the
  // summary, minus the length bound. `limitations` may cite nothing at all,
  // but only because a limitation about the supplied input as a whole has
  // nothing to cite; an ID that IS present must still exist.
  for (const key of ['state_observations', 'limitations'] as const) {
    const points = (parsed as Record<string, unknown>)[key];
    if (!Array.isArray(points)) {
      if (key in parsed) fail('malformed', `$.${key}`, 'Expected an array.');
      continue;
    }
    const textField = key === 'state_observations' ? 'observation' : 'text';
    points.forEach((point, index) => {
      const path = `$.${key}[${index}]`;
      if (!isPlainObject(point)) { fail('malformed', path, 'Expected an object.'); return; }
      for (const field of Object.keys(point)) {
        if (![textField, 'supporting_register_ids'].includes(field)) fail('unknown_field', `${path}.${field}`, `Unknown field "${field}".`);
      }
      if (!isNonEmptyString(point[textField])) fail('missing_field', `${path}.${textField}`, `"${textField}" must be a non-empty string.`);
      checkIds(point.supporting_register_ids, `${path}.supporting_register_ids`, { required: false });
    });
  }

  /* ------------------------------------------------------------ matters */
  const matters = parsed.matters;
  const matterById = new Map<string, ReasoningMatter>();
  if (!Array.isArray(matters)) {
    fail('malformed', '$.matters', 'Expected an array.');
  } else {
    if (matters.length > MAX_MATTERS) {
      fail('limit_exceeded', '$.matters', `At most ${MAX_MATTERS} matters are allowed, found ${matters.length}.`);
    }
    matters.forEach((matter, index) => {
      const path = `$.matters[${index}]`;
      if (!isPlainObject(matter)) { fail('malformed', path, 'Expected an object.'); return; }
      for (const key of Object.keys(matter)) {
        if (!MATTER_KEYS.has(key)) fail('unknown_field', `${path}.${key}`, `Unknown field "${key}".`);
      }
      for (const key of MATTER_KEYS) {
        if (!(key in matter)) fail('missing_field', `${path}.${key}`, `Required field "${key}" is absent.`);
      }

      const id = matter.matter_id;
      if (typeof id !== 'string' || !MATTER_ID_PATTERN.test(id)) {
        fail('invalid_matter_id', `${path}.matter_id`, `matter_id "${String(id)}" must match MAT-NN.`);
      } else if (matterById.has(id)) {
        fail('duplicate_matter_id', `${path}.matter_id`, `matter_id "${id}" is used more than once.`);
      }

      for (const [field, allowedValues] of [
        ['classification', CLASSIFICATIONS], ['priority', PRIORITIES], ['state', STATES],
        ['owner_class', OWNER_CLASSES], ['evidence_strength', EVIDENCE_STRENGTHS],
      ] as const) {
        if (!(allowedValues as readonly string[]).includes(matter[field] as string)) {
          fail('invalid_enum', `${path}.${field}`, `"${String(matter[field])}" is not a valid ${field}.`);
        }
      }

      for (const field of ['title', 'situation', 'why_it_matters', 'recommended_move', 'reasoning'] as const) {
        if (!isNonEmptyString(matter[field])) fail('missing_field', `${path}.${field}`, `"${field}" must be a non-empty string.`);
      }

      checkIds(matter.supporting_register_ids, `${path}.supporting_register_ids`, { required: true });
      if (!isStringArray(matter.related_matter_ids)) {
        // Reported once here, and deliberately NOT walked below. A string is
        // iterable, so cross-referencing a non-array would emit one bogus
        // unknown-matter violation per character and bury the real reason.
        fail('malformed', `${path}.related_matter_ids`, 'Expected an array of matter ID strings.');
      }

      if (typeof id === 'string' && MATTER_ID_PATTERN.test(id) && !matterById.has(id)) {
        matterById.set(id, matter as unknown as ReasoningMatter);
      }
    });

    // Cross-references resolve only after every matter id is known.
    for (const [id, matter] of matterById) {
      if (!Array.isArray(matter.related_matter_ids)) continue;
      for (const related of matter.related_matter_ids) {
        if (!matterById.has(related)) {
          fail('unknown_matter_reference', `$.matters[${id}].related_matter_ids`, `References matter "${related}", which this output does not define.`);
        }
        if (related === id) {
          fail('unknown_matter_reference', `$.matters[${id}].related_matter_ids`, 'A matter may not reference itself.');
        }
      }
    }
  }

  /* ----------------------------------------------------- section arrays */
  for (const key of SECTION_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (!isStringArray(value)) {
      if (key in parsed) fail('malformed', `$.${key}`, 'Expected an array of matter ID strings.');
      continue;
    }
    if (key === 'meeting_order' && value.length > MAX_MEETING_ORDER) {
      fail('limit_exceeded', `$.${key}`, `meeting_order may list at most ${MAX_MEETING_ORDER} matters, found ${value.length}.`);
    }
    const seen = new Set<string>();
    value.forEach((matterId, index) => {
      if (!matterById.has(matterId)) {
        fail('unknown_matter_reference', `$.${key}[${index}]`, `Section references matter "${matterId}", which this output does not define.`);
        return;
      }
      if (seen.has(matterId)) {
        fail('unknown_matter_reference', `$.${key}[${index}]`, `Section lists matter "${matterId}" more than once.`);
      }
      seen.add(matterId);
    });
  }

  /* ---------------------------------------------- semantic section rules */
  const sectionList = (key: SectionKey): string[] => {
    const value = (parsed as Record<string, unknown>)[key];
    return isStringArray(value) ? value : [];
  };

  // A customer dependency must actually be external. The skill states the rule;
  // this is where Project ManagAIr enforces it, so a future revision that
  // softens the wording cannot soften the gate.
  for (const matterId of sectionList('customer_dependencies')) {
    const matter = matterById.get(matterId);
    if (!matter) continue;
    const externallyOwned = matter.owner_class === 'customer';
    const externallyClassified = matter.classification === 'customer_dependency';
    if (!externallyOwned && !externallyClassified) {
      fail('customer_dependency_unsupported', `$.customer_dependencies[${matterId}]`,
        `Matter "${matterId}" is listed as a customer dependency but is owner_class "${matter.owner_class}" and classification "${matter.classification}"; neither establishes an external dependency.`);
    }
  }

  // A consultant action must be the consultant's, shared, or an explicit
  // ownership decision. Unowned work silently becoming the consultant's is one
  // of the failure modes this contract exists to stop.
  for (const matterId of sectionList('consultant_next_actions')) {
    const matter = matterById.get(matterId);
    if (!matter) continue;
    if (['consultant', 'shared'].includes(matter.owner_class)) continue;
    const resolvesOwnership = /assign|resolve ownership|ownership decision|owner|who owns/i.test(matter.recommended_move ?? '');
    if (matter.owner_class === 'unowned' && resolvesOwnership) continue;
    fail('consultant_action_unsupported', `$.consultant_next_actions[${matterId}]`,
      `Matter "${matterId}" is listed as a consultant action but is owner_class "${matter.owner_class}" without an explicit ownership-resolution move.`);
  }

  // Anything not confirmed-current must be flagged so the consultant cannot
  // read it as settled truth.
  const warned = new Set(sectionList('confirmation_warnings'));
  for (const [id, matter] of matterById) {
    const needsWarning = matter.evidence_strength === 'weak'
      || ['stale_needs_confirmation', 'conflicted', 'weakly_supported'].includes(matter.state);
    if (needsWarning && !warned.has(id)) {
      fail('weak_evidence_unwarned', `$.confirmation_warnings`,
        `Matter "${id}" is state "${matter.state}" with ${matter.evidence_strength} evidence but is absent from confirmation_warnings.`);
    }
  }

  const citedRegisterIds = [...cited].sort();
  if (violations.length > 0) return { ok: false, output: null, citedRegisterIds, violations };
  return { ok: true, output: parsed as unknown as ReasoningOutput, citedRegisterIds, violations: [] };
}

/**
 * Pull the JSON object out of a raw provider response.
 *
 * Kept separate from validation so a parse failure and a contract failure are
 * distinguishable in the run record: the first is a provider/transport
 * problem, the second is a skill-revision problem, and conflating them sends
 * the operator to the wrong fix.
 */
export function parseReasoningResponse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    : trimmed;
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'No JSON object found in the provider response.' };
  const candidate = withoutFence.slice(start, end + 1);
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
