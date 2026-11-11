import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  designPath,
  designTokenType,
  type SurfaceVariable,
  toTokenValue,
  type VariableSurfaceStatus,
} from '@decivo/accord-adapter-code'
import { type Evaluation, evaluate, type RouteReasonCode } from '@decivo/accord-checks'
import {
  type ChangeOp,
  type ColorValue,
  classify,
  colorToCss,
  contextLabel,
  type DriftItem,
  formatValue,
  type Owner,
  type Register,
  type Token,
  type TokenType,
  tokensInContext,
  validateValue,
} from '@decivo/accord-core'
import { createBranch, git } from './git.js'

/** One change a design tool made, as the register would take it over. */
export interface SurfaceChange {
  /** Register token path without `tokens.`. */
  token: string
  /** change: new value; new: a variable without a token (its name is a suggestion); remove: deleted in the tool. */
  kind: 'change' | 'new' | 'remove'
  type: TokenType
  /** CSS value before (register) and after (tool). */
  before?: string | undefined
  after?: string | undefined
  /**
   * surface: only the tool changed it. conflict: the register changed it too since the last sync.
   * unknown: there is no last sync to tell (no lock yet); a person decides, as for a conflict.
   */
  origin: 'surface' | 'conflict' | 'unknown'
  owner: Owner
  /** Name of the variable in the tool, for new ones. */
  variable?: string | undefined
  /**
   * The context the change is in (`dark`), from a Figma mode or a Pencil theme; absent for the default context.
   * With `remove`, only the value in that context goes: the token falls back to its default value there.
   */
  context?: string | undefined
}

/**
 * A change from Figma or Pencil, made into a proposal against the register: the tool never writes into
 * the register, the owner decides (or the change is safe enough to adopt without a person).
 */
export interface SurfaceProposal {
  id: string
  source: 'figma' | 'pen'
  createdAt: string
  route: Evaluation['route']
  decider?: Evaluation['decider']
  /** Why the route was chosen, strongest first (route reason codes). */
  reasons: { code: RouteReasonCode; at?: string | undefined }[]
  changes: SurfaceChange[]
  /** Rules the changes break, with their reason (same shape as handoff proposals). */
  violations: {
    decision: string
    level: string
    rule: string
    why: string
    value: string
    nearest?: string | undefined
    count: number
  }[]
}

const css = (type: TokenType, value: unknown) =>
  type === 'color' ? colorToCss(value as ColorValue) : formatValue(type, value)

/** A variable without a token as an addition, if Accord can tell its type and read its value. */
function addition(v: SurfaceVariable): { path: string; type: TokenType; value: unknown } | undefined {
  const type = designTokenType({ name: v.name, value: v.value })
  if (!type) return undefined
  const value = toTokenValue({ type } as Token, v.value)
  const path = designPath({ name: v.name }, type)
  // Only what the register could hold: an invalid value (a font weight of 0) is not a proposal.
  if (value === undefined || path.length === 0 || validateValue(type, value).length > 0) return undefined
  return { path: path.join('.'), type, value }
}

/** Build the proposal for what the tool changed since its last sync. Undefined when there is nothing to decide. */
export async function proposeFromSurface(input: {
  source: 'figma' | 'pen'
  status: VariableSurfaceStatus
  register: Register
  now?: Date
}): Promise<SurfaceProposal | undefined> {
  const { register, source } = input
  // Changes on the register side are not the tool's proposal: the tool simply has not caught up yet.
  // Without a last sync nobody can tell who changed what, so those are routed like conflicts.
  const items: DriftItem[] = input.status.items
    .filter((i) => i.origin !== 'register')
    .map((i) => (i.origin === 'unknown' ? { ...i, origin: 'conflict' as const } : i))
  /** Identity of a change: its path and, for a value in a context, the context. */
  const keyOf = (op: ChangeOp) =>
    op.kind === 'token.value_changed' && op.context ? `${op.path}@${contextLabel(op.context)}` : op.path
  const unknown = new Set(input.status.items.filter((i) => i.origin === 'unknown').map((i) => keyOf(i.op)))
  const added: { item: DriftItem; variable: string }[] = []
  for (const v of input.status.unmapped) {
    const a = addition(v)
    if (!a || register.tokens.has(a.path) || added.some((x) => x.item.op.path === `tokens.${a.path}`))
      continue
    const op: ChangeOp = {
      kind: 'token.added',
      path: `tokens.${a.path}`,
      after: { type: a.type, value: a.value },
    }
    added.push({ item: { op, origin: 'surface', classification: classify(op) }, variable: v.name })
  }
  // An alias that only follows its target (brand → blue.600, both changed alike) is not a change of its own.
  const after = new Map(
    items.flatMap((i) =>
      i.op.kind === 'token.value_changed' ? [[keyOf(i.op), JSON.stringify(i.op.after)]] : [],
    ),
  )
  const follows = (i: DriftItem) => {
    if (i.op.kind !== 'token.value_changed') return false
    const op = i.op
    const tokens = op.context ? tokensInContext(register, op.context) : register.tokens
    const target = tokens.get(op.path.slice(7))?.aliasOf
    if (target === undefined) return false
    const targetKey = keyOf({ ...op, path: `tokens.${target}` })
    // In a context the target may have changed in the default context only (it has no own value there):
    // the alias follows that change just the same.
    const targetAfter = after.get(targetKey) ?? after.get(`tokens.${target}`)
    return targetAfter !== undefined && targetAfter === after.get(keyOf(op))
  }
  const all = [...items.filter((i) => !follows(i)), ...added.map((a) => a.item)]
  if (all.length === 0) return undefined

  const evaluation = await evaluate({
    register,
    change: { source, intent: 'proposal', items: all, literals: [] },
  })
  const owners = new Map(evaluation.items.map((i) => [i.item.op.path, i.owner]))
  const changes: SurfaceChange[] = []
  for (const item of all) {
    const op = item.op
    const token = op.path.replace(/^tokens\./, '')
    const origin = unknown.has(keyOf(op)) ? 'unknown' : item.origin === 'conflict' ? 'conflict' : 'surface'
    const owner = owners.get(op.path) ?? 'register'
    const context = op.kind === 'token.value_changed' && op.context ? contextLabel(op.context) : undefined
    if (op.kind === 'token.value_changed' && context && op.fallback === 'after')
      // The tool has no own value there any more: the decision is whether the register's one goes too.
      changes.push({
        token,
        kind: 'remove',
        type: op.type,
        before: css(op.type, op.before),
        origin,
        owner,
        context,
      })
    else if (op.kind === 'token.value_changed')
      changes.push({
        token,
        kind: 'change',
        type: op.type,
        before: css(op.type, op.before),
        after: css(op.type, op.after),
        origin,
        owner,
        ...(context ? { context } : {}),
      })
    else if (op.kind === 'token.removed')
      changes.push({
        token,
        kind: 'remove',
        type: op.before.type,
        before: css(op.before.type, op.before.value),
        origin,
        owner,
      })
    else if (op.kind === 'token.added')
      changes.push({
        token,
        kind: 'new',
        type: op.after.type,
        after: css(op.after.type, op.after.value),
        origin,
        owner,
        variable: added.find((a) => a.item.op === op)?.variable,
      })
  }

  const grouped = new Map<string, SurfaceProposal['violations'][number]>()
  for (const v of evaluation.items.flatMap((i) => i.violations)) {
    const value = String(v.detail.value ?? v.at)
    const key = `${v.decisionId}|${value}`
    const entry = grouped.get(key) ?? {
      decision: v.decisionId,
      level: v.level,
      rule: v.rule,
      why: v.why,
      value,
      nearest: v.replacement,
      count: 0,
    }
    entry.count++
    grouped.set(key, entry)
  }

  // A change on an alias in the default context means pointing it elsewhere: the register's structure, not a
  // value the tool owns. Never automatic, even when the evaluation found nothing else.
  const repointed = changes.filter(
    (c) => c.kind === 'change' && !c.context && register.tokens.get(c.token)?.aliasOf !== undefined,
  )
  let route = evaluation.route
  let decider = evaluation.decider
  const reasons = evaluation.reasons.map((r) => ({ code: r.code, at: r.at }))
  if (repointed.length > 0 && route === 'auto') {
    route = 'owner'
    decider = 'register'
    reasons.unshift(...repointed.map((c) => ({ code: 'register_owned' as const, at: `tokens.${c.token}` })))
  }

  const now = input.now ?? new Date()
  // The same changes give the same id, so proposing twice does not pile up proposals.
  const hash = createHash('sha256').update(JSON.stringify(changes)).digest('hex').slice(0, 8)
  return {
    id: `P-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${source}-${hash}`,
    source,
    createdAt: now.toISOString(),
    route,
    decider,
    reasons: reasons.filter((r) => r.code !== 'safe' || route === 'auto'),
    changes,
    violations: [...grouped.values()],
  }
}

/** Write the proposal into the register (`proposals/`); with `branch`, on a new git branch, never on main. */
export async function saveSurfaceProposal(
  proposal: SurfaceProposal,
  input: { root: string; registerDir: string; branch: boolean },
): Promise<{ file: string; branch?: string | undefined }> {
  const file = join(input.registerDir, 'proposals', `${proposal.id}.json`)
  let branch: string | undefined
  if (input.branch) {
    branch = `accord/${proposal.id.toLowerCase()}`
    await createBranch(input.root, branch)
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`)
  if (branch) {
    await git(input.root, ['add', relative(input.root, file)])
    await git(input.root, ['commit', '-m', `accord: proposal ${proposal.id} from ${proposal.source}`])
  }
  return { file, branch }
}
