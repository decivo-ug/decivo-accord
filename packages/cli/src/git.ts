import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AccordError } from './errors.js'

const exec = promisify(execFile)

/** Run git for a step that must succeed; a failure becomes a sentence with git's own reason. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd })
    return stdout
  } catch (error) {
    const e = error as { code?: string | number; stderr?: string; message?: string }
    if (e.code === 'ENOENT') throw new AccordError('error.gitMissing')
    // git may print warnings first (line endings on Windows); the reason is the first line that is none.
    const lines = (e.stderr || e.message || '').trim().split('\n').filter(Boolean)
    const reason = lines.find((l) => !/^(warning|hint):/i.test(l)) ?? lines[0] ?? ''
    throw new AccordError('error.git', {
      command: `git ${args[0]}`,
      message: reason.replace(/^fatal:\s*/, ''),
    })
  }
}

/**
 * Create and switch to a new branch. An existing branch (the same proposal made twice) is named plainly
 * instead of git's own error: its commit is already there.
 */
export async function createBranch(cwd: string, branch: string): Promise<void> {
  const exists = await git(cwd, ['branch', '--list', branch]).catch(() => '')
  if (exists.trim()) throw new AccordError('error.branchExists', { branch })
  await git(cwd, ['checkout', '-b', branch])
}
