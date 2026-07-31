import { REASONING_CONFIG } from './config.ts'
import {
  chainHasChallenge,
  chainHasMidChainChallenge,
  downstreamCount,
  longestChainNodesFrom,
  nodesByBasis,
  type SessionGraph
} from './graph.ts'
import type { Finding } from './types.ts'

export function detectLoadBearingVibes(graph: SessionGraph): Finding[] {
  return nodesByBasis(graph, ['vibes', 'assumption'])
    .map((node) => ({ node, count: downstreamCount(graph, node.id) }))
    .filter(({ count }) => count >= REASONING_CONFIG.LOAD_BEARING_MIN_DOWNSTREAM)
    .sort((a, b) => b.count - a.count)
    .map(
      ({ node, count }) =>
        ({
          type: 'load_bearing_vibes',
          anchor_claim_id: node.id,
          claim_text: node.text,
          downstream_count: count
        }) as Finding
    )
}

export function detectUnchallengedChain(graph: SessionGraph): Finding[] {
  const byAnchor = new Map<string, Finding>()
  for (const node of graph.nodes.values()) {
    const chain = longestChainNodesFrom(graph, node.id, ['supports', 'depends_on'])
    if (chain.length < REASONING_CONFIG.UNCHALLENGED_CHAIN_MIN_LENGTH) continue
    if (chainHasChallenge(graph, chain)) continue
    const head = graph.nodes.get(chain[0]!)!
    const finding: Finding = {
      type: 'unchallenged_chain',
      anchor_claim_id: head.id,
      claim_text: head.text,
      chain_length: chain.length
    }
    const current = byAnchor.get(head.id)
    if (!current || (finding.chain_length ?? 0) > (current.chain_length ?? 0)) byAnchor.set(head.id, finding)
  }
  return [...byAnchor.values()].sort((a, b) => (b.chain_length ?? 0) - (a.chain_length ?? 0))
}

export function detectEchoChamber(graph: SessionGraph): Finding[] {
  const out: Finding[] = []
  for (const node of graph.nodes.values()) {
    if (node.speaker !== 'user') continue
    if (node.basis !== 'vibes' && node.basis !== 'assumption') continue
    const incoming = graph.incoming.get(node.id) ?? []
    const supports = incoming.filter(
      (edge) => edge.type === 'supports' && graph.nodes.get(edge.from_claim)?.speaker === 'assistant'
    ).length
    const questions = incoming.some(
      (edge) => edge.type === 'questions' && graph.nodes.get(edge.from_claim)?.speaker === 'assistant'
    )
    if (supports >= REASONING_CONFIG.ECHO_CHAMBER_MIN_SUPPORTS && !questions)
      out.push({
        type: 'echo_chamber',
        anchor_claim_id: node.id,
        claim_text: node.text,
        downstream_count: supports
      })
  }
  return out.sort((a, b) => (b.downstream_count ?? 0) - (a.downstream_count ?? 0))
}

const HEDGE_PATTERN = /\b(?:likely|probably|presumably|i suspect|most likely)\b/i

export function detectUnverifiedHedge(graph: SessionGraph): Finding[] {
  const out: Finding[] = []
  for (const node of graph.nodes.values()) {
    if (node.speaker !== 'assistant') continue
    if (node.basis === 'vibes' || node.basis === 'assumption') continue
    if (node.confidence === 'low') continue
    if (!HEDGE_PATTERN.test(node.text)) continue
    out.push({
      type: 'unverified_hedge',
      anchor_claim_id: node.id,
      claim_text: node.text
    })
  }
  return out
}

export function detectWellSourcedLoadBearer(graph: SessionGraph): Finding[] {
  return nodesByBasis(graph, ['research', 'empirical', 'deduction'])
    .map((node) => ({ node, count: downstreamCount(graph, node.id) }))
    .filter(({ count }) => count >= REASONING_CONFIG.WELL_SOURCED_MIN_DOWNSTREAM)
    .sort((a, b) => b.count - a.count)
    .map(
      ({ node, count }) =>
        ({
          type: 'well_sourced_load_bearer',
          anchor_claim_id: node.id,
          claim_text: node.text,
          downstream_count: count
        }) as Finding
    )
}

export function detectProductiveStressTest(graph: SessionGraph): Finding[] {
  const out: Finding[] = []
  for (const node of graph.nodes.values()) {
    const chain = longestChainNodesFrom(graph, node.id, ['supports', 'depends_on'])
    if (chain.length < REASONING_CONFIG.PRODUCTIVE_STRESS_MIN_CHAIN) continue
    if (!chainHasMidChainChallenge(graph, chain)) continue
    const head = graph.nodes.get(chain[0]!)!
    out.push({
      type: 'productive_stress_test',
      anchor_claim_id: head.id,
      claim_text: head.text,
      chain_length: chain.length
    })
  }
  return out.sort((a, b) => (b.chain_length ?? 0) - (a.chain_length ?? 0))
}

export function detectGroundedPremiseAdopted(graph: SessionGraph): Finding[] {
  const out: Finding[] = []
  for (const node of graph.nodes.values()) {
    if (node.speaker !== 'user') continue
    if (node.basis !== 'research' && node.basis !== 'empirical') continue
    const supports = (graph.incoming.get(node.id) ?? []).filter(
      (edge) => edge.type === 'supports' && graph.nodes.get(edge.from_claim)?.speaker === 'assistant'
    ).length
    if (supports >= REASONING_CONFIG.GROUNDED_PREMISE_MIN_SUPPORTS)
      out.push({
        type: 'grounded_premise_adopted',
        anchor_claim_id: node.id,
        claim_text: node.text,
        downstream_count: supports
      })
  }
  return out.sort((a, b) => (b.downstream_count ?? 0) - (a.downstream_count ?? 0))
}

export const DETECTOR_SUITE = [
  detectLoadBearingVibes,
  detectUnchallengedChain,
  detectEchoChamber,
  detectUnverifiedHedge,
  detectWellSourcedLoadBearer,
  detectProductiveStressTest,
  detectGroundedPremiseAdopted
] as const

export function runAllDetectors(graph: SessionGraph): Finding[] {
  if (graph.nodes.size < REASONING_CONFIG.COLD_START_MIN_CLAIMS) return []
  return DETECTOR_SUITE.flatMap((detector) => detector(graph))
}
