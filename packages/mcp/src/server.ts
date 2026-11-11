import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { cssVariableName } from '@decivo/accord-adapter-code'
import { checkChange, formatCheck } from '@decivo/accord-cli'
import {
  formatValue,
  matchPath,
  otherContexts,
  type Register,
  resolveOwner,
  tokensDifferingIn,
} from '@decivo/accord-core'
import { loadValidRegister } from '@decivo/accord-core/node'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import picomatch from 'picomatch'
import { z } from 'zod'

export interface AccordServerOptions {
  /** Repository root. */
  root: string
  /** Register directory, absolute or relative to root (default `.accord`). */
  registerDir?: string
}

const text = (value: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(structured ? { structuredContent: structured } : {}),
})
const error = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

/** Accept `color.brand.*`, `tokens.color.brand.**` or a plain prefix like `color.brand`. */
function tokenFilter(scope: string | undefined): (path: string) => boolean {
  if (!scope) return () => true
  const pattern = scope.startsWith('tokens.') ? scope.slice('tokens.'.length) : scope
  if (pattern.includes('*')) return (path) => matchPath(pattern, path)
  return (path) => path === pattern || path.startsWith(`${pattern}.`)
}

/** Decisions that apply to a register path or a file path (via `code:` scopes). */
function decisionsFor(register: Register, scope: string | undefined) {
  const all = [...register.decisions.values()].filter((d) => d.status === 'active')
  if (!scope) return all
  // `color.brand.700` is a token path; `Hero.tsx` or `src/…` is a file.
  const isFile = scope.includes('/') || /\.(?:[cm]?[jt]sx?|css|scss|html|vue|svelte|mdx?)$/.test(scope)
  const registerPath =
    scope.startsWith('tokens.') || scope.startsWith('components.') ? scope : `tokens.${scope}`
  return all.filter((d) =>
    d.scope.some((s) =>
      s.startsWith('code:')
        ? isFile && picomatch(s.slice(5), { dot: true })(scope)
        : !isFile && matchPath(s, registerPath),
    ),
  )
}

/**
 * The Accord MCP server: agents read tokens, contracts and decisions (with their reasons) and check
 * their changes before committing. All tools are read-only; the register is reloaded on every call.
 */
/** The installed package's version, so clients see which Accord answers (lockstep with the CLI). */
export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function createAccordServer(options: AccordServerOptions): McpServer {
  const registerDir = isAbsolute(options.registerDir ?? '.accord')
    ? (options.registerDir as string)
    : join(options.root, options.registerDir ?? '.accord')
  const load = () => loadValidRegister(registerDir)
  const server = new McpServer({ name: 'accord', version: serverVersion() })
  const readOnly = { readOnlyHint: true, openWorldHint: false }

  server.registerTool(
    'get_tokens',
    {
      title: 'Get design tokens',
      description:
        'Design tokens from the register (the single source of truth): path, type, value, CSS variable to use in code, owner. ' +
        '`value` is the default context (e.g. light). With light/dark modes, `contexts` has the value per other context ' +
        '(e.g. { "dark": "#0a0a0a" }) where it differs; a context missing there uses `value`. ' +
        'Optional scope narrows by path prefix or pattern, e.g. "color.brand" or "color.**".',
      inputSchema: {
        scope: z.string().optional().describe('Token path prefix or pattern, e.g. "color.brand"'),
      },
      annotations: readOnly,
    },
    async ({ scope }) => {
      const register = await load()
      const keep = tokenFilter(scope)
      // Values per non-default context, only where they differ from the default (resolver fallback otherwise).
      const differing = otherContexts(register).map(
        (context) =>
          [context, new Map(tokensDifferingIn(register, context).map((t) => [t.path, t]))] as const,
      )
      const tokens = [...register.tokens.values()]
        .filter((t) => keep(t.path) && t.value !== undefined)
        .map((t) => {
          const contexts = Object.fromEntries(
            differing.flatMap(([context, byPath]) => {
              const there = byPath.get(t.path)
              return there ? [[context, formatValue(there.type, there.value)]] : []
            }),
          )
          return {
            path: t.path,
            type: t.type,
            value: formatValue(t.type, t.value),
            ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
            cssVariable: t.type === 'typography' ? undefined : `var(${cssVariableName(t)})`,
            aliasOf: t.aliasOf,
            description: t.description,
            deprecated: t.deprecated,
            owner: resolveOwner(register, `tokens.${t.path}`).owner,
          }
        })
      const modes = register.modes
        ? { default: register.modes.default, contexts: register.modes.contexts }
        : undefined
      if (tokens.length === 0) return error(`No tokens match "${scope}".`)
      // The text stays a list of tokens, as before; the structured result also names the contexts.
      return text(JSON.stringify(tokens, null, 2), modes ? { modes, tokens } : { tokens })
    },
  )

  server.registerTool(
    'get_component_contract',
    {
      title: 'Get component contract',
      description:
        'The contract of a component: anatomy, variants, props, states, slots, tokens and where it lives in code, ' +
        'Figma and Claude Design. Build against it; do not invent variants.',
      inputSchema: { name: z.string().describe('Component name, e.g. "Button"') },
      annotations: readOnly,
    },
    async ({ name }) => {
      const register = await load()
      const contract =
        register.components.get(name) ??
        [...register.components.values()].find((c) => c.name.toLowerCase() === name.toLowerCase())
      if (!contract) {
        return error(
          `No contract for "${name}". Known components: ${[...register.components.keys()].join(', ') || 'none'}.`,
        )
      }
      const { file: _file, ...data } = contract
      return text(JSON.stringify(data, null, 2), { contract: data })
    },
  )

  server.registerTool(
    'get_decisions',
    {
      title: 'Get design decisions',
      description:
        'Design decisions (rules) with their reason ("why"), level (must/should), owner and fix hint. ' +
        'Optional scope: a token path (e.g. "color.brand.600"), a component path (e.g. "components.Button") or a file path.',
      inputSchema: { scope: z.string().optional().describe('Token path, component path or file path') },
      annotations: readOnly,
    },
    async ({ scope }) => {
      const register = await load()
      const decisions = decisionsFor(register, scope).map(({ file: _file, checks: _checks, ...d }) => d)
      return text(JSON.stringify(decisions, null, 2), { decisions })
    },
  )

  server.registerTool(
    'check_change',
    {
      title: 'Check a change against the design system',
      description:
        'Run before every commit that touches UI code. Checks the given files (or only the added lines of a unified diff) ' +
        'for hard-coded values and rule violations and returns each violation with the decision, its reason and a replacement token.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Files relative to the repository root'),
        diff: z.string().optional().describe('Unified diff, e.g. output of `git diff`'),
      },
      annotations: readOnly,
    },
    async ({ paths, diff }) => {
      if (!paths?.length && !diff) return error('Pass "paths" or "diff".')
      const result = await checkChange({ root: options.root, registerDir, paths, diff })
      return text(formatCheck(result), {
        ok: result.ok,
        files: result.files,
        findings: result.findings,
        ownership: result.ownership,
        ...(result.unparsable ? { unparsable: result.unparsable } : {}),
      })
    },
  )

  return server
}
