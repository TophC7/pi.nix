import { homedir } from 'node:os'
import { basename } from 'node:path'
import { visibleWidth } from '@earendil-works/pi-tui'
import { fitLine, formatTokenCount } from '@pi/lib/ui'
import type { SlabWorkspaceLabelMode } from './types.ts'

const SMART_NAME_MAX_SURFACE_WIDTH = 83
const SMART_PARENT_MAX_SURFACE_WIDTH = 139
const HOME_PATH = normalizePath(homedir())

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return '?'
  return count < 0 ? `-${formatTokenCount(Math.abs(count))}` : formatTokenCount(count)
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.000'
  if (cost < 0.001) return '<$0.001'
  if (cost < 1) return `$${cost.toFixed(3)}`
  if (cost < 10) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(1)}`
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '?'
  return percent >= 10 ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`
}

export function shortenModel(modelId: string | undefined, customNames: Record<string, string> = {}): string {
  if (!modelId) return 'no-model'
  for (const [pattern, name] of Object.entries(customNames)) {
    if (modelId.includes(pattern)) return name
  }
  return (
    modelId
      .replace(/^claude-/, '')
      .replace(/^anthropic[/:]/, '')
      .replace(/-20\d{6,8}$/, '')
      .replace(/-latest$/, '')
      .replace(/-/g, ' ')
      .replace(/\bsonnet\b/i, 'Sonnet')
      .replace(/\bopus\b/i, 'Opus')
      .replace(/\bhaiku\b/i, 'Haiku')
      .replace(/\bgpt\b/i, 'GPT')
      .replace(/\bglm\b/i, 'GLM')
      .trim() || modelId
  )
}

export function displayDirectory(cwd: string): string {
  if (!cwd) return '?'
  return basename(cwd) || cwd
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '') || path
}

function splitPathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function safeHomePath(cwd: string): string {
  const normalized = normalizePath(cwd)
  if (!normalized) return '?'
  if (HOME_PATH && normalized === HOME_PATH) return '~'
  if (HOME_PATH && normalized.startsWith(`${HOME_PATH}/`)) return `~/${normalized.slice(HOME_PATH.length + 1)}`
  const parts = splitPathParts(normalized)
  if (parts.length === 0) return 'root'
  if (parts.length === 1) return displayDirectory(normalized)
  return `…/${parts.slice(-Math.min(3, parts.length)).join('/')}`
}

function truncatePlainToWidth(text: string, width: number): string {
  return fitLine(text, width)
}

function fitSafePath(label: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(label) <= width) return label
  const parts = label.split('/').filter(Boolean)
  const name = parts.at(-1) ?? label
  if (visibleWidth(name) >= width) return truncatePlainToWidth(name, width)
  const tail = `…/${name}`
  if (visibleWidth(tail) <= width) return tail
  return truncatePlainToWidth(name, width)
}

function parentPathLabel(safePath: string): string {
  const parts = splitPathParts(safePath)
  if (parts.length < 2) return safePath
  return `…/${parts.slice(-2).join('/')}`
}

export function formatWorkspaceLabel(
  cwd: string,
  name: string,
  mode: SlabWorkspaceLabelMode,
  width: number,
  surfaceWidth = width
): string {
  const fallback = name || displayDirectory(cwd) || 'workspace'
  const budget = Math.max(1, width)
  if (mode === 'name') return fitSafePath(fallback, budget)

  const safePath = safeHomePath(cwd)
  if (mode === 'smart') {
    if (surfaceWidth <= SMART_NAME_MAX_SURFACE_WIDTH) return fitSafePath(fallback, budget)
    if (surfaceWidth <= SMART_PARENT_MAX_SURFACE_WIDTH) return fitSafePath(parentPathLabel(safePath), budget)
  }
  return fitSafePath(safePath, budget)
}
