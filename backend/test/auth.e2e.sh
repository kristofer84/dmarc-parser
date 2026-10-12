#!/usr/bin/env bash
# Smoke test for auth, settings and per-domain scoping, run against a throwaway instance.
#
# Start one first (it must use its own database, and a bogus IMAP host so the live
# mailbox is untouched), then run these in order - scope.e2e.sh expects the users and the
# changed password that auth.e2e.sh leaves behind:
#
#   docker run -d --name dmarc-auth-test -p 18099:8096 \
#     -e NODE_ENV=production -e PORT=8096 -e DATABASE_URL=file:/app/data/auth-test.db \
#     -e IMAP_HOST=127.0.0.1 -e IMAP_PORT=1 -e IMAP_USER=none -e IMAP_PASSWORD=none \
#     -e ENABLE_SCHEDULED_EMAIL_PROCESSING=false \
#     -e ADMIN_EMAIL=admin@test.local -e ADMIN_PASSWORD=correct-horse-battery-staple \
#     dmarc-parser-backend
#   bash test/auth.e2e.sh && bash test/scope.e2e.sh
#
# Both scripts exit non-zero on the first inconsistent result.
# End-to-end check of auth, scoping and settings against a throwaway instance.
# Keeps total logins under the 10/min login rate limit.
set -uo pipefail

BASE="${BASE:-http://localhost:18099}"
JAR=/tmp/dmarc-admin.jar
CLIENT_JAR=/tmp/dmarc-client.jar
OTHER_JAR=/tmp/dmarc-other.jar
rm -f "$JAR" "$CLIENT_JAR" "$OTHER_JAR"

pass=0
fail=0

check() {
  if [ "$2" = "$3" ]; then
    echo "  ✅ $1 ($3)"
    pass=$((pass + 1))
  else
    echo "  ❌ $1 — expected [$2], got [$3]"
    fail=$((fail + 1))
  fi
}

code() { # method path jar [data]
  local method="$1" path="$2" jar="${3-}" data="${4-}"
  if [ -n "$data" ]; then
    curl -s -o /tmp/body.json -w '%{http_code}' -X "$method" "$BASE$path" \
      ${jar:+-b "$jar"} -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -o /tmp/body.json -w '%{http_code}' -X "$method" "$BASE$path" ${jar:+-b "$jar"}
  fi
}

login() { # email password jar - stores body in /tmp/body.json, prints nothing
  curl -s -D /tmp/headers.txt -c "$3" -o /tmp/body.json -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

echo "== unauthenticated =="
check "GET /api/reports is 401" 401 "$(code GET /api/reports)"
check "GET /api/forensics is 401" 401 "$(code GET /api/forensics)"
check "GET /api/settings is 401" 401 "$(code GET /api/settings)"
check "GET /api/users is 401" 401 "$(code GET /api/users)"
check "GET /api/summary is 401" 401 "$(code GET /api/summary)"

curl -s "$BASE/health" -o /tmp/health.json
check "public /health still answers" ok "$(jq -r .status /tmp/health.json)"
check "public /health has no lastResult key" false "$(jq -r '.processing | has("lastResult")' /tmp/health.json)"
check "public /health keeps the failure counter" number "$(jq -r '.processing.consecutiveFailures | type' /tmp/health.json)"
check "public /health leaks no error text" 0 "$(jq -r '[paths(scalars) as $p | select($p[-1]=="lastError")] | length' /tmp/health.json)"

echo "== login =="
check "wrong password is 401" 401 "$(code POST /api/auth/login '' '{"email":"admin@test.local","password":"nope"}')"
check "unknown user is 401" 401 "$(code POST /api/auth/login '' '{"email":"ghost@test.local","password":"correct-horse-battery-staple"}')"
check "missing fields is 400" 400 "$(code POST /api/auth/login '' '{"email":"admin@test.local"}')"
login admin@test.local correct-horse-battery-staple "$JAR"
check "correct login returns the admin role" admin "$(jq -r .user.role /tmp/body.json)"
check "session cookie is HttpOnly" true "$(grep -ci 'set-cookie:.*httponly' /tmp/headers.txt | awk '{print ($1>0)?"true":"false"}')"
check "session cookie is SameSite=Lax" true "$(grep -ci 'set-cookie:.*samesite=lax' /tmp/headers.txt | awk '{print ($1>0)?"true":"false"}')"
check "no Secure flag over plain http" false "$(grep -ci 'set-cookie:.*secure' /tmp/headers.txt | awk '{print ($1>0)?"true":"false"}')"

echo "== authenticated admin =="
check "GET /api/auth/me is 200" 200 "$(code GET /api/auth/me "$JAR")"
check "me reports the admin role" admin "$(jq -r .user.role /tmp/body.json)"
check "GET /api/reports is 200" 200 "$(code GET /api/reports "$JAR")"
check "GET /api/forensics is 200" 200 "$(code GET /api/forensics "$JAR")"
check "GET /api/forensics/summary is 200" 200 "$(code GET /api/forensics/summary "$JAR")"
check "GET /api/summary is 200" 200 "$(code GET /api/summary "$JAR")"
check "GET /api/processing-logs is 200" 200 "$(code GET /api/processing-logs "$JAR")"
check "GET /api/users is 200" 200 "$(code GET /api/users "$JAR")"
check "GET /api/settings is 200" 200 "$(code GET /api/settings "$JAR")"
check "settings list has entries" true "$(jq -r '(.data | length) >= 9' /tmp/body.json)"
check "every setting is documented" true "$(jq -r '(.data | map(select((.description // "") | length > 10)) | length) == (.data | length)' /tmp/body.json)"
check "authenticated /health has lastResult key" true "$(curl -s -b "$JAR" "$BASE/health" | jq -r '.processing | has("lastResult")')"

echo "== settings validation =="
check "toggle a boolean on" true "$(code PATCH /api/settings/forensics.storeFullHeaders "$JAR" '{"value":"true"}' >/dev/null; jq -r .setting.value /tmp/body.json)"
check "toggle a boolean off" false "$(code PATCH /api/settings/forensics.storeFullHeaders "$JAR" '{"value":"false"}' >/dev/null; jq -r .setting.value /tmp/body.json)"
check "boolean rejects garbage" 400 "$(code PATCH /api/settings/forensics.enabled "$JAR" '{"value":"maybe"}')"
check "number range is enforced" 400 "$(code PATCH /api/settings/auth.sessionHours "$JAR" '{"value":"99999"}')"
check "unknown setting is 404" 404 "$(code PATCH /api/settings/nope.nope "$JAR" '{"value":"1"}')"
check "setting change is audited" admin@test.local "$(code PATCH /api/settings/auth.sessionHours "$JAR" '{"value":"8"}' >/dev/null; jq -r .setting.updatedBy /tmp/body.json)"

echo "== user management =="
check "admin creates a client user" 201 "$(code POST /api/users "$JAR" '{"email":"client@test.local","password":"a-long-enough-secret","name":"Client","domains":["xcds.net"]}')"
CLIENT_ID=$(jq -r .user.id /tmp/body.json)
check "created user is role user" user "$(jq -r .user.role /tmp/body.json)"
check "created user got its domain" xcds.net "$(jq -r '.user.domains[0]' /tmp/body.json)"
check "duplicate email is 409" 409 "$(code POST /api/users "$JAR" '{"email":"client@test.local","password":"a-long-enough-secret"}')"
check "short password is 400" 400 "$(code POST /api/users "$JAR" '{"email":"shortpw@test.local","password":"short"}')"
check "invalid email is 400" 400 "$(code POST /api/users "$JAR" '{"email":"not-an-email","password":"a-long-enough-secret"}')"
check "creates a second user" 201 "$(code POST /api/users "$JAR" '{"email":"other@test.local","password":"a-long-enough-secret","domains":["other.example"]}')"
OTHER_ID=$(jq -r .user.id /tmp/body.json)
check "available-domains is 200" 200 "$(code GET /api/users/available-domains "$JAR")"
ADMIN_ID=$(curl -s -b "$JAR" "$BASE/api/auth/me" | jq -r .user.id)
check "cannot delete self" 400 "$(code DELETE "/api/users/$ADMIN_ID" "$JAR")"
check "cannot demote self" 400 "$(code PATCH "/api/users/$ADMIN_ID" "$JAR" '{"role":"user"}')"
check "admin can assign two domains" 2 "$(code PUT "/api/users/$OTHER_ID/domains" "$JAR" '{"domains":["other.example","xcds.net"]}' >/dev/null; jq -r '.domains | length' /tmp/body.json)"
check "and narrow it back to one" other.example "$(code PUT "/api/users/$OTHER_ID/domains" "$JAR" '{"domains":["other.example"]}' >/dev/null; jq -r '.domains[0]' /tmp/body.json)"

echo "== scoped user =="
login client@test.local a-long-enough-secret "$CLIENT_JAR"
check "client login works" client@test.local "$(jq -r .user.email /tmp/body.json)"
check "client sees its own domain list" xcds.net "$(code GET /api/auth/me "$CLIENT_JAR" >/dev/null; jq -r '.domains[0]' /tmp/body.json)"
check "client can read reports" 200 "$(code GET /api/reports "$CLIENT_JAR")"
check "client can read forensics" 200 "$(code GET /api/forensics "$CLIENT_JAR")"
check "client can read processing logs" 200 "$(code GET /api/processing-logs "$CLIENT_JAR")"
check "client can read summary" 200 "$(code GET /api/summary "$CLIENT_JAR")"
check "client cannot list users" 403 "$(code GET /api/users "$CLIENT_JAR")"
check "client cannot read settings" 403 "$(code GET /api/settings "$CLIENT_JAR")"
check "client cannot write settings" 403 "$(code PATCH /api/settings/auth.sessionHours "$CLIENT_JAR" '{"value":"1"}')"
check "client cannot create users" 403 "$(code POST /api/users "$CLIENT_JAR" '{"email":"x@test.local","password":"a-long-enough-secret"}')"
check "client cannot reassign domains" 403 "$(code PUT "/api/users/$CLIENT_ID/domains" "$CLIENT_JAR" '{"domains":["other.example"]}')"
check "client cannot delete users" 403 "$(code DELETE "/api/users/$OTHER_ID" "$CLIENT_JAR")"

echo "== registration policy =="
check "self-registration closed by default" 403 "$(code POST /api/auth/register '' '{"email":"self@test.local","password":"a-long-enough-secret"}')"
check "admin opens registration" true "$(code PATCH /api/settings/auth.registrationOpen "$JAR" '{"value":"true"}' >/dev/null; jq -r .setting.value /tmp/body.json)"
check "registration then works" 201 "$(code POST /api/auth/register '' '{"email":"self@test.local","password":"a-long-enough-secret"}')"
check "self-registered account has no domains" 0 "$(jq '.domains | length' /tmp/body.json)"
check "session policy endpoint" true "$(code GET /api/auth/session-policy >/dev/null; jq -r .registrationOpen /tmp/body.json)"
check "admin closes registration" false "$(code PATCH /api/settings/auth.registrationOpen "$JAR" '{"value":"false"}' >/dev/null; jq -r .setting.value /tmp/body.json)"

echo "== password change and logout =="
check "wrong current password is 401" 401 "$(code POST /api/auth/change-password "$CLIENT_JAR" '{"currentPassword":"wrong","newPassword":"another-long-secret"}')"
check "short new password is 400" 400 "$(code POST /api/auth/change-password "$CLIENT_JAR" '{"currentPassword":"a-long-enough-secret","newPassword":"short"}')"
check "password change is 200" 200 "$(code POST /api/auth/change-password "$CLIENT_JAR" '{"currentPassword":"a-long-enough-secret","newPassword":"another-long-secret"}')"
login client@test.local another-long-secret "$CLIENT_JAR"
check "the new password works" client@test.local "$(jq -r .user.email /tmp/body.json)"
check "the old password is rejected" 401 "$(code POST /api/auth/login '' '{"email":"client@test.local","password":"a-long-enough-secret"}')"
check "logout is 200" 200 "$(code POST /api/auth/logout "$JAR")"
check "session is invalid after logout" 401 "$(code GET /api/reports "$JAR")"

echo
echo "PART 1: $pass passed, $fail failed"
exit "$fail"
