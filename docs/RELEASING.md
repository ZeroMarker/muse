# GitHub releases

The Release workflow builds the exact commit identified by an existing `v*`
tag. It checks version metadata, runs `npm run verify` (including codecs and
Chromium), then publishes the verified CLI and static Web builds. It does not
deploy the hosted site; follow [DEPLOYMENT.md](DEPLOYMENT.md) for deployment.

## Prepare a version

Update `package.json` and `package-lock.json` together with
`npm version <version> --no-git-tag-version`. Set the same version in
`crates/muse-core/Cargo.toml` and run `cargo check` to update `Cargo.lock`.
The CLI reads its version from `package.json`. Commit the version changes to
`main` and push before creating a tag. The current version is `0.1.0`.

```sh
node scripts/package-release.mjs v0.1.0 --check
git tag -a v0.1.0 -m "Muse v0.1.0"
git push origin v0.1.0
```

Replace the version in these commands when preparing a subsequent release.
Pushing the tag starts `.github/workflows/release.yml`. You can also run
**Actions → Release → Run workflow** with an existing tag. The workflow always
checks out `refs/tags/<tag>`, even when dispatched from `main`.
Tags with a suffix, such as `v0.2.0-rc.1`, publish as prereleases.

## Release assets

- `muse-v<version>-cli.tar.gz`: the portable Node.js bundle with embedded WASM,
  source map, examples, documentation, dependency metadata, and license notices.
  Requires Node.js 22+; compressed audio exports and custom sample decoding also
  require system FFmpeg. After extraction, run `node muse.cjs --help` inside the
  extracted CLI directory. No npm or Rust build is needed.
- `muse-v<version>-web.tar.gz`: the complete static Web build, including Monaco,
  audio workers and the local FFmpeg encoder assets. Extract and serve the
  directory containing `index.html` over HTTPS or localhost.
- `SHA256SUMS`: checksums of both archives. Download all three files into the
  same directory and run `sha256sum --check SHA256SUMS`.

The publish job uses the repository's `GITHUB_TOKEN` with `contents: write`;
no additional release secret is needed. It uploads assets to a draft before
publishing. If an upload fails, rerun the workflow to complete the draft.
An already published release is left unchanged and causes the rerun to fail.

To check packaging locally after a successful `npm run verify`:

```sh
node scripts/package-release.mjs v0.1.0
cd dist/release/v0.1.0
sha256sum --check SHA256SUMS
```
