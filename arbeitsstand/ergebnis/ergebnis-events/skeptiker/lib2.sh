#!/bin/bash
API=http://localhost:8080/api/v1
S=$(date +%s)$RANDOM
# reg NAME -> setzt T_NAME, I_NAME
reg() { local n=$1; local r; r=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"sk${n}${S}\",\"password\":\"passwort123\",\"displayName\":\"Sk ${n} ${S}\"}"); eval "T_$n=$(echo "$r" | jq -r .accessToken)"; eval "I_$n=$(echo "$r" | jq -r .user.id)"; }
# api TOKENVAR METHOD PATH [BODY]
api() { local t=$1 m=$2 p=$3 b=${4:-}; if [ -n "$b" ]; then curl -s -X $m "$API$p" -H "authorization: Bearer ${!t}" -H 'content-type: application/json' -d "$b"; else curl -s -X $m "$API$p" -H "authorization: Bearer ${!t}"; fi; }
apic() { local t=$1 m=$2 p=$3 b=${4:-}; if [ -n "$b" ]; then curl -s -o /dev/null -w "%{http_code}" -X $m "$API$p" -H "authorization: Bearer ${!t}" -H 'content-type: application/json' -d "$b"; else curl -s -o /dev/null -w "%{http_code}" -X $m "$API$p" -H "authorization: Bearer ${!t}"; fi; }
