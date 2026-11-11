import { parse as parseScript } from '@babel/parser'
import { type ColorValue, cssToColor, cssToDimension, type DimensionValue } from '@decivo/accord-core'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'

/** A literal value in code that should probably be a token. */
export interface HardValue {
  file: string
  /** 1-based, like editors show it. */
  line: number
  /** 1-based. */
  column: number
  /** Text as found, e.g. `#487a98` or `bg-[#487a98]`'s `#487a98`. */
  raw: string
  kind: 'color' | 'dimension'
  value: ColorValue | DimensionValue
  /** `string`: whole JS string literal; `embedded`: inside a longer string; `tailwind`: arbitrary value `[…]`; `style`: React style prop; `css`: stylesheet. */
  context: 'string' | 'embedded' | 'tailwind' | 'style' | 'css'
  /** What a length is used for, so only matching tokens are suggested (no radius token for a font size). */
  category?: DimensionCategory
  /**
   * The file renders where CSS variables do not exist (OG images via Satori, react-pdf, e-mail HTML).
   * Literal values are needed there; they should come from generated token constants instead.
   */
  inlineOnly?: true
}

export type DimensionCategory = 'spacing' | 'radius' | 'fontSize' | 'letterSpacing'

/** Modules whose output cannot use CSS custom properties. */
export const INLINE_ONLY_MODULES = [
  'next/og',
  '@vercel/og',
  'satori',
  '@react-pdf/renderer',
  'react-email',
  '@react-email/',
  'mjml',
]

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
/** Outside CSS contexts, three-digit hex is too ambiguous (`#add` is an anchor). */
const LONG_HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const COLOR_STYLE_PROPS = /color|background|fill|stroke|border|outline|shadow|caret|accent/i
const NON_COLOR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none'])
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const EMBEDDED_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|(?:rgba?|hsla?|oklab|oklch)\([^()]*\)/gi
/** `hover:bg-[#487a98]` → utility `bg`, value `#487a98`. */
const TAILWIND_ARBITRARY = /([a-z][a-z0-9-]*)-\[([^\][\s]+)\]/g
const IGNORE = 'accord-ignore'

/** Tailwind utilities and style props whose lengths are design decisions; widths, heights and positions are layout. */
export function lengthCategory(utilityOrProp: string): DimensionCategory | undefined {
  const name = utilityOrProp.replace(/^-/, '')
  if (/^(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)$/.test(name))
    return 'spacing'
  if (/^rounded(?:-[a-z]+)?$/.test(name)) return 'radius'
  if (name === 'text') return 'fontSize'
  if (name === 'tracking') return 'letterSpacing'
  if (/^(?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block)?$|^(?:gap|rowGap|columnGap)$/.test(name))
    return 'spacing'
  if (/^border(?:(?:Top|Bottom)(?:Left|Right))?Radius$/.test(name)) return 'radius'
  if (name === 'fontSize') return 'fontSize'
  if (name === 'letterSpacing') return 'letterSpacing'
  return undefined
}

const isColorLiteral = (text: string) => HEX.test(text) || COLOR_FUNCTION.test(text)
const isUnambiguousColor = (text: string) => LONG_HEX.test(text) || COLOR_FUNCTION.test(text)

interface Loc {
  line: number
  column: number
}

/** Position of `offset` inside a literal whose content starts at `start`. */
function offsetLoc(start: Loc, text: string, offset: number): Loc {
  const before = text.slice(0, offset)
  const lines = before.split('\n')
  if (lines.length === 1) return { line: start.line, column: start.column + offset }
  return { line: start.line + lines.length - 1, column: (lines.at(-1) as string).length }
}

function scanString(
  text: string,
  start: Loc,
  file: string,
  styleProp: string | undefined,
  out: HardValue[],
): void {
  const trimmed = text.trim()
  if (styleProp !== undefined) {
    const namedOk = COLOR_STYLE_PROPS.test(styleProp) && !NON_COLOR_KEYWORDS.has(trimmed.toLowerCase())
    const color =
      isColorLiteral(trimmed) || (namedOk && /^[a-z]+$/i.test(trimmed)) ? cssToColor(trimmed) : undefined
    if (color)
      return void out.push({ file, ...start, raw: trimmed, kind: 'color', value: color, context: 'style' })
    const category = lengthCategory(styleProp)
    const dimension = category ? cssToDimension(trimmed) : undefined
    if (category && dimension && dimension.value !== 0) {
      return void out.push({
        file,
        ...start,
        raw: trimmed,
        kind: 'dimension',
        value: dimension,
        context: 'style',
        category,
      })
    }
  }
  if (isUnambiguousColor(trimmed)) {
    const color = cssToColor(trimmed)
    if (color)
      return void out.push({ file, ...start, raw: trimmed, kind: 'color', value: color, context: 'string' })
  }

  const taken: [number, number][] = []
  for (const m of text.matchAll(TAILWIND_ARBITRARY)) {
    const utility = m[1] as string
    const inner = (m[2] as string).replace(/_/g, ' ')
    const offset = (m.index ?? 0) + utility.length + 2
    const color = isColorLiteral(inner) ? cssToColor(inner) : undefined
    const category = color ? undefined : lengthCategory(utility)
    const dimension = category ? cssToDimension(inner) : undefined
    if (!color && !(dimension && dimension.value !== 0)) continue
    taken.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    const loc = offsetLoc(start, text, offset)
    if (color) out.push({ file, ...loc, raw: inner, kind: 'color', value: color, context: 'tailwind' })
    else if (dimension && category)
      out.push({
        file,
        ...loc,
        raw: inner,
        kind: 'dimension',
        value: dimension,
        context: 'tailwind',
        category,
      })
  }
  for (const m of text.matchAll(EMBEDDED_COLOR)) {
    const at = m.index ?? 0
    if (taken.some(([a, b]) => at >= a && at < b)) continue
    const color = cssToColor(m[0])
    if (color)
      out.push({
        file,
        ...offsetLoc(start, text, at),
        raw: m[0],
        kind: 'color',
        value: color,
        context: 'embedded',
      })
  }
}

type Node = { type: string; loc?: { start: Loc } | null; [key: string]: unknown }

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && typeof (v as Node).type === 'string'

function ignoredLines(
  comments: readonly { value: string; loc?: { start: Loc; end: Loc } | null }[],
): Set<number> {
  const lines = new Set<number>()
  for (const c of comments) {
    if (!c.value.includes(IGNORE) || !c.loc) continue
    lines.add(c.loc.end.line)
    lines.add(c.loc.end.line + 1)
  }
  return lines
}

/** Find literal colours and design lengths in TS/JS/JSX. `// accord-ignore` skips the same and the next line. */
export function scanScript(code: string, file: string): HardValue[] {
  if (code.includes('accord-ignore-file')) return []
  let ast: { program: Node; comments?: { value: string; loc?: { start: Loc; end: Loc } | null }[] }
  try {
    ast = parseScript(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    }) as unknown as typeof ast
  } catch {
    return scanText(code, file)
  }
  const out: HardValue[] = []
  const imports: string[] = []

  const visit = (node: Node, styleProp: string | undefined): void => {
    switch (node.type) {
      case 'ImportDeclaration':
        imports.push((node.source as { value: string }).value)
        return
      case 'ExportAllDeclaration':
      case 'TSLiteralType':
      case 'TSImportType':
      case 'TSExternalModuleReference':
        return
      case 'StringLiteral': {
        const loc = node.loc?.start
        if (loc)
          scanString(node.value as string, { line: loc.line, column: loc.column + 1 }, file, styleProp, out)
        return
      }
      case 'TemplateElement': {
        const loc = node.loc?.start
        const cooked = (node.value as { cooked?: string | null }).cooked
        if (loc && cooked) scanString(cooked, loc, file, undefined, out)
        return
      }
      case 'NumericLiteral': {
        // `style={{ padding: 13 }}` means 13px in React.
        const loc = node.loc?.start
        const category = styleProp ? lengthCategory(styleProp) : undefined
        if (loc && category && (node.value as number) !== 0) {
          const value = node.value as number
          out.push({
            file,
            ...loc,
            raw: String(value),
            kind: 'dimension',
            value: { value, unit: 'px' },
            context: 'style',
            category,
          })
        }
        return
      }
      case 'ObjectProperty': {
        const key = node.key as Node
        const name =
          key.type === 'Identifier'
            ? (key.name as string)
            : key.type === 'StringLiteral'
              ? (key.value as string)
              : undefined
        if (node.computed) visit(key, undefined)
        // Inside a style object, remember the CSS property so `padding: '13px'` can be judged.
        visit(node.value as Node, styleProp !== undefined ? (name ?? '') : undefined)
        return
      }
      case 'JSXAttribute': {
        const name = (node.name as Node).name as string
        const value = node.value as Node | null
        if (!value) return
        // Only the `style` object gets property names; everything else is scanned as plain strings.
        if (name === 'style') visit(value, '')
        else visit(value, undefined)
        return
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        key === 'loc' ||
        key === 'start' ||
        key === 'end' ||
        key === 'leadingComments' ||
        key === 'trailingComments'
      )
        continue
      if (Array.isArray(child)) {
        for (const c of child) if (isNode(c)) visit(c, styleProp)
      } else if (isNode(child)) visit(child, styleProp)
    }
  }

  visit(ast.program, undefined)
  const ignored = ignoredLines(ast.comments ?? [])
  const inlineOnly = imports.some((source) =>
    INLINE_ONLY_MODULES.some((m) => source === m || source.startsWith(m)),
  )
  // Babel columns are 0-based.
  return out
    .filter((v) => !ignored.has(v.line))
    .map((v) => ({ ...v, column: v.column + 1, ...(inlineOnly ? { inlineOnly: true as const } : {}) }))
}

/** The syntax error of a stylesheet, or undefined when it parses. */
export function stylesheetError(css: string, file: string): string | undefined {
  try {
    postcss.parse(css, { from: file })
    return undefined
  } catch (error) {
    const e = error as { reason?: string; line?: number; column?: number; message?: string }
    return e.reason
      ? `${e.reason}${e.line ? ` at ${e.line}:${e.column ?? 1}` : ''}`
      : (e.message ?? 'unreadable')
  }
}

/** Fallback for files Babel cannot parse: unambiguous colours anywhere in the text. */
function scanText(code: string, file: string, css = false): HardValue[] {
  const out: HardValue[] = []
  code.split('\n').forEach((text, i) => {
    // In a stylesheet, a custom property definition is where a token's value lives, not a hard-coded use.
    if (css && /^\s*--[\w-]+\s*:/.test(text)) return
    for (const m of text.matchAll(EMBEDDED_COLOR)) {
      const color = cssToColor(m[0])
      if (color)
        out.push({
          file,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          raw: m[0],
          kind: 'color',
          value: color,
          context: 'embedded',
        })
    }
  })
  return out
}

/** Find literal colours in stylesheets, outside custom property definitions. `/* accord-ignore *\/` skips the next declaration. */
export function scanStylesheet(css: string, file: string): HardValue[] {
  let root: postcss.Root
  try {
    root = postcss.parse(css, { from: file })
  } catch {
    // A stylesheet with a syntax error (an unclosed block): the unambiguous colours in it still count.
    // `stylesheetError` names the problem for the report.
    return scanText(css, file, true)
  }
  const out: HardValue[] = []
  const ignored = new Set<number>()
  root.walkComments((c) => {
    if (c.text.includes(IGNORE) && c.source?.end) {
      ignored.add(c.source.end.line)
      ignored.add(c.source.end.line + 1)
    }
  })
  root.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) return
    const start = decl.source?.start
    if (!start || ignored.has(start.line)) return
    const lead = decl.prop + (decl.raws.between ?? ':')
    const text = lead + decl.value
    // Named colours (`red`, `RebeccaPurple`) only where a colour is expected; elsewhere words are keywords.
    const colorProp = COLOR_STYLE_PROPS.test(decl.prop)
    valueParser(decl.value).walk((node) => {
      let found: string | undefined
      if (node.type === 'word' && HEX.test(node.value)) found = node.value
      else if (node.type === 'function' && COLOR_FUNCTION.test(`${node.value}(`))
        found = valueParser.stringify(node)
      else if (
        colorProp &&
        node.type === 'word' &&
        /^[a-z]+$/i.test(node.value) &&
        !NON_COLOR_KEYWORDS.has(node.value.toLowerCase())
      )
        found = node.value
      if (!found) return
      const color = cssToColor(found)
      if (color) {
        // A value may span lines: the position is counted from the declaration's start (1-based columns).
        const before = text.slice(0, lead.length + node.sourceIndex).split('\n')
        const line = start.line + before.length - 1
        const column =
          before.length === 1
            ? start.column + (before[0] as string).length
            : (before.at(-1) as string).length + 1
        out.push({
          file,
          line,
          column,
          raw: found,
          kind: 'color',
          value: color,
          context: 'css',
        })
      }
      return false
    })
  })
  return out
}
