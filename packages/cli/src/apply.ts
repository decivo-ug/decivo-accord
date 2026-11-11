import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { cssToTokenValue } from '@decivo/accord-adapter-code'
import { type Evaluation, evaluate } from '@decivo/accord-checks'
import {
  applyTokenEdits,
  type ChangeOp,
  type ColorValue,
  classify,
  colorToCss,
  contextLabel,
  cssToColor,
  type EditResult,
  formatValue,
  LOCK_FILE,
  lockedSnapshot,
  parseLock,
  type Register,
  serializeLock,
  TOKEN_TYPES,
  type TokenEdit,
  type TokenType,
  tokensInContext,
  withLockedSnapshot,
} from '@decivo/accord-core'
import { readValidRegister } from '@decivo/accord-core/node'
import { type PlannedOutput, planExport } from '@decivo/accord-generators'
import { z } from 'zod'
import type { HandoffProposal } from './claude-design.js'
import { createBranch, git } from './git.js'
import type { SurfaceProposal } from './surface-proposal.js'
import { writeOutput } from './write.js'

export const RESOLUTION_SCHEMA = 'accord.resolution/1'

/**
 * A person's decision on a proposal, wherever it was made (the command line, the web app, or any review tool
 * that writes a resolution file).
 * Accord turns it into a register change; it never decides on its own.
 */
export const ResolutionSchema = z
  .object({
    schema: z.literal(RESOLUTION_SCHEMA),
    proposal: z.string().regex(/^P-[A-Za-z0-9-]+$/, 'proposal id like P-20261012-landing'),
    /** adopt: the draft wins and the register changes. reset: the register stays. reject: drop the proposal. */
    option: z.enum(['adopt', 'reset', 'reject']),
    items: z
      .array(
        z
          .object({
            /** Register token path without the `tokens.` prefix, e.g. `color.brand.600`. */
            token: z.string().min(1),
            /** CSS value in the token's type, e.g. `#4a7b9a`, `8px`, `700`. Not for `remove`. */
            value: z.string().min(1).optional(),
            /**
             * change: an existing token gets the value. new: a token is created (the person chose its name).
             * remove: the token is deleted (refused while other tokens point to it).
             */
            kind: z.enum(['change', 'new', 'remove']),
            /** Type of a new token (default colour); a changed token keeps its type. */
            type: z.enum(TOKEN_TYPES).optional(),
            description: z.string().optional(),
            /**
             * The context the item is about, e.g. `dark`: change sets the token's value there, remove takes the
             * token's own value there away (it falls back to the default). Absent: the default context.
             */
            context: z.string().min(1).optional(),
          })
          .refine((i) => i.kind === 'remove' || i.value !== undefined, {
            message: 'change and new need a value',
            path: ['value'],
          })
          .refine((i) => i.kind !== 'new' || i.context === undefined, {
            message: 'a new token is created in the default context; set its other values with change',
            path: ['context'],
          }),
      )
      .default([]),
    by: z.string().min(1),
    at: z.iso.datetime({ offset: true }),
    /** Where the decision was made, free text, e.g. `review:123`. */
    ref: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((r) => (r.option === 'adopt') === r.items.length > 0, {
    message: 'adopt needs at least one item; reset and reject take none',
    path: ['items'],
  })

export type Resolution = z.infer<typeof ResolutionSchema>

/** What Accord records on the proposal once it is decided. The proposal file stays as history. */
export type ProposalResolution = Omit<Resolution, 'schema' | 'proposal'>

export class ApplyError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'already_resolved'
      | 'invalid_value'
      | 'invalid_edit'
      | 'must_violation'
      | 'stale'
      | 'dirty',
    message: string,
  ) {
    super(message)
    this.name = 'ApplyError'
  }
}

export interface ApplyPlan {
  proposal: (HandoffProposal | SurfaceProposal) & { resolution?: ProposalResolution }
  resolution: Resolution
  /** Register path of the proposal file, e.g. `.accord/proposals/P-….json` (relative to the root). */
  proposalFile: string
  /** Token files that change, relative to the root. */
  tokenFiles: { path: string; content: string }[]
  ops: ChangeOp[]
  evaluation?: Evaluation | undefined
  /** Generated files that change (DESIGN.md, AGENTS.md, CSS …). */
  outputs: PlannedOutput[]
  /** The proposal file with its resolution. */
  proposalContent: string
  /**
   * `surfaces.lock.json` with the adopted values recorded for the proposal's surface (Figma, Pencil): the
   * tool and the register agree on them now, so the next change there is the tool's own, not a conflict.
   */
  lockFile?: { path: string; content: string } | undefined
}

const posix = (path: string) => path.split('\\').join('/')

/** Turn the resolution's items into token edits; values are stored the way the register stores them. */
function toEdits(
  resolution: Resolution,
  register: Register,
  /** The tool's name for a new token's variable (Figma, Pencil), to keep its link after a rename. */
  variable?: { source: string; of: (token: string) => string | undefined },
): TokenEdit[] {
  // A removed token and a new one with the same type and value are a rename (Figma renamed the variable):
  // the new token keeps the old one's description and links (CSS variable, Figma id) instead of losing them.
  const removed = resolution.items
    .filter((i) => i.kind === 'remove' && (i.context === undefined || i.context === register.modes?.default))
    .map((i) => register.tokens.get(i.token))
    .filter((t): t is NonNullable<typeof t> => t !== undefined && t.value !== undefined)
  const typeOf = (item: Resolution['items'][number]): TokenType =>
    item.kind === 'change' ? (register.tokens.get(item.token)?.type ?? 'color') : (item.type ?? 'color')
  const cssOf = (item: Resolution['items'][number]) => {
    const type = typeOf(item)
    const css = item.value as string
    const value = type === 'color' ? cssToColor(css) : cssToTokenValue(type, css)
    return value === undefined ? undefined : show(type, value)
  }
  const added = resolution.items.filter((i) => i.kind === 'new')
  // Only a one-to-one pair is a rename: one removed token and one new token share type and value. With two
  // candidates on either side nobody can tell which is which, and both would inherit the same links.
  const renamedFrom = (type: TokenType, css: string) => {
    const match = removed.filter((t) => t.type === type && show(t.type, t.value) === css)
    const twins = added.filter((i) => typeOf(i) === type && cssOf(i) === css)
    return match.length === 1 && twins.length === 1 ? match[0] : undefined
  }
  return resolution.items.map((item): TokenEdit => {
    if (item.kind === 'remove' && item.context !== undefined && item.context !== register.modes?.default)
      return { kind: 'unset', path: item.token, context: item.context }
    if (item.kind === 'remove') return { kind: 'remove', path: item.token }
    const type: TokenType =
      item.kind === 'change' ? (register.tokens.get(item.token)?.type ?? 'color') : (item.type ?? 'color')
    const css = item.value as string
    const value = type === 'color' ? cssToColor(css) : cssToTokenValue(type, css)
    if (value === undefined)
      throw new ApplyError(
        'invalid_value',
        `${item.token}: "${css}" is not ${type === 'color' ? 'a colour' : `a ${type} value`}`,
      )
    const own = item.context !== undefined && item.context !== register.modes?.default
    const inContext = own ? tokensInContext(register, item.context) : register.tokens
    const aliasOf = item.kind === 'change' ? inContext.get(item.token)?.aliasOf : undefined
    if (aliasOf !== undefined) {
      // An alias gets no value of its own, in any context: it points at the one token that holds the new
      // value there. Writing the colour itself would cut the link for good.
      const holders = [...inContext.values()].filter(
        (t) =>
          t.aliasOf === undefined &&
          t.type === type &&
          t.value !== undefined &&
          show(t.type, t.value) === show(type, value),
      )
      if (holders.length !== 1)
        throw new ApplyError(
          'invalid_edit',
          `${item.token} points to ${aliasOf}; ${holders.length === 0 ? `no token in the register is ${css}` : `${holders.map((h) => h.path).join(', ')} are all ${css}`}. Change ${aliasOf}, or point ${item.token} at one token by hand.`,
        )
      return {
        kind: 'retarget',
        path: item.token,
        to: (holders[0] as { path: string }).path,
        ...(own ? { context: item.context } : {}),
      }
    }
    return item.kind === 'change'
      ? { kind: 'set', path: item.token, value, ...(item.context ? { context: item.context } : {}) }
      : (() => {
          const from = renamedFrom(type, show(type, value))
          const name = variable?.of(item.token)
          const extensions = from?.extensions ? structuredClone(from.extensions) : undefined
          const ids = (extensions?.['de.decivo.accord'] as { ids?: Record<string, string> } | undefined)?.ids
          // The renamed variable is the tool's link now; the CSS variable keeps its name.
          if (ids && name && variable && variable.source in ids) ids[variable.source] = name
          return {
            kind: 'add',
            path: item.token,
            type,
            value,
            description: item.description ?? from?.description,
            extensions,
          }
        })()
  })
}

/**
 * The resolution for a decision taken on the command line (`--proposal … --option … --by …`): adopting
 * a Figma or Pencil proposal takes over exactly its changes. A handoff proposal names no tokens, so its
 * adoption needs a resolution file in which the person names them.
 */
export function resolutionFor(
  proposal: (HandoffProposal | SurfaceProposal) & { resolution?: unknown },
  decision: { option: Resolution['option']; by: string; note?: string | undefined; now?: Date },
): Resolution {
  const changes = 'changes' in proposal ? proposal.changes : []
  if (decision.option === 'adopt' && changes.length === 0)
    throw new ApplyError(
      'invalid_edit',
      `proposal ${proposal.id} names no tokens; decide it with --resolution`,
    )
  return ResolutionSchema.parse({
    schema: RESOLUTION_SCHEMA,
    proposal: proposal.id,
    option: decision.option,
    items:
      decision.option === 'adopt'
        ? changes.map((c) => ({
            token: c.token,
            kind: c.kind,
            ...(c.kind === 'remove' ? {} : { value: c.after, type: c.type }),
            ...('context' in c && c.context ? { context: c.context } : {}),
          }))
        : [],
    by: decision.by,
    at: (decision.now ?? new Date()).toISOString(),
    ...(decision.note ? { note: decision.note } : {}),
  })
}

/** The surface's lock after an adoption: the adopted values are what the tool and the register share now. */
async function lockAfterAdopt(
  proposal: ApplyPlan['proposal'],
  resolution: Resolution,
  register: Register,
  registerDir: string,
  root: string,
): Promise<ApplyPlan['lockFile']> {
  const surface = proposal.source === 'figma' || proposal.source === 'pen' ? proposal.source : undefined
  if (!surface || resolution.option !== 'adopt') return undefined
  const path = join(registerDir, LOCK_FILE)
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  const lock = parseLock(raw)
  const snapshot = lockedSnapshot(lock, surface)
  if (!snapshot) return undefined
  const modifier = register.modes?.modifier
  for (const item of resolution.items) {
    const own = item.context !== undefined && item.context !== register.modes?.default
    const key = own && modifier ? `${modifier}=${item.context}` : undefined
    let tokens = snapshot.tokens
    if (key) {
      snapshot.contexts ??= new Map()
      tokens = snapshot.contexts.get(key) ?? new Map()
      snapshot.contexts.set(key, tokens)
    }
    if (item.kind === 'remove') {
      tokens.delete(item.token)
      continue
    }
    const type: TokenType =
      item.kind === 'change' ? (register.tokens.get(item.token)?.type ?? 'color') : (item.type ?? 'color')
    const css = item.value as string
    const value = type === 'color' ? cssToColor(css) : cssToTokenValue(type, css)
    if (value !== undefined) tokens.set(item.token, { type, value })
  }
  const at = lock.surfaces[surface]?.synced_at
  const next = withLockedSnapshot(lock, surface, snapshot, at ? new Date(at) : new Date())
  return { path: posix(relative(root, path)), content: serializeLock(next) }
}

/**
 * A proposal was made against the register as it was then. If a token it changes has moved on since
 * (another decision, a hand edit), adopting it would silently undo that: the proposal is outdated and a
 * new one has to be made from the current state (`figma propose`, `pen propose`).
 */
/** One token a proposal changes that has moved on since it was made. */
export interface StaleChange {
  token: string
  context?: string | undefined
  /** `changed`: another value now; `gone`: no longer in the register; `exists`: a new token that exists now. */
  reason: 'changed' | 'gone' | 'exists'
  /** The register value the proposal was made against, and the one now. */
  before?: string | undefined
  now?: string | undefined
}

/** The tokens of a proposal that no longer hold the value it was made against (empty: still current). */
export function staleChanges(proposal: ApplyPlan['proposal'], register: Register): StaleChange[] {
  const changes = 'changes' in proposal ? proposal.changes : []
  const stale: StaleChange[] = []
  for (const c of changes) {
    const token = tokensInContext(register, c.context).get(c.token)
    const where = { token: c.token, ...(c.context ? { context: c.context } : {}) }
    if (c.kind === 'new') {
      if (token) stale.push({ ...where, reason: 'exists' })
      continue
    }
    if (!token) {
      stale.push({ ...where, reason: 'gone', before: c.before })
      continue
    }
    const now = token.value === undefined ? undefined : show(token.type, token.value)
    if (c.before !== undefined && now !== c.before)
      stale.push({ ...where, reason: 'changed', before: c.before, now })
  }
  return stale
}

export function assertCurrent(proposal: ApplyPlan['proposal'], register: Register): void {
  const stale = staleChanges(proposal, register).map((c) => {
    const where = `${c.token}${c.context ? ` (${c.context})` : ''}`
    return c.reason === 'exists'
      ? `${where} exists now`
      : c.reason === 'gone'
        ? `${where} is no longer in the register`
        : `${where} is ${c.now} now, not ${c.before}`
  })
  if (stale.length > 0) throw new ApplyError('stale', stale.join('; '))
}

/**
 * Everything `accord apply` would change, without changing it. Refuses an unknown or already decided
 * proposal, and an adoption that breaks a `must` rule: a person may decide a breaking change or a new
 * colour, but a rule only changes through its own proposal.
 */
export async function planApply(input: {
  root: string
  registerDir: string
  resolution: Resolution
}): Promise<ApplyPlan> {
  const root = resolve(input.root)
  const { resolution } = input
  const proposalPath = join(input.registerDir, 'proposals', `${resolution.proposal}.json`)
  const raw = await readFile(proposalPath, 'utf8').catch(() => undefined)
  if (raw === undefined) throw new ApplyError('not_found', `proposal ${resolution.proposal} not found`)
  const proposal = JSON.parse(raw) as ApplyPlan['proposal']
  if (proposal.resolution)
    throw new ApplyError(
      'already_resolved',
      `proposal ${proposal.id} was already decided (${proposal.resolution.option} by ${proposal.resolution.by})`,
    )

  const { files, register } = await readValidRegister(input.registerDir)
  if (resolution.option === 'adopt') assertCurrent(proposal, register)

  let edited: EditResult = { files: [], register, ops: [] }
  let evaluation: Evaluation | undefined
  if (resolution.option === 'adopt') {
    try {
      const variable =
        'changes' in proposal
          ? {
              source: proposal.source,
              of: (token: string) => proposal.changes.find((c) => c.token === token)?.variable,
            }
          : undefined
      edited = applyTokenEdits(files, register, toEdits(resolution, register, variable))
    } catch (error) {
      if (error instanceof ApplyError) throw error
      throw new ApplyError('invalid_edit', (error as Error).message)
    }
    evaluation = await evaluate({
      register: edited.register,
      change: {
        source: proposal.source,
        intent: 'proposal',
        items: edited.ops.map((op) => ({ op, origin: 'surface', classification: classify(op) })),
        literals: [],
      },
    })
    // "Outside the scale" on a token the person named is the decision itself (a new colour becomes part of the
    // register). Every other must rule still holds, e.g. contrast: a decision changes values, not rules.
    const named = new Set(resolution.items.map((i) => `tokens.${i.token}`))
    const broken = evaluation.items
      .flatMap((i) => i.violations)
      .filter((v) => v.level === 'must' && !(v.code === 'outside_scale' && named.has(v.at)))
    if (broken.length > 0)
      throw new ApplyError(
        'must_violation',
        broken.map((v) => `${v.at}: ${v.decisionId} – ${v.rule}`).join('; '),
      )
  }

  const registerRel = posix(relative(root, input.registerDir)) || '.'
  const { schema: _schema, proposal: _id, ...decided } = resolution
  const proposalContent = `${JSON.stringify({ ...proposal, resolution: decided }, null, 2)}\n`
  // The export already sees the decided proposal, so the changelog lists this decision.
  const proposalRegisterPath = `proposals/${resolution.proposal}.json`
  const outputs = (
    await planExport({
      register: edited.register,
      files: files.map((f) =>
        f.path === proposalRegisterPath
          ? { ...f, content: proposalContent }
          : (edited.files.find((e) => e.path === f.path) ?? f),
      ),
      registerDir: registerRel,
      read: (path) => readFile(join(root, path), 'utf8').catch(() => undefined),
    })
  ).filter((o) => o.changed)

  const lockFile = await lockAfterAdopt(proposal, resolution, register, input.registerDir, root)

  return {
    proposal,
    resolution,
    lockFile,
    proposalFile: posix(relative(root, proposalPath)),
    tokenFiles: edited.files.map((f) => ({ path: `${registerRel}/${f.path}`, content: f.content })),
    ops: edited.ops,
    evaluation,
    outputs,
    proposalContent,
  }
}

export interface ChangeLine {
  /** Token path without the `tokens.` prefix. */
  path: string
  /** The context the value is in (`dark`); absent for the default context. */
  context?: string | undefined
  /** The context's own value is removed; the default value applies there. */
  unset?: boolean | undefined
  /** Value before, absent for a new token. */
  before?: string | undefined
  /** Value after, absent for a removed token. */
  after?: string | undefined
  /** New path of a renamed token (without `tokens.`). */
  to?: string | undefined
}

const show = (type: Parameters<typeof formatValue>[0], value: unknown) =>
  type === 'color' ? colorToCss(value as ColorValue) : formatValue(type, value)

/** The token changes as before/after values, for the terminal and the commit message. */
export function changeLines(ops: readonly ChangeOp[]): ChangeLine[] {
  return ops.flatMap((op): ChangeLine[] => {
    const path = op.path.replace(/^tokens\./, '')
    if (op.kind === 'token.value_changed' && op.context)
      return [
        {
          path,
          context: contextLabel(op.context),
          before: show(op.type, op.before),
          after: show(op.type, op.after),
          ...(op.fallback === 'after' ? { unset: true } : {}),
        },
      ]
    if (op.kind === 'token.value_changed')
      return [{ path, before: show(op.type, op.before), after: show(op.type, op.after) }]
    if (op.kind === 'token.added') return [{ path, after: show(op.after.type, op.after.value) }]
    if (op.kind === 'token.removed') return [{ path, before: show(op.before.type, op.before.value) }]
    if (op.kind === 'token.alias_changed')
      return [
        {
          path,
          before: op.before ? `{${op.before}}` : '(value)',
          after: op.after ? `{${op.after}}` : '(value)',
        },
      ]
    if (op.kind === 'token.renamed') {
      const value = show(op.token.type, op.token.value)
      return [{ path, to: op.to.replace(/^tokens\./, ''), before: value, after: value }]
    }
    return []
  })
}

/**
 * Write the plan: token files, generated files and the decided proposal. With `branch`, all of it is
 * committed on `accord/apply-<id>` (never on main); with `push`, the branch goes to origin.
 */
export async function writeApply(
  plan: ApplyPlan,
  input: { root: string; branch: boolean; push: boolean },
): Promise<{ files: string[]; branch?: string | undefined }> {
  const root = resolve(input.root)
  const branch = input.branch ? `accord/apply-${plan.proposal.id.toLowerCase()}` : undefined
  if (branch) {
    // The commit says "decided by …": it may only hold that decision. The plan was made from the register
    // in the working tree, so uncommitted edits there would ride along unreviewed (and show up in the
    // generated files). Proposals and generated files are fine: they are written from the plan anyway.
    const registerRel = posix(dirname(dirname(plan.proposalFile)))
    const own = (path: string) =>
      path.startsWith(`${registerRel}/proposals/`) || path.startsWith(`${registerRel}/generated/`)
    const inRepo = !registerRel.startsWith('..') && !isAbsolute(registerRel)
    // git names paths from the repository's top; the project may be a folder inside it (a monorepo).
    // `-z` keeps names with spaces or umlauts unquoted.
    const prefix = inRepo ? (await git(root, ['rev-parse', '--show-prefix'])).trim() : ''
    const status = inRepo
      ? await git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', registerRel])
      : ''
    const dirty: string[] = []
    const entries = status.split('\0')
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as string
      if (entry.length < 4) continue
      // A rename or copy is followed by its old name as a separate entry.
      if (/[RC]/.test(entry.slice(0, 2))) i++
      const path = entry.slice(3)
      const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path
      if (!own(rel)) dirty.push(rel)
    }
    if (dirty.length > 0) throw new ApplyError('dirty', dirty.join(', '))
    await createBranch(root, branch)
  }

  const own = [
    ...plan.tokenFiles,
    { path: plan.proposalFile, content: plan.proposalContent },
    ...(plan.lockFile ? [plan.lockFile] : []),
  ]
  const writes = [...own, ...plan.outputs.map((o) => ({ path: o.path, content: o.content }))]
  for (const file of own) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.content)
  }
  for (const output of plan.outputs) await writeOutput(root, output.path, output.content)
  const paths = writes.map((w) => w.path)

  if (branch) {
    const r = plan.resolution
    const subject = `accord: ${r.option} ${plan.proposal.id} – decided by ${r.by}${r.ref ? ` (${r.ref})` : ''}`
    const body = [
      ...(r.note ? [r.note, ''] : []),
      ...changeLines(plan.ops).map((c) =>
        c.to
          ? `${c.path} -> ${c.to} (renamed, ${c.after})`
          : `${c.path}${c.context ? ` (${c.context})` : ''}: ${c.before ?? '(new)'} -> ${c.unset ? '(own value removed)' : (c.after ?? '(removed)')}`,
      ),
    ].join('\n')
    await git(root, ['add', '--', ...paths])
    await git(root, ['commit', '-m', subject, ...(body ? ['-m', body] : []), '--', ...paths])
    if (input.push) await git(root, ['push', '-u', 'origin', branch])
  }
  return { files: paths, branch }
}
