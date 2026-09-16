/**
 * Compare two evaluated trials.
 *
 * This is the thinnest version of the comparison the loop eventually needs, and
 * it is deliberately unable to support the interesting question. Given two
 * trials, it reports whether they differ and in which criteria. It does **not**
 * say which harness is better: with one trial per harness there is no power to
 * say that, and a function that appeared to would be a bug wearing a result's
 * clothes.
 *
 * What this *can* support: the machinery works end to end, a candidate is
 * distinguishable from its parent, and a criterion that moved is named. What
 * it cannot support is a promotion decision — that needs replicates, and
 * lives in PR 7B.
 */

import type { EvaluationResult } from "./evaluate.ts";

export interface TrialArm {
  /** The genome the trial ran under, e.g. `evocfd:m1-baseline`. */
  genome_id: string;
  /** The harness identity of that genome, so the arm is content-addressed. */
  harness_identity: string;
  result: EvaluationResult;
}

export interface CriterionDelta {
  criterion: string;
  /** `parent` and `candidate` verdicts for this one criterion. */
  parent_pass: boolean;
  candidate_pass: boolean;
  detail: string;
}

export type ComparisonKind =
  | "differ"
  | "same"
  | "incomparable";

export interface TrialComparison {
  comparison_schema_version: 1;
  kind: ComparisonKind;
  /** Present for `incomparable`, with the reason no comparison is possible. */
  reason?: string;
  parent: TrialArm;
  candidate: TrialArm;
  /** Criteria whose verdicts differ. Empty for `same`. */
  deltas: CriterionDelta[];
  /**
   * True only when the candidate passed a criterion the parent failed. This is
   * a *description* of what happened, not evidence of anything: one trial per
   * arm means it could as easily be noise.
   */
  candidate_gained: boolean;
  candidate_lost: boolean;
}

/**
 * Compare a parent arm against a candidate arm.
 *
 * Both arms must have been judged, and judged over the same fixture —
 * comparing verdicts from different fixtures compares two different questions,
 * which is reported as `incomparable` rather than silently subtracted. The
 * function is pure: it reads two records and returns a description.
 */
export function compareTrials(input: { parent: TrialArm; candidate: TrialArm }): TrialComparison {
  if (input.parent.result.fixture_id !== input.candidate.result.fixture_id) {
    return {
      comparison_schema_version: 1,
      kind: "incomparable",
      reason: `the arms ran different fixtures (${input.parent.result.fixture_id} and ${input.candidate.result.fixture_id}); a verdict over one task says nothing about another`,
      parent: input.parent,
      candidate: input.candidate,
      deltas: [],
      candidate_gained: false,
      candidate_lost: false,
    };
  }

  if (input.parent.result.error || input.candidate.result.error) {
    const which = [input.parent.result.error ? "the parent" : null, input.candidate.result.error ? "the candidate" : null]
      .filter((value) => value !== null)
      .join(" and ");
    return {
      comparison_schema_version: 1,
      kind: "incomparable",
      reason: `${which} arm has no verdict; an arm that was not judged cannot be compared`,
      parent: input.parent,
      candidate: input.candidate,
      deltas: [],
      candidate_gained: false,
      candidate_lost: false,
    };
  }

  const parentByCriterion = new Map(
    input.parent.result.criteria.map((criterion) => [criterion.criterion, criterion]),
  );
  const parentNames = new Set(parentByCriterion.keys());
  const candidateNames = new Set(input.candidate.result.criteria.map((criterion) => criterion.criterion));
  if (parentNames.size !== candidateNames.size || [...parentNames].some((name) => !candidateNames.has(name))) {
    // Both arms ran the same fixture, so one evaluator judged both: the
    // criterion sets must agree. A mismatch means the two verdicts answer
    // slightly different questions — a partial verdict, a fixture that moved,
    // or packages that do not correspond. It is reported as no comparison
    // rather than as a synthetic delta, because a criterion present on only
    // one side would otherwise look like a gain or a loss the trial cannot
    // support.
    return {
      comparison_schema_version: 1,
      kind: "incomparable",
      reason: `the arms report different criteria (${[...parentNames].join(", ")} versus ${[...candidateNames].join(", ")}); the two verdicts do not answer the same question`,
      parent: input.parent,
      candidate: input.candidate,
      deltas: [],
      candidate_gained: false,
      candidate_lost: false,
    };
  }

  const deltas: CriterionDelta[] = [];
  for (const candidate of input.candidate.result.criteria) {
    const parent = parentByCriterion.get(candidate.criterion);
    if (parent === undefined) {
      // Unreachable after the set check above; kept so the type is total.
      continue;
    }
    if (parent.pass !== candidate.pass) {
      deltas.push({
        criterion: candidate.criterion,
        parent_pass: parent.pass,
        candidate_pass: candidate.pass,
        detail: candidate.detail,
      });
    }
  }

  const gained = deltas.some((delta) => !delta.parent_pass && delta.candidate_pass);
  const lost = deltas.some((delta) => delta.parent_pass && !delta.candidate_pass);

  return {
    comparison_schema_version: 1,
    kind: deltas.length === 0 && input.parent.result.pass === input.candidate.result.pass ? "same" : "differ",
    parent: input.parent,
    candidate: input.candidate,
    deltas,
    candidate_gained: gained,
    candidate_lost: lost,
  };
}
