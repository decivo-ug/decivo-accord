import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ResetFile } from '@decivo/accord-adapter-claude-design'
import { scanCode, type VariableSurfaceStatus } from '@decivo/accord-adapter-code'
import { figmaStatus, readFigmaExports } from '@decivo/accord-adapter-figma'
import { penStatus, readPenFiles } from '@decivo/accord-adapter-pen'
import {
  contextFile,
  contextForMode,
  contextLabel,
  explainOwner,
  formatIssue,
  formatValue,
  hasErrors,
  LOCK_FILE,
  parseLock,
  type Register,
  serializeLock,
  withLockedSnapshot,
} from '@decivo/accord-core'
import { DEFAULT_REGISTER_DIR, loadValidRegister, readValidRegister } from '@decivo/accord-core/node'
import { planExport } from '@decivo/accord-generators'
import {
  ApplyError,
  changeLines,
  planApply,
  type Resolution,
  ResolutionSchema,
  resolutionFor,
  writeApply,
} from './apply.js'
import { checkChange, formatCheck, formatGithubAnnotations, formatMarkdownSummary } from './check.js'
import { designLock, designReset, designStatus, ingestHandoff, saveProposal } from './claude-design.js'
import { formatDriftReport } from './format.js'
import { type InitSource, planInit, writeInit } from './init.js'
import type { T } from './messages.js'
import { buildDriftReport, type DriftReport } from './report.js'
import {
  checkReportUrl,
  loadProposals,
  ReportError,
  sendReport,
  toReportPayload,
  toReportProposals,
} from './report-payload.js'
import { proposeFromSurface, saveSurfaceProposal } from './surface-proposal.js'
import { writeOutput } from './write.js'

const runGit = promisify(execFile)

export interface CommonOptions {
  /** Repository root (default: current directory). */
  root: string
  /** Register directory, relative to root unless absolute (default: .accord). */
  register: string
}

const registerDir = ({ root, register }: CommonOptions) =>
  isAbsolute(register) ? register : join(root, register)
/** Short path for messages: relative when inside the working directory, absolute otherwise. */
const display = (path: string) => {
  const rel = relative(process.cwd(), path)
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel
}

type Print = (text: string) => void

export async function initCommand(
  opts: CommonOptions & {
    force: boolean
    dryRun: boolean
    from?: InitSource | undefined
    figma?: string[] | undefined
    mode?: string | undefined
  },
  t: T,
  print: Print,
): Promise<number> {
  const plan = await planInit(resolve(opts.root), t, { from: opts.from, figma: opts.figma, mode: opts.mode })
  const d = plan.detected
  print(t('init.title'))
  const found = (label: string, values: string[]) =>
    print(`  ${label}: ${values.length > 0 ? values.join(', ') : t('init.none')}`)
  print(`${t('init.found')}:`)
  found(t('init.designMd'), d.designMd)
  found(
    t('init.tokens'),
    d.tokens.map((f) => `${f.path} (${f.format})`),
  )
  found(t('init.css'), d.css)
  found(t('init.ui'), d.uiDir ? [d.uiDir] : [])
  found(t('init.storybook'), d.storybook ? ['.storybook'] : [])
  found(t('init.pen'), d.pen)
  found(t('init.figma'), d.figma)
  const origin = plan.openPoints.design
  const sourceLabel = origin
    ? t(`init.source.design.${origin.surface}`, { count: origin.variables, files: origin.sources.length })
    : t(`init.source.${plan.source.kind}`)
  print(`${t('init.source')}: ${sourceLabel} (${t(`init.reason.${plan.source.reason}`)})`)
  if (origin) {
    for (const error of origin.errors) print(`  ${t('init.design.error', { error })}`)
    for (const m of origin.modes.filter((m) => m.others.length > 0 && !m.contexts))
      print(
        `  ${t('init.design.mode', {
          main: m.main,
          collection: m.collection ? ` (${m.collection})` : '',
          others: m.others.join(', '),
        })}`,
      )
  }
  const modes = plan.modes
  if (modes) {
    const source = t(`init.modes.source.${modes.source}`, {
      selector: modes.selector ?? '',
      from: modes.from.join(', '),
    })
    print(`${t('init.modes.title', { contexts: modes.contexts.join(', '), source })}`)
    for (const [context, count] of Object.entries(modes.values))
      print(
        `  ${t('init.modes.values', { count, context, file: display(join(registerDir(opts), contextFile(context))) })}`,
      )
    for (const [context, count] of Object.entries(modes.unreadable))
      if (count > 0) print(`  ${t('init.modes.unreadable', { count, context })}`)
    for (const [context, names] of Object.entries(modes.contextOnly ?? {}))
      if (names.length > 0)
        print(`  ${t('init.modes.contextOnly', { count: names.length, context, names: names.join(', ') })}`)
  }
  if (d.tokens.length === 0 && plan.source.kind === 'tokens') print(t('init.noTokens'))
  print(t('init.mappedVars', { count: plan.mappedVariables.length }))
  print(t('init.components', { count: plan.components.length }))
  if (d.designMd.length > 0) print(t('init.designMdNote'))
  for (const issue of [...plan.importIssues, ...plan.register.issues]) print(`  ${formatIssue(issue)}`)
  const op = plan.openPoints
  const designSkipped = origin?.skipped ?? []
  if (op.corrected.length + op.dropped.length + op.codeOnly + op.skipped.length + designSkipped.length > 0) {
    print(`${t('init.openPoints')}:`)
    if (op.corrected.length > 0) {
      print(`  ${t('init.corrected', { count: op.corrected.length })}`)
      for (const c of op.corrected) print(`    ${c.path}: ${c.tokens} → ${c.code}`)
    }
    if (op.dropped.length > 0) print(`  ${t('init.dropped', { count: op.dropped.length })}`)
    if (op.codeOnly > 0) print(`  ${t('init.codeOnly', { count: op.codeOnly })}`)
    for (const s of op.skipped)
      print(`  ${t(`init.skipped.${s.reason}`, { file: s.file, detail: s.detail })}`)
    for (const reason of ['type', 'value', 'name', 'duplicate'] as const) {
      const names = designSkipped.filter((s) => s.reason === reason).map((s) => s.name)
      if (names.length > 0)
        print(
          `  ${t(`init.design.skipped.${reason}`, { count: names.length, names: names.slice(0, 5).join(', ') })}`,
        )
    }
  }

  const dir = registerDir(opts)
  if (opts.dryRun) {
    print(t('init.dryRun'))
    for (const path of plan.files.keys()) print(`  ${display(join(dir, path))}`)
    return hasErrors(plan.register.issues) ? 1 : 0
  }
  const result = await writeInit(dir, plan.files, opts.force)
  if (result === 'exists') {
    print(t('init.exists', { dir: display(dir) }))
    return 1
  }
  print(`${t('init.written')} ${display(dir)}`)
  if (result === 'written-kept-config') print(t('init.keptConfig'))
  // The register starts equal to the design tool: record that as the tool's last sync, so the next
  // status can tell a change in the tool from a change in the register.
  if (origin && !hasErrors(plan.register.issues)) {
    const common = { root: opts.root, register: opts.register, json: false, action: 'lock' as const }
    if (origin.surface === 'figma')
      await figmaCommand({ ...common, file: opts.figma, mode: opts.mode }, t, print)
    else await penCommand(common, t, print)
  }
  print(t('init.next'))
  return hasErrors(plan.register.issues) ? 1 : 0
}

export async function driftReport(opts: CommonOptions): Promise<DriftReport> {
  const dir = registerDir(opts)
  const register = await loadValidRegister(dir)
  const lock = parseLock(await readFile(join(dir, LOCK_FILE), 'utf8').catch(() => undefined))
  const scan = await scanCode({ root: resolve(opts.root), register })
  return buildDriftReport(register, scan, lock)
}

export async function diffCommand(
  opts: CommonOptions & { json: boolean; limit: number },
  t: T,
  print: Print,
): Promise<number> {
  const report = await driftReport(opts)
  print(opts.json ? JSON.stringify(report, null, 2) : formatDriftReport(report, t, { limit: opts.limit }))
  return hasErrors(report.register.issues) ? 1 : 0
}

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runGit('git', args, { cwd: root })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export const REPORT_URL_ENV = 'ACCORD_REPORT_URL'
export const REPORT_TOKEN_ENV = 'ACCORD_REPORT_TOKEN'

/** A report failure in the reader's language. The token is already redacted by `sendReport`. */
function reportFailure(error: ReportError, t: T): string {
  const f = error.failure
  switch (f.kind) {
    case 'invalid-url':
      return t('report.invalidUrl')
    case 'insecure-url':
      return t('report.insecureUrl', { host: f.host })
    case 'unreachable':
      return t('report.unreachable', { endpoint: f.endpoint, detail: f.detail })
    case 'rejected':
      return t('report.rejected', { endpoint: f.endpoint, status: String(f.status), detail: f.detail })
  }
}

/**
 * Print the drift report as JSON (accord.report/1), or POST it to a webhook. Nothing leaves the machine without
 * an explicit URL (`--url` or ACCORD_REPORT_URL); `--json` always prints instead of sending. The token comes only
 * from the environment (ACCORD_REPORT_TOKEN, or the variable named by `--token-env`), never from a flag value,
 * so it stays out of shell history and logs. Commit and branches default to GitHub Actions, then git.
 */
export async function reportCommand(
  opts: CommonOptions & {
    url?: string | undefined
    tokenEnv?: string | undefined
    commit?: string | undefined
    branch?: string | undefined
    defaultBranch?: string | undefined
    source: 'action' | 'cli'
    json: boolean
  },
  t: T,
  print: Print,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const root = resolve(opts.root)
  const url = opts.json ? undefined : opts.url || env[REPORT_URL_ENV] || undefined
  const token = env[opts.tokenEnv || REPORT_TOKEN_ENV] || undefined
  if (url) {
    try {
      checkReportUrl(url)
    } catch (error) {
      if (error instanceof ReportError) {
        print(reportFailure(error, t))
        return 2
      }
      throw error
    }
  }
  const commit = opts.commit ?? env.GITHUB_SHA ?? (await git(root, ['rev-parse', 'HEAD']))
  const branch =
    opts.branch ||
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ||
    'main'
  const defaultBranch =
    opts.defaultBranch ||
    (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '') ||
    'main'
  if (!commit) {
    print(t('report.noCommit'))
    return 2
  }
  const register = await loadValidRegister(registerDir(opts))
  const proposals = toReportProposals(await loadProposals(registerDir(opts)), register)
  const payload = toReportPayload(
    await driftReport(opts),
    { commit, branch, defaultBranch, source: opts.source },
    undefined,
    proposals,
  )
  if (!url) {
    print(JSON.stringify(payload, null, 2))
    return 0
  }
  try {
    const result = await sendReport({
      url,
      token,
      payload,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    print(
      t('report.sent', {
        endpoint: checkReportUrl(url).host,
        commit: commit.slice(0, 7),
        branch,
        result:
          result.created === undefined
            ? `HTTP ${result.status}`
            : t(result.created ? 'report.created' : 'report.replaced'),
      }),
    )
    return 0
  } catch (error) {
    if (error instanceof ReportError) {
      print(reportFailure(error, t))
      return 2
    }
    throw error
  }
}

export async function explainOwnerCommand(
  opts: CommonOptions & { path: string },
  print: Print,
): Promise<number> {
  const register = await loadValidRegister(registerDir(opts))
  print(explainOwner(register, opts.path))
  return 0
}

/**
 * Write DESIGN.md, AGENTS.md, the CLAUDE.md block and configured CSS from the register.
 * With `check`, write nothing and fail when a generated file is out of date (for CI).
 */
export async function exportCommand(
  opts: CommonOptions & { check: boolean },
  t: T,
  print: Print,
): Promise<number> {
  const root = resolve(opts.root)
  const dir = registerDir(opts)
  const { files, register } = await readValidRegister(dir)
  const plans = await planExport({
    register,
    files,
    registerDir: relative(root, dir).split('\\').join('/') || '.',
    read: (path) => readFile(join(root, path), 'utf8').catch(() => undefined),
  })
  let stale = 0
  for (const plan of plans) {
    if (plan.mode === 'skipped') {
      print(`  ${t('export.skipped', { path: plan.path })}`)
      continue
    }
    if (!plan.changed) continue
    stale++
    if (opts.check) {
      print(`  ${t('export.stale', { path: plan.path })}`)
      continue
    }
    await writeOutput(root, plan.path, plan.content)
    print(`  ${t(plan.mode === 'block' ? 'export.block' : 'export.written', { path: plan.path })}`)
  }
  if (stale === 0) print(t('export.upToDate'))
  return opts.check && stale > 0 ? 1 : 0
}

/** `accord check`: files and/or a diff against the register's decisions. Exit 1 on a `must` violation. */
export async function checkCommand(
  opts: CommonOptions & {
    paths: string[]
    diff?: string | undefined
    json: boolean
    format?: 'text' | 'json' | 'github'
  },
  print: Print,
): Promise<number> {
  const diff =
    opts.diff === undefined
      ? undefined
      : opts.diff === '-'
        ? await readStdin()
        : await readFile(opts.diff, 'utf8')
  const result = await checkChange({
    root: opts.root,
    registerDir: registerDir(opts),
    paths: opts.paths,
    diff,
  })
  const format = opts.format ?? (opts.json ? 'json' : 'text')
  if (format === 'json') {
    print(
      JSON.stringify(
        {
          ok: result.ok,
          files: result.files,
          findings: result.findings,
          ownership: result.ownership,
          ...(result.unparsable ? { unparsable: result.unparsable } : {}),
          route: result.evaluation.route,
        },
        null,
        2,
      ),
    )
  } else if (format === 'github') {
    // In Actions, annotation paths are relative to the workspace (repository root), not to --root.
    const prefix = process.env.GITHUB_WORKSPACE
      ? relative(process.env.GITHUB_WORKSPACE, resolve(opts.root))
      : ''
    const annotations = formatGithubAnnotations(result, prefix.startsWith('..') ? '' : prefix)
    if (annotations) print(annotations)
    print(formatCheck(result))
    // Job summary on the workflow run page.
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, formatMarkdownSummary(result))
  } else print(formatCheck(result))
  return result.ok ? 0 : 1
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** `accord ingest <bundle>`: a Claude Design handoff becomes a proposal for the owner. */
export async function ingestCommand(
  opts: CommonOptions & { bundle: string; json: boolean; write: boolean; branch: boolean },
  t: T,
  print: Print,
): Promise<number> {
  const proposal = await ingestHandoff({
    root: opts.root,
    registerDir: registerDir(opts),
    bundle: opts.bundle,
  })
  if (opts.json) print(JSON.stringify(proposal, null, 2))
  else {
    print(t('ingest.title', { name: proposal.bundle.name }))
    if (proposal.bundle.primary) print(`  ${t('ingest.primary')}: ${proposal.bundle.primary}`)
    print(`  ${t('ingest.pages')}: ${proposal.bundle.pages.join(', ')}`)
    const c = proposal.colors
    print(
      `  ${t('ingest.colors', { register: c.inRegister.length, near: c.nearMisses.length, new: c.new.length })}`,
    )
    for (const near of c.nearMisses.slice(0, 10)) {
      print(
        `    ${near.value} ×${near.count} ${t('diff.near')} ${near.near?.path} (ΔE ${near.near?.distance})`,
      )
    }
    print(
      `  ${t('ingest.route')}: ${t(`route.${proposal.route}`)}${proposal.decider ? ` · ${t('diff.owner')} ${t(`owner.${proposal.decider}`)}` : ''}`,
    )
    for (const v of proposal.violations.slice(0, 10)) {
      print(
        `    ${v.decision} (${v.level}): ${v.value} ×${v.count}${v.nearest ? ` → ${v.nearest}` : ''} – ${v.rule}`,
      )
    }
  }
  if (opts.write || opts.branch) {
    const saved = await saveProposal(proposal, {
      root: opts.root,
      registerDir: registerDir(opts),
      branch: opts.branch,
    })
    print(t('ingest.saved', { file: display(saved.file) }))
    if (saved.branch) print(t('ingest.branch', { branch: saved.branch }))
  }
  return 0
}

/** `accord design status|reset|lock --mirror <dir>`: the Claude Design design-system project. */
export async function designCommand(
  opts: CommonOptions & { action: 'status' | 'reset' | 'lock'; mirror: string; json: boolean },
  t: T,
  print: Print,
): Promise<number> {
  const input = { registerDir: registerDir(opts), mirror: resolve(opts.mirror) }
  if (opts.action === 'lock') {
    print(t('design.locked', { count: await designLock(input) }))
    return 0
  }
  if (opts.action === 'reset') {
    const plan = await designReset(input)
    if (plan.files.length === 0 && plan.skipped.length === 0) print(t('design.inSync'))
    for (const file of plan.files) {
      print(`  ${file.path}`)
      for (const c of file.changes) print(`    ${designChange(c)}`)
    }
    for (const s of plan.skipped)
      print(
        `  ${t(`design.skipped.${s.reason}`, { path: s.path, context: s.context ? ` (${s.context})` : '' })}`,
      )
    if (plan.files.length > 0) print(t('design.resetNext'))
    return 0
  }
  const { status, plan } = await designStatus(input)
  if (opts.json) {
    const { items, missing, contexts, selectors } = status
    print(JSON.stringify({ items, missing, contexts, selectors, plan }, null, 2))
    return 0
  }
  print(t('design.title', { count: status.snapshot.tokens.size }))
  if (status.contexts.length > 0)
    print(`  ${t('surface.contexts', { contexts: status.contexts.join(', ') })}`)
  if (status.items.length === 0) print(t('design.inSync'))
  for (const item of status.items) {
    const op = item.op
    const context = op.kind === 'token.value_changed' && op.context ? ` (${contextLabel(op.context)})` : ''
    const values =
      op.kind === 'token.value_changed'
        ? `  ${formatValue(op.type, op.before)} → ${formatValue(op.type, op.after)}`
        : ''
    print(`  ${op.path}${context}  [${t(`diff.origin.${item.origin}`)}]${values}`)
  }
  if (plan.files.length > 0) print(t('design.resetHint', { count: plan.files.length }))
  return status.items.length > 0 ? 1 : 0
}

/** One line of a reset: `--brand: #111 → #222 (dark)`, or the added value of a context. */
const designChange = (c: ResetFile['changes'][number]) =>
  `${c.variable}: ${c.from ?? '—'} → ${c.to}${c.context ? ` (${c.context})` : ''}`

class ResolutionError extends Error {}

async function readResolution(path: string): Promise<Resolution> {
  const raw = path === '-' ? await readStdin() : await readFile(resolve(path), 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new ResolutionError((error as Error).message)
  }
  const parsed = ResolutionSchema.safeParse(json)
  if (!parsed.success)
    throw new ResolutionError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '·'}: ${i.message}`).join('; '),
    )
  return parsed.data
}

/** `--proposal P-… --option adopt --by "Name"`: the decision without writing a resolution file. */
async function decideOnCommandLine(
  opts: CommonOptions & {
    proposal?: string | undefined
    option?: Resolution['option'] | undefined
    by?: string | undefined
    note?: string | undefined
  },
): Promise<Resolution> {
  if (!opts.proposal || !opts.option)
    throw new ResolutionError('give --resolution <file>, or --proposal <id> with --option adopt|reset|reject')
  const by = opts.by ?? (await git(resolve(opts.root), ['config', 'user.name']))
  if (!by) throw new ResolutionError('--by <name> is needed (who decides)')
  const file = join(registerDir(opts), 'proposals', `${opts.proposal}.json`)
  const raw = await readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) throw new ApplyError('not_found', `proposal ${opts.proposal} not found`)
  return resolutionFor(JSON.parse(raw), { option: opts.option, by, note: opts.note })
}

/**
 * `accord apply --resolution <file>`: a person's decision on a proposal becomes a register change with
 * regenerated files, on its own branch. Exit 1 when the decision cannot be applied.
 */
export async function applyCommand(
  opts: CommonOptions & {
    resolution?: string | undefined
    proposal?: string | undefined
    option?: Resolution['option'] | undefined
    by?: string | undefined
    note?: string | undefined
    dryRun: boolean
    branch: boolean
    push: boolean
    json: boolean
  },
  t: T,
  print: Print,
): Promise<number> {
  let resolution: Resolution
  try {
    resolution = opts.resolution ? await readResolution(opts.resolution) : await decideOnCommandLine(opts)
  } catch (error) {
    if (error instanceof ApplyError) {
      print(t(`apply.error.${error.code}`, { detail: error.message }))
      return 1
    }
    if (!(error instanceof ResolutionError)) throw error
    print(t('apply.error.invalid_resolution', { detail: error.message }))
    return 1
  }

  let plan: Awaited<ReturnType<typeof planApply>>
  try {
    plan = await planApply({ root: opts.root, registerDir: registerDir(opts), resolution })
  } catch (error) {
    if (!(error instanceof ApplyError)) throw error
    print(t(`apply.error.${error.code}`, { detail: error.message }))
    return 1
  }

  const lines = changeLines(plan.ops)
  if (opts.json) {
    print(
      JSON.stringify(
        {
          proposal: plan.proposal.id,
          option: plan.resolution.option,
          changes: lines,
          files: [
            ...plan.tokenFiles.map((f) => f.path),
            ...plan.outputs.map((o) => o.path),
            plan.proposalFile,
          ],
        },
        null,
        2,
      ),
    )
  } else {
    const r = plan.resolution
    print(t('apply.title', { id: plan.proposal.id }))
    print(
      `  ${t('apply.decided', { option: t(`apply.option.${r.option}`), by: r.by })}${r.ref ? ` · ${r.ref}` : ''}`,
    )
    if (lines.length === 0) print(`  ${t('apply.registerUnchanged')}`)
    for (const c of lines) {
      const path = c.context ? `${c.path} (${c.context})` : c.path
      print(
        `  ${
          c.to
            ? t('apply.renamed', { path, to: c.to, value: c.after ?? '' })
            : c.unset
              ? t('apply.unset', { path, before: c.before ?? '' })
              : c.before === undefined
                ? t('apply.added', { path, after: c.after ?? '' })
                : c.after === undefined
                  ? t('apply.removed', { path, before: c.before })
                  : t('apply.changed', { path, before: c.before, after: c.after })
        }`,
      )
    }
    for (const o of plan.outputs) print(`  ${t('apply.output', { path: o.path })}`)
  }
  if (opts.dryRun) {
    if (!opts.json) print(t('apply.dryRun'))
    return 0
  }
  let written: Awaited<ReturnType<typeof writeApply>>
  try {
    written = await writeApply(plan, {
      root: opts.root,
      branch: opts.branch || opts.push,
      push: opts.push,
    })
  } catch (error) {
    if (!(error instanceof ApplyError)) throw error
    print(t(`apply.error.${error.code}`, { detail: error.message }))
    return 1
  }
  if (!opts.json) {
    print(t('apply.written', { count: written.files.length }))
    if (written.branch) print(t(opts.push ? 'apply.pushed' : 'apply.branch', { branch: written.branch }))
  }
  return 0
}

/** `accord pen status|lock`: the Pencil (pen.dev) files in the repository against the register. */
export async function penCommand(
  opts: CommonOptions & {
    action: 'status' | 'lock' | 'propose'
    json: boolean
    write?: boolean | undefined
    branch?: boolean | undefined
  },
  t: T,
  print: Print,
): Promise<number> {
  const root = resolve(opts.root)
  const dir = registerDir(opts)
  const register = await loadValidRegister(dir)
  const lock = parseLock(await readFile(join(dir, LOCK_FILE), 'utf8').catch(() => undefined))
  const docs = await readPenFiles(root, register.config.surfaces.pen.include)
  const status = penStatus(docs, register, lock)
  if (opts.action === 'propose') return proposeCommand('pen', status, register, opts, t, print)
  if (opts.action === 'lock') {
    const next = withLockedSnapshot(lock, 'pen', status.snapshot, new Date())
    await writeFile(join(dir, LOCK_FILE), serializeLock(next))
    print(t('pen.locked', { count: status.snapshot.tokens.size }))
    return 0
  }
  if (opts.json) {
    const { snapshot: _snapshot, ...rest } = status
    print(JSON.stringify({ files: docs.map((d) => d.path), ...rest }, null, 2))
    return status.items.length > 0 ? 1 : 0
  }
  if (docs.length === 0) {
    print(t('pen.none'))
    return 0
  }
  print(t('pen.title', { files: docs.length, count: status.snapshot.tokens.size }))
  if (status.contexts.length > 0)
    print(`  ${t('surface.contexts', { contexts: status.contexts.join(', ') })}`)
  for (const error of status.errors) print(`  ✗ ${error}`)
  if (status.items.length === 0) print(`  ${t('pen.inSync')}`)
  for (const item of status.items) print(`  ${statusLine(item, 'pen', t)}`)
  for (const u of status.unreadable)
    print(`  ${t('pen.unreadable', { variable: u.variable, value: String(u.value) })}`)
  if (status.unmapped.length > 0)
    print(
      `  ${t('pen.unmapped', {
        count: status.unmapped.length,
        names: status.unmapped
          .slice(0, 10)
          .map((v) => v.name)
          .join(', '),
      })}`,
    )
  if (status.literals.length > 0) {
    print(`  ${t('pen.literals', { count: status.literals.reduce((n, l) => n + l.count, 0) })}`)
    for (const l of status.literals.slice(0, 10)) print(`    ${l.value} ×${l.count}  ${l.nodes.join(', ')}`)
  }
  const notCompared = themedElsewhere(status, register)
  if (notCompared > 0) print(`  ${t('pen.themed', { count: notCompared })}`)
  return status.items.length > 0 ? 1 : 0
}

/** One drift line of a design tool: path (and context), where it changed, the values. */
function statusLine(item: VariableSurfaceStatus['items'][number], surface: 'pen' | 'figma', t: T): string {
  const op = item.op
  const context = op.kind === 'token.value_changed' && op.context ? contextLabel(op.context) : undefined
  const values =
    op.kind === 'token.value_changed'
      ? `  ${formatValue(op.type, op.before)} → ${formatValue(op.type, op.after)}`
      : ''
  const origin =
    op.kind === 'token.removed'
      ? t(`${surface}.deleted`)
      : op.kind === 'token.value_changed' && op.fallback === 'after' && context
        ? t(`${surface}.contextDeleted`, { context })
        : t(`${surface}.origin.${item.origin}`)
  return `${op.path}${context ? ` (${context})` : ''}  [${origin}]${values}`
}

/** Tokens with values in modes the register has no context for (Pill, a brand): shown, not compared. */
const themedElsewhere = (status: VariableSurfaceStatus, register: Register) =>
  status.themed.filter((t) =>
    t.themed.some(
      (e) =>
        !Object.values(e.theme).some((v) => {
          const context = contextForMode(register, v)
          return context !== undefined && status.contexts.includes(context)
        }),
    ),
  ).length

/** `accord figma status|lock`: Figma variable exports in the repository against the register. */
export async function figmaCommand(
  opts: CommonOptions & {
    action: 'status' | 'lock' | 'propose'
    json: boolean
    file?: string[] | undefined
    mode?: string | undefined
    write?: boolean | undefined
    branch?: boolean | undefined
  },
  t: T,
  print: Print,
): Promise<number> {
  const root = resolve(opts.root)
  const dir = registerDir(opts)
  const register = await loadValidRegister(dir)
  const lock = parseLock(await readFile(join(dir, LOCK_FILE), 'utf8').catch(() => undefined))
  const config = register.config.surfaces.figma
  const exports = await readFigmaExports(root, opts.file?.length ? [] : config.include, opts.file ?? [])
  const status = figmaStatus(exports, register, lock, { defaultMode: opts.mode ?? config.default_mode })
  if (opts.action === 'propose') return proposeCommand('figma', status, register, opts, t, print)
  if (opts.action === 'lock') {
    const next = withLockedSnapshot(lock, 'figma', status.snapshot, new Date())
    await writeFile(join(dir, LOCK_FILE), serializeLock(next))
    print(t('figma.locked', { count: status.snapshot.tokens.size }))
    return 0
  }
  if (opts.json) {
    const { snapshot: _snapshot, ...rest } = status
    print(
      JSON.stringify({ files: exports.map((e) => ({ path: e.path, format: e.format })), ...rest }, null, 2),
    )
    return status.items.length > 0 ? 1 : 0
  }
  if (exports.length === 0) {
    print(t('figma.none'))
    return 0
  }
  print(t('figma.title', { files: exports.length, count: status.snapshot.tokens.size }))
  if (status.modes.length > 0) {
    // The default mode, and every other mode the register has as a context (Dark → dark).
    const compared = [
      ...(status.defaultMode ? [status.defaultMode] : []),
      ...status.modes.filter((m) => {
        const context = contextForMode(register, m)
        return context !== undefined && status.contexts.includes(context)
      }),
    ]
    print(`  ${t('figma.modes', { modes: status.modes.join(', '), main: compared.join(', ') })}`)
  }
  for (const error of status.errors) print(`  ✗ ${error}`)
  if (status.items.length === 0) print(`  ${t('pen.inSync')}`)
  for (const item of status.items) print(`  ${statusLine(item, 'figma', t)}`)
  for (const u of status.unreadable)
    print(`  ${t('pen.unreadable', { variable: u.variable, value: JSON.stringify(u.value) })}`)
  if (status.unmapped.length > 0)
    print(
      `  ${t('figma.unmapped', {
        count: status.unmapped.length,
        names: status.unmapped
          .slice(0, 10)
          .map((v) => v.name)
          .join(', '),
      })}`,
    )
  const notCompared = themedElsewhere(status, register)
  if (notCompared > 0) print(`  ${t('pen.themed', { count: notCompared })}`)
  return status.items.length > 0 ? 1 : 0
}

/**
 * `accord figma|pen propose`: what the tool changed since its last sync becomes a proposal against the
 * register, routed by the check layer (ownership, breaking changes, rules). Nothing changes in the register.
 */
async function proposeCommand(
  source: 'figma' | 'pen',
  status: VariableSurfaceStatus,
  register: Register,
  opts: CommonOptions & { json: boolean; write?: boolean | undefined; branch?: boolean | undefined },
  t: T,
  print: Print,
): Promise<number> {
  const proposal = await proposeFromSurface({ source, status, register })
  if (!proposal) {
    print(opts.json ? JSON.stringify(null) : t('propose.none'))
    return 0
  }
  const saved =
    opts.write || opts.branch
      ? await saveSurfaceProposal(proposal, {
          root: resolve(opts.root),
          registerDir: registerDir(opts),
          branch: Boolean(opts.branch),
        })
      : undefined
  if (opts.json) {
    print(JSON.stringify(proposal, null, 2))
    return 1
  }
  print(t('propose.title', { id: proposal.id, source: t(`propose.source.${source}`) }))
  const decider = proposal.decider ? ` (${t('propose.decider', { owner: proposal.decider })})` : ''
  print(`  ${t('ingest.route')}: ${t(`route.${proposal.route}`)}${decider}`)
  const reasons = [...new Set(proposal.reasons.map((r) => r.code))].filter((c) => c !== 'safe')
  if (reasons.length > 0)
    print(`  ${t('propose.reasons', { reasons: reasons.map((c) => t(`propose.reason.${c}`)).join(', ') })}`)
  for (const c of proposal.changes) {
    const conflict = c.origin === 'surface' ? '' : ` · ${t(`propose.origin.${c.origin}`)}`
    const line =
      c.kind === 'change'
        ? `${c.before} → ${c.after}`
        : c.kind === 'new'
          ? t('propose.new', { value: c.after ?? '', variable: c.variable ?? '' })
          : c.context
            ? t('propose.removeContext', { context: c.context, value: c.before ?? '' })
            : t('propose.remove', { value: c.before ?? '' })
    const where = c.context ? ` (${c.context})` : ''
    print(`  ${c.token}${where}: ${line}  [${t('propose.owner', { owner: c.owner })}${conflict}]`)
  }
  for (const v of proposal.violations) print(`  ✗ ${v.decision} (${v.level}): ${v.rule} – ${v.why}`)
  if (saved) {
    print(`  ${t('ingest.saved', { file: display(saved.file) })}`)
    if (saved.branch) print(`  ${t('ingest.branch', { branch: saved.branch })}`)
    print(`  ${t('propose.next', { id: proposal.id })}`)
  } else print(`  ${t('propose.write')}`)
  return 1
}

export { DEFAULT_REGISTER_DIR }
