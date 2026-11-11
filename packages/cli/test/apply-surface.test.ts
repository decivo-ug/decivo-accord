import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, figmaCommand, initCommand } from '../src/commands.js'
import { translator } from '../src/messages.js'

/**
 * Decisions on Figma proposals in the demo project, the cases an independent review found:
 * outdated proposals, unreviewed edits on --branch, the lock after an adoption, renames and aliases.
 */
const demo = fileURLToPath(new URL('../../../examples/demo/project', import.meta.url))
const t = translator('en')

interface Variable {
  name: string
  valuesByMode: Record<string, unknown>
}

describe('apply on Figma proposals', () => {
  let root = ''
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  const commit = (m: string) => {
    git('add', '-A')
    git('commit', '-q', '-m', m)
  }
  const figma = async (edit: (vars: Record<string, Variable>) => void) => {
    const file = join(root, 'figma', 'variables.json')
    const doc = JSON.parse(await readFile(file, 'utf8'))
    edit(doc.meta.variables)
    await writeFile(file, JSON.stringify(doc, null, 2))
  }
  const byName = (vars: Record<string, Variable>, name: string) =>
    Object.values(vars).find((v) => v.name === name) as Variable
  const setRadius = (px: number) =>
    figma((vars) => {
      const v = byName(vars, 'Radius/Card')
      for (const m of Object.keys(v.valuesByMode)) v.valuesByMode[m] = px
    })
  const propose = async () => {
    await figmaCommand(
      { root, register: '.accord', action: 'propose', json: false, write: true },
      t,
      () => {},
    )
    const dir = join(root, '.accord', 'proposals')
    const files = await Promise.all(
      (await readdir(dir)).map(async (f) => ({ f, at: (await stat(join(dir, f))).mtimeMs })),
    )
    return (files.sort((a, b) => b.at - a.at)[0]?.f ?? '').replace(/\.json$/, '')
  }
  const adopt = async (id: string, branch = false) => {
    const out: string[] = []
    const code = await applyCommand(
      {
        root,
        register: '.accord',
        proposal: id,
        option: 'adopt',
        by: 'Dana',
        dryRun: false,
        branch,
        push: false,
        json: false,
      },
      t,
      (s) => out.push(s),
    )
    return { code, out: out.join('\n') }
  }
  const radius = async () =>
    JSON.parse(await readFile(join(root, '.accord/tokens/radius.tokens.json'), 'utf8')).radius

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-surface-apply-'))
    await cp(demo, root, { recursive: true })
    git('init', '-q', '-b', 'main')
    commit('shop')
    await initCommand(
      { root, register: '.accord', force: false, dryRun: false, figma: ['figma/variables.json'] },
      t,
      () => {},
    )
    commit('register')
  })

  it('refuses an outdated proposal instead of undoing a newer decision', async () => {
    await setRadius(20)
    const older = await propose()
    await setRadius(24)
    const newer = await propose()
    expect((await adopt(newer)).code).toBe(0)
    const stale = await adopt(older)
    expect(stale.code).toBe(1)
    expect(stale.out).toMatch(/out of date.*radius\.card is 24px now, not 12px/)
    expect((await radius()).card.$value).toEqual({ value: 24, unit: 'px' })
  })

  it('records the adopted values in the lock, so the next Figma change is not a conflict', async () => {
    await figmaCommand({ root, register: '.accord', action: 'lock', json: false }, t, () => {})
    await setRadius(16)
    expect((await adopt(await propose())).code).toBe(0)
    await setRadius(20)
    const out: string[] = []
    await figmaCommand({ root, register: '.accord', action: 'status', json: false }, t, (s) => out.push(s))
    const line = out.find((l) => l.includes('radius.card')) ?? ''
    expect(line).toContain('changed in Figma')
    expect(line).not.toMatch(/also changed in the register|conflict/i)
  })

  it('with --branch it refuses uncommitted register edits that would ride along', async () => {
    await setRadius(16)
    const id = await propose()
    const file = join(root, '.accord/tokens/radius.tokens.json')
    const doc = JSON.parse(await readFile(file, 'utf8'))
    doc.radius.sneaky = { $type: 'dimension', $value: { value: 3, unit: 'px' } }
    await writeFile(file, JSON.stringify(doc, null, 2))
    const result = await adopt(id, true)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/uncommitted changes.*radius\.tokens\.json/i)
    expect(git('branch', '--show-current')).toBe('main')
  })

  it('a rename keeps the links to the CSS variable and names the new Figma variable', async () => {
    await figma((vars) => {
      byName(vars, 'Radius/Card').name = 'Radius/Panel'
    })
    const result = await adopt(await propose())
    expect(result.code).toBe(0)
    expect(result.out).toContain('radius.card → radius.panel: renamed (12px)')
    const { panel, card } = await radius()
    expect(card).toBeUndefined()
    expect(panel.$extensions['de.decivo.accord'].ids).toEqual({ figma: 'Radius.Panel', css: '--radius-card' })
  })

  it('an alias pointed elsewhere in Figma is a decision, and adopting it re-points the alias', async () => {
    let blue700 = ''
    await figma((vars) => {
      blue700 = Object.entries(vars).find(([, v]) => v.name === 'Blue/700')?.[0] ?? ''
      const brand = byName(vars, 'Color/Brand')
      const mode = Object.keys(brand.valuesByMode)[0] as string
      brand.valuesByMode[mode] = { type: 'VARIABLE_ALIAS', id: blue700 }
    })
    const id = await propose()
    const proposal = JSON.parse(await readFile(join(root, '.accord/proposals', `${id}.json`), 'utf8'))
    expect(proposal.route).not.toBe('auto')
    expect((await adopt(id)).code).toBe(0)
    const color = JSON.parse(await readFile(join(root, '.accord/tokens/color.tokens.json'), 'utf8'))
    expect(color.color.brand.$value).toBe('{blue.700}')
  })
  it('a dark value that only follows its target stays an alias', async () => {
    const dark = join(root, '.accord/modes/theme/dark.tokens.json')
    const before = await readFile(dark, 'utf8')
    expect(before).toContain('{gray.50}')
    await figma((vars) => {
      const v = byName(vars, 'Gray/50')
      for (const m of Object.keys(v.valuesByMode)) v.valuesByMode[m] = { r: 0.9, g: 0.95, b: 0.97, a: 1 }
    })
    const id = await propose()
    const proposal = JSON.parse(await readFile(join(root, '.accord/proposals', `${id}.json`), 'utf8'))
    expect(proposal.changes.map((c: { token: string }) => c.token)).toEqual(['gray.50'])
    expect((await adopt(id)).code).toBe(0)
    expect(await readFile(dark, 'utf8')).toBe(before)
  })

  it("two new tokens with a removed one's value are no rename: neither inherits its links", async () => {
    await figma((vars) => {
      const [id, v] = Object.entries(vars).find(([, x]) => x.name === 'Spacing/4') as [string, Variable]
      delete vars[id]
      vars[`${id}a`] = { ...structuredClone(v), name: 'Spacing/A' }
      vars[`${id}b`] = { ...structuredClone(v), name: 'Spacing/B' }
    })
    expect((await adopt(await propose())).code).toBe(0)
    const spacing = JSON.parse(
      await readFile(join(root, '.accord/tokens/spacing.tokens.json'), 'utf8'),
    ).spacing
    expect(Object.keys(spacing).sort()).toEqual(['a', 'b'])
    expect(spacing.a.$extensions?.['de.decivo.accord']?.ids?.css).toBeUndefined()
    expect(spacing.b.$extensions?.['de.decivo.accord']?.ids?.css).toBeUndefined()
  })

  it('with --branch it works for a project in a subfolder of the repository', async () => {
    const top = await mkdtemp(join(tmpdir(), 'accord-mono-'))
    const sub = join(top, 'apps', 'web shop')
    await cp(root, sub, { recursive: true, filter: (src) => !src.includes(`${root}/.git`) })
    const g = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: top })
    g('init', '-q', '-b', 'main')
    g('add', '-A')
    g('commit', '-q', '-m', 'mono')
    root = sub
    await setRadius(16)
    const result = await adopt(await propose(), true)
    expect(result.out).not.toMatch(/uncommitted/i)
    expect(result.code).toBe(0)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: top, encoding: 'utf8' }).trim()).toMatch(
      /^accord\/apply-/,
    )
  })
})
