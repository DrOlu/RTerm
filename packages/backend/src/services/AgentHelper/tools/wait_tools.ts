import { z } from 'zod'
import type { ToolExecutionContext } from '../types'

export const waitSchema = z.object({
  seconds: z.number().min(5).max(120).describe('Number of seconds to wait (5-120)')
})

export const waitTerminalIdleSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to monitor')
})

export async function wait(args: z.infer<typeof waitSchema>, context: ToolExecutionContext): Promise<string> {
  const { sessionId, messageId, sendEvent } = context
  const { seconds } = args

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    title: 'Wait',
    hint: `Waiting for ${seconds}s...`,
    input: JSON.stringify(args)
  })

  const waitResult = await waitWithSignalOrQueuedInsertion(
    seconds * 1000,
    context.signal,
    context.waitForQueuedInsertion
  )

  if (waitResult === 'queued_insertion') {
    context.markWaitInterruptedByQueuedInsertion?.()
    const result = 'Wait ended early because a queued agent notification became available.'
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: result
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })
    return result
  }

  const result = `Waited for ${seconds} seconds.`
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })
  return result
}

export async function waitTerminalIdle(
  args: z.infer<typeof waitTerminalIdleSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    return found.length > 1
      ? `Error: Multiple terminal tabs found with name "${tabIdOrName}".`
      : `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'wait_terminal_idle',
    title: `Waiting on ${bestMatch.title || bestMatch.id}`,
    hint: ''
  })

  let lastContent = ''
  let stableCount = 0
  const maxWaitSeconds = 120
  let elapsed = 0

  while (elapsed < maxWaitSeconds) {
    abortIfNeeded(context.signal)
    const currentContent = terminalService.getRecentOutput(bestMatch.id)

    if (currentContent === lastContent && currentContent !== '') {
      stableCount++
    } else {
      stableCount = 0
      lastContent = currentContent
    }

    if (stableCount >= 4) {
      const finalOutput = terminalService.getRecentOutput(bestMatch.id)
      const successMsg = `The terminal has stabilized. The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
<terminal_content>
${finalOutput}
</terminal_content>`
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_delta',
        outputDelta: successMsg
      })
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_finished'
      })
      return successMsg
    }

    await waitWithSignal(1000, context.signal)
    elapsed++
  }

  const currentOutput = terminalService.getRecentOutput(bestMatch.id)
  const timeoutMsg = `Wait timeout: The terminal has been running for over 120s and is still not idle. Please check if the task is still running correctly. If you need to continue waiting, run this tool again. If you need to stop it, use write_stdin (e.g., Ctrl+C). The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
<terminal_content>
${currentOutput}
</terminal_content>`
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_delta',
    outputDelta: timeoutMsg
  })

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })

  return timeoutMsg
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AbortError')
  }
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function waitWithSignalOrQueuedInsertion(
  ms: number,
  signal: AbortSignal | undefined,
  waitForQueuedInsertion?: (signal?: AbortSignal) => Promise<boolean>
): Promise<'timer' | 'queued_insertion'> {
  if (!waitForQueuedInsertion) {
    return waitWithSignal(ms, signal).then(() => 'timer' as const)
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }

    let settled = false
    const queuedInsertionController = new AbortController()
    const timer = setTimeout(() => {
      finish('timer')
    }, ms)

    function cleanup() {
      clearTimeout(timer)
      queuedInsertionController.abort()
      signal?.removeEventListener('abort', onAbort)
    }
    function finish(reason: 'timer' | 'queued_insertion') {
      if (settled) return
      settled = true
      cleanup()
      resolve(reason)
    }
    function fail(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onAbort() {
      fail(new Error('AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    waitForQueuedInsertion(queuedInsertionController.signal)
      .then((available) => {
        if (available) {
          finish('queued_insertion')
        }
      })
      .catch((error) => {
        if (settled || queuedInsertionController.signal.aborted) return
        fail(error instanceof Error ? error : new Error(String(error)))
      })
  })
}
