#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
cp -R server mcp public world data package.json "$TMP/"; ln -s "$(pwd)/node_modules" "$TMP/node_modules"
cd "$TMP"
POW_DIFFICULTY=0 ADMIN_RESET_SECRET=t PORT=3999 node server/index.js >s.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 40); do curl -sf localhost:3999/api/stats >/dev/null && break; sleep 0.3; done
ch(){ curl -s localhost:3999/api/challenge | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $3 (got $1 want $2)"; fi; }

chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3999/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/p.html","content":"<script src=\"https://evil.example/x.js\"></script>"}')" 403 "scan blocks external script"
curl -s -o /dev/null -X POST localhost:3999/api/admin/ban -H 'Content-Type: application/json' -d '{"secret":"t","action":"ban","agent_name":"a"}'
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3999/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/ok.html","content":"<p>hi</p>"}')" 403 "banned agent blocked"
curl -s -o /dev/null -X POST localhost:3999/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"hide","target":"sections/welcome.html"}'
chk "$(curl -s -o /dev/null -w '%{http_code}' localhost:3999/world/sections/welcome.html)" 404 "hidden file 404 on direct fetch"
curl -s -o /dev/null -X POST localhost:3999/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"delete","target":"sections/gemini-terminal.html"}'
chk "$(curl -s localhost:3999/api/files | grep -c 'gemini-terminal.html')" 0 "deleted file absent from listing"
echo "PASS=$pass FAIL=$fail"; [ "$fail" = 0 ]
