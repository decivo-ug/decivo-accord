import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  type CssVariable,
  codeModeSelectors,
  codeSnapshot,
  cssVariableName,
  type HardValueFinding,
  parseCssVariables,
  prepareCodeScan,
  scanPaths,
  stylesheetError,
  withCodeContexts,
} from '@decivo/accord-adapter-code'
import {
  auditContrast,
  contextFallbacks,
  type Evaluation,
  evaluate,
  type LiteralUse,
  type Violation,
} from '@decivo/accord-checks'
import {
  type ColorValue,
  colorToCss,
  contextLabel,
  type DimensionValue,
  formatValue,
  type Owner,
  type Register,
  restrictTo,
  snapshotFromRegister,
  THEME_MODIFIER,
  type TokenType,
  threeWayDiff,
} from '@decivo/accord-core'
import { loadValidRegister } from '@decivo/accord-core/node'

/** Added line numbers per file from a unified diff (`git diff`). */
export function addedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>()
  let current: Set<number> | undefined
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim().replace(/^b\//, '')
      current = path === '/dev/null' ? undefined : (files.get(path) ?? new Set())
      if (current) files.set(path, current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!current || raw.startsWith('---')) continue
    if (raw.startsWith('+')) current.add(line++)
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) line++
  }
  return files
}

/** Custom properties whose declaration a unified diff removes, per file (`-  --brand: …`). */
export function removedVariables(diff: string): Map<string, Set<string>> {
  const files = new Map<string, Set<string>>()
  let current: Set<string> | undefined
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim().replace(/^b\//, '')
      current = path === '/dev/null' ? undefined : (files.get(path) ?? new Set())
      if (current) files.set(path, current)
      continue
    }
    if (!current || raw.startsWith('---') || !raw.startsWith('-')) continue
    for (const m of raw.slice(1).matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/g)) current.add(m[1] as string)
  }
  return files
}

const exec = promisify(execFile)

/** A file as the last commit has it; undefined when there is no git, no commit, or the file is new. */
async function committed(root: string, file: string): Promise<string | undefined> {
  try {
    return (await exec('git', ['show', `HEAD:./${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch {
    return undefined
  }
}

const variableKey = (v: CssVariable) => `${v.name}|${v.scope}|${v.list ?? ''}`

/**
 * The custom properties this change touched in the checked stylesheets: declared on a line the diff adds,
 * removed by the diff, or, without a diff, different from the last commit. `check` judges the change, not
 * the state: a value that already differed from the register before (the register moved on, code has not
 * caught up) is drift for `accord diff`, not something this commit did.
 * Undefined when nothing tells what changed (no diff, and no commit to compare with).
 */
async function touchedVariables(input: {
  root: string
  files: string[]
  variables: readonly CssVariable[]
  added: Map<string, Set<number>> | undefined
  diff: string | undefined
}): Promise<{ changed: Set<string>; removed: Set<string> } | undefined> {
  const changed = new Set<string>()
  const removed = new Set<string>()
  const now = (file: string) => input.variables.filter((v) => v.file === file)
  if (input.added && input.diff !== undefined) {
    const gone = removedVariables(input.diff)
    for (const file of input.files) {
      const lines = input.added.get(file)
      const present = new Set(now(file).map((v) => v.name))
      for (const v of now(file)) if (lines?.has(v.line)) changed.add(v.name)
      for (const name of gone.get(file) ?? []) (present.has(name) ? changed : removed).add(name)
    }
  } else {
    let known = false
    for (const file of input.files) {
      const before = await committed(input.root, file)
      if (before === undefined) continue
      known = true
      let base: CssVariable[]
      try {
        base = parseCssVariables(before, file)
      } catch {
        continue
      }
      const was = new Map(base.map((v) => [variableKey(v), v.value]))
      const is = new Map(now(file).map((v) => [variableKey(v), v.value]))
      for (const v of now(file)) if (was.get(variableKey(v)) !== v.value) changed.add(v.name)
      const present = new Set(now(file).map((v) => v.name))
      for (const v of base) if (!is.has(variableKey(v))) (present.has(v.name) ? changed : removed).add(v.name)
    }
    if (!known) return undefined
  }
  // A variable that points at a touched one (`--brand: var(--blue-600)`) changes with it.
  for (let grew = true; grew; ) {
    grew = false
    for (const v of input.variables)
      if (
        !changed.has(v.name) &&
        [...v.value.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => changed.has(m[1] as string))
      ) {
        changed.add(v.name)
        grew = true
      }
  }
  return { changed, removed }
}

export interface CheckInput {
  /** Repository root. */
  root: string
  /** Register directory (absolute, or relative to root). */
  registerDir: string
  /** Files to check, relative to root. */
  paths?: string[] | undefined
  /** Unified diff; only added lines are checked. */
  diff?: string | undefined
  register?: Register | undefined
}

export interface CheckFinding {
  decision: string
  level: 'must' | 'should'
  rule: string
  why: string
  fixHint?: string | undefined
  at: string
  value?: string | undefined
  replacement?: string | undefined
  /** CSS variable of the replacement token, ready to paste. */
  replacementVar?: string | undefined
  /** The context the finding is about (`dark`); absent for the default context. */
  context?: string | undefined
}

/** A hint that does not fail the check (F15: a colour shows its light value in dark). */
export interface CheckWarning {
  code: 'context_fallback'
  /** Token path without `tokens.`. */
  token: string
  context: string
}

/** A checked stylesheet Accord could not parse: its token values were not judged. */
export interface UnparsableFile {
  file: string
  detail: string
}

/**
 * A token change made in code that code does not own (a design value, a register name), or the removal
 * of a token's CSS variable. Code proposes these; the owner decides. Not a rule violation, but not
 * something to commit as it is either: `ok` is false.
 */
export interface OwnershipFinding {
  /** Register path without `tokens.`. */
  token: string
  context?: string | undefined
  kind: 'changed' | 'removed'
  owner: Owner
  before?: string | undefined
  after?: string | undefined
  /** CSS variable of the token in code. */
  variable?: string | undefined
}

export interface CheckResult {
  ok: boolean
  /** Token changes code may not make on its own (see OwnershipFinding). */
  ownership: OwnershipFinding[]
  evaluation: Evaluation
  findings: CheckFinding[]
  files: string[]
  /** Hints, never a reason to fail. */
  warnings?: CheckWarning[] | undefined
  /** Checked stylesheets with a syntax error; their token values could not be judged. */
  unparsable?: UnparsableFile[] | undefined
}

const toLiteral = (h: HardValueFinding): LiteralUse => ({
  file: h.file,
  line: h.line,
  column: h.column,
  raw: h.raw,
  kind: h.kind,
  value: h.value as ColorValue | DimensionValue,
  replacement: h.match.exact[0],
  near: h.match.near,
  allowed: h.allowed,
  inlineOnly: h.inlineOnly,
})

const show = (type: TokenType, value: unknown) =>
  type === 'color' ? colorToCss(value as ColorValue) : formatValue(type, value)

/** The CSS variable a token is linked to in code (`ids.css`), if any. */
const linkedVariable = (register: Register, path: string) =>
  register.tokens.get(path.replace(/^tokens\./, ''))?.accord?.ids?.css

const cssVar = (register: Register, token: string) => {
  const t = register.tokens.get(token)
  return t ? cssVariableName(t) : undefined
}

/**
 * Check a change before it is committed or merged: hard-coded values in the touched files
 * (only added lines when a diff is given) and token changes in the configured stylesheets,
 * evaluated against the register's decisions. Used by `accord check`, the MCP tool and CI.
 */
export async function checkChange(input: CheckInput): Promise<CheckResult> {
  const root = resolve(input.root)
  const registerDir = isAbsolute(input.registerDir) ? input.registerDir : join(root, input.registerDir)
  const register = input.register ?? (await loadValidRegister(registerDir))
  const added = input.diff !== undefined ? addedLines(input.diff) : undefined
  // Only files inside the project are checked: a path from an agent or a diff (`../../.ssh/config`,
  // `+++ b/../x`) never makes Accord read and report from elsewhere.
  const files = [
    ...new Set(
      [...(input.paths ?? []), ...(added ? [...added.keys()] : [])]
        .map((p) => relative(root, resolve(root, p)))
        .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p)),
    ),
  ]

  const ctx = await prepareCodeScan({ root, register })
  const hardValues = (await scanPaths(ctx, files)).filter((h) => !added || added.get(h.file)?.has(h.line))

  // Token values edited in the stylesheet that defines them (or one it imports) are register changes proposed
  // from code, in every context code expresses (`.dark`).
  const touchesTokens = files.some(
    (f) => register.config.surfaces.code.css.includes(f) || ctx.stylesheets.includes(f),
  )
  const base = codeSnapshot(register.tokens.values(), ctx.resolved)
  const code = {
    ...base,
    snapshot: withCodeContexts(
      base.snapshot,
      register.tokens.values(),
      ctx.variables,
      codeModeSelectors(register, ctx.variables),
      register.modes?.modifier ?? THEME_MODIFIER,
    ),
  }
  // A stylesheet with a syntax error cannot be judged: its variables are unread, which would look like
  // every linked token was deleted. It is named instead.
  const unparsable: UnparsableFile[] = []
  for (const file of files.filter((f) => f.endsWith('.css'))) {
    const content = await readFile(join(root, file), 'utf8').catch(() => undefined)
    const detail = content === undefined ? undefined : stylesheetError(content, file)
    if (detail) unparsable.push({ file, detail })
  }
  const sheets = files.filter(
    (f) =>
      (register.config.surfaces.code.css.includes(f) || ctx.stylesheets.includes(f)) &&
      !unparsable.some((u) => u.file === f),
  )
  const touched =
    touchesTokens && unparsable.length === 0
      ? await touchedVariables({ root, files: sheets, variables: ctx.variables, added, diff: input.diff })
      : undefined
  const variableOf = (path: string) => {
    const token = register.tokens.get(path.replace(/^tokens\./, ''))
    return token ? (token.accord?.ids?.css ?? cssVariableName(token)) : undefined
  }
  const items = touched
    ? threeWayDiff({
        register: restrictTo(snapshotFromRegister(register), code.snapshot.coverage),
        surface: code.snapshot,
      }).filter((i) => {
        const name = variableOf(i.op.path)
        if (name === undefined) return false
        // A token without a variable in code is no removal: most tokens are never written as CSS. Only a
        // linked variable this change took away (`ids.css`) means code deleted it.
        if (i.op.kind === 'token.removed')
          return linkedVariable(register, i.op.path) !== undefined && touched.removed.has(name)
        // Only what this change touched: drift that was there before is not this commit's doing.
        return touched.changed.has(name)
      })
    : []

  const evaluation = await evaluate({
    register,
    change: { source: 'code', intent: 'proposal', items, literals: hardValues.map(toLiteral) },
  })

  // A change to the register itself (token files, modes, resolver.json): contrast must hold in light and
  // dark, and colours that fall back to light in dark are pointed out (F15).
  const registerRel = relative(root, registerDir).split('\\').join('/')
  const touchesRegister = files.some(
    (f) => f.startsWith(`${registerRel}/`) && !/\/(proposals|generated)\//.test(f.slice(registerRel.length)),
  )
  const audit = touchesRegister ? auditContrast(register) : []

  const describe = (v: Violation): CheckFinding => {
    const token = v.replacement ? register.tokens.get(v.replacement) : undefined
    const value =
      typeof v.detail.value === 'string'
        ? v.detail.value
        : v.code === 'low_contrast'
          ? `${v.detail.ratio}:1 on ${v.detail.against}, needs ${v.detail.required}:1`
          : undefined
    return {
      decision: v.decisionId,
      level: v.level,
      rule: v.rule,
      why: v.why,
      fixHint: v.fixHint,
      at: v.at,
      value,
      replacement: v.replacement,
      // Only a variable code really defines: a name from the naming convention would not resolve.
      replacementVar: token && ctx.resolved.has(cssVariableName(token)) ? cssVariableName(token) : undefined,
      ...(typeof v.detail.context === 'string' ? { context: v.detail.context } : {}),
    }
  }
  const seen = new Set<string>()
  const findings = [
    ...evaluation.literalViolations,
    ...evaluation.items.flatMap((i) => i.violations),
    ...audit,
  ]
    .map(describe)
    .filter((f) => {
      const key = `${f.decision}|${f.at}|${f.context ?? ''}|${f.value ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const warnings: CheckWarning[] = [
    ...(evaluation.warnings ?? []).map((w) => ({
      code: w.code,
      token: w.at.replace(/^tokens\./, ''),
      context: contextLabel(w.context),
    })),
    ...(touchesRegister
      ? contextFallbacks(register).map((f) => ({
          code: 'context_fallback' as const,
          token: f.path,
          context: f.context,
        }))
      : []),
  ].filter((w, i, all) => all.findIndex((x) => x.token === w.token && x.context === w.context) === i)
  const ownership: OwnershipFinding[] = evaluation.items.flatMap((e): OwnershipFinding[] => {
    const op = e.item.op
    const token = op.path.replace(/^tokens\./, '')
    const variable =
      linkedVariable(register, op.path) ??
      ((v) => (v && ctx.resolved.has(v) ? v : undefined))(cssVar(register, token))
    if (op.kind === 'token.removed')
      return [
        { token, kind: 'removed', owner: e.owner, before: show(op.before.type, op.before.value), variable },
      ]
    if (op.kind === 'token.value_changed' && !e.ownerAllowed)
      return [
        {
          token,
          kind: 'changed',
          owner: e.owner,
          before: show(op.type, op.before),
          after: show(op.type, op.after),
          variable,
          ...(op.context ? { context: contextLabel(op.context) } : {}),
        },
      ]
    return []
  })
  return {
    ownership,
    ok: !findings.some((f) => f.level === 'must') && ownership.length === 0,
    evaluation,
    findings,
    files,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(unparsable.length > 0 ? { unparsable } : {}),
  }
}

/** One line per F15 hint and per stylesheet Accord could not read, for terminals and agents. */
const warningLines = (result: CheckResult) => [
  ...(result.unparsable ?? []).map(
    (u) => `  Note: ${u.file} has a syntax error (${u.detail}); its token values were not checked.`,
  ),
  ...warningList(result),
]
const warningList = (result: CheckResult) =>
  (result.warnings ?? []).map(
    (w) =>
      `  Note: ${w.token} has no ${w.context} value of its own and shows its default value in ${w.context}.`,
  )

/** Plain-text report for agents and terminals, grouped by decision. */
/** Lines for token changes code may not make on its own: who owns them, and what to do instead. */
export function ownershipLines(result: CheckResult): string[] {
  if (result.ownership.length === 0) return []
  const lines = [
    '',
    'Ownership: code changed what it does not own. Revert it and ask the owner to change it in the register.',
  ]
  for (const o of result.ownership) {
    const where = `tokens.${o.token}${o.context ? ` (${o.context})` : ''}${o.variable ? ` [${o.variable}]` : ''}`
    lines.push(
      o.kind === 'removed'
        ? `  ${where}  removed in code (was ${o.before}); a deletion always needs a person (owner: ${o.owner})`
        : `  ${where}  ${o.before} → ${o.after}; owned by ${o.owner}`,
    )
  }
  return lines
}

export function formatCheck(result: CheckResult): string {
  if (result.findings.length === 0 && result.ownership.length === 0)
    return [`check_change: no violations in ${result.files.length} file(s).`, ...warningLines(result)].join(
      '\n',
    )
  if (result.findings.length === 0)
    return [
      `check_change: ${result.ownership.length} change(s) for the owner to decide – do not commit them as they are.`,
      ...ownershipLines(result),
      ...warningLines(result),
    ].join('\n')
  const lines: string[] = []
  const must = result.findings.filter((f) => f.level === 'must').length
  lines.push(
    `check_change: ${result.findings.length} violation(s)${must > 0 ? `, ${must} must – fix before committing` : ''}.`,
  )
  const byDecision = new Map<string, CheckFinding[]>()
  for (const f of result.findings) byDecision.set(f.decision, [...(byDecision.get(f.decision) ?? []), f])
  for (const [id, list] of byDecision) {
    const first = list[0] as CheckFinding
    lines.push('', `${id} (${first.level}): ${first.rule}`, `  Why: ${first.why}`)
    if (first.fixHint) lines.push(`  Fix: ${first.fixHint}`)
    for (const f of list) {
      const fix = f.replacement
        ? ` → ${f.replacement}${f.replacementVar ? ` (var(${f.replacementVar}))` : ''}`
        : ''
      lines.push(`  ${f.at}${f.context ? ` (${f.context})` : ''}${f.value ? `  ${f.value}` : ''}${fix}`)
    }
  }
  lines.push(...ownershipLines(result))
  const notes = warningLines(result)
  if (notes.length > 0) lines.push('', ...notes)
  return lines.join('\n')
}

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/**
 * GitHub Actions workflow commands: one annotation per finding at its line (`error` for must,
 * `warning` for should), shown in the pull request diff. `pathPrefix` is where the checked root lies
 * inside the repository (e.g. `apps/web`).
 */
export function formatGithubAnnotations(result: CheckResult, pathPrefix = ''): string {
  const ownership = result.ownership.map(
    (o) =>
      `::error title=${escapeProperty(`Owner: ${o.owner}`)}::${escapeData(
        o.kind === 'removed'
          ? `tokens.${o.token} was removed in code (was ${o.before}). A deletion always needs a person.`
          : `tokens.${o.token}${o.context ? ` (${o.context})` : ''}: ${o.before} → ${o.after} in code, but ${o.owner} owns it. Revert it and ask ${o.owner} to change it in the register.`,
      )}`,
  )
  return [
    ...ownership,
    ...result.findings.map((f) => {
      const [file, line, col] = f.at.split(':')
      // GitHub places annotations by path from the repository root.
      const path = pathPrefix ? `${pathPrefix.replace(/\/$/, '')}/${file}` : (file as string)
      const where = line ? `file=${escapeProperty(path)},line=${line},col=${col ?? 1},` : ''
      const fix = f.replacement
        ? ` Replace with ${f.replacement}${f.replacementVar ? ` (var(${f.replacementVar}))` : ''}.`
        : ''
      const message = `${f.rule}${f.value ? `: ${f.value}` : ''}.${fix} Why: ${f.why}`
      return `::${f.level === 'must' ? 'error' : 'warning'} ${where}title=${escapeProperty(`${f.decision} (${f.level})`)}::${escapeData(message)}`
    }),
  ].join('\n')
}

/** Markdown summary for the job page (`$GITHUB_STEP_SUMMARY`) or a pull request comment. */
export function formatMarkdownSummary(result: CheckResult): string {
  const owners = result.ownership.length
    ? [
        '',
        '**Ownership:** code changed what it does not own. Revert it and ask the owner to change it in the register.',
        '',
        ...result.ownership.map((o) =>
          o.kind === 'removed'
            ? `- \`tokens.${o.token}\` removed in code (was \`${o.before}\`); a deletion always needs a person`
            : `- \`tokens.${o.token}\`${o.context ? ` (${o.context})` : ''}: \`${o.before}\` → \`${o.after}\`, owned by ${o.owner}`,
        ),
      ].join('\n')
    : ''
  if (result.findings.length === 0 && owners) return `### ❌ decivo Accord\n${owners}\n`
  if (result.findings.length === 0)
    return `### ✅ decivo Accord\n\nNo violations in ${result.files.length} changed file(s).\n`
  const must = result.findings.filter((f) => f.level === 'must').length
  const lines = [
    `### ${must > 0 ? '❌' : '⚠️'} decivo Accord`,
    '',
    `${result.findings.length} violation(s) in ${new Set(result.findings.map((f) => f.at.split(':')[0])).size} file(s)${must > 0 ? `, ${must} must` : ''}.`,
    '',
    '| Decision | Where | Value | Replace with |',
    '| --- | --- | --- | --- |',
  ]
  for (const f of result.findings) {
    const replace = f.replacement
      ? `\`${f.replacement}\`${f.replacementVar ? ` (\`var(${f.replacementVar})\`)` : ''}`
      : '–'
    lines.push(
      `| ${f.decision} (${f.level}) | \`${f.at}\` | ${f.value ? `\`${f.value}\`` : '–'} | ${replace} |`,
    )
  }
  const decisions = new Map(result.findings.map((f) => [f.decision, f]))
  lines.push('')
  for (const [id, f] of decisions) lines.push(`- **${id}** ${f.rule} – ${f.why}`)
  if (owners) lines.push(owners)
  return `${lines.join('\n')}\n`
}
