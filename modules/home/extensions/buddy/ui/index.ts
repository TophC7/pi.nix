import { publishWidget } from '@pi/lib/ui'
import { renderBuddyInput } from './render.ts'

const OWNER = 'buddy'
const INPUT_WIDGET_ID = 'buddy:input'

export function publishBuddyWidgets(): void {
  publishWidget({
    id: INPUT_WIDGET_ID,
    owner: OWNER,
    placement: 'inputRight',
    priority: 'high',
    order: 0,
    schedule: { animateEveryMs: 600 },
    content: (context) => renderBuddyInput(context)
  })
}

export { renderBuddyInput }
