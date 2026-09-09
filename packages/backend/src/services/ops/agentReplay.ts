/**
 * Replay an agent run with tools stubbed (v3.8.0).
 */

export interface ReplayStep {
  tool: string
  args: Record<string, unknown>
  stub: string
}

export interface ReplayResult {
  runId: string
  steps: Array<{ tool: string; usedStub: boolean; output: string }>
  wouldHaveCalled: string[]
}

export function replayWithStubs(runId: string, steps: ReplayStep[]): ReplayResult {
  return {
    runId,
    steps: steps.map((s) => ({
      tool: s.tool,
      usedStub: true,
      output: s.stub,
    })),
    wouldHaveCalled: steps.map((s) => s.tool),
  }
}

export function breakpointBefore(tool: string, nextTool: string): boolean {
  return tool === nextTool
}
