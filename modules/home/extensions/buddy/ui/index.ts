import { clearUiOwner, publishWidget } from '@pi/lib/ui'
import { renderBuddyFooter, renderBuddyInput } from './render.ts'

const OWNER = 'buddy'
const INPUT_WIDGET_ID = 'buddy:input'
const FOOTER_WIDGET_ID = 'buddy:footer'

export function publishBuddyWidgets(): void {
  clearUiOwner(OWNER)
  publishWidget({
    id: INPUT_WIDGET_ID,
    owner: OWNER,
    placement: 'inputRight',
    priority: 'high',
    order: 0,
    schedule: { animateEveryMs: 600 },
    content: (context) => renderBuddyInput(context)
  })
  publishWidget({
    id: FOOTER_WIDGET_ID,
    owner: OWNER,
    placement: 'footerRight',
    priority: 'high',
    order: 0,
    schedule: { animateEveryMs: 600 },
    content: (context) => renderBuddyFooter(context)
  })
}

export { renderBuddyFooter, renderBuddyInput }
