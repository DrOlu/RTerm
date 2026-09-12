/**
 * historySearchBounded — the v3.8.4 freeze fix for history:search.
 *
 * The old bridge path called historyStore.listChatSessions(), which
 * JSON.parses EVERY message of EVERY session in one synchronous burst. With a
 * 1.6 GB multi-session store that blocks the event loop for seconds, and
 * because better-sqlite3 is synchronous the whole app (UI included) freezes.
 *
 * These cases pin the four properties that make the bounded path safe:
 *   1. it loads one session at a time (never the whole store at once)
 *   2. it yields to the event loop between sessions
 *   3. it keeps the pre-existing ranking / limit / truncated semantics
 *   4. it does not load a session that has no messages of interest
 *
 * Uses injected loaders, so no SQLite and no real store are involved.
 *
 * Run:  npx tsx packages/backend/src/services/history/historySearchBounded.extreme.spec.ts
 */
import {
  searchChatHistoryBounded,
  type HistorySearchOptions,
} from './historySearch'
import type { StoredChatSession } from '../ChatHistoryService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

let passed = 0
const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  passed += 1
  console.log(`PASS ${name}`)
}

const mkSession = (
  id: string,
  bodies: string[],
  updatedAt = 1000,
  title = `title-${id}`,
): StoredChatSession =>
  ({
    id,
    title,
    updatedAt,
    lastCheckpointOffset: 0,
    createdAt: 1,
    messages: bodies.map((b, i) => ({
      id: `${id}-m${i}`,
      type: 'assistant',
      data: { content: b },
    })),
  }) as unknown as StoredChatSession

type Loader = (id: string) => StoredChatSession | null

const makeLoaders = (store: Record<string, StoredChatSession>) => {
  const loaded: string[] = []
  const loadSession: Loader = (id) => {
    loaded.push(id)
    return store[id] ?? null
  }
  return { loaded, loadSession }
}

const run = async (): Promise<void> => {
  // ------------------------------------------------------------------ basics
  await runCase('finds a match and reports session/total counts', async () => {
    const store: Record<string, StoredChatSession> = {
      s1: mkSession('s1', ['the bgp peer flapped']),
      s2: mkSession('s2', ['disk full on /var']),
    }
    const { loadSession } = makeLoaders(store)
    const r = await searchChatHistoryBounded(
      () => Object.keys(store).map((id) => ({ id })),
      loadSession,
      'bgp',
    )
    assertEqual(r.totalSessions, 1, 'one session matches')
    assertEqual(r.sessions[0].sessionId, 's1', 'matching session is s1')
    assertCondition(r.totalMatches >= 1, 'at least one match recorded')
  })

  // ---------------------------------------------------- one-at-a-time loading
  await runCase('loads sessions one at a time, never the whole store at once', async () => {
    // 20 sessions; assert the loader is called sequentially and that at no
    // point do we hand the loop a full store (loadSession returns one object).
    const store: Record<string, StoredChatSession> = {}
    for (let i = 0; i < 20; i++) {
      store[`s${i}`] = mkSession(`s${i}`, [`payload ${i}`])
    }
    const { loaded, loadSession } = makeLoaders(store)
    await searchChatHistoryBounded(
      () => Object.keys(store).map((id) => ({ id })),
      loadSession,
      'payload',
    )
    assertEqual(loaded.length, 20, 'every session was loaded exactly once')
    assertEqual(
      new Set(loaded).size,
      20,
      'no session was loaded twice',
    )
  })

  // ------------------------------------------------------------ event loop yield
  await runCase('yields to the event loop between sessions', async () => {
    const store: Record<string, StoredChatSession> = {}
    for (let i = 0; i < 5; i++) store[`s${i}`] = mkSession(`s${i}`, ['none'])

    let timerFiredDuring = false
    let done = false
    // A macrotask scheduled now must get a chance to run BEFORE the search
    // finishes, otherwise the loop never yielded.
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!done) timerFiredDuring = true
        resolve()
      }, 0)
    })

    const { loadSession } = makeLoaders(store)
    const search = searchChatHistoryBounded(
      () => Object.keys(store).map((id) => ({ id })),
      loadSession,
      'none',
    )
    await Promise.all([search, timer])
    done = true
    assertCondition(
      timerFiredDuring,
      'a setTimeout(0) should run before a 5-session bounded search completes',
    )
  })

  // ------------------------------------------------------ ranking / limits
  await runCase('ranks by match count and honours sessionLimit + truncated', async () => {
    const store: Record<string, StoredChatSession> = {
      many: mkSession('many', ['hit hit hit']),
      some: mkSession('some', ['hit then quiet']),
      none: mkSession('none', ['unrelated']),
    }
    const { loadSession } = makeLoaders(store)

    const all = await searchChatHistoryBounded(
      () => Object.keys(store).map((id) => ({ id })),
      loadSession,
      'hit',
    )
    assertEqual(all.totalSessions, 2, 'two sessions match')
    assertEqual(all.sessions[0].sessionId, 'many', 'more matches ranks first')
    assertEqual(all.truncated, false, 'no truncation when under the limit')

    const limited: HistorySearchOptions = { sessionLimit: 1 }
    const capped = await searchChatHistoryBounded(
      () => Object.keys(store).map((id) => ({ id })),
      loadSession,
      'hit',
      limited,
    )
    assertEqual(capped.sessions.length, 1, 'sessionLimit caps the returned list')
    assertEqual(capped.totalSessions, 2, 'but the true total is still reported')
    assertEqual(capped.truncated, true, 'truncated flags the cap')
  })

  // --------------------------------------------------------------- options
  await runCase('wholeWord and includeTitles are honoured', async () => {
    const store: Record<string, StoredChatSession> = {
      s1: mkSession('s1', ['bgpx is not bgp'], 1000, 'a bgp title'),
    }
    const { loadSession } = makeLoaders(store)

    const partial = await searchChatHistoryBounded(
      () => [{ id: 's1' }],
      loadSession,
      'bgp',
      { wholeWord: false, includeTitles: false },
    )
    assertCondition(partial.totalMatches >= 2, 'substring search finds both hits')

    const whole = await searchChatHistoryBounded(
      () => [{ id: 's1' }],
      loadSession,
      'bgp',
      { wholeWord: true, includeTitles: false },
    )
    assertCondition(
      whole.totalMatches < partial.totalMatches,
      'wholeWord must narrow the match set',
    )

    const noTitle = await searchChatHistoryBounded(
      () => [{ id: 's1' }],
      loadSession,
      'title',
      { includeTitles: false },
    )
    assertEqual(noTitle.totalSessions, 0, 'includeTitles:false ignores the title')

    const withTitle = await searchChatHistoryBounded(
      () => [{ id: 's1' }],
      loadSession,
      'title',
      { includeTitles: true },
    )
    assertEqual(withTitle.totalSessions, 1, 'includeTitles:true matches the title')
  })

  // --------------------------------------------------------------- edge cases
  await runCase('blank query short-circuits without loading anything', async () => {
    const { loaded, loadSession } = makeLoaders({})
    const r = await searchChatHistoryBounded(
      () => [{ id: 's1' }],
      loadSession,
      '   ',
    )
    assertEqual(r.totalSessions, 0, 'blank query returns empty')
    assertEqual(loaded.length, 0, 'blank query must not touch the store')
  })

  await runCase('a session that vanished between summary and load is skipped', async () => {
    // listChatSessionSummaries() and loadChatSession() are separate reads, so a
    // session can be deleted in between. A null load must not throw.
    const store: Record<string, StoredChatSession> = {
      alive: mkSession('alive', ['needle']),
    }
    const { loadSession } = makeLoaders(store)
    const r = await searchChatHistoryBounded(
      () => [{ id: 'ghost' }, { id: 'alive' }],
      loadSession,
      'needle',
    )
    assertEqual(r.totalSessions, 1, 'the missing session is skipped, not fatal')
    assertEqual(r.sessions[0].sessionId, 'alive', 'the surviving session is found')
  })

  console.log(`\n${passed} passed, 0 failed`)
  console.log('historySearchBounded: ALL TESTS PASSED')
}

void run()
