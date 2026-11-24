export default function extension(pi) {
  pi.registerTool({
    name: 'meters_to_cm',
    label: '米转厘米',
    description: '将整数米数换算为厘米',
    parameters: {
      type: 'object', additionalProperties: false, required: ['meters'],
      properties: { meters: { type: 'integer', minimum: -1000000, maximum: 1000000 } }
    },
    async execute(_toolCallId, { meters }, signal) {
      signal?.throwIfAborted()
      return { content: [{ type: 'text', text: String(meters * 100) }], details: { unit: 'cm' } }
    }
  })
}
