// ## STATUS ## //
// Publishes the active-spec entry into the shared UI status store. Slab and
// any other footer/widget consumers read from this store. Cleared when no
// spec is active.

import { clearUiOwner, publishStatus, publishWidget } from '@pi/lib/ui'

export const STATUS_OWNER = 'sdd'
const STATUS_ID = 'sdd:active-spec'
const WIDGET_ID = 'sdd:active-spec-widget'

export interface ActiveSpecStatus {
  slug: string
  title: string
  status: 'draft' | 'verified' | 'shipped'
}

export function publishActiveSpec(active: ActiveSpecStatus): void {
  publishStatus({
    id: STATUS_ID,
    owner: STATUS_OWNER,
    text: `spec:${active.slug} · ${active.status}`,
    label: 'Active spec',
    priority: 'high',
    order: 30,
    staleAfterMs: 10 * 60_000
  })
  publishWidget({
    id: WIDGET_ID,
    owner: STATUS_OWNER,
    placement: 'aboveEditor',
    content: [`Active spec: ${active.title}`, `slug: ${active.slug} · status: ${active.status}`],
    priority: 'high',
    order: 30,
    staleAfterMs: 10 * 60_000
  })
}

export function clearActiveSpec(): void {
  clearUiOwner(STATUS_OWNER)
}
