Release **v{{VERSION}}** on **Monday {{DATE}}**. Today is the freeze: no more feature branches go into `develop`; fixes only. Full process: [docs/RELEASING.md](../blob/main/docs/RELEASING.md).

## Freeze (today to Monday)

- [ ] `develop` is green on GitHub (tests, security scans, ZAP baseline)
- [ ] The host screen has been tried on a real phone, and the TV page on a real TV or a laptop on HDMI
- [ ] A full quiz was played through with a couple of phones
- [ ] Open pull requests that should wait are labelled for the next release

## Release day

- [ ] `chore/release-{{VERSION}}`: "Unreleased" in `CHANGELOG.md` renamed to v{{VERSION}} with today's date, version bumped in `package.json` and `package-lock.json`, merged into `develop`
- [ ] Pull request `develop` into `main`, CI green, merged
- [ ] Tagged `v{{VERSION}}` on `main` and pushed
- [ ] `npm run build:binaries`, then the GitHub release created with the changelog text, the five programs and `SHA256SUMS`
- [ ] Docker image workflow finished; `ghcr.io/michael-kro/pubquiz:{{VERSION}}` pulled and checked
- [ ] `main` merged back into `develop`
- [ ] This issue closed
