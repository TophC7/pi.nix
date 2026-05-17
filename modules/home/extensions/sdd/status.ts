// ## STATUS ## //
// Publishes the active-spec entry into the shared UI status store. Slab and
// any other footer consumers read from this store. Cleared when no spec is
// active.

import { clearUiOwner, publishStatus } from '@pi/lib/ui'

export const STATUS_OWNER = 'sdd'
const STATUS_ID = 'sdd:active-spec'
const SPEC_STATUS_ICON = '󰈙'

export interface ActiveSpecStatus {
  slug: string
  title: string
  status: 'draft' | 'verified' | 'shipped'
}

export function publishActiveSpec(active: ActiveSpecStatus): void {
  publishStatus({
    id: STATUS_ID,
    owner: STATUS_OWNER,
    icon: SPEC_STATUS_ICON,
    text: `${active.slug}:${active.status}`,
    priority: 'high',
    order: 30,
    staleAfterMs: 10 * 60_000
  })
}

export function clearActiveSpec(): void {
  clearUiOwner(STATUS_OWNER)
}
