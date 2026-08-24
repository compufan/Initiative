#!/usr/bin/env node
// Startet Rust-API und PWA gemeinsam (`pnpm dev`).
// Ohne Argument laufen beide, mit `api` bzw. `web` nur eines davon.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];

const RESET = '[0m';

const targets = [
  {
    name: 'api',
    color: '[36m',
    command: 'cargo',
    args: ['run', '--manifest-path', 'apps/api/Cargo.toml'],
  },
  {
    name: 'web',
    color: '[35m',
    command: 'pnpm',
    args: ['--filter', '@initiative/web', 'dev'],
  },
].filter((target) => !only || target.name === only);

if (targets.length === 0) {
  console.error('Unbekanntes Ziel. Erlaubt: api, web');
  process.exit(1);
}

const children = targets.map((target) => {
  const child = spawn(target.command, target.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `${target.color}[${target.name}]${RESET} `;

  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) console.error(`${prefix}beendet mit Code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
