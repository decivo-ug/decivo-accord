# decivo Accord

**The register for design decisions that people and agents check against.** For Figma, Pencil, Claude Design and code.

[Deutsch](README.de.md) · [Demo](examples/demo/) · MIT

Design tokens usually live in four places at once: a Figma file, a design tool for drafts, a token file and the CSS that ships. Sync tools copy values between them, and whoever writes last wins. Accord does it differently. One **register** in your repository (`.accord/`, [DTCG 2025.10](https://www.designtokens.org/)) is the truth. Figma, Pencil, Claude Design and code are working surfaces in front of it. A change on a surface becomes a **proposal**. A check layer routes the proposal by **ownership** and **rules**: safe changes go through on their own, and everything else goes to the person who owns it. Agents read the same register, rules included with their reasons, and check themselves before every commit.

## Sync versus governance

| | Typical token sync | decivo Accord |
| --- | --- | --- |
| Source of truth | whichever tool wrote last | one register in git, reviewed like code |
| A designer changes a value | copied into code (or overwritten from code) | a proposal; safe changes go through, the rest goes to the owner |
| Who may change what | anyone, from anywhere | an owner per property: `design` (values), `code` (behaviour, API), `register` (names, rules, deletions) |
| A new in-between shade | ships | breaks rule D-002 ("every new colour is a decision"); design decides |
| A variable deleted in Figma | disappears from code | "deleted in Figma"; deletions and breaking changes always need a person, by code and not by setting |
| Both sides changed | last write wins | three-way diff against the last sync: changed in Figma, in the register, or both |
| Coding agents | guess from the code | MCP server: tokens, contracts, decisions with their `why`; `check_change` before every commit |
| Getting variables out of Figma | a plugin, or the Enterprise-only REST API | reads `.fig` files directly, or any common export |
| History | `git blame` on generated files | a changelog of decisions: who, when, why |

## See it in five minutes

```sh
pnpm install && pnpm build
bash examples/demo/run.sh
```

The demo copies a small app with a Figma export into a temporary folder and plays the designer. Excerpts from a real run:

```text
$ accord init --figma figma/variables.json
Start source: Figma (9 variables from 1 file(s))
Modes: light, dark from Figma (Theme)
  3 value(s) for dark in .accord/modes/theme/dark.tokens.json
Mapped 5 tokens to their CSS variable (ids.css)

$ accord check src/components/Card.tsx
D-001 (must): No hard-coded colours in components
  Why: Only then do register changes apply everywhere, and agents do not invent colours.
  src/components/Card.tsx:12:31  #3c6681 → color.brand (var(--brand))

$ accord figma propose            # the designer made cards rounder
  Route: can be applied automatically
  radius.card: 12px → 16px  [owner design]

$ accord figma propose            # the designer tried a new shade of blue
  Route: owner decides (decides: design)
  blue.600: #3c6681 → #2a5d7c  [owner design]
  ✗ D-002 (must): Colours only from the register – Every new colour is a decision.

$ accord figma status             # someone deleted a variable in Figma
  tokens.spacing.4  [deleted in Figma]
$ accord figma propose
  Route: owner decides (decides: register)
  Because: breaking change, deletion (always a person), names and existence belong to the register
```

## Quick start

Requirements: Node.js 22 or newer (22.15+ to read the newest `.fig` files) and git.

```sh
npm install -g @decivo/accord-cli   # or run each command with npx @decivo/accord-cli

cd ~/your-product
accord init --dry-run   # see what Accord finds and would write
accord init             # create .accord/ from code, token files, Figma or Pencil
accord diff             # drift between the register and the code
accord export           # DESIGN.md, AGENTS.md, CLAUDE.md block, CSS, CHANGELOG.md
accord ui               # the web app in the browser, for the people who decide
```

`accord init` takes what is there. The start source decides which side wins where today's sources disagree:

- **Code** wins when the code defines CSS variables: plain CSS, Tailwind v4 `@theme`, shadcn/ui.
- **Token files** win otherwise: DTCG, including the older draft notation, or Tokens Studio. For several sets, the default one is taken; a dark set becomes the dark context, other alternates (brands) are listed.
- **Design** wins with `--from design` or `--figma <file or folder>`. Accord starts from design on its own when there is nothing else: a `.fig` file, Figma variable exports, or `.pen` files.

Whatever cannot be taken over is listed as an open point, never silently dropped.

## Surfaces

| Surface | What Accord reads | Commands |
| --- | --- | --- |
| **Code** | CSS custom properties, Tailwind v4 `@theme`, hard-coded colours and lengths in TS/JS/CSS, shadcn/ui component contracts | `diff`, `check`, `export` |
| **Figma** | `.fig` files ("Save local copy"), Figma's DTCG export, the REST `variables/local` response, Plugin API dumps, variables2json, Tokens Studio; collections, modes, aliases, scopes, code syntax | `figma status \| propose \| lock` |
| **Pencil** ([pen.dev](https://pen.dev)) | `.pen` variables, theme axes, hard-coded colours on nodes | `pen status \| propose \| lock` |
| **Claude Design** | handoff bundles (ZIP, folder, HTML) and the design-system project | `ingest`, `design status \| reset \| lock` |

Every design surface works the same way:

- `status` compares it three-way with the register and its last sync (`.accord/surfaces.lock.json`).
- `propose` turns what changed there into a proposal.
- `lock` records the current state as synced.

Accord never writes into a design tool. Where the tool is behind, `status` shows it ("changed in the register, Figma not updated"), and the people working in the tool update it.

### Figma without plugins

Drop the `.fig` file into the repository: in Figma, *File → Save local copy*. Accord reads its variables itself, without a plugin, an export script or an Enterprise plan. The schema travels inside the file, so new Figma versions keep working. The reader is bounds-checked and fuzzed against damaged files. Exports work too: put them under `figma/`, name them `*.figma.json`, or pass `--figma` / `--file`.

## Decisions and proposals

A proposal is a file in `.accord/proposals/`. A person decides on it: on the command line, in the web app, or in any tool that writes an `accord.resolution/1` file or starts the apply workflow:

```sh
accord figma propose --write      # or --branch: commit it on its own branch, never main
accord apply --proposal P-20261019-figma-b680570f --option adopt --by "Dana"
#   adopt  → the register changes; CSS, DESIGN.md, AGENTS.md and CHANGELOG.md are regenerated
#   reset  → the register stays; the surface is put back
#   reject → the proposal is dropped
```

`apply --branch --push` does the same on its own branch, and `templates/github/accord-apply.yml` runs it from a workflow. An adoption that would break a `must` rule is refused: a decision changes values, not rules.

How a proposal is routed:

- **Automatic:** the surface owns what it changed, nothing breaks, no rule is broken, and the confidence is above `routing.auto_apply`.
- **Owner decides:** a rule is broken, the surface does not own the property, or both sides changed.
- **Always a person:** deletions and breaking changes. This is fixed in code, not a threshold you can configure.

Ownership lives in `accord.config.yaml`: a default per group, with exceptions per token or property. Names, additions, deletions, deprecations and the rules themselves always belong to the register. `accord explain-owner <path>` shows who owns a path and why.

## Web app

The web app is for the people who decide. Start it inside the repository:

```sh
accord ui        # or: npx @decivo/accord-cli ui
```

It opens in the browser and runs on your machine only: no account, no database, no server on the internet. Each project has:

- **Overview:** the state in one sentence and the next step.
- **Decisions:** the open proposals as an inbox. Adopt, reset and reject run the same code as `accord apply`, so the register, CSS, DESIGN.md, AGENTS.md and CHANGELOG.md change exactly as they do on the command line.
- **Register:** tokens, components and rules to look up, with their CSS variables.
- **Connections:** which surfaces (code, Figma, Pencil, Claude Design) Accord reads, and from where.

- A decision changes files in the working tree and does not commit them; that stays with you.
- Without a register, the app says how to create one (`accord init --dry-run`, then `accord init`).
- Several repositories: `accord ui ../shop ../website`. Options: `--port <n>` (default 4317 or the next free one), `--no-open`.
- The app ships as its own package, [`@decivo/accord-ui`](packages/ui/README.md) (about 25 MB), so the CLI stays small for agents and CI. `accord ui` uses an installed copy, otherwise it loads the same version once through npx.
- Security: it listens on `127.0.0.1` only. The printed address carries a one-time code; opening it starts a session in that browser, and the address is worth nothing afterwards (press Enter in the terminal for a new one). Without a session, from another host name or from another page, the app answers nothing, and other pages cannot embed it. Stopping `accord ui` always stops the app.

From source, for development: `pnpm install && pnpm build`, then `pnpm --filter @decivo/accord-web dev` with `ACCORD_PROJECTS` in `apps/web/.env.local` (see `apps/web/.env.example`).

## For agents

```sh
claude mcp add accord -- npx -y @decivo/accord-mcp --root .
```

| Tool | Purpose |
| --- | --- |
| `get_tokens(scope?)` | tokens with value, CSS variable and owner |
| `get_component_contract(name)` | variants, props, states, slots, accessibility of a component |
| `get_decisions(scope?)` | decisions with their `why`, filtered by token, component or file |
| `check_change(paths? \| diff?)` | violations with the fix, e.g. `Card.tsx:12:31 #3c6681 → color.brand (var(--brand))` |

`accord export` writes `AGENTS.md`, a block for `CLAUDE.md` and `DESIGN.md`. Every agent that reads them gets the rules with their reasons. The check layer is model-agnostic: deterministic checks run without any model, and questions a rule cannot answer by itself go through a provider interface. No provider is required.

## In CI

```yaml
# .github/workflows/accord.yml
name: Accord
on: pull_request
jobs:
  accord:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: decivo-ug/decivo-accord/packages/action@v0
```

The Action fails on `must` violations in the lines a pull request adds, annotates the line with the fix, and writes a summary. `accord export --check` fails when generated files are out of date. More in [`packages/action`](packages/action/README.md) and [`templates/`](templates/).

Optionally the Action sends the drift report to a webhook of your own after every run: set `report-url` (an https address, for example from `vars.ACCORD_REPORT_URL`) and, if your receiver wants one, `report-token` (from `secrets.ACCORD_REPORT_TOKEN`). Without a URL nothing is sent. The format, `accord.report/1`, is in [docs/report-format.md](docs/report-format.md): metadata only, never source lines.

## Command reference

All commands take `-C, --root <dir>` (repository) and `-r, --register <dir>` (default `.accord`). Texts are in English, or German for German locales; `ACCORD_LANG=de|en` overrides. Exit codes: `0` ok, `1` findings (drift, violations, a proposal), `2` error. `ACCORD_DEBUG=1` shows stack traces.

| Command | |
| --- | --- |
| `accord init [--from code\|tokens\|design] [--figma <path...>] [--mode <name>] [--dry-run] [--force]` | create the register from what the repository has |
| `accord diff [--json]` | drift report: register against code |
| `accord check [paths...] [--diff <file\|->] [--format text\|json\|github]` | check changed files against the decisions |
| `accord export [--check]` | generate DESIGN.md, AGENTS.md, the CLAUDE.md block, CSS and CHANGELOG.md |
| `accord figma status\|propose\|lock [--file <path...>] [--mode <name>] [--write] [--branch]` | Figma against the register |
| `accord pen status\|propose\|lock [--write] [--branch]` | Pencil against the register |
| `accord ingest <bundle> [--write] [--branch]` | a Claude Design handoff as a proposal |
| `accord design status\|reset\|lock --mirror <dir>` | the Claude Design design-system project against the register |
| `accord apply --proposal <id> --option adopt\|reset\|reject --by <name>` or `--resolution <file>` | apply a person's decision |
| `accord explain-owner <path>` | who owns a register path, and why |
| `accord ui [folders...] [--port <n>] [--no-open]` | open the web app for the repository, on this machine only |
| `accord report [--url <url>] [--token-env <name>] [--json]` | print the drift report as JSON, or POST it to `--url` / `ACCORD_REPORT_URL` with the token from `ACCORD_REPORT_TOKEN` (metadata only, never source lines; [format](docs/report-format.md)) |

## Principles

1. **One truth per decision, not per tool.** The register wins. Figma, Claude Design, Pencil and code are working surfaces in front of it.
2. **Ownership.** Every property has exactly one owner. A change by another side becomes a proposal to the owner, not a sync.
3. **Proposals instead of direct sync.** No surface writes into another.
4. **Breaking changes and deletions always need a person.** This is a rule in the code, not a threshold.
5. **Readable and checkable for agents.** Rules come with their reason, and agents check themselves before every commit.
6. **Model-agnostic.** No provider is required.
7. **Figma stays.** Accord is built for teams that use Figma.

## Status

Accord is young. The register format and the commands above are tested against real design systems from public repositories: 13 Figma exports, 19 Pencil projects, `.fig` files, Tokens Studio and DTCG sets, and Claude Design handoffs. Coming next:

- brand and density modes: more modifiers of the DTCG resolver module

Light and dark work: the register keeps them with the DTCG resolver module (`resolver.json`, `modes/theme/dark.tokens.json`). `init` takes them over from code (`.dark`, `[data-theme]`, `@import`ed themes), Figma modes and Pencil themes; `diff`, `status`, `propose`, `apply`, `design`, the checks (contrast in light and dark) and the generated files work per context.

| Package | |
| --- | --- |
| [`packages/core`](packages/core) | register schema, DTCG 2025.10, ownership, three-way diff, edits |
| [`packages/checks`](packages/checks) | check layer: deterministic rules, provider interface, routing |
| [`packages/adapters/*`](packages/adapters) | code, Figma (`.fig` reader included), Pencil, Claude Design |
| [`packages/generators`](packages/generators) | DESIGN.md, AGENTS.md, CLAUDE.md block, CSS, CHANGELOG.md |
| [`packages/cli`](packages/cli) · [`packages/mcp`](packages/mcp) · [`packages/action`](packages/action) | command line, MCP server, GitHub Action |
| [`packages/ui`](packages/ui) · [`apps/web`](apps/web) | the web app as an npm package (`accord ui`), and its source |

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). What changed in each release is in [CHANGELOG.md](CHANGELOG.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

A product by [decivo](https://decivo.de): Clarity before Code. MIT licensed.
