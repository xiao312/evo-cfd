import { test } from "node:test";
import assert from "node:assert/strict";

import { validateProposal, type HarnessProposal } from "../src/proposal.ts";

function validPropose(overrides: Record<string, unknown> = {}): HarnessProposal {
  return validateProposal({
    schema_version: 1,
    decision: "propose",
    kind: "skill_upsert",
    skill: "verify-before-claim",
    rationale: "The agent claimed a fix without running it.",
    hypothesis: "The harness does not teach verification before a claim is made.",
    expected_effect: "The agent runs the program before reporting it fixed.",
    risks: ["The skill could fire on tasks where running is not possible."],
    evidence_refs: ["evidence/m1-trial-001/episode/events.jsonl"],
    skill_content:
      "---\nname: verify-before-claim\ndescription: Run the program before claiming it is fixed.\n---\n# Verify before claim\n\nRun it. Read the output. Then report.\n",
    ...overrides,
  });
}

test("proposal: no_change is a valid first-class decision", () => {
  const proposal = validateProposal({
    schema_version: 1,
    decision: "no_change",
    rationale: "All criteria passed; the evidence shows no harness defect.",
    evidence_refs: ["evidence/m1-trial-001/evaluation/result.json"],
  });
  assert.equal(proposal.decision, "no_change");
  assert.equal(proposal.evidence_refs.length, 1);
});

test("proposal: a full skill_upsert validates", () => {
  const proposal = validPropose();
  assert.equal(proposal.decision, "propose");
  assert.equal(proposal.kind, "skill_upsert");
  assert.equal(proposal.skill, "verify-before-claim");
});

test("proposal: rejects a schema version other than 1", () => {
  assert.throws(
    () => validateProposal({ schema_version: 2, decision: "no_change", rationale: "x", evidence_refs: [] }),
    /schema_version/,
  );
});

test("proposal: rejects an unknown decision", () => {
  assert.throws(
    () => validateProposal({ schema_version: 1, decision: "maybe", rationale: "x", evidence_refs: [] }),
    /decision/,
  );
});

test("proposal: rejects a skill name that Pi would not accept", () => {
  for (const bad of ["Verify First", "verify_first", "-leading", "trailing-", "double--hyphen", ""]) {
    assert.throws(() => validPropose({ skill: bad }), /skill/, `expected rejection of ${bad}`);
  }
});

test("proposal: rejects skill content without a frontmatter description", () => {
  assert.throws(() => validPropose({ skill_content: "# Verify\n\nJust do it.\n" }), /description/);
  assert.throws(
    () => validPropose({ skill_content: "---\nname: x\n---\nbody\n" }),
    /description/,
    "a frontmatter with no description is not a loadable skill",
  );
});

test("proposal: rejects an empty rationale", () => {
  assert.throws(() => validPropose({ rationale: "   " }), /rationale/);
});

test("proposal: rejects missing hypothesis or expected_effect", () => {
  assert.throws(() => validPropose({ hypothesis: "" }), /hypothesis/);
  assert.throws(() => validPropose({ expected_effect: "" }), /expected_effect/);
});

test("proposal: rejects risks that are empty or absent", () => {
  assert.throws(() => validPropose({ risks: [""] }), /risks\[0\]/);
  assert.throws(() => validPropose({ risks: "a string" }), /risks/);
});

test("proposal: rejects evidence refs that are not non-empty strings", () => {
  assert.throws(() => validPropose({ evidence_refs: [""] }), /evidence_refs\[0\]/);
  assert.throws(() => validPropose({ evidence_refs: "evidence/x" }), /evidence_refs/);
});

test("proposal: rejects an unknown change kind", () => {
  assert.throws(() => validPropose({ kind: "tool_upsert" }), /kind/);
});

test("proposal: bounds unbounded fields, so a runaway proposer is bounded", () => {
  const long = "a".repeat(5000);
  assert.throws(() => validPropose({ rationale: long }), /rationale/);
  assert.throws(() => validPropose({ skill_content: "x".repeat(70000) }), /skill_content/);
  assert.throws(() => validPropose({ risks: new Array(20).fill("risk") }), /risks/);
});

test("proposal: no_change carries no skill fields", () => {
  // A no_change that also specified a skill would be ambiguous about what it
  // wants built; the union makes that unrepresentable rather than ignorable.
  const proposal = validateProposal({
    schema_version: 1,
    decision: "no_change",
    rationale: "Nothing to change.",
    evidence_refs: [],
  });
  assert.ok(!("skill" in proposal));
});
