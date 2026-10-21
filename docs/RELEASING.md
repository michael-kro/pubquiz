# Releases, branches and hotfixes

## Schedule

**A release every two weeks, on a Monday**, starting Monday 2 November 2026. The Friday before is the **freeze**: feature branches stop merging into `develop`, only fixes go in, and the weekend is for testing on a real phone and TV. On Monday the release is cut from whatever is on `develop` and green; anything not ready waits for the next one. A release with nothing in it is skipped. A workflow opens a "Release vX.Y.0" issue with the checklist below on each freeze Friday.

**Versions** while the app is `0.x`: a release with any new feature bumps the minor number (`0.2.0`); fixes only, including a hotfix, bump the patch number (`0.2.1`). Anything that breaks an old quiz file or saved game is called out at the top of the changelog entry.

## Branches

| Branch | What it is | From | Into |
|---|---|---|---|
| `main` | What has been released; every commit is a tagged release or a hotfix | | |
| `develop` | The next release; always green | | |
| `feature/<name>` | New functionality | `develop` | `develop` |
| `fix/<name>` | A bug fix that can wait for the next release | `develop` | `develop` |
| `hotfix/<name>` | An urgent fix to a released version | `main` | `main`, then back into `develop` |
| `chore/<name>`, `docs/<name>` | Tooling, CI, documentation, dependencies | `develop` | `develop` |

Every change is a pull request, merged with a merge commit once CI is green (tests, Semgrep, CodeQL, Trivy, ZAP). Keep branches small and short-lived. Each pull request adds a line to `CHANGELOG.md` under "Unreleased" and updates the docs if behaviour changed; a bug fix comes with a test that fails without it. The pull request template has the checklist.

## Release day

1. `develop` is green and the freeze testing found nothing open.
2. On `chore/release-X.Y.Z` from `develop`: rename "Unreleased" in `CHANGELOG.md` to the version and date, set `version` in `package.json` and `package-lock.json`, merge into `develop`.
3. Pull request `develop` into `main`; merge once green.
4. Tag `vX.Y.Z` on `main`, push the tag, and create the GitHub release with the changelog text (`gh release create vX.Y.Z --notes-file …`). Publishing it builds and pushes the Docker image.
5. Pull `ghcr.io/michael-kro/pubquiz:X.Y.Z` and check it starts and the host page loads.
6. Merge `main` back into `develop`, and close the release issue.

## Hotfix

For something released that cannot wait (a crash during a quiz, a wrong score, a security advisory): branch `hotfix/<name>` from `main`, make the smallest fix with a test and a changelog line, pull request into `main`, tag the next patch version and release it as above, then **merge `main` back into `develop`** straight away. A hotfix does not wait for or move the schedule.

## Settings on GitHub

Branch protection on `main` and `develop` is recommended: require a pull request and the CI checks (`Types and tests`, `Load test`, `Screen tour`, `Dependency audit`, `Secret scan`, `Semgrep`, `CodeQL`, `Docker image`, `ZAP baseline scan`), and block force pushes. Scheduled jobs (the weekly security scan, the nightly ZAP scan, the release reminder) and Dependabot run from `main`.
