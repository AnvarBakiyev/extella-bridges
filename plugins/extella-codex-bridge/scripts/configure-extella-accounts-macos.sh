#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This account configurator currently supports macOS only.\n' >&2
  exit 1
fi

for command_name in launchctl node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command_name" >&2
    exit 1
  fi
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
auth_check="$script_dir/check-extella-auth.mjs"

printf 'Primary Extella token (your default account; input is hidden): ' >&2
IFS= read -r -s primary_token
printf '\n' >&2
if [[ ${#primary_token} -lt 8 ]]; then
  unset primary_token
  printf 'Primary Extella token is missing or too short.\n' >&2
  exit 1
fi

printf 'Configure a second Extella account on this Mac? [y/N]: ' >&2
IFS= read -r configure_secondary

secondary_token=""
case "$configure_secondary" in
  y|Y|yes|YES|Yes)
    printf 'Secondary Extella token (for example, the 1C account; input is hidden): ' >&2
    IFS= read -r -s secondary_token
    printf '\n' >&2
    if [[ ${#secondary_token} -lt 8 ]]; then
      unset primary_token secondary_token
      printf 'Secondary Extella token is missing or too short.\n' >&2
      exit 1
    fi
    ;;
  n|N|no|NO|No|"")
    ;;
  *)
    unset primary_token
    printf 'Please answer y or n.\n' >&2
    exit 1
    ;;
esac

printf 'Validating primary Extella account without calling an agent or model...\n'
EXTELLA_API_TOKEN="$primary_token" \
  node "$auth_check" --token-env EXTELLA_API_TOKEN

if [[ -n "$secondary_token" ]]; then
  printf 'Validating secondary Extella account without calling an agent or model...\n'
  EXTELLA_SECONDARY_API_TOKEN="$secondary_token" \
    node "$auth_check" --token-env EXTELLA_SECONDARY_API_TOKEN
fi

# Apply both changes only after every supplied token has passed validation.
launchctl setenv EXTELLA_API_TOKEN "$primary_token"
if [[ -n "$secondary_token" ]]; then
  launchctl setenv EXTELLA_SECONDARY_API_TOKEN "$secondary_token"
else
  launchctl unsetenv EXTELLA_SECONDARY_API_TOKEN 2>/dev/null || true
fi

unset primary_token secondary_token configure_secondary

printf '\nExtella account slots are configured.\n'
printf 'Fully quit and reopen Codex, then start a new task.\n'
