import { randomUUID } from 'node:crypto'
import extension from './pi-extension.mjs'

export function activate(host) {
  extension({
    registerTool(tool) {
      host.registerTool({
        name: tool.name, description: tool.description, parameters: tool.parameters, risk: 'read',
        async execute(args, ctx) {
          const result = await tool.execute(randomUUID(), args, ctx.signal)
          return { summary: result.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
        }
      })
    }
  })
}
