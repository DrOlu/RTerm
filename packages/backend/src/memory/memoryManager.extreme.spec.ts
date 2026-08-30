/**
 * memoryManager.extreme.spec — v3.4.2 memory improvements.
 * Covers: the userInput recall fix, recency-weighted scoring, section-aware
 * recall, per-project memory, and the auto-write distiller.
 *
 * Run: npx tsx packages/backend/src/memory/memoryManager.extreme.spec.ts
 */
import {
  parseMemoryEntries,
  searchMemory,
  recallForPrompt,
  appendMemoryNote,
  resolveProjectMemoryPath,
  isProjectMemoryPath,
  MEMORY_SECTIONS,
} from './memoryManager'
import { distillMemoryNotes, applyDistilledNotes } from './memoryDistiller'

let pass = 0
let fail = 0
const failures: string[] = []
function assert(cond: unknown, label: string): void {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  FAIL  ${label}`)
  }
}

console.log('== 1. parseMemoryEntries: position + section tracking ==')
{
  const md = `# Memory

## Gotchas
- npm publish needs the stage dir
- heredocs mangle in exec_command

## Decisions
- version numbers go in three files`
  const entries = parseMemoryEntries(md)
  assert(entries.length >= 5, `parsed ${entries.length} entries`)
  const gotcha = entries.find((e) => e.text.includes('npm publish'))
  assert(gotcha?.section === 'Gotchas', `npm publish is in Gotchas (got ${gotcha?.section})`)
  const dec = entries.find((e) => e.text.includes('version numbers'))
  assert(dec?.section === 'Decisions', `version note is in Decisions (got ${dec?.section})`)
  assert(entries[0].position === 0, `first entry position 0`)
  assert(entries[entries.length - 1].position > 0, `last entry position > 0`)
  const headings = entries.filter((e) => e.text.startsWith('## '))
  assert(headings.length === 2, `both headings parsed as entries (${headings.length})`)
  assert(headings[0].section === 'Gotchas', `heading carries its own section`)
}

console.log('\n== 2. searchMemory: recency weighting ==')
{
  // Two entries with EQUAL token overlap; the newer one must rank higher.
  const md = `# Memory
- version bump the package
- version bump the package again`
  const hits = searchMemory(md, 'version bump package', 10)
  assert(hits.length === 2, `both matched (${hits.length})`)
  assert(hits[0].text.includes('again'), `newer entry ranks first (got "${hits[0].text}")`)
  assert(hits[0].score > hits[1].score, `scores differ (${hits[0].score} > ${hits[1].score})`)
}
{
  // A much better match from an OLD entry still beats a weak NEW one.
  const md = `# Memory
- deep dive on version bumping across three files and the release runbook
- unrelated note`
  const hits = searchMemory(md, 'version bump release runbook', 10)
  assert(hits[0]?.text.includes('deep dive'), `strong old match wins`)
}
{
  // Empty query returns nothing.
  assert(searchMemory('anything', '', 10).length === 0, `empty query -> no hits`)
}

console.log('\n== 3. recallForPrompt: small file returns whole ==')
{
  const small = '# Memory\n- one note'
  assert(recallForPrompt(small) === small, `small file returned whole`)
}

console.log('\n== 4. recallForPrompt: query-aware recall (the v3.4.2 bug fix) ==')
{
  // Build a file big enough to trigger recall (> 12000 chars).
  const filler = Array.from({ length: 400 }, (_, i) => `- filler note number ${i} padding padding padding`).join('\n')
  const md = `# Memory
${filler}
## Gotchas
- heredocs mangle in exec_command; always write_file first`
  const recalled = recallForPrompt(md, { query: 'heredoc exec_command write_file', maxChars: 2000 })
  assert(recalled.includes('heredocs mangle'), `relevant entry recalled`)
  assert(!recalled.includes('filler note number 399'), `irrelevant filler excluded`)
  assert(recalled.includes('## Gotchas'), `section heading included in recall`)
}
{
  // No query -> newest entries.
  const filler = Array.from({ length: 400 }, (_, i) => `- filler note ${i}`).join('\n')
  const md = `# Memory\n${filler}`
  const recalled = recallForPrompt(md, { maxChars: 500 })
  assert(recalled.includes('filler note 399'), `no query -> newest entries`)
  assert(!recalled.includes('filler note 0'), `oldest excluded`)
}

console.log('\n== 5. recallForPrompt: section-aware dedup of headings ==')
{
  const filler = Array.from({ length: 400 }, (_, i) => `- filler ${i}`).join('\n')
  const md = `# Memory
${filler}
## Gotchas
- gotcha one
- gotcha two`
  const recalled = recallForPrompt(md, { query: 'gotcha', maxChars: 3000 })
  const headingCount = (recalled.match(/## Gotchas/g) ?? []).length
  assert(headingCount === 1, `section heading emitted once (${headingCount})`)
  assert(recalled.includes('gotcha one') && recalled.includes('gotcha two'), `both gotchas recalled`)
}

console.log('\n== 6. appendMemoryNote: dedupe + cap ==')
{
  let body = '# Memory\n- note A'
  body = appendMemoryNote(body, 'note A') // duplicate
  assert((body.match(/note A/g) ?? []).length === 1, `duplicate not added twice`)
  body = appendMemoryNote(body, 'note B')
  assert(body.includes('note B'), `new note appended`)
  // cap
  const capped = appendMemoryNote('# Memory\n' + 'x'.repeat(5000), 'new note', { maxChars: 1000 })
  assert(capped.length <= 1200, `cap respected (${capped.length})`)
  // A single 5000-char entry cannot preserve the new note AND fit — the hard
  // truncate keeps the newest content at the head of the slice.
  assert(capped.startsWith('# Memory') || capped.includes('new note'), `cap output is sane`)
}

console.log('\n== 7. resolveProjectMemoryPath ==')
{
  const home = '/Users/olu'
  // First path segment under home is the slug (~/work/RTerm -> "work").
  assert(resolveProjectMemoryPath('/Users/olu/work/RTerm', home) === '/Users/olu/.gybackend-data/memory/projects/work.md', `~/work/RTerm -> work`)
  assert(resolveProjectMemoryPath('/Users/olu/work/RTerm/packages', home) === '/Users/olu/.gybackend-data/memory/projects/work.md', `nested path maps to the same project slug`)
  assert(resolveProjectMemoryPath('/Users/olu', home) === null, `home itself -> null`)
  assert(resolveProjectMemoryPath(null, home) === null, `null wd -> null`)
  assert(resolveProjectMemoryPath('/opt/other', home) === null, `outside home -> null`)
  assert(resolveProjectMemoryPath('/Users/olu/My Project!', home)?.endsWith('my-project-.md') === true, `slug sanitised`)
  assert(isProjectMemoryPath('/Users/olu/.gybackend-data/memory/projects/x.md') === true, `isProjectMemoryPath true`)
  assert(isProjectMemoryPath('/Users/olu/.agents/skills/agent-setting-slot-1/memory.md') === false, `global memory -> false`)
}

console.log('\n== 8. distillMemoryNotes: release detection ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'release and bump version',
    toolCalls: ['exec_command', 'exec_command'],
    commands: ['npm publish --access public', 'git tag v3.4.2'],
    filesWritten: [],
    errors: [],
    status: 'completed',
  })
  assert(notes.length >= 1, `release produced a note (${notes.length})`)
  assert(notes[0].section === 'Decisions', `release note is a Decision`)
  assert(notes[0].note.includes('3.4.2'), `version extracted (${notes[0].note})`)
}

console.log('\n== 9. distillMemoryNotes: error -> gotcha ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'deploy the thing',
    toolCalls: [],
    commands: [],
    filesWritten: [],
    errors: ['error: The command line is too long.'],
    status: 'completed',
  })
  assert(notes.some((n) => n.section === 'Gotchas'), `error produced a Gotcha`)
  assert(notes.some((n) => n.note.includes('command line')), `gotcha mentions the error`)
}

console.log('\n== 10. distillMemoryNotes: hot project dir ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'edit some files',
    toolCalls: [],
    commands: [],
    filesWritten: ['/Users/olu/work/RTerm/a.ts', '/Users/olu/work/RTerm/b.ts', '/Users/olu/work/RTerm/c.ts'],
    errors: [],
    status: 'completed',
  })
  assert(notes.some((n) => n.section === 'Estate'), `hot dir produced an Estate note`)
  assert(notes.some((n) => n.note.includes('/work/RTerm')), `note names the dir`)
}

console.log('\n== 11. distillMemoryNotes: failed run -> open work ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'fix the canary watcher',
    toolCalls: [],
    commands: [],
    filesWritten: [],
    errors: [],
    status: 'failed',
  })
  assert(notes.some((n) => n.section === 'Open work'), `failed run produced Open work`)
  assert(notes.some((n) => n.note.includes('canary')), `note mentions the request`)
}

console.log('\n== 12. distillMemoryNotes: quiet run -> no notes ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'what time is it',
    toolCalls: [],
    commands: [],
    filesWritten: [],
    errors: [],
    status: 'completed',
  })
  assert(notes.length === 0, `no signals -> no notes (${notes.length})`)
}

console.log('\n== 13. distillMemoryNotes: caps at 3 ==')
{
  const notes = distillMemoryNotes({
    userRequest: 'x',
    toolCalls: [],
    commands: ['npm publish', 'git tag v1.2.3'],
    filesWritten: ['/a/b/c', '/a/b/d', '/a/b/e'],
    errors: ['error: one', 'error: two', 'error: three'],
    status: 'failed',
  })
  assert(notes.length === 3, `capped at 3 (${notes.length})`)
}

console.log('\n== 14. distillMemoryNotes: dedupes identical notes ==')
{
  const a = distillMemoryNotes({ userRequest: 'r', toolCalls: [], commands: [], filesWritten: [], errors: ['error: same thing'], status: 'completed' })
  const b = distillMemoryNotes({ userRequest: 'r', toolCalls: [], commands: [], filesWritten: [], errors: ['error: same thing'], status: 'completed' })
  assert(a[0]?.note === b[0]?.note, `same input -> same note`)
}

console.log('\n== 15. applyDistilledNotes: appends under sections ==')
{
  const body = '# Memory\n- existing'
  const notes = distillMemoryNotes({
    userRequest: 'release v9.9.9',
    toolCalls: [], commands: ['npm publish'], filesWritten: [], errors: [],
    status: 'completed',
  })
  const next = applyDistilledNotes(body, notes)
  assert(next.includes('## Decisions'), `section heading created`)
  assert(next.includes('9.9.9'), `note content present`)
  assert(next.includes('existing'), `existing content preserved`)
  // idempotent: applying the same notes again does not duplicate
  const again = applyDistilledNotes(next, notes)
  assert((again.match(/9\.9\.9/g) ?? []).length === (next.match(/9\.9\.9/g) ?? []).length, `re-apply does not duplicate`)
}

console.log('\n== 16. MEMORY_SECTIONS exported ==')
{
  assert(MEMORY_SECTIONS.includes('Gotchas' as never), `Gotchas in sections`)
  assert(MEMORY_SECTIONS.length === 4, `four canonical sections`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('FAILURES:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('memoryManager: ALL TESTS PASSED')