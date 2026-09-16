/**
 * A bounded proposal to change a harness.
 *
 * This is the proposer's only product, and it is deliberately not a candidate.
 * A proposal is what an agent hypothesized after reading evidence; a candidate
 * is what the controller actually constructed. Keeping them apart is what keeps
 * an agent from publishing a harness change by writing a file: the proposal is
 * prose and a skill body, and the controller decides whether it is executable
 * at all.
 *
 * The union is exhaustive and closed. `no_change` is a first-class outcome with
 * the same standing as `propose`, because a proposer that must always produce
 * a change is a proposer that will invent one. Three passing trials are not a
 * defect; saying so plainly is a result, not an empty run.
 *
 * A `propose` carries exactly one skill change. Multi-skill proposals are
 * refused, because a change set that cannot be attributed individually cannot
 * be compared individually either.
 */
export type HarnessProposal =
  | {
      schema_version: 1;
      decision: "no_change";
      rationale: string;
      evidence_refs: string[];
    }
  | {
      schema_version: 1;
      decision: "propose";
      kind: "skill_upsert" | "skill_modify";
      skill: string;
      rationale: string;
      /** What the proposer believed the deficiency was, as a testable claim. */
      hypothesis: string;
      /** What the change is expected to change about agent behaviour. */
      expected_effect: string;
      risks: string[];
      evidence_refs: string[];
      /** The full SKILL.md body the candidate would install. */
      skill_content: string;
    };

/** The one shape a proposal file may take on disk. */
export const PROPOSAL_FILE = "proposal.json";
export const PROPOSAL_SCHEMA_VERSION = 1;

export class ProposalError extends Error {
  readonly code = "EPROPOSAL";
}

/**
 * Names a skill the way Pi names one: lowercase, digits and hyphens only, with
 * no leading or trailing hyphen and no doubling — and it must match the
 * directory it lives in. A proposal that asks for `Verify First` cannot be
 * constructed at all, and neither can one that asks for `-verify-`.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Hard limits on what a proposer may write, so a runaway one is bounded. */
const LIMITS = {
  rationale: 4000,
  hypothesis: 4000,
  expected_effect: 4000,
  skill_content: 65536,
  risks: 8,
  riskText: 1000,
  evidence_refs: 16,
} as const;

/**
 * True if a proposal is well-formed enough to be constructed from.
 *
 * Validation is separate from construction so a proposer's malformed output can
 * be recorded as a failure rather than silently repaired: a field the
 * controller invented is a field the proposer did not write, and a verdict
 * later attributed to this proposal would then be attributed to nothing.
 */
export function validateProposal(value: unknown): HarnessProposal {
  if (typeof value !== "object" || value === null) {
    throw new ProposalError("a proposal must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== PROPOSAL_SCHEMA_VERSION) {
    throw new ProposalError(
      `proposal schema_version must be ${PROPOSAL_SCHEMA_VERSION}, got ${JSON.stringify(raw.schema_version)}`,
    );
  }
  if (raw.decision !== "no_change" && raw.decision !== "propose") {
    throw new ProposalError(`proposal decision must be no_change or propose, got ${JSON.stringify(raw.decision)}`);
  }
  text(raw.rationale, "rationale", 1, LIMITS.rationale);
  const evidence = stringArray(raw.evidence_refs, "evidence_refs", LIMITS.evidence_refs);

  if (raw.decision === "no_change") {
    return { schema_version: 1, decision: "no_change", rationale: raw.rationale as string, evidence_refs: evidence };
  }

  if (raw.kind !== "skill_upsert" && raw.kind !== "skill_modify") {
    throw new ProposalError(`proposal kind must be skill_upsert or skill_modify, got ${JSON.stringify(raw.kind)}`);
  }
  if (typeof raw.skill !== "string" || !SKILL_NAME_PATTERN.test(raw.skill)) {
    throw new ProposalError(
      `proposal skill must be lowercase, digits and hyphens only, got ${JSON.stringify(raw.skill)}`,
    );
  }
  text(raw.hypothesis, "hypothesis", 1, LIMITS.hypothesis);
  text(raw.expected_effect, "expected_effect", 1, LIMITS.expected_effect);
  const risks = stringArray(raw.risks, "risks", LIMITS.risks);
  for (const [index, risk] of risks.entries()) {
    if (risk.trim().length === 0) {
      throw new ProposalError(`proposal risks[${index}] is empty`);
    }
    if (risk.length > LIMITS.riskText) {
      throw new ProposalError(`proposal risks[${index}] exceeds ${LIMITS.riskText} characters`);
    }
  }
  if (typeof raw.skill_content !== "string" || raw.skill_content.trim().length === 0) {
    throw new ProposalError("proposal skill_content is required for a propose decision");
  }
  if (raw.skill_content.length > LIMITS.skill_content) {
    throw new ProposalError(`proposal skill_content exceeds ${LIMITS.skill_content} characters`);
  }
  if (!hasSkillFrontmatter(raw.skill_content)) {
    throw new ProposalError(
      "proposal skill_content must be a SKILL.md with a description in its frontmatter",
    );
  }

  return {
    schema_version: 1,
    decision: "propose",
    kind: raw.kind,
    skill: raw.skill,
    rationale: raw.rationale as string,
    hypothesis: raw.hypothesis as string,
    expected_effect: raw.expected_effect as string,
    risks,
    evidence_refs: evidence,
    skill_content: raw.skill_content,
  };
}

/**
 * A skill file must carry a description, because that is the only line Pi
 * shows the model before it decides to load the skill. A skill without one is
 * loaded as no skill at all, which would make a candidate that cannot fire.
 */
function hasSkillFrontmatter(content: string): boolean {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (match === null) return false;
  return /(^|\n)description:\s*\S/.test(match[1]);
}

function text(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== "string" || value.trim().length < min) {
    throw new ProposalError(`proposal ${name} is required`);
  }
  if (value.length > max) {
    throw new ProposalError(`proposal ${name} exceeds ${max} characters`);
  }
}

function stringArray(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value)) {
    throw new ProposalError(`proposal ${name} must be an array of strings`);
  }
  if (value.length > max) {
    throw new ProposalError(`proposal ${name} exceeds ${max} entries`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ProposalError(`proposal ${name}[${index}] must be a non-empty string`);
    }
  }
  return value as string[];
}
