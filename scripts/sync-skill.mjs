import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(packageRoot, '..')
const resources = ['SKILL.md', 'references/tools-mode.md', 'references/harness-mode.md', 'references/subagent-validation.md', 'protocol/control-policy.json']
const targetFor = name => name.startsWith('protocol/') ? join(packageRoot, name) : join(packageRoot, 'skill/project-cybersyn', name)
const hasParentSource = existsSync(join(sourceRoot, 'protocol/control-policy.json')) && existsSync(join(sourceRoot, 'SKILL.md'))
for (const name of resources) {
  const target = targetFor(name)
  if (hasParentSource) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(sourceRoot, name), target)
  } else if (!existsSync(target)) {
    throw new Error(`Missing committed standalone resource: ${name}`)
  }
}
