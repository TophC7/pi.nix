import type { Database } from 'bun:sqlite'
import type { Basis, EdgeType, StoredClaim, StoredEdge } from './types.ts'

export interface SessionGraph {
  readonly sessionId: string
  readonly nodes: Map<string, StoredClaim>
  readonly outgoing: Map<string, StoredEdge[]>
  readonly incoming: Map<string, StoredEdge[]>
}

export function loadSessionGraph(db: Database, sessionId: string): SessionGraph {
  const claims = db.query('SELECT * FROM reasoning_claims WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as StoredClaim[]
  const edges = db.query('SELECT * FROM reasoning_edges WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as StoredEdge[]
  const nodes = new Map(claims.map((claim) => [claim.id, claim]))
  const outgoing = new Map<string, StoredEdge[]>()
  const incoming = new Map<string, StoredEdge[]>()
  for (const edge of edges) {
    if (!nodes.has(edge.from_claim) || !nodes.has(edge.to_claim)) continue
    push(outgoing, edge.from_claim, edge)
    push(incoming, edge.to_claim, edge)
  }
  return { sessionId, nodes, outgoing, incoming }
}

export function nodesByBasis(graph: SessionGraph, bases: readonly Basis[]): StoredClaim[] {
  return [...graph.nodes.values()].filter((node) => bases.includes(node.basis))
}

export function downstreamCount(graph: SessionGraph, claimId: string, types: readonly EdgeType[] = ['supports', 'depends_on']): number {
  return (graph.incoming.get(claimId) ?? []).filter((edge) => types.includes(edge.type)).length
}

export function longestChainNodesFrom(graph: SessionGraph, claimId: string, types: readonly EdgeType[]): string[] {
  const visit = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id)) return [id]
    const nextSeen = new Set(seen).add(id)
    const edges = (graph.outgoing.get(id) ?? []).filter((edge) => types.includes(edge.type))
    let best = [id]
    for (const edge of edges) {
      const chain = [id, ...visit(edge.to_claim, nextSeen)]
      if (chain.length > best.length) best = chain
    }
    return best
  }
  return visit(claimId, new Set())
}

export function chainHasChallenge(graph: SessionGraph, chain: readonly string[]): boolean {
  const ids = new Set(chain)
  for (const id of chain) {
    for (const edge of graph.outgoing.get(id) ?? []) if ((edge.type === 'contradicts' || edge.type === 'questions') && ids.has(edge.to_claim)) return true
    for (const edge of graph.incoming.get(id) ?? []) if ((edge.type === 'contradicts' || edge.type === 'questions') && ids.has(edge.from_claim)) return true
  }
  return false
}

export function chainHasMidChainChallenge(graph: SessionGraph, chain: readonly string[]): boolean {
  if (chain.length < 3) return false
  const middle = new Set(chain.slice(1, -1))
  for (const id of middle) {
    for (const edge of [...(graph.outgoing.get(id) ?? []), ...(graph.incoming.get(id) ?? [])]) {
      if (edge.type === 'contradicts' || edge.type === 'questions') return true
    }
  }
  return false
}

function push(map: Map<string, StoredEdge[]>, key: string, value: StoredEdge): void {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}

