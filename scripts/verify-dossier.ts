/**
 * Verify a committed dossier against the pinned solver source.
 *
 * Run on the compute host, where the pinned package actually exists:
 *
 *   node --experimental-strip-types scripts/verify-dossier.ts \
 *     --dossier dossiers/realfluid-reacting-001.json \
 *     --source-root /data2/kexiao/of8/realFluidFoam-8
 *
 * A failure means the dossier and the code have diverged. The fix is to
 * re-derive the entry from the code, never to relax the check -- a dossier that
 * cannot be verified is a story about a solver that may not exist.
 */
import { verifyDossier, readDossier } from "../packages/controller/src/dossier.ts";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const dossierPath = arg("--dossier") ?? "dossiers/realfluid-reacting-001.json";
  const sourceRoot = arg("--source-root");
  if (!sourceRoot) {
    console.error("usage: verify-dossier.ts --dossier <json> --source-root <pinned package>");
    process.exit(2);
  }
  const dossier = await readDossier(dossierPath);
  console.log(`dossier      ${dossier.dossier_id}`);
  console.log(`profile      ${dossier.solver_profile_id}`);
  console.log(`pinned       ${dossier.source_package}`);

  const verification = await verifyDossier(dossier, sourceRoot);
  console.log(`checked      ${verification.checked} anchors`);
  if (verification.ok) {
    console.log(`ok           all anchors resolve against ${sourceRoot}`);
    return;
  }
  console.error(`FAILED       ${verification.failures.length} anchor(s) drifted:`);
  for (const f of verification.failures) {
    console.error(`  ${f.entry}  ${f.file}`);
    console.error(`    ${f.reason}`);
  }
  console.error("");
  console.error("Re-derive the affected entries from the pinned source before using this");
  console.error("dossier as input to a consultation. A dossier that does not verify is not");
  console.error("evidence about the solver that actually runs.");
  process.exit(1);
}

await main();
