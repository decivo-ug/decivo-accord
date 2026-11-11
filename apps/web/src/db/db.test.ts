import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import { auditLog, proposal, repository } from './schema'

describe('database schema', () => {
  const client = new PGlite()
  const db = drizzle(client)

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
  })

  it('stores a proposal with its evaluation', async () => {
    const [repo] = await db
      .insert(repository)
      .values({ slug: 'decivo', fullName: 'decivo-ug/decivo' })
      .returning()
    if (!repo) throw new Error('no repository')
    await db.insert(proposal).values({
      repositoryId: repo.id,
      key: 'P-20261012-landing',
      title: 'Landing',
      source: 'claude-design',
      intent: 'proposal',
      route: 'owner',
      decider: 'design',
      risk: 'high',
      confidence: 1,
      evaluation: { reasons: [{ code: 'must_violation', detail: { decision: 'D-004' } }] },
    })
    const [row] = await db.select().from(proposal).where(eq(proposal.key, 'P-20261012-landing'))
    expect(row).toMatchObject({ status: 'open', route: 'owner', decider: 'design' })
  })

  it('refuses to change or delete audit entries', async () => {
    const [entry] = await db
      .insert(auditLog)
      .values({ actor: 'dana', action: 'accept', subject: 'P-1' })
      .returning()
    if (!entry) throw new Error('no entry')
    await expect(
      db.update(auditLog).set({ action: 'reject' }).where(eq(auditLog.id, entry.id)),
    ).rejects.toThrow()
    await expect(db.delete(auditLog).where(eq(auditLog.id, entry.id))).rejects.toThrow()
  })
})
