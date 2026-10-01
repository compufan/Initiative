#!/bin/bash
# Legt einen Arbeitsbaum an: $1 = Name, $2 = Zweig, $3 = Port (Vite), wird in pw/pw-$1.config.ts eingetragen.
set -e
S=/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad
name="$1"; zweig="$2"; port="$3"
dir="$S/$name"
cd /home/user/Initiative
git worktree add -b "$zweig" "$dir" HEAD >/dev/null
ln -s /home/user/Initiative/node_modules "$dir/node_modules"
ln -s /home/user/Initiative/apps/web/node_modules "$dir/apps/web/node_modules"
ln -s /home/user/Initiative/packages/shared/node_modules "$dir/packages/shared/node_modules"
for d in icons mediapipe models marke; do
  [ -e "/home/user/Initiative/apps/web/public/$d" ] && [ ! -e "$dir/apps/web/public/$d" ] && ln -s "/home/user/Initiative/apps/web/public/$d" "$dir/apps/web/public/$d" || true
done
mkdir -p "$S/pw" "$S/ergebnis-$name"
cat > "$S/pw/pw-$name.config.ts" <<EOT
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '$dir/apps/web/e2e',
  outputDir: '$S/ergebnis-$name/test-results',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:$port' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: '/opt/pw-browsers/chromium' } },
    },
  ],
});
EOT
echo "$dir"
