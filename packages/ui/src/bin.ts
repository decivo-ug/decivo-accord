#!/usr/bin/env node
import { openBrowser, startUi, UiError, watchParent } from './index.js'

/** `accord-ui [folder …] [--port <n>] [--no-open]`; `accord ui` in the CLI starts the same. */
const args = process.argv.slice(2)
const roots: string[] = []
let port: number | undefined
let open = true
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string
  if (a === '--no-open') open = false
  else if (a === '--port') port = Number(args[++i])
  else if (a.startsWith('--port=')) port = Number(a.slice(7))
  else if (a === '-h' || a === '--help') {
    console.log('accord-ui [folder …] [--port <n>] [--no-open]')
    process.exit(0)
  } else roots.push(a)
}
if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
  console.error('accord-ui: --port needs a number between 1 and 65535')
  process.exit(2)
}

const de = /^de/i.test(process.env.ACCORD_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? '')
const say = (text: { de: string; en: string }) => console.log(de ? text.de : text.en)

// Signals count from the first moment: a Ctrl+C while the app starts must not leave it running.
const abort = new AbortController()
let stopping = false
const stopAll = () => {
  stopping = true
  abort.abort()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stopAll)
// Started by `accord ui`: stop with it, also when it was killed hard and could pass no signal on.
const parent = Number(process.env.ACCORD_UI_PARENT_PID)
if (Number.isInteger(parent) && parent > 1) watchParent(parent, stopAll)

try {
  const ui = await startUi({ roots, port, open, signal: abort.signal })
  abort.signal.addEventListener('abort', () => ui.stop(), { once: true })
  if (stopping) ui.stop()
  const names = ui.projects.map((p) => p.name).join(', ')
  say({
    de: `decivo Accord · ${names}\n  ${ui.url}\n  Nur auf diesem Rechner. Die Adresse gilt einmal; Enter gibt eine neue aus. Strg+C beendet.`,
    en: `decivo Accord · ${names}\n  ${ui.url}\n  Only on this machine. The address works once; Enter prints a new one. Ctrl+C stops it.`,
  })
  // Enter: a new one-time address (another browser, a closed tab), opened like the first one.
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (!chunk.includes('\n') && !chunk.includes('\r')) return
      const next = ui.newUrl()
      console.log(`  ${next}`)
      if (open) openBrowser(next)
    })
  }
  const code = await ui.exited
  if (!stopping) {
    say({
      de: `accord-ui: Die Oberfläche hat sich unerwartet beendet (Code ${code ?? '–'}).`,
      en: `accord-ui: the web app stopped unexpectedly (code ${code ?? '–'}).`,
    })
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  if (stopping) process.exit(0)
  const message = error instanceof Error ? error.message : String(error)
  console.error(`accord-ui: ${message}`)
  process.exit(error instanceof UiError ? 1 : 2)
}
