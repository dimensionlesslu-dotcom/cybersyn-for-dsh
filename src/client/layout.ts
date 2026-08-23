import type { ControlTask } from '../domain/types.ts'

export interface GraphNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface GraphEdge {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GraphLayout {
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export function layoutGraph(tasks: readonly ControlTask[]): GraphLayout {
  const nodeWidth = 220
  const nodeHeight = 76
  const xGap = 54
  const yGap = 28
  const margin = 22
  const rows = new Map<number, number>()
  const nodes = tasks.map(task => {
    const row = rows.get(task.depth) ?? 0
    rows.set(task.depth, row + 1)
    return {
      id: task.id,
      x: margin + (task.depth - 1) * (nodeWidth + xGap),
      y: margin + row * (nodeHeight + yGap),
      width: nodeWidth,
      height: nodeHeight,
    }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges: GraphEdge[] = []
  for (const task of tasks) {
    const to = byId.get(task.id)
    if (to === undefined) continue
    for (const dependency of task.dependsOn) {
      const from = byId.get(dependency)
      if (from === undefined) continue
      edges.push({
        from: dependency,
        to: task.id,
        x1: from.x + from.width,
        y1: from.y + from.height / 2,
        x2: to.x,
        y2: to.y + to.height / 2,
      })
    }
  }
  const maxRows = Math.max(1, ...rows.values())
  const maxDepth = Math.max(1, ...tasks.map(task => task.depth))
  return {
    width: margin * 2 + maxDepth * nodeWidth + (maxDepth - 1) * xGap,
    height: margin * 2 + maxRows * nodeHeight + (maxRows - 1) * yGap,
    nodes,
    edges,
  }
}
