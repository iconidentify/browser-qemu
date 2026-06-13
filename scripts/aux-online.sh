#!/usr/bin/env bash
# Bring the browser-qemu A/UX guest "online" for outbound internet through the
# dialtone relay's slirp gateway, driven entirely via auxagent (AAP) over the
# wasmbridge ethernet bridge -- no GUI, no telnet login.
#
# The guest ships statically configured at 10.1.1.20 with default gateway
# 10.1.1.1 (unreachable here). The relay's slirp gateway is 10.68.0.1. Rather
# than rebuild the relay, we widen the guest's netmask to /8 so 10.68.0.1 is
# on-link, then point the default route at it; slirp answers its ARP and
# source-NATs outbound TCP. Guest changes are ephemeral (the disk runs with
# -snapshot), so re-run this each session.
#
# Prereqs: a guest booted with ?net=1&netZone=<zone> (bridge connected) and a
# relay running with outbound allowed (e.g. -allow-ips PUBLIC -allow-ports '*').
#
# usage: aux-online.sh [zone] [relay-gateway-ip]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZONE="${1:-lan}"
GW="${2:-10.68.0.1}"
AUXCTL=(node "${ROOT}/scripts/auxctl-zone.mjs" --zone "${ZONE}")

echo "waiting for auxagent in the guest (zone=${ZONE})..."
up=0
for i in $(seq 1 24); do
  if "${AUXCTL[@]}" ping 2>/dev/null | grep -q auxagent; then up=1; break; fi
  sleep 10
done
[ "${up}" = "1" ] || { echo "auxagent never answered; is the guest booted with net=1&netZone=${ZONE}?" >&2; exit 1; }
echo "auxagent up."

echo "reconfiguring guest routing for outbound via ${GW}..."
"${AUXCTL[@]}" exec "
/etc/ifconfig ao0 10.1.1.20 netmask 255.0.0.0 up
/usr/etc/route delete default 10.1.1.1 2>/dev/null
/usr/etc/route add default ${GW} 1
echo 'nameserver ${GW}' > /etc/resolv.conf
echo 'domain local' >> /etc/resolv.conf
echo '--- routes ---'; netstat -rn | grep -E 'default|^10'
"

echo "testing outbound TCP to 1.1.1.1:80 ..."
"${AUXCTL[@]}" exec '(telnet 1.1.1.1 80 </dev/null 2>&1 & p=$!; sleep 6; kill $p 2>/dev/null) 2>&1'

echo
echo "guest is online. Drive it with: node scripts/auxctl-zone.mjs --zone ${ZONE} exec \"<cmd>\""
