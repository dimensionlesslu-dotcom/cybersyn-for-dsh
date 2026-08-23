import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-client-connection'
import { JsonlWorkflowStore } from './persistence.ts'
import { createRpcHandler } from './rpc.ts'
import { registerTools } from './tools.ts'

export const name = 'project-cybersyn-dsh-plugin'
export const inject = ['tools', 'skills']

const SUPPORTED_DSH_TOOLS_VERSION = '0.1.1-rc.2'

export interface Config {
  stateFile?: string
  workspaceCapacity?: number
  maxPromptChars?: number
  l4MinimumModels?: number
  registerBundledSkill?: boolean
}

export const Config: z<Config> = z.object({
  stateFile: z.string(),
  workspaceCapacity: z.natural().min(1).default(6),
  maxPromptChars: z.natural().min(1).default(24_000),
  l4MinimumModels: z.natural().min(1).default(3),
  registerBundledSkill: z.boolean().default(true),
})

function assertHarnessVersion(): void {
  const require = createRequire(import.meta.url)
  const pkg = require('@deepseek-ai/dsh-tools/package.json') as { version?: unknown }
  if (pkg.version !== SUPPORTED_DSH_TOOLS_VERSION) {
    throw new Error(`project-cybersyn supports @deepseek-ai/dsh-tools ${SUPPORTED_DSH_TOOLS_VERSION}; found ${String(pkg.version)}`)
  }
}

export async function apply(ctx: Context, rawConfig: Config = {}): Promise<void> {
  assertHarnessVersion()
  const config = {
    workspaceCapacity: rawConfig.workspaceCapacity ?? 6,
    maxPromptChars: rawConfig.maxPromptChars ?? 24_000,
    l4MinimumModels: rawConfig.l4MinimumModels ?? 3,
  }
  const stateFile = resolve(rawConfig.stateFile ?? '.dsh/cybersyn/events.jsonl')
  const store = new JsonlWorkflowStore(stateFile)
  await store.initialize()

  registerTools(store, config, tool => ctx.tools.register(tool))
  if (rawConfig.registerBundledSkill ?? true) {
    const skillUrl = new URL('../skill/project-cybersyn/SKILL.md', import.meta.url)
    const content = await readFile(skillUrl, 'utf8')
    ctx.skills.register({
      name: 'project-cybersyn',
      description: 'Evidence-first L1-L4 closed-loop control with explicit decomposition, J-workspace coordination, and human prompt governance.',
      source: 'runtime',
      content,
    })
  }

  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () => scope.connection.rpc.handle('/cybersyn', createRpcHandler(store), { authority: 'loopback' }),
      'project-cybersyn: loopback human-control RPC',
    )
  })
}

export * from './domain/types.ts'
export * from './domain/engine.ts'
export * from './domain/audit.ts'
export * from './persistence.ts'
export { createRpcHandler } from './rpc.ts'
