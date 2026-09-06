# Release and platform QA

The release is built from a signed version tag. CI is the source of truth: it
runs lint, typecheck, tests, the documentation build, an isolated global npm
install, and native smoke tests for every standalone executable.

## Prepare a release

1. Move the relevant entries in `CHANGELOG.md` from Unreleased to a version and date.
2. Set the same semver in `packages/cli/package.json`, the private workspace
   packages, and `packages/core/src/version.ts`.
3. Run `bun run release:check`.
4. Commit, create a signed `vX.Y.Z` tag, and push it.
5. Approve the protected `npm` environment after the artifact jobs pass.

The tag workflow publishes the Node package and creates a GitHub release
containing these native assets. Provenance is not attached: npm can only verify
a provenance bundle when the source repository is public, and this one is
private.

```text
earshot-darwin-arm64
earshot-darwin-x64
earshot-linux-x64
earshot-linux-arm64
earshot-windows-x64.exe
```

To build one locally, run `bun run build:binaries linux-x64`. Omitting the target
builds all five by cross-compilation.

## Windows Terminal acceptance checklist

Automation catches crashes; a terminal UI still needs human eyes. Test the
release candidate in current Windows Terminal on Windows 11, using both a
PowerShell tab and a Git Bash tab:

- Install with `npm install --global @raegent/earshot@<version>` and confirm `where.exe earshot`.
- Run the standalone `.exe` separately and confirm both builds print the same version.
- Run `earshot doctor`; Git Bash must be found and no DA1/DCS probe may appear or hang.
- Resize narrower and wider during a streamed response; completed output must remain in scrollback.
- Approve and deny a file edit; the prompt must show the real diff and keyboard input must remain responsive.
- Run a Bash tool command containing a pipeline and quoted path with spaces.
- Interrupt a streaming response and a long-running command with Ctrl-C.
- Exercise `/tree`, `/rewind`, `/fork`, and `/undo` in a temporary Git repository.
- Start a stdio MCP server several times and note any failure to start. CI has
  seen this fail intermittently on Windows during process spawn; a hands-on run
  is the only place a rate rather than a single occurrence gets observed.
- Close and reopen Windows Terminal, then resume with `earshot --continue`.
- Record Windows, Windows Terminal, Node, npm, Git for Windows, and earshot versions in the release issue.

Do not mark the release candidate accepted until a human records the checklist.
CI intentionally does not claim to be Windows Terminal.

## npm package check

`bun run smoke:npm` builds and packs the exact publishable directory, installs
the tarball into an isolated global prefix, and runs its installed `earshot`
shim under Node. This catches missing bundled files and accidental `workspace:*`
runtime dependencies before publication.
