import type { Api, Model } from '@mariozechner/pi-ai'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { ModelSelectorComponent, SettingsManager, ThinkingSelectorComponent } from '@mariozechner/pi-coding-agent'
import { resolveModel, THINKING_LEVELS, type ThinkingLevel } from './actions'

export async function selectModelFromMenu(ctx: ExtensionCommandContext, current?: string): Promise<string | undefined> {
  const resolvedCurrent = current?.trim() ? resolveModel(ctx, current.trim()) : undefined
  const currentModel = resolvedCurrent && resolvedCurrent !== 'ambiguous' ? resolvedCurrent : ctx.model
  const selected = await ctx.ui.custom<Model<Api> | undefined>(
    (tui, _theme, _keybindings, done) =>
      new ModelSelectorComponent(
        tui,
        currentModel,
        SettingsManager.inMemory(),
        ctx.modelRegistry,
        [],
        (model) => done(model),
        () => done(undefined)
      )
  )

  return selected ? `${selected.provider}/${selected.id}` : undefined
}

export async function selectThinkingFromMenu(
  ctx: ExtensionCommandContext,
  current?: ThinkingLevel
): Promise<ThinkingLevel | undefined> {
  return ctx.ui.custom<ThinkingLevel | undefined>((tui, _theme, _keybindings, done) => {
    const selector = new ThinkingSelectorComponent(
      current ?? 'high',
      [...THINKING_LEVELS],
      (level) => done(level as ThinkingLevel),
      () => done(undefined)
    )
    const selectList = selector.getSelectList()
    return {
      render: (width: number) => selector.render(width),
      invalidate: () => selector.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data)
        tui.requestRender()
      }
    }
  })
}
