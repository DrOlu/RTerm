import { HumanMessage } from '@langchain/core/messages'
import { buildDynamicRequestHistory } from './model_messages'

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('text-only dynamic history strips image parts without mutating persisted content', () => {
    const originalContent = [
      { type: 'text', text: 'Look at this chart.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ]
    const message = new HumanMessage(originalContent as any)

    const sanitized = buildDynamicRequestHistory([message], { modelSupportsImage: false })
    const sanitizedContent = sanitized[0]?.content

    assert(typeof sanitizedContent === 'string', 'sanitized text-only content should collapse to string')
    assertEqual(
      sanitizedContent as string,
      'Look at this chart.',
      'sanitized text should preserve the original text payload'
    )
    assert(Array.isArray(message.content), 'original persisted message content should remain structured')
    assertEqual(
      ((message.content as any[])[1] as any)?.type,
      'image_url',
      'original persisted message should keep its image part'
    )
  })

  await runCase('image-only history becomes a text placeholder for text-only models', () => {
    const message = new HumanMessage([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }
    ] as any)

    const sanitized = buildDynamicRequestHistory([message], { modelSupportsImage: false })
    const sanitizedContent = sanitized[0]?.content

    assert(typeof sanitizedContent === 'string', 'image-only content should become a string placeholder')
    assert(
      String(sanitizedContent).includes('target model does not support image inputs'),
      'placeholder should explain why image content was removed'
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
