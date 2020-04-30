import { Plugin } from './server'
import path from 'path'
import slash from 'slash'
import LRUCache from 'lru-cache'
import MagicString from 'magic-string'
import { Readable } from 'stream'
import { init as initLexer, parse as parseImports } from 'es-module-lexer'
import { InternalResolver } from './resolver'
import {
  debugHmr,
  importerMap,
  importeeMap,
  ensureMapEntry,
  rewriteFileWithHMR,
  hmrClientPublicPath
} from './serverPluginHmr'

const debug = require('debug')('vite:rewrite')

const rewriteCache = new LRUCache({ max: 1024 })

// Plugin for rewriting served js.
// - Rewrites named module imports to `/@modules/:id` requests, e.g.
//   "vue" => "/@modules/vue"
// - Rewrites HMR `hot.accept` calls to inject the file's own path. e.g.
//   `hot.accept('./dep.js', cb)` -> `hot.accept('/importer.js', './dep.js', cb)`
// - Also tracks importer/importee relationship graph during the rewrite.
//   The graph is used by the HMR plugin to perform analysis on file change.
export const moduleRewritePlugin: Plugin = ({ app, watcher, resolver }) => {
  // bust module rewrite cache on file change
  watcher.on('change', (file) => {
    const publicPath = resolver.fileToRequest(file)
    debug(`${publicPath}: cache busted`)
    rewriteCache.del(publicPath)
  })

  // inject __DEV__ and process.env.NODE_ENV flags
  // since some ESM builds expect these to be replaced by the bundler
  const devInjectionCode =
    `\n<script>` +
    `window.__DEV__ = true\n` +
    `window.process = { env: { NODE_ENV: 'development' }}\n` +
    `</script>\n`

  app.use(async (ctx, next) => {
    await next()

    if (ctx.status === 304) {
      return
    }

    if (ctx.path === '/index.html') {
      const html = await readBody(ctx.body)
      if (rewriteCache.has(html)) {
        debug('/index.html: serving from cache')
        ctx.body = rewriteCache.get(html)
      } else if (ctx.body) {
        await initLexer
        let hasInjectedDevFlag = false
        ctx.body = html.replace(
          /(<script\b[^>]*>)([\s\S]*?)<\/script>/gm,
          (_, openTag, script) => {
            // also inject __DEV__ flag
            const devFlag = hasInjectedDevFlag ? `` : devInjectionCode
            hasInjectedDevFlag = true
            return `${devFlag}${openTag}${rewriteImports(
              script,
              '/index.html',
              resolver
            )}</script>`
          }
        )
        rewriteCache.set(html, ctx.body)
      }
    }

    // we are doing the js rewrite after all other middlewares have finished;
    // this allows us to post-process javascript produced by user middlewares
    // regardless of the extension of the original files.
    if (
      ctx.response.is('js') &&
      !ctx.url.endsWith('.map') &&
      // skip internal client
      !ctx.path.startsWith(`/@hmr`) &&
      // only need to rewrite for <script> part in vue files
      !((ctx.path.endsWith('.vue') || ctx.vue) && ctx.query.type != null)
    ) {
      const content = await readBody(ctx.body)
      if (rewriteCache.has(content)) {
        debug(`${ctx.url}: serving from cache`)
        ctx.body = rewriteCache.get(content)
      } else {
        await initLexer
        ctx.body = rewriteImports(
          content,
          ctx.url.replace(/(&|\?)t=\d+/, ''),
          resolver,
          ctx.query.t
        )
        rewriteCache.set(content, ctx.body)
      }
    } else {
      debug(`not rewriting: ${ctx.url}`)
    }
  })
}

async function readBody(stream: Readable | string): Promise<string> {
  if (stream instanceof Readable) {
    return new Promise((resolve, reject) => {
      let res = ''
      stream
        .on('data', (chunk) => (res += chunk))
        .on('error', reject)
        .on('end', () => {
          resolve(res)
        })
    })
  } else {
    return stream
  }
}

function rewriteImports(
  source: string,
  importer: string,
  resolver: InternalResolver,
  timestamp?: string
) {
  if (typeof source !== 'string') {
    source = String(source)
  }
  try {
    const [imports] = parseImports(source)

    if (imports.length) {
      debug(`${importer}: rewriting`)
      const s = new MagicString(source)
      let hasReplaced = false

      const prevImportees = importeeMap.get(importer)
      const currentImportees = new Set<string>()
      importeeMap.set(importer, currentImportees)

      imports.forEach(({ s: start, e: end, d: dynamicIndex }) => {
        const id = source.substring(start, end)
        if (dynamicIndex === -1) {
          let resolved
          if (/^[^\/\.]/.test(id)) {
            resolved = resolver.idToRequest(id) || `/@modules/${id}`
            if (
              resolved === hmrClientPublicPath &&
              !/.vue$|.vue\?type=/.test(importer)
            ) {
              // the user explicit imports the HMR API in a js file
              // making the module hot.
              rewriteFileWithHMR(source, importer, s)
              // we rewrite the hot.accept call
              hasReplaced = true
            }
          } else {
            const queryRE = /\?.*$/
            let pathname = id.replace(queryRE, '')
            const queryMatch = id.match(queryRE)
            let query = queryMatch ? queryMatch[0] : ''
            // append .js for extension-less imports
            // for now we don't attemp to resolve other extensions
            if (!/\.\w+/.test(pathname)) {
              pathname += '.js'
            }
            // force re-fetch all imports by appending timestamp
            // if this is a hmr refresh request
            if (timestamp) {
              query += `${query ? `&` : `?`}t=${timestamp}`
            }
            resolved = pathname + query
          }

          if (resolved !== id) {
            debug(`    "${id}" --> "${resolved}"`)
            s.overwrite(start, end, resolved)
            hasReplaced = true
          }

          // save the import chain for hmr analysis
          const importee = slash(path.resolve(path.dirname(importer), resolved))
          currentImportees.add(importee)
          debugHmr(`        ${importer} imports ${importee}`)
          ensureMapEntry(importerMap, importee).add(importer)
        } else if (dynamicIndex >= 0) {
          // TODO dynamic import
          debug(`    dynamic import "${id}" (ignored)`)
        }
      })

      // since the importees may have changed due to edits,
      // check if we need to remove this importer from certain importees
      if (prevImportees) {
        prevImportees.forEach((importee) => {
          if (!currentImportees.has(importee)) {
            const importers = importerMap.get(importee)
            if (importers) {
              importers.delete(importer)
            }
          }
        })
      }

      if (!hasReplaced) {
        debug(`    no imports rewritten.`)
      }

      return hasReplaced ? s.toString() : source
    } else {
      debug(`${importer}: no imports found.`)
    }

    return source
  } catch (e) {
    console.error(
      `[vite] Error: module imports rewrite failed for ${importer}.\n`,
      e
    )
    debug(source)
    return source
  }
}