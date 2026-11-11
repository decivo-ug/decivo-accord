import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { choosePort, projectsFor, serverEnv, slugOf, watchParent } from './index.js'

describe('accord ui', () => {
  it('makes URL-safe, unique project slugs', () => {
    expect(slugOf('Acme Shop', new Set())).toBe('acme-shop')
    expect(slugOf('Café_Ü', new Set())).toBe('cafe-u')
    expect(slugOf('...', new Set())).toBe('project')
    expect(slugOf('shop', new Set(['shop', 'shop-2']))).toBe('shop-3')
  })

  it('shows the repository root, once, for folders inside it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'accord-ui-'))
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo })
    mkdirSync(join(repo, 'src'))
    const projects = projectsFor([repo, join(repo, 'src')])
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ branch: 'trunk' })
    expect(projects[0]?.root.endsWith(projects[0]?.name ?? '?')).toBe(true)
    expect(() => projectsFor([join(repo, 'missing')])).toThrow(/does not exist/)
    writeFileSync(join(repo, 'file.json'), '{}')
    expect(() => projectsFor([join(repo, 'file.json')])).toThrow(/not a folder/)
  })

  it('treats a symbolic link and its target as one project', () => {
    const real = mkdtempSync(join(tmpdir(), 'accord-ui-real-'))
    const link = join(tmpdir(), `accord-ui-link-${Date.now()}`)
    symlinkSync(real, link)
    expect(projectsFor([real, link])).toHaveLength(1)
  })

  it('names the commit on a detached HEAD instead of claiming main', () => {
    const repo = mkdtempSync(join(tmpdir(), 'accord-ui-detached-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo })
    g('init', '-q', '-b', 'main')
    g('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x')
    g('checkout', '-q', '--detach')
    expect(projectsFor([repo])[0]?.branch).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('takes the next free port, and refuses a busy one that was asked for', async () => {
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const port = (busy.address() as { port: number }).port
    await expect(choosePort(port)).rejects.toThrow(/in use/)
    busy.close()
    expect(await choosePort()).toBeGreaterThanOrEqual(4317)
  })

  it('always runs the app in local mode on 127.0.0.1 with the guard on', () => {
    const env = serverEnv(
      {
        PATH: '/bin',
        DATABASE_URL: 'postgres://x',
        GITHUB_CLIENT_SECRET: 's',
        ACCORD_UI_INSTANCE: 'old',
        PORT: '1',
        NEXT_PRIVATE_DEBUG: '1',
        __NEXT_X: '1',
      },
      { port: 4318, instance: 'inst', projects: [{ slug: 's', name: 's', root: '/r', branch: 'main' }] },
    )
    expect(env).toMatchObject({
      PATH: '/bin',
      PORT: '4318',
      HOSTNAME: '127.0.0.1',
      ACCORD_UI_INSTANCE: 'inst',
      ACCORD_UI_HOSTS: '127.0.0.1:4318,localhost:4318',
    })
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.GITHUB_CLIENT_SECRET).toBeUndefined()
    expect(env.NEXT_PRIVATE_DEBUG).toBeUndefined()
    expect(env.__NEXT_X).toBeUndefined()
    expect(JSON.parse(env.ACCORD_PROJECTS ?? '[]')).toHaveLength(1)
  })

  it('notices when the process that started it is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const gone = new Promise<void>((done) => watchParent(child.pid as number, done, 50))
    let early = false
    void gone.then(() => {
      early = true
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(early).toBe(false)
    child.kill('SIGKILL')
    await gone
  })
})
