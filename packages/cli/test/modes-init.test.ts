import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ColorValue, colorToHex, registerInContext } from '@decivo/accord-core'
import { loadValidRegister } from '@decivo/accord-core/node'
import { afterEach, describe, expect, it } from 'vitest'
import { diffCommand, driftReport, initCommand } from '../src/commands.js'
import { planInit } from '../src/init.js'
import { translator } from '../src/messages.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const t = translator('en')
const hexOf = (tokens: Map<string, { value: unknown }>, path: string) =>
  colorToHex(tokens.get(path)?.value as ColorValue)

describe('accord init reads what code really defines', () => {
  it('follows @import from the stylesheet components.json names (tokens only in an imported file)', async () => {
    const plan = await planInit(join(fixtures, 'imported'), t)
    expect(plan.detected.css).toEqual(['src/app/globals.css'])
    expect([...plan.register.tokens.keys()]).toEqual([
      'color.brand',
      'color.surface',
      'color.ink',
      'dimension.radius',
    ])
    expect(plan.register.issues.filter((i) => i.severity === 'error')).toEqual([])
    // No dark block, no modes: the register looks as it always did.
    expect(plan.modes).toBeUndefined()
    expect([...plan.files.keys()].some((f) => f.startsWith('modes/') || f === 'resolver.json')).toBe(false)
  })

  it('reads a theme written with [data-theme] and split over imported files, dark included', async () => {
    const plan = await planInit(join(fixtures, 'data-theme'), t)
    expect(plan.detected.css).toEqual(['src/styles/globals.css'])
    expect([...plan.register.tokens.keys()]).toEqual([
      'color.bg',
      'color.fg',
      'color.accent',
      'dimension.space-4',
    ])
    expect(hexOf(plan.register.tokens, 'color.bg')).toBe('#ffffff')
    expect(plan.modes).toMatchObject({
      source: 'code',
      selector: "[data-theme='dark']",
      contexts: ['light', 'dark'],
      default: 'light',
      values: { dark: 3 },
    })
    expect(plan.files.get('accord.config.yaml')).toContain(`modes: {"dark":"[data-theme='dark']"}`)
    const dark = registerInContext(plan.register, 'dark')
    expect(hexOf(dark.tokens, 'color.bg')).toBe('#0b1120')
    expect(dark.tokens.get('dimension.space-4')?.value).toEqual({ value: 1, unit: 'rem' })
    expect(plan.register.issues).toEqual([])
  })
})

describe('accord init names what the dark block holds without a default', () => {
  let root = ''
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('a variable only .dark declares is an open point, never dropped silently', async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-dark-only-'))
    await mkdir(join(root, 'app'))
    await writeFile(
      join(root, 'app', 'globals.css'),
      ':root {\n  --background: #ffffff;\n}\n.dark {\n  --background: #0a0a0a;\n  --destructive: #ef4444;\n}\n',
    )
    const plan = await planInit(root, t)
    expect(plan.modes?.values).toEqual({ dark: 1 })
    expect(plan.modes?.contextOnly).toEqual({ dark: ['--destructive'] })
    const out: string[] = []
    await initCommand({ root, register: '.accord', force: false, dryRun: true }, t, (s) => out.push(s))
    expect(out.join('\n')).toContain(
      '1 variable(s) only for dark, without a default value, not taken over: --destructive.',
    )
  })
})

describe('accord init and diff with a shadcn .dark block', () => {
  let root = ''
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('writes modes/theme/dark.tokens.json and resolver.json, says so, and reports no drift', async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-shadcn-'))
    await cp(join(fixtures, 'shadcn'), root, { recursive: true })
    const out: string[] = []
    expect(
      await initCommand({ root, register: '.accord', force: false, dryRun: false }, t, (s) => out.push(s)),
    ).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('Modes: light, dark from code (.dark, detected)')
    expect(text).toMatch(/10 value\(s\) for dark in .*\.accord[\\/]modes[\\/]theme[\\/]dark\.tokens\.json/)

    const register = await loadValidRegister(join(root, '.accord'))
    expect(register.modes?.contexts).toEqual(['light', 'dark'])
    const resolver = JSON.parse(await readFile(join(root, '.accord/resolver.json'), 'utf8'))
    expect(resolver.modifiers.theme).toEqual({
      contexts: { light: [], dark: [{ $ref: 'modes/theme/dark.tokens.json' }] },
      default: 'light',
    })
    expect(resolver.sets.core.sources).toEqual([
      { $ref: 'tokens/color.tokens.json' },
      { $ref: 'tokens/dimension.tokens.json' },
    ])

    const report = await driftReport({ root, register: '.accord' })
    expect(report.code.drift).toEqual([])
    expect(report.code.modes).toEqual([
      { context: 'dark', selector: '.dark', how: 'configured', found: true },
    ])

    // Someone changes the dark primary in code: drift in dark, light untouched.
    const css = join(root, 'src/app/globals.css')
    await writeFile(
      css,
      (await readFile(css, 'utf8')).replace('--primary: oklch(0.922 0 0);', '--primary: #3c6681;'),
    )
    const drift = (await driftReport({ root, register: '.accord' })).code.drift
    expect(drift).toEqual([
      expect.objectContaining({
        path: 'tokens.color.primary',
        context: { theme: 'dark' },
        kind: 'token.value_changed',
        surface: '#3c6681',
        owner: 'design',
        breaking: false,
      }),
    ])
    const lines: string[] = []
    expect(
      await diffCommand({ root, register: '.accord', json: false, limit: 10 }, t, (s) => lines.push(s)),
    ).toBe(0)
    expect(lines.join('\n')).toContain('tokens.color.primary (dark)')
    expect(lines.join('\n')).toContain('Mode dark: .dark (from surfaces.code.modes)')
  })
})

describe('accord init --from design takes the theme modes over', () => {
  let root = ''
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('Figma Light/Dark modes: the dark mode becomes the dark context, aliases stay aliases', async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-figma-modes-'))
    await mkdir(join(root, 'figma'))
    const rest = {
      meta: {
        variableCollections: {
          p: { id: 'p', name: 'Primitives', defaultModeId: 'v', modes: [{ modeId: 'v', name: 'Value' }] },
          s: {
            id: 's',
            name: 'Semantic',
            defaultModeId: 'l',
            modes: [
              { modeId: 'l', name: 'Light' },
              { modeId: 'd', name: 'Dark' },
            ],
          },
          r: {
            id: 'r',
            name: 'Radius',
            defaultModeId: 'a',
            modes: [
              { modeId: 'a', name: 'Rounded' },
              { modeId: 'b', name: 'Pill' },
            ],
          },
        },
        variables: {
          g50: {
            id: 'g50',
            name: 'Gray/50',
            resolvedType: 'COLOR',
            variableCollectionId: 'p',
            valuesByMode: { v: { r: 0.98, g: 0.98, b: 0.98, a: 1 } },
          },
          g900: {
            id: 'g900',
            name: 'Gray/900',
            resolvedType: 'COLOR',
            variableCollectionId: 'p',
            valuesByMode: { v: { r: 0.09, g: 0.09, b: 0.09, a: 1 } },
          },
          bg: {
            id: 'bg',
            name: 'Color/Background',
            resolvedType: 'COLOR',
            variableCollectionId: 's',
            codeSyntax: { WEB: 'var(--background)' },
            valuesByMode: {
              l: { type: 'VARIABLE_ALIAS', id: 'g50' },
              d: { type: 'VARIABLE_ALIAS', id: 'g900' },
            },
          },
          accent: {
            id: 'accent',
            name: 'Color/Accent',
            resolvedType: 'COLOR',
            variableCollectionId: 's',
            valuesByMode: { l: { r: 0.15, g: 0.39, b: 0.92, a: 1 }, d: { r: 0.38, g: 0.65, b: 0.98, a: 1 } },
          },
          card: {
            id: 'card',
            name: 'Card',
            resolvedType: 'FLOAT',
            variableCollectionId: 'r',
            scopes: ['CORNER_RADIUS'],
            valuesByMode: { a: 8, b: 999 },
          },
        },
      },
    }
    await writeFile(join(root, 'figma/variables.json'), JSON.stringify(rest))
    const out: string[] = []
    expect(
      await initCommand({ root, register: '.accord', force: false, dryRun: false, from: 'design' }, t, (s) =>
        out.push(s),
      ),
    ).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('Modes: light, dark from Figma (Semantic)')
    expect(text).toContain('2 value(s) for dark')
    // Not a theme: Rounded/Pill stays a mode for later.
    expect(text).toContain('mode Rounded taken over (Radius); Pill follow with modes')
    expect(text).not.toContain('Dark follow with modes')

    const dark = JSON.parse(await readFile(join(root, '.accord/modes/theme/dark.tokens.json'), 'utf8'))
    expect(dark.color.background).toEqual({ $value: '{gray.900}' })
    expect(dark.color.accent.$value).toMatchObject({ colorSpace: 'srgb' })
    const register = await loadValidRegister(join(root, '.accord'))
    expect(hexOf(registerInContext(register, 'dark').tokens, 'color.background')).toBe('#171717')
    expect(hexOf(register.tokens, 'color.background')).toBe('#fafafa')
  })

  it('Pencil themes: mode dark becomes the dark context', async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-pen-modes-'))
    await writeFile(
      join(root, 'library.pen'),
      JSON.stringify({
        themes: { mode: ['light', 'dark'] },
        variables: {
          '--primary': {
            type: 'color',
            value: [{ value: '#3c6681' }, { value: '#9fc0d6', theme: { mode: 'dark' } }],
          },
          '--radius': { type: 'number', value: 8 },
        },
        children: [],
      }),
    )
    const out: string[] = []
    expect(
      await initCommand({ root, register: '.accord', force: false, dryRun: false }, t, (s) => out.push(s)),
    ).toBe(0)
    expect(out.join('\n')).toContain('Modes: light, dark from Pencil (axis mode)')
    const register = await loadValidRegister(join(root, '.accord'))
    expect(hexOf(registerInContext(register, 'dark').tokens, 'color.primary')).toBe('#9fc0d6')
  })
})

describe('accord init --from tokens takes a dark token file over as the dark context', () => {
  it('Light.tokens.json and Dark.tokens.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accord-sets-'))
    try {
      const color = (hex: string) => ({ $type: 'color', $value: hex })
      const write = async (path: string, json: unknown) => {
        await mkdir(join(root, dirname(path)), { recursive: true })
        await writeFile(join(root, path), JSON.stringify(json))
      }
      await write('tokens/Light.tokens.json', { bg: { primary: color('#ffffff'), brand: color('#3c6681') } })
      await write('tokens/Dark.tokens.json', { bg: { primary: color('#000000'), brand: color('#3c6681') } })
      const plan = await planInit(root, t)
      expect(plan.modes).toMatchObject({
        source: 'tokens',
        from: ['tokens/Dark.tokens.json'],
        values: { dark: 1 },
      })
      expect(plan.openPoints.skipped).toEqual([])
      expect(hexOf(registerInContext(plan.register, 'dark').tokens, 'bg.primary')).toBe('#000000')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
