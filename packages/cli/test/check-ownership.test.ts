import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkChange, formatCheck, removedVariables } from '../src/check.js'
import { applyCommand, figmaCommand, initCommand } from '../src/commands.js'
import { translator } from '../src/messages.js'

/**
 * `check` is the agents' gate before a commit. It must not wave through what code may not decide, and
 * it must judge the change, not the state: drift that was there before is not this commit's doing.
 */
const demo = fileURLToPath(new URL('../../../examples/demo/project', import.meta.url))
const t = translator('en')

describe('check: ownership', () => {
  let root = ''
  const styles = () => join(root, 'src', 'styles.css')
  const edit = async (fn: (css: string) => string) =>
    writeFile(styles(), fn(await readFile(styles(), 'utf8')))
  const check = (paths = ['src/styles.css'], diff?: string) =>
    checkChange({ root, registerDir: '.accord', paths: diff === undefined ? paths : undefined, diff })
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
  const commit = () => {
    git('add', '-A')
    git('commit', '-q', '-m', 'x')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'accord-check-owner-'))
    await cp(demo, root, { recursive: true })
    git('init', '-q')
    await initCommand(
      { root, register: '.accord', force: false, dryRun: false, figma: ['figma/variables.json'] },
      t,
      () => {},
    )
    commit()
  })

  it('passes an untouched stylesheet', async () => {
    const result = await check()
    expect(result.ok).toBe(true)
    expect(result.ownership).toEqual([])
  })

  it('reports a design value changed in code, with its owner', async () => {
    await edit((css) => css.replace('--brand: #3c6681', '--brand: #2f5a74'))
    const result = await check()
    expect(result.ok).toBe(false)
    expect(result.ownership).toEqual([
      expect.objectContaining({ token: 'color.brand', kind: 'changed', owner: 'design', after: '#2f5a74' }),
    ])
    expect(formatCheck(result)).toMatch(/owned by design/)
  })

  it('reports a linked CSS variable removed from code as a deletion', async () => {
    await edit((css) =>
      css
        .split('\n')
        .filter((l) => !l.includes('--radius-card'))
        .join('\n'),
    )
    const result = await check()
    expect(result.ok).toBe(false)
    expect(result.ownership).toEqual([
      expect.objectContaining({ token: 'radius.card', kind: 'removed', variable: '--radius-card' }),
    ])
  })

  it('does not blame code for drift that was there before the change', async () => {
    // Design changes the radius in Figma and the register adopts it: code is behind, but changed nothing.
    const file = join(root, 'figma', 'variables.json')
    const doc = JSON.parse(await readFile(file, 'utf8'))
    const radius = Object.values(
      doc.meta.variables as Record<string, { name: string; valuesByMode: Record<string, unknown> }>,
    ).find((v) => v.name === 'Radius/Card')
    for (const m of Object.keys(radius?.valuesByMode ?? {}))
      (radius as { valuesByMode: Record<string, unknown> }).valuesByMode[m] = 16
    await writeFile(file, JSON.stringify(doc, null, 2))
    await figmaCommand(
      { root, register: '.accord', action: 'propose', json: false, write: true },
      t,
      () => {},
    )
    const id = (await import('node:fs'))
      .readdirSync(join(root, '.accord', 'proposals'))[0]
      ?.replace('.json', '')
    await applyCommand(
      {
        root,
        register: '.accord',
        proposal: id,
        option: 'adopt',
        by: 'Dana',
        dryRun: false,
        branch: false,
        push: false,
        json: false,
      },
      t,
      () => {},
    )
    commit()
    expect((await check()).ok).toBe(true)
    // Another edit in the same file is still judged on its own.
    await edit((css) => `${css}\n.card { padding: 4px; }\n`)
    expect((await check()).ownership).toEqual([])
    await edit((css) => css.replace('--brand: #3c6681', '--brand: #2f5a74'))
    expect((await check()).ownership.map((o) => o.token)).toEqual(['color.brand'])
  })

  it('with a diff, judges only the declarations the diff adds or removes', async () => {
    await edit((css) => css.replace('--radius-card: 12px', '--radius-card: 20px'))
    commit() // the drift is committed: it is not part of the next change
    await edit((css) => css.replace('--brand: #3c6681', '--brand: #2f5a74'))
    const result = await check(undefined, git('diff', '--', 'src/styles.css'))
    expect(result.ownership.map((o) => o.token)).toEqual(['color.brand'])
    const other = `--- a/src/styles.css\n+++ b/src/styles.css\n@@ -9,0 +10,1 @@\n+.card { padding: 4px; }\n`
    expect((await check(undefined, other)).ownership).toEqual([])
  })

  it('reads removed declarations from a diff', () => {
    const diff =
      '--- a/a.css\n+++ b/a.css\n@@ -1,3 +1,2 @@\n :root {\n-  --brand: #000; --x-1:1px;\n   --keep: 1;\n'
    expect([...(removedVariables(diff).get('a.css') ?? [])]).toEqual(['--brand', '--x-1'])
  })

  it('a variable that points at a changed one changes with it', async () => {
    await edit((css) => css.replace('--brand: #3c6681', '--blue: #3c6681;\n  --brand: var(--blue)'))
    commit()
    await edit((css) => css.replace('--blue: #3c6681', '--blue: #2f5a74'))
    expect((await check()).ownership.map((o) => o.token)).toEqual(['color.brand'])
  })

  it('names a stylesheet with a syntax error instead of calling its tokens deleted', async () => {
    await edit((css) => `${css}\n.x { color: var(--text)`)
    const result = await check()
    expect(result.ownership).toEqual([])
    expect(result.unparsable).toEqual([expect.objectContaining({ file: 'src/styles.css' })])
    expect(result.findings).toEqual([])
    expect(formatCheck(result)).toMatch(/syntax error/)
  })

  it('suggests only CSS variables code really defines', async () => {
    // blue.700 has no variable in this stylesheet; --blue-700 would be a name from the convention only.
    await writeFile(join(root, 'src', 'x.css'), '.a { color: #2f5a74; }\n.b { color: #3c6681; }\n')
    const { findings } = await check(['src/x.css'])
    const byValue = new Map(findings.map((f) => [f.value, f]))
    expect(byValue.get('#3c6681')?.replacementVar).toBe('--brand')
    expect(byValue.get('#2f5a74')?.replacement).toBe('blue.700')
    expect(byValue.get('#2f5a74')?.replacementVar).toBeUndefined()
  })
})
