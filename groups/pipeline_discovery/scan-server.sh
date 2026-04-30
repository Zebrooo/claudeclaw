#!/bin/bash
# Server Discovery Script — scans infrastructure and outputs JSON
set -euo pipefail

SCANNED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Services
SERVICES=$(systemctl list-units --type=service --state=active --no-pager --no-legend 2>/dev/null \
  | awk '{print $1}' | grep -E "(marnero|coffeeshop|classifieds|nails|claudeclaw)" \
  | jq -R . | jq -s .)

# Ports
PORTS=$(ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | grep -oE '[0-9]+$' | sort -un \
  | jq -R . | jq -s .)

# Cloudflare tunnels
TUNNELS=$(cloudflared tunnel list --output json 2>/dev/null || echo "[]")

# Disk usage
DISK=$(df -h / 2>/dev/null | awk 'NR==2 {print "{\"used\":\""$3"\",\"available\":\""$4"\",\"percent\":\""$5"\"}"}')

# Memory
MEM=$(free -m 2>/dev/null | awk 'NR==2 {printf "{\"total_mb\":%s,\"used_mb\":%s,\"free_mb\":%s}", $2, $3, $4}')

cat <<JSON
{
  "scanned_at": "$SCANNED_AT",
  "services": $SERVICES,
  "open_ports": $PORTS,
  "cloudflare_tunnels": $TUNNELS,
  "disk": $DISK,
  "memory": $MEM
}
JSON
