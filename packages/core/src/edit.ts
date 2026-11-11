import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  parseTree,
} from 'jsonc-parser'
import { type ChangeOp, diffSnapshots } from './diff/diff.js'
import { snapshotFromRegister } from './diff/snapshot.js'
import type { TokenType } from './dtcg/types.js'
import { validateValue } from './dtcg/validate.js'
import { hasErrors, type Issue } from './issues.js'
import { contextFile, RESOLVER_FILE } from './modes/resolver.js'
import { joinPath, splitPath } from './paths.js'
import { buildRegister, type Register, type RegisterFile } from './register.js'

/** A change to the register's tokens, decided by a person (an accepted proposal). */
export type TokenEdit =
  /**
   * New `$value` for an existing token. With `context` (e.g. `dark`), its own value in that context: written to
   * the context's file under `modes/` (created, and added to resolver.json, when the context has none yet).
   */
  | { kind: 'set'; path: string; value: unknown; context?: string | undefined }
  /** Remove a token's own value in a context; it falls back to the default value there. A person's decision. */
  | { kind: 'unset'; path: string; context: string }
  /** A new token. Without `file` it goes into the file of its closest existing group. */
  | {
      kind: 'add'
      path: string
      type: TokenType
      value: unknown
      description?: string | undefined
      /** `$extensions` to keep, e.g. a renamed token's links to its CSS variable and Figma variable. */
      extensions?: Record<string, unknown> | undefined
      file?: string | undefined
    }
  /** Delete a token. Always a person's decision; refused while other tokens point to it. */
  | { kind: 'remove'; path: string }
  /** Point an alias at another token of the same type (`{color.brand}` → `{blue.700}`). */
  | { kind: 'retarget'; path: string; to: string; context?: string | undefined }

export interface EditResult {
  /** Register files whose content changed, with the new content. */
  files: RegisterFile[]
  /** The register after the edits. */
  register: Register
  /** What changed, as diff operations (same shape as every other diff in Accord). */
  ops: ChangeOp[]
}

export class EditError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'EditError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Indentation and line ends as the file already has them, so edits blend in. */
function formatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  '
  return {
    insertSpaces: !indent.startsWith('\t'),
    tabSize: indent.startsWith('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  }
}

/**
 * Text edits that turn `before` into `after` at `path`, as small as possible: unchanged keys and
 * array items are left alone, so a changed hex value is one changed line, not a re-formatted block.
 */
function valueEdits(
  text: string,
  path: JSONPath,
  before: unknown,
  after: unknown,
  options: FormattingOptions,
): string {
  if (isObj(before) && isObj(after)) {
    let out = text
    for (const key of Object.keys(before))
      if (!(key in after))
        out = applyEdits(out, modify(out, [...path, key], undefined, { formattingOptions: options }))
    for (const [key, value] of Object.entries(after))
      out = valueEdits(out, [...path, key], before[key], value, options)
    return out
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    let out = text
    after.forEach((value, i) => {
      out = valueEdits(out, [...path, i], before[i], value, options)
    })
    return out
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return text
  return applyEdits(text, modify(text, path, after, { formattingOptions: options }))
}

/** File of the closest group that already exists for `path`, e.g. `color.brand.600` → file of `color.brand`. */
function closestGroupFile(register: Register, path: string): string | undefined {
  const segs = splitPath(path)
  for (let i = segs.length - 1; i > 0; i--) {
    const group = register.groups.get(joinPath(segs.slice(0, i)))
    if (group?.file && !group.inherited) return group.file
  }
  return undefined
}

/** Type a new token would inherit from its closest existing group. */
function inheritedType(register: Register, groupSegs: readonly string[]): TokenType | undefined {
  for (let i = groupSegs.length; i > 0; i--) {
    const group = register.groups.get(joinPath(groupSegs.slice(0, i)))
    if (group) return group.effectiveType
  }
  return undefined
}

/**
 * Apply token edits to the register files as text edits: only the edited `$value`s change, and the
 * file keeps its formatting, key order, descriptions and unknown `$extensions`. Refuses edits the
 * register could not hold: unknown, aliased or inherited tokens, invalid values, and anything that
 * leaves the register with errors.
 */
export function applyTokenEdits(
  files: readonly RegisterFile[],
  register: Register,
  edits: readonly TokenEdit[],
): EditResult {
  const texts = new Map<string, string>()
  const text = (file: string, path: string): string => {
    const known = texts.get(file) ?? files.find((f) => f.path === file)?.content
    if (known === undefined) throw new EditError(`token file ${file} not found`, path)
    return known
  }
  const modes = register.modes
  /** Context files created by these edits (a context that had no file yet). */
  const contextFiles = new Map<string, string>()
  const fileOfContext = (context: string, path: string): string => {
    const existing = modes?.files.get(context)?.[0] ?? contextFiles.get(context)
    if (existing) return existing
    const file = contextFile(context, modes?.modifier)
    if (!texts.has(file) && !files.some((f) => f.path === file)) texts.set(file, '{}\n')
    const resolver = text(RESOLVER_FILE, path)
    const sources = (
      JSON.parse(resolver) as { modifiers?: Record<string, { contexts?: Record<string, unknown[]> }> }
    ).modifiers?.[modes?.modifier ?? '']?.contexts?.[context]
    texts.set(
      RESOLVER_FILE,
      applyEdits(
        resolver,
        modify(
          resolver,
          ['modifiers', modes?.modifier ?? '', 'contexts', context, sources?.length ?? 0],
          { $ref: file },
          {
            formattingOptions: formatting(resolver),
            isArrayInsertion: true,
          },
        ),
      ),
    )
    contextFiles.set(context, file)
    return file
  }

  const checkValue = (type: TokenType, edit: TokenEdit & { value: unknown }) => {
    const problems = validateValue(type, edit.value)
    if (problems.length > 0)
      throw new EditError(`invalid value for ${edit.path}: ${problems.join('; ')}`, edit.path)
  }

  for (const edit of edits) {
    const context =
      edit.kind === 'unset' ||
      ((edit.kind === 'set' || edit.kind === 'retarget') && edit.context !== undefined)
        ? edit.context
        : undefined
    if (context !== undefined && context !== modes?.default) {
      if (!modes?.contexts.includes(context))
        throw new EditError(`the register has no context ${context}`, edit.path)
      const token = register.tokens.get(edit.path)
      if (!token) throw new EditError(`token ${edit.path} does not exist`, edit.path)
      if (token.inheritedFrom !== undefined)
        throw new EditError(
          `token ${edit.path} is inherited from ${token.inheritedFrom}; edit that one`,
          edit.path,
        )
      const own = modes.own.get(context)?.get(edit.path)
      const segs = splitPath(edit.path)
      if (edit.kind === 'unset') {
        if (!own) throw new EditError(`${edit.path} has no ${context} value of its own`, edit.path)
        texts.set(own, removeAt(text(own, edit.path), segs))
        continue
      }
      if (edit.kind === 'retarget') {
        // The context's own value points at another token there (`{gray.50}` → `{gray.100}`), never a literal.
        const target = register.tokens.get(edit.to)
        if (!target || target.type !== token.type)
          throw new EditError(`${edit.to} is no ${token.type} token to point ${edit.path} at`, edit.path)
        const file = own ?? fileOfContext(context, edit.path)
        const current = text(file, edit.path)
        texts.set(
          file,
          applyEdits(
            current,
            modify(current, [...segs, '$value'], `{${edit.to}}`, { formattingOptions: formatting(current) }),
          ),
        )
        continue
      }
      if (edit.kind !== 'set') continue
      checkValue(token.type, edit)
      const file = own ?? fileOfContext(context, edit.path)
      const current = text(file, edit.path)
      const at = [...segs, '$value']
      const before = findNodeAtLocation(parseTree(current) as Node, at)
      texts.set(
        file,
        before
          ? valueEdits(current, at, getNodeValue(before), edit.value, formatting(current))
          : applyEdits(current, modify(current, at, edit.value, { formattingOptions: formatting(current) })),
      )
      continue
    }
    if (edit.kind === 'unset')
      throw new EditError('the default context has no own values to remove', edit.path)
    if (edit.kind === 'remove') {
      const token = register.tokens.get(edit.path)
      if (!token) throw new EditError(`token ${edit.path} does not exist`, edit.path)
      if (token.inheritedFrom !== undefined)
        throw new EditError(`token ${edit.path} is inherited from ${token.inheritedFrom}`, edit.path)
      const users = [...register.tokens.values()].filter((t) => t.aliasOf === edit.path).map((t) => t.path)
      if (users.length > 0)
        throw new EditError(`${users.join(', ')} still point to ${edit.path}; change them first`, edit.path)
      const segs = splitPath(edit.path)
      // Remove the token, then every group it leaves without tokens; its own values in contexts go with it.
      texts.set(token.file, removeAt(text(token.file, edit.path), segs))
      for (const own of modes?.own.values() ?? []) {
        const file = own.get(edit.path)
        if (file) texts.set(file, removeAt(text(file, edit.path), segs))
      }
      continue
    }
    if (edit.kind === 'retarget') {
      const token = register.tokens.get(edit.path)
      const target = register.tokens.get(edit.to)
      if (!token) throw new EditError(`token ${edit.path} does not exist`, edit.path)
      if (token.aliasOf === undefined) throw new EditError(`token ${edit.path} is not an alias`, edit.path)
      if (token.inheritedFrom !== undefined)
        throw new EditError(`token ${edit.path} is inherited from ${token.inheritedFrom}`, edit.path)
      if (!target || target.type !== token.type)
        throw new EditError(`${edit.to} is no ${token.type} token to point ${edit.path} at`, edit.path)
      const current = text(token.file, edit.path)
      const at = [...splitPath(edit.path), '$value']
      texts.set(
        token.file,
        applyEdits(current, modify(current, at, `{${edit.to}}`, { formattingOptions: formatting(current) })),
      )
      continue
    }
    if (edit.kind === 'set') {
      const token = register.tokens.get(edit.path)
      if (!token) throw new EditError(`token ${edit.path} does not exist`, edit.path)
      if (token.inheritedFrom !== undefined)
        throw new EditError(
          `token ${edit.path} is inherited from ${token.inheritedFrom}; edit that one`,
          edit.path,
        )
      if (token.aliasOf !== undefined)
        throw new EditError(`token ${edit.path} is an alias of ${token.aliasOf}; edit that one`, edit.path)
      checkValue(token.type, edit)
      const current = text(token.file, edit.path)
      const at = [...splitPath(edit.path), '$value']
      const before = findNodeAtLocation(parseTree(current) as Node, at)
      if (!before) throw new EditError(`token ${edit.path} not found in ${token.file}`, edit.path)
      texts.set(token.file, valueEdits(current, at, getNodeValue(before), edit.value, formatting(current)))
      continue
    }

    if (register.tokens.has(edit.path) || register.groups.has(edit.path))
      throw new EditError(`${edit.path} already exists`, edit.path)
    checkValue(edit.type, edit)
    const file = edit.file ?? closestGroupFile(register, edit.path)
    if (!file) throw new EditError(`no token file for ${edit.path}; name one`, edit.path)
    const segs = splitPath(edit.path)
    const current = text(file, edit.path)
    const tree = parseTree(current) as Node
    for (let i = 1; i < segs.length; i++) {
      const node = findNodeAtLocation(tree, segs.slice(0, i))
      if (node && (node.type !== 'object' || findNodeAtLocation(node, ['$value'])))
        throw new EditError(`${edit.path} would go inside the token ${segs[i - 1]}`, edit.path)
    }
    const token: Obj = {}
    if (inheritedType(register, segs.slice(0, -1)) !== edit.type) token.$type = edit.type
    token.$value = edit.value
    if (edit.description !== undefined) token.$description = edit.description
    if (edit.extensions !== undefined && Object.keys(edit.extensions).length > 0)
      token.$extensions = edit.extensions
    texts.set(
      file,
      applyEdits(current, modify(current, segs, token, { formattingOptions: formatting(current) })),
    )
  }

  const nextFiles = files.map((f) => {
    const content = texts.get(f.path)
    return content === undefined ? f : { ...f, content }
  })
  for (const [path, content] of texts)
    if (!files.some((f) => f.path === path)) nextFiles.push({ path, content })
  const next = buildRegister(nextFiles)
  const before = new Set(register.issues.map(issueKey))
  const introduced = next.issues.filter((i) => !before.has(issueKey(i)))
  if (hasErrors(introduced))
    throw new EditError(
      `the edits leave the register invalid: ${introduced.map((i) => i.message).join('; ')}`,
      edits[0]?.path ?? '',
    )

  const original = new Map<string, string>(files.map((f) => [f.path, f.content]))
  return {
    files: nextFiles.filter((f) => original.get(f.path) !== f.content),
    register: next,
    ops: diffSnapshots(snapshotFromRegister(register), snapshotFromRegister(next)),
  }
}

const issueKey = (i: Issue) => `${i.severity}|${i.code}|${i.file ?? ''}|${i.message}`

/** Remove the node at `segs`, then every group it leaves without tokens. */
function removeAt(text: string, segs: readonly string[]): string {
  let at = segs.length
  let out = applyEdits(text, modify(text, [...segs], undefined, { formattingOptions: formatting(text) }))
  while (--at > 0) {
    const group = findNodeAtLocation(parseTree(out) as Node, segs.slice(0, at))
    const keys = group?.children?.map((c) => c.children?.[0]?.value as string) ?? []
    if (!group || keys.some((k) => !k.startsWith('$') || k === '$root')) break
    out = applyEdits(out, modify(out, segs.slice(0, at), undefined, { formattingOptions: formatting(out) }))
  }
  return out
}
