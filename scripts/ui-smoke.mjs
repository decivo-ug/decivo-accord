#!/usr/bin/env node
// Starts the built web app like `accord ui` does and checks the basics, on any system (CI runs it on
// Windows): the printed address works once, nothing answers without it, and stopping frees the port.
//   node scripts/ui-smoke.mjs
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = 4398
const child = spawn(
  process.execPath,
  [
    join(root, 'packages', 'ui', 'dist', 'bin.js'),
    join(root, 'examples', 'demo', 'project'),
    '--no-open',
    '--port',
    String(port),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
let out = ''
child.stdout.on('data', (d) => {
  out += d
})
child.stderr.on('data', (d) => {
  out += d
})
const fail = (message) => {
  console.error(`ui-smoke: ${message}\n${out}`)
  child.kill()
  process.exit(1)
}
const timer = setTimeout(() => fail('no address within 60 s'), 60_000)
const url = await new Promise((resolve) => {
  const look = () => {
    const found = out.match(/http:\/\/127\.0\.0\.1:\d+\S+/)?.[0]
    if (found) resolve(found)
    else setTimeout(look, 100)
  }
  look()
})
clearTimeout(timer)
const bare = url.replace(/\?t=.*/, '')
const status = async (address, init) => (await fetch(address, { redirect: 'manual', ...init })).status
if ((await status(bare)) !== 401) fail('answers without the code')
const opened = await fetch(url, { redirect: 'manual' })
if (opened.status !== 303) fail(`opening the address gave ${opened.status}`)
const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0]
if ((await status(url)) !== 401) fail('the address works twice')
if ((await status(bare, { headers: { cookie } })) !== 200) fail('the page does not load with the session')
child.kill()
await new Promise((r) => setTimeout(r, 3000))
const still = await fetch(bare).then(
  () => true,
  () => false,
)
if (still) fail('the web server keeps running after the launcher stopped')
console.log('ui-smoke: ok')
process.exit(0)
