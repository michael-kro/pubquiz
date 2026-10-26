# Releases and branches

## Branches

`main` is the only long-lived branch. Every change is a short-lived branch off `main`, merged back by pull request once CI is green:

| Branch | What it is |
|---|---|
| `feature/<name>` | New functionality |
| `fix/<name>` | A bug fix |
| `chore/<name>`, `docs/<name>` | Tooling, CI, documentation, dependencies |
| `release/vX.Y.Z` | Made by `npm run release` |

Each pull request adds a line to `CHANGELOG.md` under "Unreleased" and updates the docs if behaviour changed; a bug fix comes with a test that fails without it. The pull request template has the checklist. Pull requests are merged with a merge commit.

## Releasing

Release whenever there is something worth releasing:

```sh
git switch main && git pull
npm run release              # minor: 0.3.0 -> 0.4.0
npm run release -- patch     # fixes only: 0.3.0 -> 0.3.1
npm run release -- --dry-run # show what would be released
```

`npm run release` dates the "Unreleased" section of the changelog, sets the version in `package.json` and the lock file, commits that on `release/vX.Y.Z`, pushes it, opens the pull request into `main` and turns on auto-merge. Because the pull request is opened as you, its checks run like any other.

Once it merges, the `Publish release` workflow sees the new version on `main`, tags `vX.Y.Z`, creates the GitHub release with the changelog section as its notes (only the newest release is kept on the releases page; older tags remain) and builds the image for the tag. Then pull `ghcr.io/michael-kro/pubquiz:X.Y.Z` and check it starts and the host page loads.

An urgent fix to a released version is an ordinary `fix/` branch followed by `npm run release -- patch`.

**Versions** while the app is `0.x`: a release with features in it bumps the minor number, a fixes-only release the patch number, and `major` makes `1.0.0`. Anything that breaks an old quiz file or saved game is called out at the top of the changelog entry.

If the workflow ever has to be done by hand: `git tag -a vX.Y.Z`, push the tag, `gh release create vX.Y.Z --notes-file <(node scripts/release.ts notes X.Y.Z)`, delete the older releases, and run the `Docker image` workflow on the tag.

## Settings on GitHub

- **Ruleset** on `main`: require a pull request, the CI checks (`Types and tests`, `Load test`, `Screen tour`, `Dependency audit`, `Secret scan`, `Semgrep`, `CodeQL`, `Docker image`, `ZAP baseline scan`) and an up-to-date branch, and block force pushes.
- **Allow auto-merge** (Settings → General → Pull Requests), so a release pull request merges itself when green.
- No extra token or secret is needed: the release pull request is opened by you, and publishing uses the workflow's own token.
