# Changelog

All packages (`@decivo/accord-*`) are released together under one version. Dates are release dates.

## 0.2.3 – 2026-11-12

Fixes from a review of the 0.2.1 changes, and Windows in CI.

### Fixed
- **`check` judges the change, not drift that was there before.** Since 0.2.1 it compared the whole stylesheet with the register, so a value the register had moved on from (a Figma change adopted, code not caught up) failed every commit touching that file. Now only custom properties the change touched count: lines a diff adds or removes, or the difference to the last commit.
- `check` names a stylesheet with a syntax error instead of reporting its linked tokens as deleted.
- `check` skipped files on Windows (backslash paths).
- Adopting a proposal no longer turns a dark value that only follows its target into a literal colour; an alias re-pointed in a context stays a reference.
- A removed token and two new ones with its value are no rename; links are carried over for a one-to-one pair only.
- `apply --branch` works for a project in a subfolder of the repository (monorepos).
- The web app stops when `accord ui` is killed hard, also when it was started through npx.
- git errors name the reason, not a line-ending warning printed before it.

### Changed
- **GitHub Action:** use `decivo-ug/decivo-accord/packages/action@v0` (or an exact `@v0.2.3`). The Action runs the CLI release it belongs to from npm; `pnpm/action-setup` is only needed for `version: source`.
- CI runs build, tests and a real start of the web app on Windows.

## 0.2.2 – 2026-11-05

- The GitHub organisation is `decivo-ug`: package metadata, links and the Action template point to `decivo-ug/decivo-accord`. No functional changes.

## 0.2.1 – 2026-11-05

Fixes from three independent reviews of 0.2.0.

### accord ui
- The printed address carries a one-time code; Enter in the terminal prints a new address.
- Each instance has its own session cookie; other pages cannot embed the app; the app never outlives `accord ui`.
- npx runs without a shell where possible and outside the repository.

### Decisions
- An outdated proposal is refused instead of silently undoing a newer decision; the web app marks it.
- `apply --branch` refuses uncommitted register edits.
- Adopting a Figma or Pencil proposal updates the lock; renames keep their links; an alias pointed elsewhere in Figma is the register's decision.
- The web app's undo no longer overwrites later decisions.

### check and diff
- `check`, `check_change` (MCP) and the GitHub Action report changes code does not own, with the owner.
- A stylesheet with a syntax error no longer stops `diff`.
- Named colours in stylesheets, positions in multi-line values, `!important` custom properties; suggested CSS variables only when code defines them.

### Web app
- A broken register gives one answer on every page; texts name CSS only when Accord writes CSS.

## 0.2.0 – 2026-11-05

### Added
- **`accord ui`**: the web app on your machine with one command, `npx @decivo/accord-cli ui`. No clone, no account, no database.
- `@decivo/accord-ui`: the web app as its own package; the CLI loads it on demand.
- The local server answers only its own address, with a token, and accepts changes only from its own page.
- Clear pages for a repository without a register or with one Accord cannot read.

## 0.1.1 – 2026-11-03

### Fixed
- `accord design reset` no longer replaces `var()` references with fixed values, and lists every drift it does not rewrite with the reason.
- Custom properties inside component rules within media queries are not taken for the page's dark value; selector lists such as `:root, .dark` are read for every context.
- Output paths stay inside the project; Accord does not write through symbolic links.
- `check_change` ignores paths outside the project.
- The MCP server reports its real version.

## 0.1.0 – 2026-10-26

Initial public release: register (`.accord/`), ownership, proposals and routing; CLI, MCP server and GitHub Action; adapters for code, Figma, Pencil and Claude Design; light and dark contexts.
