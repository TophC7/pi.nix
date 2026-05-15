export const BASIS_VALUES = ['research', 'empirical', 'deduction', 'analogy', 'definition', 'llm_output', 'assumption', 'vibes'] as const
export type Basis = (typeof BASIS_VALUES)[number]

export const EDGE_TYPES = ['supports', 'depends_on', 'contradicts', 'questions'] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

export const SPEAKERS = ['user', 'assistant'] as const
export type Speaker = (typeof SPEAKERS)[number]

export const CONFIDENCES = ['low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export interface ClaimInput {
  readonly text: string
  readonly basis: Basis
  readonly speaker: Speaker
  readonly confidence: Confidence
  readonly external_id: string
}

export interface EdgeInput {
  readonly from: string
  readonly to: string
  readonly type: EdgeType
}

export interface StoredClaim {
  readonly id: string
  readonly session_id: string
  readonly speaker: Speaker
  readonly text: string
  readonly basis: Basis
  readonly confidence: Confidence
  readonly created_at: number
}

export interface StoredEdge {
  readonly id: string
  readonly session_id: string
  readonly from_claim: string
  readonly to_claim: string
  readonly type: EdgeType
  readonly created_at: number
}

export const FINDING_TYPES = [
  'load_bearing_vibes',
  'unchallenged_chain',
  'echo_chamber',
  'unverified_hedge',
  'well_sourced_load_bearer',
  'productive_stress_test',
  'grounded_premise_adopted'
] as const
export type FindingType = (typeof FINDING_TYPES)[number]

export const CAUTION_FINDINGS = ['load_bearing_vibes', 'echo_chamber', 'unchallenged_chain', 'unverified_hedge'] as const
export const KUDOS_FINDINGS = ['well_sourced_load_bearer', 'productive_stress_test', 'grounded_premise_adopted'] as const

export interface Finding {
  readonly type: FindingType
  readonly anchor_claim_id: string
  readonly claim_text: string
  readonly downstream_count?: number
  readonly chain_length?: number
}

export function isCaution(type: FindingType): boolean {
  return (CAUTION_FINDINGS as readonly FindingType[]).includes(type)
}

export function isBasis(value: unknown): value is Basis {
  return typeof value === 'string' && (BASIS_VALUES as readonly string[]).includes(value)
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && (EDGE_TYPES as readonly string[]).includes(value)
}

export function isSpeaker(value: unknown): value is Speaker {
  return typeof value === 'string' && (SPEAKERS as readonly string[]).includes(value)
}

export function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCES as readonly string[]).includes(value)
}
