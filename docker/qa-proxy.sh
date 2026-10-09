#!/usr/bin/env bash
# Start the qa-proxy service of a compose stack and route the debug app's own
# traffic through it, or undo that.
#
# Only the app's OkHttp clients use the proxy: the app stores the address it is
# launched with (`--es debug_qa_proxy <host:port>`) and keeps using it on every
# later launch until it is launched with `none` or its data is cleared. SDKs,
# WebViews and the rest of the device connect directly, so their TLS is never
# intercepted. The device-wide proxy setting is not touched.
#
# The address is the proxy container's IP rather than its service name: the
# emulator's NAT sends guest traffic out through the emulator container, which
# can reach that IP, and the app then does not depend on the Android guest
# resolving names through Docker's DNS.
#
# Usage: qa-proxy.sh <compose-file> <emulator-service> <action> [scenarios]
#
#   attach [scenarios]  start the proxy, set the scenario list, launch the app routed through it
#   use <scenarios>     replace the scenario list between tests (no restart, no relaunch)
#   launch              relaunch the app with the proxy address (after `pm clear`, for example)
#   log                 requests and frames a scenario modified, plus hook and TLS errors
#   status              container state and the address the app has stored
#   detach              launch the app with `none` so it connects directly, then stop the proxy
#
# [scenarios] is the list the test needs: "billing-grace-period", "billing-grace-period:daysAgo=10,ai-credits",
# a JSON array of {name, params}, or "none". attach always applies it (empty
# means none), so a proxy left running by an earlier test cannot leak its set.
#
# Env overrides:
#   QA_PROXY_APP_PACKAGE     application id to route (com.example.app)
#   QA_PROXY_LAUNCH_ACTIVITY launcher activity that reads the debug_qa_proxy extra (.LauncherActivity)
#   QA_PROXY_HEALTH_TIMEOUT  seconds to wait for the proxy to report healthy (60)
set -euo pipefail

COMPOSE_FILE="${1:?usage: $(basename "$0") <compose-file> <emulator-service> attach|use|launch|log|status|detach [scenarios]}"
SERVICE="${2:?emulator service name required (e.g. emulator)}"
ACTION="${3:?action required: attach|use|launch|log|status|detach}"
SCENARIOS="${4:-}"

PROXY_SERVICE=qa-proxy
PROXY_PORT=8080
APP_PACKAGE="${QA_PROXY_APP_PACKAGE:-com.example.app}"
START_ACTIVITY="${APP_PACKAGE}/${QA_PROXY_LAUNCH_ACTIVITY:-.LauncherActivity}"
HEALTH_TIMEOUT="${QA_PROXY_HEALTH_TIMEOUT:-60}"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --profile qa-proxy)

device() { "${COMPOSE[@]}" exec -T "$SERVICE" adb shell "$@" | tr -d '\r'; }

proxy_container() {
    local cid
    cid="$("${COMPOSE[@]}" ps -q "$PROXY_SERVICE" 2>/dev/null || true)"
    [ -n "$cid" ] || { echo "::error::${PROXY_SERVICE} is not running in ${COMPOSE_FILE}." >&2; exit 1; }
    echo "$cid"
}

proxy_exec() { "${COMPOSE[@]}" exec -T "$PROXY_SERVICE" "$@"; }

set_scenarios() { proxy_exec node src/set-scenarios.js "$1"; }

proxy_address() {
    local ip
    ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(proxy_container)" | awk '{print $1}')"
    [ -n "$ip" ] || { echo "::error::could not resolve the ${PROXY_SERVICE} container IP." >&2; exit 1; }
    echo "${ip}:${PROXY_PORT}"
}

launch_app() {
    device am force-stop "$APP_PACKAGE"
    device am start -W -n "$START_ACTIVITY" --es debug_qa_proxy "$1" | grep -E '^Status' || true
}

wait_healthy() {
    local cid="$1" waited=0 health
    while :; do
        health="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo missing)"
        [ "$health" = "healthy" ] && return 0
        if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
            echo "::error::${PROXY_SERVICE} is '${health}' after ${waited}s." >&2
            "${COMPOSE[@]}" logs --tail 80 "$PROXY_SERVICE" >&2 || true
            exit 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
}

case "$ACTION" in
    attach)
        "${COMPOSE[@]}" up -d --build "$PROXY_SERVICE"
        wait_healthy "$(proxy_container)"
        set_scenarios "$SCENARIOS"
        address="$(proxy_address)"
        launch_app "$address"
        echo "App routed through qa-proxy at ${address} (launch argument: --es debug_qa_proxy ${address})"
        ;;
    use)
        [ -n "$SCENARIOS" ] || { echo "use needs a scenario list (or \"none\")" >&2; exit 2; }
        proxy_container >/dev/null
        set_scenarios "$SCENARIOS"
        ;;
    launch)
        address="$(proxy_address)"
        launch_app "$address"
        echo "App relaunched through qa-proxy at ${address}"
        ;;
    log)
        proxy_container >/dev/null
        proxy_exec node -e "fetch('http://127.0.0.1:8090/log?modified=true&limit=500').then((r) => r.text()).then(console.log)"
        ;;
    status)
        "${COMPOSE[@]}" ps "$PROXY_SERVICE"
        stored="$(device run-as "$APP_PACKAGE" cat "shared_prefs/debug_settings.xml" 2>/dev/null \
            | sed -n 's/.*name="pref_qa_proxy_address">\([^<]*\)<.*/\1/p')"
        echo "App proxy address: ${stored:-none (direct)}"
        ;;
    detach)
        launch_app none
        device am force-stop "$APP_PACKAGE"
        "${COMPOSE[@]}" stop "$PROXY_SERVICE" >/dev/null 2>&1 || true
        echo "App routed directly again; qa-proxy stopped"
        ;;
    *)
        echo "unknown action '${ACTION}' (attach|use|launch|log|status|detach)" >&2
        exit 2
        ;;
esac
