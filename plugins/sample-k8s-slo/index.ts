/**
 * Sample plugin — Kubernetes SLO tracker.
 *
 * Demonstrates the RTerm plugin system: it registers an agent tool (evaluate a
 * service's SLO from pod health), an event-driven trigger (pod CrashLoopBackOff),
 * and a dashboard panel (the k8s SLO board). RTerm discovers this folder, loads
 * it, calls register(ctx) with RTerm's services, and the capabilities appear
 * automatically — the agent can then call k8s_slo_evaluate, and the trigger fires
 * when a pod crashloops.
 */
import type { PluginContext } from '../../packages/backend/src/services/plugin/pluginRegistry'

export function register(ctx: PluginContext): void {
  ctx.log('[sample-k8s-slo] registering')

  // Agent tool: evaluate a service's SLO from its pods.
  ctx.registerTool({
    name: 'k8s_slo_evaluate',
    description: 'Evaluate a Kubernetes service SLO (SLI + error budget + burn rate) from its pod health.',
    handler: async (args: Record<string, unknown>) => {
      const service = String(args.service ?? 'default')
      // In a real plugin this would run `kubectl get pods` via ctx.exec and compute.
      // Here we return a structured stub so the agent can reason about it.
      return {
        service,
        sli: 0.9992,
        errorBudgetRemaining: 0.62,
        burnRate: 0.38,
        fastBurning: false,
        podsReady: '12/13',
        note: 'computed by the sample-k8s-slo plugin',
      }
    },
  })

  // Agent tool: list pods with high restart counts.
  ctx.registerTool({
    name: 'k8s_pod_restarts',
    description: 'List Kubernetes pods with a restart count above a threshold.',
    handler: async (args: Record<string, unknown>) => {
      const min = Number(args.minRestarts ?? 5)
      return { threshold: min, pods: [{ name: 'cache-5b7a2', restarts: 12, ready: false }], note: 'computed by the sample-k8s-slo plugin' }
    },
  })

  // Trigger: fire a critical alert when a pod crashloops.
  ctx.registerTrigger({
    name: 'k8s-pod-crashloop',
    kind: 'pattern',
    match: 'CrashLoopBackOff',
    action: 'critical-alert',
  })

  // Dashboard panel: the k8s SLO board.
  ctx.registerPanel('k8s-slo-board', async () => {
    return '<h3>Kubernetes SLO Board</h3><p>Rendered by the sample-k8s-slo plugin.</p>'
  })
}
