/**
 * Contract tests for the Consultant Reasoning validator.
 *
 * Every fixture here is entirely invented. The project code "ACME", the
 * register ids, and the two named people are fictional: nothing in this file
 * is derived from a real customer register, and nothing customer-specific may
 * ever be added to it, because this repository is public.
 *
 * The point of the validator is that a provider response is *accepted or
 * refused*, never repaired. These tests therefore lean hard on the refusal
 * cases: each one pins a distinct way a model could produce plausible-looking
 * output that would mislead a consultant, and asserts the specific violation
 * code the operator would be shown.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_MATTERS,
  MAX_MEETING_ORDER,
  parseReasoningResponse,
  validateReasoningOutput,
  type ValidationResult,
  type ViolationCode,
} from '../src/consultantReasoningContract.js';

/** The register ids the model was given. Anything else is invented by the model. */
const ALLOWED_REGISTER_IDS = ['ACME-A-001', 'ACME-D-002', 'ACME-R-003', 'ACME-Q-004'];
const REQUESTED_MODE = 'meeting';

type Loose = Record<string, unknown>;

function options(overrides: Partial<{ allowedRegisterIds: string[]; requestedMode: string }> = {}) {
  return {
    allowedRegisterIds: ALLOWED_REGISTER_IDS,
    requestedMode: REQUESTED_MODE,
    ...overrides,
  };
}

/**
 * A single contract-valid matter. Defaults to consultant-owned work, because
 * that is the shape most sections legitimately reference; every awkward case
 * below is expressed as an override of this baseline so the diff between a
 * passing and a failing fixture is exactly the defect under test.
 */
function matter(overrides: Loose = {}): Loose {
  return {
    matter_id: 'MAT-01',
    title: 'Survey pack not yet reissued',
    situation: 'Dana Whitfield agreed to reissue the survey pack after the last workshop.',
    why_it_matters: 'The design freeze cannot be signed off until the pack has been circulated.',
    recommended_move: 'Reissue the survey pack ahead of the next workshop.',
    classification: 'consultant_action',
    priority: 'high',
    state: 'confirmed_current',
    owner_class: 'consultant',
    evidence_strength: 'strong',
    supporting_register_ids: ['ACME-A-001'],
    reasoning: 'The actions register records this as open and attributed to the consultant.',
    related_matter_ids: [],
    ...overrides,
  };
}

/** The customer-owned counterpart, used wherever a genuine dependency is needed. */
function customerMatter(overrides: Loose = {}): Loose {
  return matter({
    matter_id: 'MAT-02',
    title: 'Ravi Chandra to confirm the site access dates',
    situation: 'Ravi Chandra undertook to confirm the access window with his facilities team.',
    why_it_matters: 'Nothing on site can be scheduled until the window is fixed.',
    recommended_move: 'Ask Ravi Chandra to confirm the access window in writing.',
    classification: 'customer_dependency',
    owner_class: 'customer',
    supporting_register_ids: ['ACME-D-002'],
    related_matter_ids: ['MAT-01'],
    ...overrides,
  });
}

/**
 * A minimal output that passes every gate. Overrides replace whole keys, so a
 * test that cares about matters supplies the entire matters array.
 */
function validOutput(overrides: Loose = {}): Loose {
  return {
    brief_type: REQUESTED_MODE,
    executive_summary: [
      { text: 'The survey pack remains outstanding on the consultant side.', supporting_register_ids: ['ACME-A-001'] },
      { text: 'Site access dates are still awaited from the customer.', supporting_register_ids: ['ACME-D-002'] },
    ],
    matters: [matter(), customerMatter()],
    meeting_order: ['MAT-01', 'MAT-02'],
    decisions_required: [],
    customer_dependencies: ['MAT-02'],
    consultant_next_actions: ['MAT-01'],
    risks_and_blockers: [],
    unanswered_questions: [],
    contradictions_and_state_conflicts: [],
    recent_changes: [],
    confirmation_warnings: [],
    state_observations: [],
    limitations: [],
    ...overrides,
  };
}

/** Drop a key, for the "the model simply omitted a required field" cases. */
function omit(source: Loose, key: string): Loose {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const codesOf = (result: ValidationResult): ViolationCode[] => result.violations.map((violation) => violation.code);

/** Assert the run was refused and that the named gate is among the reasons. */
function expectRefusedWith(result: ValidationResult, code: ViolationCode): void {
  expect(result.ok).toBe(false);
  expect(result.output).toBeNull();
  expect(codesOf(result)).toContain(code);
}

describe('the happy path', () => {
  it('accepts a fully contract-valid output', () => {
    const result = validateReasoningOutput(validOutput(), options());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.output).not.toBeNull();
  });

  it('reports the deduped, sorted union of every register id the output cites', () => {
    // The cited set is what the run record pins the brief to, so a repeated
    // citation must not appear twice and the order must not depend on the
    // order the model happened to emit them in.
    const result = validateReasoningOutput(validOutput({
      executive_summary: [
        { text: 'Two threads dominate the session.', supporting_register_ids: ['ACME-R-003', 'ACME-A-001'] },
        { text: 'One question is still unanswered.', supporting_register_ids: ['ACME-Q-004'] },
      ],
      matters: [
        matter({ supporting_register_ids: ['ACME-A-001', 'ACME-R-003'] }),
        customerMatter({ supporting_register_ids: ['ACME-D-002', 'ACME-A-001'] }),
      ],
    }), options());
    expect(result.ok).toBe(true);
    expect(result.citedRegisterIds).toEqual(['ACME-A-001', 'ACME-D-002', 'ACME-Q-004', 'ACME-R-003']);
  });
});

describe('invented register ids', () => {
  it('refuses a summary point citing a register id that was never supplied', () => {
    // The single most dangerous failure: a citation that looks authoritative
    // but points at a record that does not exist.
    const result = validateReasoningOutput(validOutput({
      executive_summary: [
        { text: 'A fabricated citation.', supporting_register_ids: ['ACME-X-999'] },
        { text: 'Site access dates are still awaited.', supporting_register_ids: ['ACME-D-002'] },
      ],
    }), options());
    expectRefusedWith(result, 'unknown_register_id');
  });

  it('refuses a matter citing a register id that was never supplied', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ supporting_register_ids: ['ACME-A-777'] }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'unknown_register_id');
  });

  it('does not report an invented id as cited', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ supporting_register_ids: ['ACME-A-001', 'ACME-A-777'] }), customerMatter()],
    }), options());
    expect(result.citedRegisterIds).not.toContain('ACME-A-777');
  });
});

describe('shape of the object', () => {
  it('refuses an unknown top-level field', () => {
    // Unknown keys are rejected rather than ignored: a field the contract does
    // not know about is a skill revision that has drifted from the validator.
    const result = validateReasoningOutput({ ...validOutput(), narrative_summary: 'extra prose' }, options());
    expectRefusedWith(result, 'unknown_field');
  });

  it('refuses an unknown field inside a matter', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ confidence_score: 0.92 }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'unknown_field');
  });

  it('refuses a missing required top-level field', () => {
    const result = validateReasoningOutput(omit(validOutput(), 'limitations'), options());
    expectRefusedWith(result, 'missing_field');
  });

  it('refuses a missing required matter field', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [omit(matter(), 'reasoning'), customerMatter()],
    }), options());
    expectRefusedWith(result, 'missing_field');
  });

  it('refuses a matter whose narrative field is present but blank', () => {
    // Whitespace is not an explanation; an empty why_it_matters would render
    // as a confident heading with nothing behind it.
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ why_it_matters: '   ' }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'missing_field');
  });
});

describe('enumerations', () => {
  const badValues: Array<[string, string]> = [
    ['classification', 'urgent_thing'],
    ['priority', 'low'],
    ['state', 'probably_fine'],
    ['owner_class', 'the_sponsor'],
    ['evidence_strength', 'quite_good'],
  ];

  for (const [field, badValue] of badValues) {
    it(`refuses an invalid ${field}`, () => {
      const result = validateReasoningOutput(validOutput({
        matters: [matter({ [field]: badValue }), customerMatter()],
      }), options());
      expectRefusedWith(result, 'invalid_enum');
    });
  }
});

describe('the requested mode', () => {
  it('refuses an output whose brief_type is not the mode that was asked for', () => {
    // A status brief silently answering a meeting request would be presented
    // to the consultant under the wrong framing entirely.
    const result = validateReasoningOutput(validOutput({ brief_type: 'status' }), options());
    expectRefusedWith(result, 'invalid_mode');
    expect(codesOf(result)).not.toContain('invalid_enum');
  });

  it('refuses a brief_type that is not a supported mode at all', () => {
    const result = validateReasoningOutput(validOutput({ brief_type: 'weekly-digest' }), options());
    expectRefusedWith(result, 'invalid_enum');
    expect(codesOf(result)).toContain('invalid_mode');
  });
});

describe('matter identifiers', () => {
  it('refuses a duplicated matter_id', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter(), customerMatter({ matter_id: 'MAT-01', related_matter_ids: [] })],
      customer_dependencies: [],
      meeting_order: ['MAT-01'],
    }), options());
    expectRefusedWith(result, 'duplicate_matter_id');
  });

  it('refuses a matter_id that does not match the MAT-NN shape', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ matter_id: 'MATTER-1' }), customerMatter({ related_matter_ids: [] })],
      meeting_order: ['MAT-02'],
      consultant_next_actions: [],
    }), options());
    expectRefusedWith(result, 'invalid_matter_id');
  });
});

describe('cross-references between sections and matters', () => {
  it('refuses a section entry pointing at a matter the output never defines', () => {
    const result = validateReasoningOutput(validOutput({
      meeting_order: ['MAT-01', 'MAT-99'],
    }), options());
    expectRefusedWith(result, 'unknown_matter_reference');
  });

  it('refuses a section that lists the same matter twice', () => {
    // A repeated entry would inflate the apparent agenda and could push a real
    // item off the end of the meeting order.
    const result = validateReasoningOutput(validOutput({
      meeting_order: ['MAT-01', 'MAT-01', 'MAT-02'],
    }), options());
    expectRefusedWith(result, 'unknown_matter_reference');
  });

  it('refuses related_matter_ids pointing at a matter the output never defines', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ related_matter_ids: ['MAT-42'] }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'unknown_matter_reference');
  });

  it('refuses a matter that relates to itself', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ related_matter_ids: ['MAT-01'] }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'unknown_matter_reference');
    expect(result.violations.some((violation) => /may not reference itself/.test(violation.detail))).toBe(true);
  });
});

describe('citations are mandatory', () => {
  it('refuses a matter with no supporting register ids at all', () => {
    // An uncited matter is the model's own opinion presented as register fact.
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ supporting_register_ids: [] }), customerMatter()],
    }), options());
    expectRefusedWith(result, 'missing_citation');
  });

  it('refuses a summary point with no supporting register ids', () => {
    const result = validateReasoningOutput(validOutput({
      executive_summary: [
        { text: 'An unsupported assertion.', supporting_register_ids: [] },
        { text: 'Site access dates are still awaited.', supporting_register_ids: ['ACME-D-002'] },
      ],
    }), options());
    expectRefusedWith(result, 'missing_citation');
  });
});

describe('limits', () => {
  it('refuses an executive summary with fewer than two points', () => {
    const result = validateReasoningOutput(validOutput({
      executive_summary: [{ text: 'A single point.', supporting_register_ids: ['ACME-A-001'] }],
    }), options());
    expectRefusedWith(result, 'limit_exceeded');
  });

  it('refuses an executive summary with more than five points', () => {
    const result = validateReasoningOutput(validOutput({
      executive_summary: Array.from({ length: 6 }, (_, index) => ({
        text: `Summary point ${index + 1} for the ACME session.`,
        supporting_register_ids: ['ACME-A-001'],
      })),
    }), options());
    expectRefusedWith(result, 'limit_exceeded');
  });

  it(`refuses more than ${MAX_MATTERS} matters`, () => {
    // Everything else about this fixture is valid, so the limit is the only
    // reason the run is refused — that keeps the assertion honest.
    const many = Array.from({ length: MAX_MATTERS + 1 }, (_, index) => matter({
      matter_id: `MAT-${String(index + 1).padStart(2, '0')}`,
    }));
    const result = validateReasoningOutput(validOutput({
      matters: many,
      meeting_order: [],
      customer_dependencies: [],
      consultant_next_actions: [],
    }), options());
    expect(codesOf(result)).toEqual(['limit_exceeded']);
  });

  it(`refuses a meeting order longer than ${MAX_MEETING_ORDER} entries`, () => {
    const many = Array.from({ length: MAX_MEETING_ORDER + 1 }, (_, index) => matter({
      matter_id: `MAT-${String(index + 1).padStart(2, '0')}`,
    }));
    const result = validateReasoningOutput(validOutput({
      matters: many,
      meeting_order: many.map((entry) => entry.matter_id as string),
      customer_dependencies: [],
      consultant_next_actions: [],
    }), options());
    expect(codesOf(result)).toEqual(['limit_exceeded']);
  });
});

describe('customer dependencies must actually be external', () => {
  it('refuses consultant-owned consultant work listed as a customer dependency', () => {
    // This is the misattribution the contract exists to stop: the consultant's
    // own outstanding work reported back to them as something they are waiting
    // on the customer for.
    const result = validateReasoningOutput(validOutput({
      customer_dependencies: ['MAT-01', 'MAT-02'],
    }), options());
    expectRefusedWith(result, 'customer_dependency_unsupported');
  });

  it('accepts a shared-ownership matter whose classification is customer_dependency', () => {
    // Classification alone establishes the external dependency, so shared
    // ownership is not on its own a reason to refuse.
    const result = validateReasoningOutput(validOutput({
      matters: [matter(), customerMatter({ owner_class: 'shared' })],
    }), options());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('consultant next actions must be the consultant’s to take', () => {
  it('refuses customer-owned work listed as a consultant next action', () => {
    const result = validateReasoningOutput(validOutput({
      consultant_next_actions: ['MAT-01', 'MAT-02'],
    }), options());
    expectRefusedWith(result, 'consultant_action_unsupported');
  });

  it('accepts unowned work when the recommended move is to settle ownership', () => {
    // Unowned work may be raised with the consultant, but only as an explicit
    // ownership decision — never as work that has quietly become theirs.
    const result = validateReasoningOutput(validOutput({
      matters: [
        matter({
          owner_class: 'unowned',
          classification: 'shared_action',
          recommended_move: 'Agree who owns this and assign an owner at the next session.',
        }),
        customerMatter(),
      ],
    }), options());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('refuses unowned work whose recommended move quietly assumes the consultant will do it', () => {
    const result = validateReasoningOutput(validOutput({
      matters: [
        matter({
          owner_class: 'unowned',
          classification: 'shared_action',
          recommended_move: 'Reissue the survey pack ahead of the next workshop.',
        }),
        customerMatter(),
      ],
    }), options());
    expectRefusedWith(result, 'consultant_action_unsupported');
  });
});

describe('weak evidence must be flagged', () => {
  const shaky: Array<[string, Loose]> = [
    ['weak evidence', { evidence_strength: 'weak' }],
    ['stale state', { state: 'stale_needs_confirmation' }],
    ['conflicted state', { state: 'conflicted' }],
    ['weakly supported state', { state: 'weakly_supported' }],
  ];

  for (const [label, override] of shaky) {
    it(`refuses a matter with ${label} that is absent from confirmation_warnings`, () => {
      // Anything short of confirmed-current, presented without a warning, reads
      // to the consultant as settled fact.
      const result = validateReasoningOutput(validOutput({
        matters: [matter(override), customerMatter()],
      }), options());
      expectRefusedWith(result, 'weak_evidence_unwarned');
    });

    it(`accepts a matter with ${label} once it is listed in confirmation_warnings`, () => {
      const result = validateReasoningOutput(validOutput({
        matters: [matter(override), customerMatter()],
        confirmation_warnings: ['MAT-01'],
      }), options());
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});

describe('malformed input', () => {
  for (const [label, value] of [
    ['a string', 'not an object at all'],
    ['an array', [{ brief_type: 'meeting' }]],
    ['null', null],
    ['a number', 7],
  ] as Array<[string, unknown]>) {
    it(`refuses ${label} outright`, () => {
      const result = validateReasoningOutput(value, options());
      expect(result.ok).toBe(false);
      expect(result.citedRegisterIds).toEqual([]);
      expect(codesOf(result)).toEqual(['malformed']);
    });
  }

  it('refuses a section that is not an array of strings', () => {
    const result = validateReasoningOutput(validOutput({ meeting_order: 'MAT-01' }), options());
    expectRefusedWith(result, 'malformed');
  });
});

describe('reporting every reason at once', () => {
  it('collects all violations rather than stopping at the first', () => {
    // There are deliberately no retries in this path, so the operator has to be
    // shown the whole list of reasons in one go rather than one per attempt.
    const result = validateReasoningOutput({
      ...validOutput({
        brief_type: 'handover',
        matters: [
          matter({ supporting_register_ids: ['ACME-A-404'], evidence_strength: 'weak' }),
          customerMatter({ owner_class: 'consultant', classification: 'consultant_action' }),
        ],
        executive_summary: [{ text: 'Only one point.', supporting_register_ids: ['ACME-A-001'] }],
      }),
      speculation: 'an unknown field',
    }, options());

    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(1);
    const codes = new Set(codesOf(result));
    for (const expected of [
      'invalid_mode', 'unknown_register_id', 'weak_evidence_unwarned',
      'customer_dependency_unsupported', 'limit_exceeded', 'unknown_field',
    ] as ViolationCode[]) {
      expect(codes).toContain(expected);
    }
  });

  it('gives every violation a path so the operator can find the offending part', () => {
    const result = validateReasoningOutput(validOutput({ meeting_order: ['MAT-99'] }), options());
    for (const violation of result.violations) {
      expect(violation.path.startsWith('$')).toBe(true);
      expect(violation.detail.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The trailing citation-bearing arrays.
 *
 * These were unvalidated at first: an invented register ID in a state
 * observation reached the consultant with exactly the authority of a checked
 * one, which is the hallucinated-citation failure the contract exists to stop,
 * merely wearing a different key. Note `state_observations` names its prose
 * field `observation`, not `text`.
 */
describe('state_observations and limitations', () => {
  it('rejects an invented register id cited in a state observation', () => {
    const result = validateReasoningOutput(validOutput({
      state_observations: [{ observation: 'The register has not been refreshed since the last session.', supporting_register_ids: ['ACME-Z-999'] }],
    }), options());
    expectRefusedWith(result, 'unknown_register_id');
  });

  it('rejects an invented register id cited in a limitation', () => {
    const result = validateReasoningOutput(validOutput({
      limitations: [{ text: 'Only one source was available.', supporting_register_ids: ['ACME-Z-999'] }],
    }), options());
    expectRefusedWith(result, 'unknown_register_id');
  });

  it('rejects an unknown field inside a limitations point', () => {
    const result = validateReasoningOutput(validOutput({
      limitations: [{ text: 'Only one source was available.', supporting_register_ids: ['ACME-A-001'], confidence_score: 0.4 }],
    }), options());
    expectRefusedWith(result, 'unknown_field');
  });

  it('rejects a state observation that uses text instead of observation', () => {
    const result = validateReasoningOutput(validOutput({
      state_observations: [{ text: 'Wrong field name.', supporting_register_ids: ['ACME-A-001'] }],
    }), options());
    expectRefusedWith(result, 'unknown_field');
  });

  it('allows a limitation that cites nothing, because it concerns the whole input', () => {
    const result = validateReasoningOutput(validOutput({
      limitations: [{ text: 'Only one source has been processed for this project.', supporting_register_ids: [] }],
    }), options());
    expect(result.ok).toBe(true);
  });

  it('counts state_observations citations in citedRegisterIds', () => {
    // citedRegisterIds is what the run record pins the brief to, so an id cited
    // only in a state observation must still reach the audit trail.
    const result = validateReasoningOutput(validOutput({
      state_observations: [{ observation: 'The risk register is the only recently updated source.', supporting_register_ids: ['ACME-R-003'] }],
    }), options());
    expect(result.citedRegisterIds).toContain('ACME-R-003');
  });
});

describe('malformed cross-references', () => {
  it('reports a non-array related_matter_ids once, not once per character', () => {
    // A string is iterable, so an unguarded cross-reference pass walks its
    // characters and emits a spurious unknown_matter_reference for each one,
    // burying the real malformed violation under noise.
    const result = validateReasoningOutput(validOutput({
      matters: [matter({ related_matter_ids: 'MAT-02' }), customerMatter()],
    }), options());
    expect(codesOf(result)).toEqual(['malformed']);
  });
});

describe('parseReasoningResponse', () => {
  const payload = { brief_type: 'meeting', matters: [] };

  it('parses a plain JSON object', () => {
    const result = parseReasoningResponse(JSON.stringify(payload));
    expect(result).toEqual({ ok: true, value: payload });
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const result = parseReasoningResponse('```json\n' + JSON.stringify(payload) + '\n```');
    expect(result).toEqual({ ok: true, value: payload });
  });

  it('parses JSON wrapped in an unlabelled fence', () => {
    const result = parseReasoningResponse('```\n' + JSON.stringify(payload) + '\n```');
    expect(result).toEqual({ ok: true, value: payload });
  });

  it('extracts the object when the model wraps it in prose', () => {
    // Providers routinely prepend a sentence of commentary; that is a transport
    // quirk, not a contract breach, so it must not be reported as one.
    const raw = `Here is the brief you asked for:\n${JSON.stringify(payload)}\nLet me know if you would like more detail.`;
    const result = parseReasoningResponse(raw);
    expect(result).toEqual({ ok: true, value: payload });
  });

  it('reports malformed JSON as a parse failure, not a contract failure', () => {
    const result = parseReasoningResponse('{ "brief_type": "meeting", }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('reports a response containing no object at all', () => {
    const result = parseReasoningResponse('I was unable to produce a brief for this session.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No JSON object/i);
  });

  it('reports an empty response', () => {
    const result = parseReasoningResponse('   ');
    expect(result.ok).toBe(false);
  });
});
