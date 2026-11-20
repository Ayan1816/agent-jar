import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = join(process.cwd(), 'out')
const indexPath = join(outDir, 'index.html')

if (!existsSync(indexPath)) {
  console.error('missing out/index.html')
  process.exit(1)
}

const html = readFileSync(indexPath, 'utf8').replace(/&amp;/g, '&')
const footer =
  'Independent community project. Ownerless & immutable contract: no admin, no pause, no freeze, no withdraw, zero fees. Verified open-source on BscScan.'

if (!html.includes(footer)) {
  console.error('footer sentence missing from static export')
  process.exit(1)
}

copyFileSync(indexPath, join(outDir, '404.html'))
console.log('static export ok: out/index.html and out/404.html')
