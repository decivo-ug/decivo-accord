import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { type FigmaExport, readFigmaExports } from '@decivo/accord-adapter-figma'
import { readPenFiles } from '@decivo/accord-adapter-pen'
import { detectSources } from '@decivo/accord-cli'
import { CONFIG_FILE, ConfigSchema } from '@decivo/accord-core'
import { isScalar, parse, parseDocument } from 'yaml'
import { type Project, registerDirOf } from './projects'

/** Surfaces a person can switch on and off on the Connections screen. Code is always compared. */
export type ToolId = 'claude_design' | 'figma' | 'pen'

export const TOOL_IDS: readonly ToolId[] = ['figma', 'pen', 'claude_design']

export const isToolId = (value: unknown): value is ToolId => TOOL_IDS.includes(value as ToolId)

/** A Figma file Accord read: a `.fig` file or a variables export. */
export interface FigmaFile {
  path: string
  format: FigmaExport['format']
  /** Distinct variables (per collection and name, not per mode). */
  variables: number
  modes: string[]
  errors: string[]
}

export interface PenFile {
  path: string
  variables: number
  /** Theme axes defined in the file (e.g. `mode: light, dark`). */
  themes: string[]
  errors: string[]
}

export interface ConnectionsData {
  /** Register directory as the repository sees it (`.accord`). */
  registerDir: string
  /** Config file relative to the repository, for "edit this file" hints. */
  configFile: string
  code: {
    enabled: boolean
    include: string[]
    /** Stylesheets that define the custom properties: configured ones first, then detected ones. */
    css: string[]
    uiDir?: string | undefined
    tokens: { path: string; format: 'dtcg' | 'tokens-studio' }[]
    designMd: string[]
    storybook: boolean
  }
  figma: {
    enabled: boolean
    include: string[]
    defaultMode?: string | undefined
    files: FigmaFile[]
    /** Figma files in the usual places that `include` does not cover. */
    outside: string[]
    error?: string | undefined
  }
  pen: {
    enabled: boolean
    include: string[]
    files: PenFile[]
    outside: string[]
    error?: string | undefined
  }
  claudeDesign: {
    enabled: boolean
    /** Name or id of the Claude Design design-system project, when the config names it. */
    project?: string | undefined
  }
}

const configPath = (project: Project) => join(registerDirOf(project), CONFIG_FILE)

const shown = (root: string, path: string) => {
  const rel = relative(root, path)
  // Inside the project, paths read like in the config and in git: forward slashes, on Windows too.
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel.split('\\').join('/') || '.'
}

const unique = <T>(list: readonly T[]) => [...new Set(list)]

/** What Accord reads from one Figma file, in numbers a person can check against Figma's variables panel. */
export function figmaFile(e: FigmaExport): FigmaFile {
  return {
    path: e.path,
    format: e.format,
    variables: new Set(e.variables.map((v) => `${v.collection ?? ''}/${v.name}`)).size,
    modes: unique(e.variables.map((v) => v.mode).filter((m): m is string => Boolean(m))),
    errors: e.errors,
  }
}

/**
 * What the repository contains for each surface and how `accord.config.yaml` connects it: files found (and
 * those outside the configured paths), whether the surface is on, its paths and Figma's default mode.
 */
export async function getConnections(project: Project): Promise<ConnectionsData> {
  const registerDir = registerDirOf(project)
  const [detected, configText] = await Promise.all([
    detectSources(project.root),
    readFile(configPath(project), 'utf8'),
  ])
  const config = ConfigSchema.parse(parse(configText) ?? { version: 1 })
  const { code, figma, pen, claude_design } = config.surfaces

  const [figmaRead, penRead] = await Promise.all([
    readFigmaExports(project.root, figma.include).then(
      (exports) => ({ files: exports.map(figmaFile) }),
      (error: Error) => ({ files: [] as FigmaFile[], error: error.message }),
    ),
    readPenFiles(project.root, pen.include).then(
      (docs) => ({
        files: docs.map((d) => ({
          path: d.path,
          variables: d.variables.length,
          themes: Object.entries(d.themes).map(([axis, values]) => `${axis}: ${values.join(', ')}`),
          errors: d.errors,
        })),
      }),
      (error: Error) => ({ files: [] as PenFile[], error: error.message }),
    ),
  ])

  const figmaPaths = new Set(figmaRead.files.map((f) => f.path))
  const penPaths = new Set(penRead.files.map((f) => f.path))
  return {
    registerDir: shown(project.root, registerDir),
    configFile: shown(project.root, configPath(project)),
    code: {
      enabled: code.enabled,
      include: code.include,
      css: unique([...code.css, ...detected.css]),
      uiDir: detected.uiDir,
      tokens: detected.tokens,
      designMd: detected.designMd,
      storybook: detected.storybook,
    },
    figma: {
      enabled: figma.enabled,
      include: figma.include,
      defaultMode: figma.default_mode,
      files: figmaRead.files,
      outside: detected.figma.filter((p) => !figmaPaths.has(p)),
      error: 'error' in figmaRead ? figmaRead.error : undefined,
    },
    pen: {
      enabled: pen.enabled,
      include: pen.include,
      files: penRead.files,
      outside: detected.pen.filter((p) => !penPaths.has(p)),
      error: 'error' in penRead ? penRead.error : undefined,
    },
    claudeDesign: { enabled: claude_design.enabled, project: claude_design.project },
  }
}

/** How Accord writes a config it edited: flow lists stay `["a"]`, as people write them. */
const YAML_OUT = { flowCollectionPadding: false } as const

/**
 * The config text with `surfaces.<tool>.enabled` set. Only that one value changes, byte for byte: the
 * rest of the file (comments, quotes, flow lists) stays as the customer wrote it, so a switch that is
 * turned off and on again leaves no diff in `.accord/`. Unchanged text when the value already matches.
 */
export function withToolEnabled(text: string, tool: ToolId, enabled: boolean): string {
  const doc = parseDocument(text)
  const node = doc.getIn(['surfaces', tool, 'enabled'], true)
  if (isScalar(node) && node.range) {
    if (node.value === enabled) return text
    const [start, end] = node.range
    return `${text.slice(0, start)}${String(enabled)}${text.slice(end)}`
  }
  // Without an `enabled` line the surface is off (the schema's default), so "off" changes nothing.
  if (node === undefined && !enabled) return text
  // Otherwise add the line through the document (or replace a value Accord cannot edit in place).
  doc.setIn(['surfaces', tool, 'enabled'], enabled)
  return doc.toString(YAML_OUT)
}

/** Switch a surface on or off in `accord.config.yaml`; nothing is written when it is already so. */
export async function setToolEnabled(project: Project, tool: ToolId, enabled: boolean): Promise<void> {
  if (!isToolId(tool)) throw new Error(`Unknown surface: ${String(tool)}`)
  const path = configPath(project)
  const before = await readFile(path, 'utf8')
  const after = withToolEnabled(before, tool, enabled)
  if (after !== before) await writeFile(path, after)
}

/**
 * Points `surfaces.code.include` at the folders with code Accord found but does not look in yet (the same
 * folders the overview names). Returns those folders; nothing is written when there are none.
 */
export async function includeCodeFolders(project: Project): Promise<string[]> {
  const { code } = await getConnections(project)
  const found = missedCodeFolders(code)
  if (found.length === 0) return []
  const path = configPath(project)
  const doc = parseDocument(await readFile(path, 'utf8'))
  doc.setIn(['surfaces', 'code', 'include'], suggestInclude(code.include, found))
  await writeFile(path, doc.toString(YAML_OUT))
  return found
}

/**
 * Undoes `includeCodeFolders`: drops the patterns that start in exactly these folders. The patterns
 * Accord had before stay, and the list never ends up empty.
 */
export function withoutFolders(include: readonly string[], folders: readonly string[]): string[] {
  const drop = new Set(folders.map((f) => f.replace(/\/+$/, '')))
  const kept = include.filter((p) => !drop.has(globRoot(p)))
  return kept.length > 0 ? kept : [...include]
}

export async function excludeCodeFolders(project: Project, folders: readonly string[]): Promise<string[]> {
  const { code } = await getConnections(project)
  const next = withoutFolders(code.include, folders)
  if (next.length === code.include.length) return []
  const path = configPath(project)
  const doc = parseDocument(await readFile(path, 'utf8'))
  doc.setIn(['surfaces', 'code', 'include'], next)
  await writeFile(path, doc.toString(YAML_OUT))
  return code.include.filter((p) => !next.includes(p)).map(globRoot)
}

/** Folders with stylesheets or the UI kit that the code patterns miss ("app" and "components"). */
export function missedCodeFolders(
  code: Pick<ConnectionsData['code'], 'css' | 'uiDir' | 'include'>,
): string[] {
  return codeOutside([...code.css, ...(code.uiDir ? [code.uiDir] : [])], code.include)
}

/** The fixed folder a glob starts in: `src/**\/*.css` → `src`, `**\/*.pen` → `` (the whole repository). */
export function globRoot(pattern: string): string {
  const parts = pattern.split('/')
  const fixed: string[] = []
  for (const part of parts.slice(0, -1)) {
    if (/[*?[{]/.test(part)) break
    fixed.push(part)
  }
  // A pattern without any wildcard is one exact file: its folder is where it lives.
  return fixed.join('/')
}

/** A glob in plain words: which file endings, and where. Undefined for shapes Accord cannot say simply. */
export type GlobMeaning =
  | { kind: 'files'; extensions: string[]; root: string }
  | { kind: 'file'; path: string }

export function describeGlob(pattern: string): GlobMeaning | undefined {
  if (!/[*?[{]/.test(pattern)) return { kind: 'file', path: pattern }
  const match = /^(?:(.+)\/)?\*\*\/\*(\.[\w.]+|\.\{[\w.,]+\})$/.exec(pattern)
  if (!match) return undefined
  const [, root = '', ending = ''] = match
  if (/[*?[{]/.test(root)) return undefined
  const extensions = ending.startsWith('.{')
    ? ending
        .slice(2, -1)
        .split(',')
        .map((e) => `.${e}`)
    : [ending]
  return { kind: 'files', extensions, root }
}

/**
 * Top-level folders that hold code Accord found (stylesheets, the UI kit, token files) but that no
 * `surfaces.code.include` pattern reaches, e.g. `app` and `components` when it only looks in `src/`.
 * Empty when a pattern covers the whole repository or every found path.
 */
export function codeOutside(found: readonly string[], include: readonly string[]): string[] {
  const roots = include.map(globRoot)
  if (roots.includes('')) return []
  const folders = new Set<string>()
  for (const path of found) {
    const slash = path.indexOf('/')
    if (slash < 0) continue
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) continue
    folders.add(path.slice(0, slash))
  }
  return [...folders]
}

/** `include` with the found folders added, each with the endings of the first folder pattern. */
export function suggestInclude(include: readonly string[], folders: readonly string[]): string[] {
  const template = include.find((p) => globRoot(p) !== '' && /[*?[{]/.test(p))
  const tail = template ? template.slice(globRoot(template).length) : '/**/*.{ts,tsx,js,jsx,css}'
  return [...new Set([...include, ...folders.map((f) => `${f}${tail}`)])]
}

/** The YAML lines for `surfaces.code.include`, ready to paste into `accord.config.yaml`. */
export function includeYaml(include: readonly string[]): string {
  return ['surfaces:', '  code:', '    include:', ...include.map((p) => `      - "${p}"`)].join('\n')
}
