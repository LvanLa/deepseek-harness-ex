#!/usr/bin/env node
/**
 * Cross-platform entry for the scripted equivalent of the plugin's link
 * feature. Dispatches by OS:
 *   win32           -> link-skills.ps1 (NTFS junctions, via PowerShell)
 *   darwin / linux  -> link-skills.sh  (POSIX symlinks, via bash)
 *
 * usage: node link-skills.mjs <source-directory> [target-directory]
 * Target defaults to $DSH_HOME/skills or ~/.dsh/skills.
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [source, targetArg] = process.argv.slice(2)

if (!source || !path.isAbsolute(source)) {
  console.error('usage: node link-skills.mjs <absolute-source-directory> [target-directory]')
  process.exit(2)
}
try {
  if (!statSync(source).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`Source directory not found: ${source}`)
  process.exit(1)
}
const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const target = targetArg || path.join(home, 'skills')

const win32 = process.platform === 'win32'
const script = path.join(here, win32 ? 'link-skills.ps1' : 'link-skills.sh')
const result = win32
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-SourceDirectory', source, '-TargetDirectory', target], { stdio: 'inherit' })
  : spawnSync('bash', [script, source, target], { stdio: 'inherit' })

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
