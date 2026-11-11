import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the bundled web app lives (built by `scripts/bundle.mjs`). */
export const APP_SERVER = fileURLToPath(new URL('../app/server.js', import.meta.url))
const PRELOAD = new URL('./preload.js', import.meta.url).href

export const DEFAULT_PORT = 4317
const HOST = '127.0.0.1'

export interface UiProject {
  slug: string
  name: string
  root: string
  branch: string
}

export interface StartOptions {
  /** Repositories to show; default: the working directory. */
  roots?: string[] | undefined
  /** Port; default 4317, or the next free one. A port given here must be free. */
  port?: number | undefined
  /** Open the browser (default true). */
  open?: boolean | undefined
  /** How long to wait for the server, in ms (default 30 s). */
  timeout?: number | undefined
  /** Stops a start that is still running (Ctrl+C while the app comes up). */
  signal?: AbortSignal | undefined
}

export interface RunningUi {
  /** Address to open, with a one-time code. */
  url: string
  port: number
  projects: UiProject[]
  /** A new address with a new one-time code (the old one works only once). */
  newUrl(): string
  /** Resolves when the server process ends. */
  exited: Promise<number | null>
  stop(): void
}

export class UiError extends Error {}

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return (
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() ||
      undefined
    )
  } catch {
    return undefined
  }
}

/** URL part of a project: lowercase letters, digits and hyphens, unique among `taken`. */
export function slugOf(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

/** The projects for the given folders: each one's repository root (git), else the folder itself. */
export function projectsFor(roots: string[]): UiProject[] {
  const taken = new Set<string>()
  const seen = new Set<string>()
  const projects: UiProject[] = []
  for (const given of roots) {
    const dir = resolve(given)
    if (!existsSync(dir)) throw new UiError(`${dir} does not exist`)
    if (!statSync(dir).isDirectory()) throw new UiError(`${dir} is not a folder`)
    // Real paths, so a symbolic link and its target are one project.
    const root = realpathSync(git(dir, ['rev-parse', '--show-toplevel']) ?? dir)
    if (seen.has(root)) continue
    seen.add(root)
    const name = basename(root)
    const slug = slugOf(name, taken)
    taken.add(slug)
    const branch =
      git(root, ['branch', '--show-current']) ??
      (git(root, ['rev-parse', '--short', 'HEAD']) /* detached HEAD: the commit */ || 'main')
    projects.push({ slug, name, root, branch })
  }
  return projects
}

type PortState = 'free' | 'busy' | 'denied'
const portState = (port: number) =>
  new Promise<PortState>((done) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'EACCES' || error.code === 'EPERM' ? 'denied' : 'busy'),
    )
    probe.listen(port, HOST, () => probe.close(() => done('free')))
  })

/** The given port (must be free), else the first free one from 4317 on. */
export async function choosePort(wanted?: number): Promise<number> {
  if (wanted !== undefined) {
    const state = await portState(wanted)
    if (state === 'free') return wanted
    throw new UiError(
      state === 'denied'
        ? `port ${wanted} needs other permissions; pick one above 1023`
        : `port ${wanted} is in use`,
    )
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 50; port++)
    if ((await portState(port)) === 'free') return port
  throw new UiError(`no free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + 49}`)
}

/**
 * The environment of the app process. Database and sign-in settings of the user's shell are dropped (on
 * the user's machine the app always runs in local mode), and so are Next's internal switches.
 */
export function serverEnv(
  base: NodeJS.ProcessEnv,
  { port, instance, projects }: { port: number; instance: string; projects: UiProject[] },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base))
    if (
      !/^(DATABASE_URL|BETTER_AUTH_|GITHUB_CLIENT_|ACCORD_UI_|ACCORD_PROJECTS$|PORT$|HOSTNAME$|NEXT_PRIVATE_|__NEXT_)/.test(
        key,
      )
    )
      env[key] = value
  return {
    ...env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    HOSTNAME: HOST,
    ACCORD_PROJECTS: JSON.stringify(projects),
    ACCORD_UI_INSTANCE: instance,
    ACCORD_UI_HOSTS: `${HOST}:${port},localhost:${port}`,
  }
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['explorer.exe', [url]] // no shell: the code's characters need no quoting
        : ['xdg-open', [url]]
  const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/** Waits until the app answers as this instance (its guard echoes the instance id). */
async function waitUntilUp(
  port: number,
  instance: string,
  child: ChildProcess,
  timeout: number,
  signal: AbortSignal | undefined,
  log: () => string,
) {
  const until = Date.now() + timeout
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  while (Date.now() < until) {
    if (signal?.aborted) throw new UiError('stopped while starting')
    if (exited) throw new UiError(`the app stopped while starting:\n${log()}`)
    const answer = await fetch(`http://${HOST}:${port}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    }).then(
      (r) => r.headers.get('x-accord-ui'),
      () => null,
    )
    if (answer === instance) return
    if (answer !== null) throw new UiError(`another program answers on port ${port}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new UiError(`the app did not start within ${Math.round(timeout / 1000)} s:\n${log()}`)
}

/**
 * Calls `gone` once the process `pid` no longer exists. `accord ui` passes its own pid: between it and this
 * launcher there may be npx, so no pipe or IPC channel links the two, and a hard kill of the CLI would
 * otherwise leave the app running.
 */
export function watchParent(pid: number, gone: () => void, everyMs = 2000): () => void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch (error) {
      // EPERM: the process exists but belongs to someone else. Everything else: it is gone.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      clearInterval(timer)
      gone()
    }
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

const secret = () => randomBytes(32).toString('base64url')

/** Start the web app for the given repositories on 127.0.0.1 and return its address with a one-time code. */
export async function startUi(options: StartOptions = {}): Promise<RunningUi> {
  if (!existsSync(APP_SERVER)) throw new UiError(`the app bundle is missing (${APP_SERVER})`)
  const projects = projectsFor(options.roots?.length ? options.roots : [process.cwd()])
  const port = await choosePort(options.port)
  const instance = secret()
  const child = spawn(process.execPath, ['--import', PRELOAD, APP_SERVER], {
    env: serverEnv(process.env, { port, instance, projects }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  let output = ''
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const path = projects.length === 1 ? `/p/${projects[0]?.slug}` : '/'
  const newUrl = () => {
    const code = secret()
    child.send({ type: 'code', code })
    return `http://${HOST}:${port}${path}?t=${code}`
  }
  try {
    await waitUntilUp(port, instance, child, options.timeout ?? 30_000, options.signal, () => output.trim())
  } catch (error) {
    stop()
    throw error
  }
  const url = newUrl()
  if (options.open !== false) openBrowser(url)
  return { url, port, projects, newUrl, exited, stop }
}
