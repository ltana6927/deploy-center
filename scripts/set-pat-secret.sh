#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage:' \
    '  scripts/set-pat-secret.sh deploy-center-token OWNER/REPOSITORY' \
    '  scripts/set-pat-secret.sh source-read-token'
}

if [ ! -t 0 ]; then
  printf '%s\n' 'Refusing non-interactive input: run this script in a terminal.' >&2
  exit 1
fi

case "${1:-}" in
  deploy-center-token)
    source_repo="${2:-}"
    case "${source_repo}" in
      ltana6927/*) ;;
      *) usage >&2; exit 2 ;;
    esac
    printf '%s\n' \
      "Setting DEPLOY_CENTER_TOKEN for ${source_repo}." \
      'Paste the fine-grained PAT only at the hidden GitHub CLI prompt.'
    gh secret set DEPLOY_CENTER_TOKEN --repo "${source_repo}"
    ;;
  source-read-token)
    if [ "$#" -ne 1 ]; then
      usage >&2
      exit 2
    fi
    printf '%s\n' \
      'Setting SOURCE_READ_TOKEN for ltana6927/deploy-center.' \
      'Paste the fine-grained PAT only at the hidden GitHub CLI prompt.'
    gh secret set SOURCE_READ_TOKEN --repo ltana6927/deploy-center
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
