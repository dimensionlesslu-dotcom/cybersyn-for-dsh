import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('standalone pure Skill', () => {
  it('satisfies the skill-creator frontmatter and placeholder rules', async () => {
    const content = await readFile(resolve('skill/project-cybersyn/SKILL.md'), 'utf8')
    if (existsSync(resolve('../protocol/control-policy.json')) && existsSync(resolve('../SKILL.md'))) {
      expect(content).toBe(await readFile(resolve('../SKILL.md'), 'utf8'))
    }
    const policy = JSON.parse(await readFile(resolve('protocol/control-policy.json'), 'utf8'))
    expect(policy.version).toBe('3.0.0')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
    expect(match).not.toBeNull()
    const frontmatter = match![1]!
    const keys = [...frontmatter.matchAll(/^([a-zA-Z0-9-]+):/gm)].map(item => item[1])
    expect(keys).toEqual(['name', 'description', 'metadata'])
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(name!.length).toBeLessThanOrEqual(64)
    expect(description).toBeTruthy()
    expect(description!.length).toBeLessThanOrEqual(1024)
    expect(description).not.toMatch(/[<>]/)
    expect(content).not.toMatch(/^\s{0,3}\[TODO:[^\n]*\]\s*$/m)
    await expect(readFile(resolve('skill/project-cybersyn/references/runtime-protocol.md'), 'utf8')).resolves.toContain('J-workspace boundary')
  })
})
