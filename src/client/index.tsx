import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Dashboard, type DashboardInjected } from './Dashboard.tsx'
import type { CybersynRpcResult } from '../rpc.ts'

export const name = 'project-cybersyn-dsh-plugin/client'
export const inject = ['slots', 'connection']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'project-cybersyn',
    order: 20,
    label: 'Cybersyn',
    inject: (sessionId: SessionId): DashboardInjected => {
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) throw new Error('project-cybersyn client requires the Connection service')
      return {
        canEdit: connection.isLoopback,
        rpc: async (endpoint, payload) => connection.rpc.call('/cybersyn', endpoint, payload) as Promise<CybersynRpcResult>,
      }
    },
  }, Dashboard))
}

export { Dashboard, WorkflowGraph } from './Dashboard.tsx'
export { layoutGraph } from './layout.ts'
