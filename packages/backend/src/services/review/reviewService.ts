/**
 * reviewService — the maker/checker pattern for RTerm's agent.
 *
 * The action model (maker) produces output. The review model (checker)
 * independently verifies it for correctness, completeness, safety, compliance,
 * and accuracy. If no reviewModelId is specified in the profile, reviews are
 * skipped entirely (fast output mode).
 *
 * The review model's verdict:
 *   - approved: the action is correct, complete, safe, compliant, accurate
 *   - needs_revision: the action has issues that need fixing (route back to maker)
 *   - escalate: the action has serious issues (route to human operator)
 *
 * Pure + injectable: the review model runner is injected; the evaluation logic
 * is pure and fully testable.
 */

export type ReviewVerdict = 'approved' | 'needs_revision' | 'escalate'

export interface ReviewIssue {
  /** the dimension of the issue. */
  dimension: 'correctness' | 'completeness' | 'safety' | 'compliance' | 'accuracy'
  /** the severity. */
  severity: 'info' | 'warning' | 'critical'
  /** the issue description. */
  message: string
}

export interface ReviewResult {
  /** the verdict. */
  verdict: ReviewVerdict
  /** the issues found (if any). */
  issues: ReviewIssue[]
  /** the confidence in the verdict (0-1). */
  confidence: number
  /** the review model's reasoning. */
  reasoning: string
  /** the review model's identity (for audit). */
  reviewerId: string
  /** whether the review was skipped (no reviewModelId). */
  skipped: boolean
}

export interface ReviewAction {
  /** the action type (e.g., 'restart', 'patch', 'deploy', 'delete'). */
  type: string
  /** the target (e.g., 'web-01', 'prod-db-01'). */
  target?: string
  /** the command to execute (e.g., 'systemctl restart nginx'). */
  command?: string
  /** the user's original request. */
  userRequest?: string
}

export interface ReviewServiceDeps {
  /** run the review model (injected LLM runner). */
  runReviewModel: (prompt: string) => Promise<{ verdict: ReviewVerdict; issues: ReviewIssue[]; reasoning: string; confidence: number }>
  /** the review model's identity (e.g., 'claude-sonnet-4.6'). */
  reviewerId?: string
  /** the review mode: strict (block on any issue), advisory (flag but allow), auto-approve (skip review for low-risk actions). */
  reviewMode?: 'strict' | 'advisory' | 'auto-approve'
}

export class ReviewService {
  private readonly reviewerId: string
  private readonly reviewMode: 'strict' | 'advisory' | 'auto-approve'

  constructor(private readonly deps: ReviewServiceDeps) {
    this.reviewerId = deps.reviewerId ?? 'review-model'
    this.reviewMode = deps.reviewMode ?? 'strict'
  }

  /** Review an action. Returns the review result. */
  async review(action: ReviewAction): Promise<ReviewResult> {
    // Auto-approve mode: skip review for low-risk actions.
    if (this.reviewMode === 'auto-approve' && this.isLowRisk(action)) {
      return {
        verdict: 'approved',
        issues: [],
        confidence: 1.0,
        reasoning: 'auto-approved (low-risk action)',
        reviewerId: this.reviewerId,
        skipped: true,
      }
    }

    const prompt = this.buildReviewPrompt(action)
    const result = await this.deps.runReviewModel(prompt)

    // Post-process the verdict based on the review mode.
    let verdict = result.verdict
    if (this.reviewMode === 'advisory' && verdict === 'escalate') {
      verdict = 'needs_revision' // advisory mode downgrades escalate to needs_revision
    }

    return {
      verdict,
      issues: result.issues ?? [],
      confidence: result.confidence ?? 0.5,
      reasoning: result.reasoning ?? '',
      reviewerId: this.reviewerId,
      skipped: false,
    }
  }

  /** Check if an action is low-risk (for auto-approve mode). */
  private isLowRisk(action: ReviewAction): boolean {
    const type = action.type.toLowerCase()
    const target = (action.target ?? '').toLowerCase()
    // Low-risk: read-only actions, non-prod targets, status checks.
    if (['read', 'status', 'list', 'show', 'get', 'describe', 'check'].some((w) => type.includes(w))) return true
    if (target.includes('dev') || target.includes('staging') || target.includes('test')) return true
    return false
  }

  /** Build the review prompt for the review model. */
  private buildReviewPrompt(action: ReviewAction): string {
    return `You are a review model. Independently verify the following action for correctness, completeness, safety, compliance, and accuracy.

Action type: ${action.type}
Target: ${action.target ?? 'unknown'}
Command: ${action.command ?? 'none'}
User request: ${action.userRequest ?? 'unknown'}

Evaluate the action on 5 dimensions:
1. Correctness: Is this the right action for the user's intent?
2. Completeness: Does this action fully address the user's request?
3. Safety: Is this action safe (not destructive, not harmful)?
4. Compliance: Does this action comply with policy?
5. Accuracy: Is the information in this action accurate?

Return your verdict: approved, needs_revision, or escalate, with issues and reasoning.`
  }
}

/** Pure: create a skipped review result (no reviewModelId specified). */
export function createSkippedReviewResult(): ReviewResult {
  return {
    verdict: 'approved',
    issues: [],
    confidence: 1.0,
    reasoning: 'review skipped (no reviewModelId specified)',
    reviewerId: 'none',
    skipped: true,
  }
}

/** Pure: check if a review should be skipped (no reviewModelId). */
export function shouldSkipReview(reviewModelId?: string): boolean {
  return !reviewModelId || reviewModelId.trim() === ''
}
