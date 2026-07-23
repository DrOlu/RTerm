import { ReviewService, createSkippedReviewResult, shouldSkipReview } from './reviewService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- shouldSkipReview ----
test('shouldSkipReview: returns true when reviewModelId is undefined', () => {
  if (!shouldSkipReview(undefined)) throw new Error('should skip when undefined')
})
test('shouldSkipReview: returns true when reviewModelId is empty string', () => {
  if (!shouldSkipReview('')) throw new Error('should skip when empty')
})
test('shouldSkipReview: returns false when reviewModelId is set', () => {
  if (shouldSkipReview('claude-sonnet-4.6')) throw new Error('should not skip when set')
})

// ---- createSkippedReviewResult ----
test('createSkippedReviewResult: returns approved with skipped=true', () => {
  const r = createSkippedReviewResult()
  if (r.verdict !== 'approved') throw new Error('should be approved')
  if (r.skipped !== true) throw new Error('should be skipped')
  if (r.confidence !== 1.0) throw new Error('should be 1.0 confidence')
})

// ---- ReviewService.review: strict mode ----
test('review: strict mode approves a correct action', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'strict',
  })
  const r = await svc.review({ type: 'restart', target: 'web-01', command: 'systemctl restart nginx', userRequest: 'restart nginx' })
  if (r.verdict !== 'approved') throw new Error(`expected approved, got ${r.verdict}`)
  if (r.reviewerId !== 'test-reviewer') throw new Error('reviewerId')
  if (r.skipped !== false) throw new Error('should not be skipped')
})

test('review: strict mode flags needs_revision for a questionable action', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'needs_revision', issues: [{ dimension: 'correctness', severity: 'warning', message: 'wrong command' }], reasoning: 'wrong command', confidence: 0.7 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'strict',
  })
  const r = await svc.review({ type: 'restart', target: 'web-01', command: 'systemctl stop nginx', userRequest: 'restart nginx' })
  if (r.verdict !== 'needs_revision') throw new Error(`expected needs_revision, got ${r.verdict}`)
  if (r.issues.length !== 1) throw new Error('should have 1 issue')
  if (r.issues[0].dimension !== 'correctness') throw new Error('issue dimension')
})

test('review: strict mode escalates for a dangerous action', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'escalate', issues: [{ dimension: 'safety', severity: 'critical', message: 'destructive' }], reasoning: 'destructive', confidence: 0.9 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'strict',
  })
  const r = await svc.review({ type: 'delete', target: 'prod-db-01', command: 'rm -rf /data', userRequest: 'delete the database' })
  if (r.verdict !== 'escalate') throw new Error(`expected escalate, got ${r.verdict}`)
  if (r.issues[0].severity !== 'critical') throw new Error('issue severity')
})

// ---- ReviewService.review: advisory mode ----
test('review: advisory mode downgrades escalate to needs_revision', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'escalate', issues: [{ dimension: 'safety', severity: 'critical', message: 'destructive' }], reasoning: 'destructive', confidence: 0.9 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'advisory',
  })
  const r = await svc.review({ type: 'delete', target: 'prod-db-01', command: 'rm -rf /data', userRequest: 'delete the database' })
  if (r.verdict !== 'needs_revision') throw new Error(`expected needs_revision (advisory downgrade), got ${r.verdict}`)
})

// ---- ReviewService.review: auto-approve mode ----
test('review: auto-approve mode skips low-risk actions', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => { throw new Error('should not be called') },
    reviewerId: 'test-reviewer',
    reviewMode: 'auto-approve',
  })
  const r = await svc.review({ type: 'status', target: 'web-01', command: 'systemctl status nginx', userRequest: 'check nginx status' })
  if (r.verdict !== 'approved') throw new Error('should be approved')
  if (r.skipped !== true) throw new Error('should be skipped (auto-approve)')
})

test('review: auto-approve mode reviews high-risk actions', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'auto-approve',
  })
  const r = await svc.review({ type: 'delete', target: 'prod-db-01', command: 'rm -rf /data', userRequest: 'delete the database' })
  if (r.verdict !== 'approved') throw new Error('should be approved (model returned approved)')
  if (r.skipped !== false) throw new Error('should not be skipped (high-risk)')
})

// ---- ReviewService.review: accuracy dimension ----
test('review: flags accuracy issues', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'needs_revision', issues: [{ dimension: 'accuracy', severity: 'warning', message: 'wrong version number' }], reasoning: 'version mismatch', confidence: 0.8 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'strict',
  })
  const r = await svc.review({ type: 'patch', target: 'web-01', command: 'yum update nginx-1.20', userRequest: 'patch nginx to 1.22' })
  if (r.verdict !== 'needs_revision') throw new Error(`expected needs_revision, got ${r.verdict}`)
  if (r.issues[0].dimension !== 'accuracy') throw new Error('should flag accuracy')
})

// ---- ReviewService.review: all 5 dimensions ----
test('review: checks all 5 dimensions', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'needs_revision', issues: [
      { dimension: 'correctness', severity: 'warning', message: 'wrong command' },
      { dimension: 'completeness', severity: 'info', message: 'missing step' },
      { dimension: 'safety', severity: 'critical', message: 'destructive' },
      { dimension: 'compliance', severity: 'warning', message: 'policy violation' },
      { dimension: 'accuracy', severity: 'info', message: 'wrong version' },
    ], reasoning: 'multiple issues', confidence: 0.6 }),
    reviewerId: 'test-reviewer',
    reviewMode: 'strict',
  })
  const r = await svc.review({ type: 'delete', target: 'prod-db-01', command: 'rm -rf /data', userRequest: 'delete the database' })
  if (r.issues.length !== 5) throw new Error(`expected 5 issues, got ${r.issues.length}`)
  const dimensions = r.issues.map((i) => i.dimension)
  for (const d of ['correctness', 'completeness', 'safety', 'compliance', 'accuracy']) {
    if (!dimensions.includes(d as any)) throw new Error(`missing dimension ${d}`)
  }
})

// ---- ReviewService.review: default reviewerId and reviewMode ----
test('review: uses default reviewerId when not specified', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
  })
  const r = await svc.review({ type: 'status', target: 'web-01', command: 'systemctl status nginx' })
  if (r.reviewerId !== 'review-model') throw new Error(`expected default reviewerId, got ${r.reviewerId}`)
})

test('review: uses default reviewMode (strict) when not specified', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'escalate', issues: [], reasoning: 'dangerous', confidence: 0.9 }),
  })
  const r = await svc.review({ type: 'delete', target: 'prod-db-01', command: 'rm -rf /data' })
  if (r.verdict !== 'escalate') throw new Error(`expected escalate (strict default), got ${r.verdict}`)
})

// ---- ReviewService.review: result shape ----
test('review: result has all required fields', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
    reviewerId: 'test-reviewer',
  })
  const r = await svc.review({ type: 'status', target: 'web-01', command: 'systemctl status nginx' })
  if (typeof r.verdict !== 'string') throw new Error('verdict')
  if (!Array.isArray(r.issues)) throw new Error('issues')
  if (typeof r.confidence !== 'number') throw new Error('confidence')
  if (typeof r.reasoning !== 'string') throw new Error('reasoning')
  if (typeof r.reviewerId !== 'string') throw new Error('reviewerId')
  if (typeof r.skipped !== 'boolean') throw new Error('skipped')
})

// ---- ReviewService.review: edge cases ----
test('review: handles missing optional fields in action', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
  })
  const r = await svc.review({ type: 'status' })
  if (r.verdict !== 'approved') throw new Error('should approve minimal action')
})

test('review: handles empty issues array from model', async () => {
  const svc = new ReviewService({
    runReviewModel: async () => ({ verdict: 'approved', issues: [], reasoning: 'correct', confidence: 0.95 }),
  })
  const r = await svc.review({ type: 'status', target: 'web-01', command: 'systemctl status nginx' })
  if (r.issues.length !== 0) throw new Error('should have 0 issues')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
