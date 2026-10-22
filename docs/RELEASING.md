# Releases, branches and hotfixes

## Schedule

**A release every week, on a Friday morning, by itself.** The `Release` workflow runs at 09:00 UTC each Friday (and whenever you press "Run workflow" on it): if `CHANGELOG.md` has anything under "Unreleased", it cuts a `release/vX.Y.Z` branch from `develop` with the version bumped and the changelog section dated, opens the pull request into `main`, and lets it merge itself once every check is green. A red check holds the release; closing the pull request skips the week. A week with nothing in it is skipped by itself.

Once that merge lands on `main`, the `Publish release` workflow tags `vX.Y.Z`, creates the GitHub release with the changelog section as its notes (only the newest release is kept on the releases page; older tags remain), builds the image for the tag, and opens the merge of `main` back into `develop`, which also merges itself when green.

**Versions** while the app is `0.x`: the weekly release bumps the minor number (`0.2.0`) because it has features in it; run the workflow by hand with `patch` for a fixes-only release, or `major` for `1.0.0`. Anything that breaks an old quiz file or saved game is called out at the top of the changelog entry.

## Branches

| Branch | What it is | From | Into |
|---|---|---|---|
| `main` | What has been released; every commit is a tagged release or a hotfix | | |
| `develop` | The next release; always green | | |
| `feature/<name>` | New functionality | `develop` | `develop` |
| `fix/<name>` | A bug fix that can wait for the next release | `develop` | `develop` |
| `hotfix/<name>` | An urgent fix to a released version | `main` | `main`, then back into `develop` |
| `chore/<name>`, `docs/<name>` | Tooling, CI, documentation, dependencies | `develop` | `develop` |
| `release/vX.Y.Z` | Cut by the release workflow | `develop` | `main` |

Every change is a pull request, merged with a merge commit once CI is green (tests, the screen tour, Semgrep, CodeQL, Trivy, ZAP). Keep branches small and short-lived. Each pull request adds a line to `CHANGELOG.md` under "Unreleased" and updates the docs if behaviour changed; a bug fix comes with a test that fails without it. The pull request template has the checklist.

## Releasing by hand

The same steps the workflows take, with `scripts/release.ts`:

1. On a branch from `develop`: `node scripts/release.ts prepare minor` (or `patch`, `major`) dates the changelog section and sets the version in `package.json` and the lock file; commit as "Release vX.Y.Z".
2. Pull request into `main`; merge once green. `Publish release` does the rest when it sees the new version on `main`. If it has to be done by hand too: `git tag -a vX.Y.Z`, push the tag, `gh release create vX.Y.Z --notes-file <(node scripts/release.ts notes X.Y.Z)`, delete the older releases, and run the `Docker image` workflow on the tag.
3. Pull `ghcr.io/michael-kro/pubquiz:X.Y.Z` and check it starts and the host page loads.
4. Merge `main` back into `develop`.

## Hotfix

For something released that cannot wait (a crash during a quiz, a wrong score, a security advisory): branch `hotfix/<name>` from `main`, make the smallest fix with a test and a changelog line, run `node scripts/release.ts prepare patch` on the branch so the version and changelog are right, pull request into `main`. `Publish release` tags and publishes it as soon as it merges, and opens the merge back into `develop`. A hotfix does not wait for or move the weekly release.

## Settings on GitHub

- **Rulesets** on `main` and `develop`: require a pull request, the CI checks (`Types and tests`, `Load test`, `Screen tour`, `Dependency audit`, `Secret scan`, `Semgrep`, `CodeQL`, `Docker image`, `ZAP baseline scan`) and an up-to-date branch, and block force pushes.
- **Allow auto-merge** (Settings → General → Pull Requests), so the release and merge-back pull requests can merge themselves.
- **`RELEASE_TOKEN`** secret (Settings → Secrets and variables → Actions): a fine-grained personal access token for this repository with **Contents**, **Pull requests** and **Actions** set to read and write. Checks never run on a pull request opened with a workflow's own token, so without it the `Release` workflow stops with a message and releases are done by hand; `Publish release` still tags and publishes, and only the merge-back waits for a person.
- Scheduled jobs (the weekly release, the weekly security scan, the nightly ZAP and nuclei scans) and Dependabot run from `main`, and a workflow can only be scheduled or run by hand once its file is on `main`. A change to the release workflows therefore goes to `main` first (a small pull request from a branch off `main`, like a hotfix) and is merged back into `develop`.
