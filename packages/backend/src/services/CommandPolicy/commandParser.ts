import { createRequire } from 'module'

let parserPromise: Promise<any> | null = null

export async function getBashParser() {
  if (parserPromise) return parserPromise
  parserPromise = (async () => {
    const { Parser, Language } = await import('web-tree-sitter')
    const require = createRequire(
      typeof __filename !== 'undefined' ? __filename : import.meta.url,
    )
    const treePath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')
    await Parser.init({
      locateFile() {
        return treePath
      }
    })
    const bashPath = require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')
    const bashLanguage = await Language.load(bashPath)
    const p = new Parser()
    p.setLanguage(bashLanguage)
    return p
  })()
  return parserPromise
}
