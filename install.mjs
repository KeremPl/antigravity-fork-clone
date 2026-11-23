#!/usr/bin/env node
/**
 * Cross-platform installer for Antigravity Fork & Clone plugin.
 * Copies the plugin bundle into ~/.gemini/config/plugins/fork-clone.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(homedir(), '.gemini', 'config', 'plugins', 'fork-clone');
const uninstall = process.argv.includes('--uninstall');

if (uninstall) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`Uninstalled: ${target}`);
  } else {
    console.log(`Not installed: ${target}`);
  }
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const item of ['plugin.json', 'README.md', 'LICENSE', 'assets', 'skills', 'sidecars']) {
  const src = join(__dirname, item);
  if (existsSync(src)) {
    cpSync(src, join(target, item), { recursive: true, force: true });
  }
}

console.log(`Installed Fork & Clone plugin to: ${target}`);
console.log('Open the right-hand side pane "+" menu -> "Fork & Clone" (or run /fork in chat).');
