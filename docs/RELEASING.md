# Releases, branches and hotfixes

How changes get from an idea to a release. The short version is in the [README](../README.md#releases-and-contributing).

## The schedule

**A release every two weeks, on a Monday.** The first is **Monday 2 November 2026**, then every second Monday after it:

| Release day | Freeze (Friday before) |
|---|---|
| 2 Nov 2026 | 30 Oct |
| 16 Nov 2026 | 13 Nov |
| 30 Nov 2026 | 27 Nov |
| 14 Dec 2026 | 11 Dec |
| 28 Dec 2026 | 25 Dec (probably skip: Christmas) |
| 11 Jan 2027 | 8 Jan |

- **Freeze (the Friday before):** feature branches stop merging into `develop`. Only fixes go in, so the weekend is for testing the build on a real phone, a TV and a quiz night if there is one.
- **Release day (Monday):** the release is cut from whatever is on `develop` and green. Anything not ready waits for the next one; releases are never held back for a feature.
- A release with nothing in it can be skipped. A release is never "a few more things".
- On the Friday freeze a workflow opens an issue called "Release vX.Y.0" with the checklist below, so it is not forgotten.

## Versions

While the app is `0.x`:

- A release with any new feature bumps the **minor** number: `0.2.0`, `0.3.0`.
- A release with only fixes, including a hotfix, bumps the **patch** number: `0.2.1`.
- Anything that stops an old quiz file or saved game working is called out at the top of that release's changelog entry.

From `1.0` this becomes strict semantic versioning.

## Branches

| Branch | What it is | Made from | Merges into |
|---|---|---|---|
| `main` | What has been released. Every commit on it is a tagged release or a hotfix. Never commit to it directly. | | |
| `develop` | The next release, being put together. Always builds and passes CI. | | |
| `feature/<name>` | New functionality, for example `feature/solo-practice`. | `develop` | `develop` (pull request) |
| `fix/<name>` | A non-urgent bug fix, for example `fix/phone-menu-offscreen`. | `develop` | `develop` (pull request) |
| `hotfix/<name>` | An urgent fix for something already released. | `main` | `main`, then back into `develop` |
| `chore/<name>`, `docs/<name>` | Tooling, CI, documentation, dependency bumps. | `develop` | `develop` |

Rules for all of them:

- **Small and short-lived.** Merge within days. If a feature is big, split it so each piece is releasable (behind a setting if it is half finished).
- **Pull requests, and CI must be green** (tests, Semgrep, CodeQL, Trivy, ZAP). Merge with a merge commit, then delete the branch.
- **Each pull request adds a line to `CHANGELOG.md`** under "Unreleased", and updates the docs if the behaviour changed. The pull request template has the checklist.
- **A bug fix comes with a test that fails without it.**

## Release day checklist

1. `develop` is green on GitHub and the freeze week's testing found nothing open.
2. On a branch from `develop` (`chore/release-X.Y.Z`): rename "Unreleased" in `CHANGELOG.md` to the version and date, and set `version` in `package.json` and `package-lock.json`. Merge it into `develop`.
3. Open a pull request **`develop` into `main`**. CI runs again. Merge it with a merge commit.
4. Tag the merge `vX.Y.Z` on `main` and push the tag.
5. Create the GitHub release with the changelog text (`gh release create vX.Y.Z --notes-file …`). Publishing the release starts the Docker image workflow, which is what users download.
6. When the image workflow finishes, pull `ghcr.io/michael-kro/pubquiz:X.Y.Z` and check it starts and the host page loads.
7. Merge `main` back into `develop` so the two match (`git checkout develop && git merge main`).
8. Close the release issue.

## Hotfix: something released is broken

For a bug or a security problem that cannot wait for the next release, such as a crash during a quiz, a wrong score, or a security advisory:

1. Branch **from `main`**: `git checkout main && git checkout -b hotfix/<name>`.
2. Make the smallest fix that solves it, with a test that fails without it and a changelog entry.
3. Pull request into **`main`**. CI must pass (the same checks as any change).
4. Merge, tag the next patch version (`vX.Y.Z+1`), and release it as in steps 5 and 6 above.
5. **Merge `main` back into `develop`** straight away, so the fix is not lost in the next release.

A hotfix does not wait for, or move, the fortnightly schedule. Dependabot security updates that matter are handled the same way.

## Branch protection (recommended GitHub settings)

On `main` and `develop`: require a pull request, require the CI checks to pass before merging (`Types and tests`, `Load test`, `Dependency audit`, `Secret scan`, `Semgrep`, `CodeQL`, `Docker image`, `ZAP baseline scan`), and block force pushes and deletion. This is a setting in the repository on GitHub (Settings, Branches), not something stored in the code.

## What is automatic

- **Every push and pull request:** CI (tests, audit, secret scan), security scanning (Semgrep, CodeQL, hadolint, Trivy) and a ZAP baseline scan.
- **Nightly:** a ZAP active scan against a throwaway copy of the app. **Weekly:** the security scanning again, because new vulnerabilities are published against code that has not changed.
- **Weekly:** Dependabot proposes dependency, GitHub Actions and Docker base image updates.
- **Every other Friday (the freeze):** the release issue with the checklist.
- **On publishing a release:** the multi-architecture Docker image is built and pushed.

The scheduled jobs and Dependabot only run from the default branch, `main`, so they start working after the first release that contains them.
