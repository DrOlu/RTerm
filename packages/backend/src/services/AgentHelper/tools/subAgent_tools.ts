import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import { abortIfNeeded } from './terminal_tools'

export const spawnSubAgentsSchema = z.object({
  tasks: z
    .array(
      z.object({
        label: z.string().min(1).describe('Short label for reporting, e.g. "server-1"'),
        prompt: z.string().min(1).describe('The self-contained prompt for the child agent.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('The tasks to fan out. Each child gets its own session. Max 20.'),
  maxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Max children running concurrently (default 3).'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Per-child timeout in ms (default 300000 = 5 minutes).'),
})

/**
 * spawn_subagents (v3.2.18) — fan work out to concurrent child agent sessions.
 *
 * The agent loop is linear; this tool lets the model parallelize independent
 * work ("check all 6 servers and summarize") by spawning child sessions that
 * run concurrently, each with a scoped prompt. Results are collected into a
 * single summary. Failures and timeouts become failed results — one bad child
 * never kills the others.
 *
 * Guards: max 20 tasks per fan-out, per-child timeout (default 5 min),
 * concurrency cap (default 3).
 */
export async function spawnSubAgents(
  args: z.infer<typeof spawnSubAgentsSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  abortIfNeeded(context.signal)

  const { sendEvent, sessionId, messageId } = context
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'spawn_subagents',
    title: `Fan out ${args.tasks.length} sub-agent(s)`,
    hint: `concurrency ${args.maxConcurrent ?? 3}`,
    input: JSON.stringify(args),
  })

  const finish = (output: string): string => {
    sendEvent(sessionId, { messageId, type: 'sub_tool_delta', outputDelta: output })
    sendEvent(sessionId, { messageId, type: 'sub_tool_finished' })
    return output
  }

  try {
    const { validateSubAgentSpec, runSubAgents, renderSubAgentSummary } = await import(
      '../utils/subAgent'
    )

    const validation = validateSubAgentSpec(args)
    if (!validation.ok) {
      return finish(`Invalid sub-agent spec: ${validation.error}`)
    }

    // Each child runs in its own session via the agent service.
    const agentService = (context as any).agentService as {
      startTask?: (input: { sessionId: string; userInput: string }) => Promise<unknown>
      createSession?: () => Promise<{ sessionId: string }>
    } | undefined

    if (!agentService?.startTask) {
      return finish(
        'Sub-agent delegation is not available in this runtime (no agent service bridge).',
      )
    }

    const summary = await runSubAgents(
      {
        tasks: args.tasks.map((t) => ({ label: t.label, prompt: t.prompt })),
        maxConcurrent: args.maxConcurrent,
        timeoutMs: args.timeoutMs,
      },
      async (task) => {
        // Create a fresh child session and run the prompt to completion.
        const childSession = await agentService.createSession!()
        const result = await agentService.startTask!({
          sessionId: childSession.sessionId,
          userInput: task.prompt,
        })
        // The blocking startTask returns the final answer.
        const text =
          typeof result === 'string'
            ? result
            : String((result as { answer?: string; output?: string })?.answer ??
              (result as { output?: string })?.output ??
              result)
        return text
      },
    )

    return finish(renderSubAgentSummary(summary))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return finish(`Sub-agent fan-out failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
