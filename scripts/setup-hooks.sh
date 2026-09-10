#!/bin/sh
# Point this clone's git hooks at scripts/hooks/. Run once after cloning:
#
#   scripts/setup-hooks.sh
#
# No husky, no lint-staged, no install-time magic — one git config setting and
# a shell script you can read.

set -e

repo=$(git rev-parse --show-toplevel)
cd "$repo"

chmod +x scripts/hooks/pre-push
git config core.hooksPath scripts/hooks

echo "core.hooksPath -> scripts/hooks"
echo "pre-push now runs: typecheck, check, tests + coverage, gitleaks."

if ! command -v gitleaks >/dev/null 2>&1; then
  echo
  echo "gitleaks is not installed and the hook requires it:"
  echo "  brew install gitleaks"
fi
