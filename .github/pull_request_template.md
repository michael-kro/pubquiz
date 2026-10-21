## What and why

<!-- A sentence or two. What changes for the host or the teams? -->

## Checklist

- [ ] The branch is named for what it is: `feature/…`, `fix/…`, `hotfix/…`, `chore/…` or `docs/…` (see docs/RELEASING.md)
- [ ] It aims at `develop` (a `hotfix/…` aims at `main`)
- [ ] A line is added to `CHANGELOG.md` under "Unreleased"
- [ ] Tests added or updated (a bug fix has a test that fails without it)
- [ ] Docs updated if the behaviour changed
- [ ] If it adds a WebSocket message type, it is classified in `test/host-only.test.ts`
- [ ] If it touches the host screen, checked at phone width as well as laptop width
