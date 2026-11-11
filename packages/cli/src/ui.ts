import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { T } from './messages.js'

/**
 * `accord ui` starts the web app from `@decivo/accord-ui`. That package carries a whole web server
 * (~25 MB), so the CLI does not depend on it: agents and CI running `npx @decivo/accord-cli check` would
 * load it for nothing. An installed copy is used; otherwise npx fetches the same version once.
 */
export const UI_PACKAGE = '@decivo/accord-ui'

/**
 * `dist/bin.js` of an installed `@decivo/accord-ui` in exactly this version, looked up from each base (a
 * file path or URL): next to the CLI first, then in the project. Another version is not taken; the CLI and
 * the app read the same register format.
 */
export function findUiBin(bases: string[], version: string): string | undefined {
  for (const base of bases) {
    try {
      const manifest = createRequire(base).resolve(`${UI_PACKAGE}/package.json`)
      const bin = join(dirname(manifest), 'dist', 'bin.js')
      if (JSON.parse(readFileSync(manifest, 'utf8')).version === version && existsSync(bin)) return bin
    } catch {
      // not installed there
    }
  }
  return undefined
}

export interface UiOptions {
  root: string
  folders: string[]
  port?: number | undefined
  open: boolean
}

export function uiArgs({ root, folders, port, open }: UiOptions): string[] {
  return [
    ...(folders.length > 0 ? folders : [root]).map((f) => resolve(f)),
    ...(port !== undefined ? ['--port', String(port)] : []),
    ...(open ? [] : ['--no-open']),
  ]
}

/**
 * How to run npx. Through node and npm's own npx-cli.js where it sits next to node (the normal install,
 * also on Windows): no shell, so nothing in a path is expanded (`%VAR%`) and a signal reaches npx itself.
 */
export function npxCommand(
  execPath = process.execPath,
  platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): { cmd: string; pre: string[]; shell: boolean } {
  const dir = dirname(execPath)
  for (const cli of [
    join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ])
    if (exists(cli)) return { cmd: execPath, pre: [cli], shell: false }
  // Elsewhere npx is a script on PATH; on Windows a .cmd file, which only runs through the shell.
  return platform === 'win32'
    ? { cmd: 'npx.cmd', pre: [], shell: true }
    : { cmd: 'npx', pre: [], shell: false }
}

const quoteForCmd = (arg: string) => `"${arg.replaceAll('"', '""').replaceAll('%', '%%')}"`

export async function uiCommand(
  o: UiOptions,
  version: string,
  t: T,
  print: (text: string) => void,
): Promise<number> {
  const args = uiArgs(o)
  const installed = findUiBin([import.meta.url, join(resolve(o.root), 'package.json')], version)
  const pkg = `${UI_PACKAGE}@${version}`
  if (!installed) print(t('ui.download', { pkg }))
  const npx = npxCommand()
  const npxArgs = [...npx.pre, '--yes', pkg, ...args]
  // The app watches this process: if it is killed hard, no signal reaches the app (npx may sit between).
  const env = { ...process.env, ACCORD_UI_PARENT_PID: String(process.pid) }
  const child = installed
    ? spawn(process.execPath, [installed, ...args], { stdio: 'inherit', env })
    : // From a neutral folder: a repository's own .npmrc must not redirect where @decivo packages come from.
      spawn(npx.cmd, npx.shell ? npxArgs.map(quoteForCmd) : npxArgs, {
        stdio: 'inherit',
        shell: npx.shell,
        cwd: tmpdir(),
        env,
      })
  // Ctrl+C in a terminal reaches both processes; a signal sent to this process alone (kill, a closed
  // terminal, a process manager) is passed on, so the app never outlives the command.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal)
  }
  for (const s of signals) process.on(s, forward)
  try {
    return await new Promise<number>((done) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') print(t('ui.noNpx', { pkg: UI_PACKAGE }))
        else print(error.message)
        done(1)
      })
      child.once('exit', (code, signal) => done(code ?? (signal ? 0 : 1)))
    })
  } finally {
    for (const s of signals) process.off(s, forward)
  }
}
