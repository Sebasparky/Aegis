#!/usr/bin/env bash
set -euo pipefail

export AEGIS_API_BASE="http://localhost:4000"
export AEGIS_AGENT_TOKEN="pass_demo_001"
export ANTIGEN_BROWSER_HEADLESS="false"
export ANTIGEN_INPUT_REALISM="realistic"
export ANTIGEN_BROWSER_TRACE="true"
export ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS="true"
export ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION="true"
# Explicit: keep the adapter's fail-closed QA-env guard ON. The adapter exits with
# FATAL if it is launched without the QA flags above (e.g. a cached direct command).
export ANTIGEN_ADAPTER_REQUIRE_QA_ENV="true"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../examples/antigen-browser-adapter.mjs"
