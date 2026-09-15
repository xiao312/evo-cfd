# Third-party components

Provenance and license status for every component used by EvoCFD. Entries marked
**pending** must be resolved before that component is redistributed from this
repository.

| Component | Origin | Revision | License | Status |
|---|---|---|---|---|
| RSI-Harness | `github.com/CosmosMind-ai/RSI-Harness` (via fork `xiao312/RSI-Harness`) | `33c4f8dfac4359987f2e814e187de67c332498de` | **none found** | **Pending clarification** — no `LICENSE` file, no `package.json` field, no README statement at that revision. Held as a local working copy only; not committed here. |
| Pi | `@earendil-works/pi-coding-agent` (npm) | `0.84.3` (as pinned by RSI-Harness) | MIT | Confirmed from the installed `package.json`. |
| pi-websearch | `github.com/code-yeongyu/pi-websearch` | not yet vendored | unknown | **Pending** — check before import. |
| realFluidFoam-8 | `github.com/danhnam11/realFluidFoam-8` | not yet vendored | GPL-3.0 | Confirmed: repo-root `LICENSE` is GNU GPL v3 (29 June 2007). Source headers carry "GNU General Public License" notices. |
| DeepFlame | `github.com/deepmodeling/DeepFlame` | not yet vendored | GPL-3.0-or-later (unverified) | **Pending** — stated in solver source headers; repo-level file not yet inspected. |

## Notes

- **RSI-Harness.** Public visibility is not a license. GitHub's terms permit
  viewing and forking, but not redistribution or derivative distribution. The
  upstream authors have been asked to clarify; see
  `docs/upstream-license-issue.md`. Until then, the tree is present locally for
  development and is excluded from this repository (`.gitignore`).
- **GPL solvers.** If GPL-covered solver sources are vendored, their notices
  must be preserved, modifications marked, and corresponding-source obligations
  considered for any binary distribution. Placing GPL code in a separate
  directory does not by itself settle whether a combined work is formed; that
  question is deferred to whoever prepares the first distribution.
- **Attribution.** Every vendored component keeps its original notices. Git
  subtree import (when permitted) retains upstream history for attribution and
  later synchronization.
