import { App } from '@modelcontextprotocol/ext-apps'

export const host = new App(
  { name: 'FlowTest-Lite', version: '0.3.1' },
  { availableDisplayModes: ['fullscreen'] },
  { autoResize: false, strict: true },
)

export async function call<T>(name: string, args: Record<string, unknown> = {}, timeout = 25_000): Promise<T> {
  const result = await host.callServerTool({ name, arguments: args }, { timeout })
  if (result.isError || !result.structuredContent) {
    const message = result.content?.find((item) => item.type === 'text')?.text
    throw new Error(message || 'FlowTest-Lite 未返回结果。')
  }
  return result.structuredContent as T
}
