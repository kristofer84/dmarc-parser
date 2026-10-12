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
# Authorization test with real rows: does a domain-scoped user see only their own data,
# and can they reach another domain's record by guessing its id?
#
# The rows are seeded while the container is stopped: overwriting the SQLite file under a
# running process leaves it reading the old inode, which makes results unreproducible.
set -uo pipefail

BASE="${BASE:-http://localhost:18099}"
CONTAINER="${CONTAINER:-dmarc-auth-test}"
IMAGE="${IMAGE:-dmarc-parser-backend}"
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
code() {
  local method="$1" path="$2" jar="${3-}" data="${4-}"
  if [ -n "$data" ]; then
    curl -s -o /tmp/body.json -w '%{http_code}' -X "$method" "$BASE$path" ${jar:+-b "$jar"} -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -o /tmp/body.json -w '%{http_code}' -X "$method" "$BASE$path" ${jar:+-b "$jar"}
  fi
}
login() { curl -s -c "$3" -o /tmp/body.json -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
json() { jq -r "$1" /tmp/body.json; }

echo "== seeding rows for two domains (container stopped) =="
docker stop "$CONTAINER" >/dev/null
docker cp "$CONTAINER:/app/data/auth-test.db" /tmp/scope.db >/dev/null
sqlite3 /tmp/scope.db <<'SQL'
DELETE FROM records; DELETE FROM reports; DELETE FROM forensic_reports;
INSERT INTO reports (id, domain, reportId, orgName, email, startDate, endDate, createdAt, updatedAt) VALUES
  ('crxxxxxxxxxxxxxxxxxxxxxxx','xcds.net','rep-xcds-1','google.com','noreply-dmarc-support@google.com',1791244800000,1791331199000,1791331199000,1791331199000),
  ('cryyyyyyyyyyyyyyyyyyyyyyy','other.example','rep-other-1','google.com','noreply-dmarc-support@google.com',1791244800000,1791331199000,1791331199000,1791331199000);
INSERT INTO records (id, reportId, sourceIp, count, disposition, dkim, spf, headerFrom) VALUES
  ('cexxxxxxxxxxxxxxxxxxxxxxx','crxxxxxxxxxxxxxxxxxxxxxxx','203.0.113.9',5,'reject','fail','fail','xcds.net'),
  ('ceyyyyyyyyyyyyyyyyyyyyyyy','cryyyyyyyyyyyyyyyyyyyyyyy','198.51.100.7',3,'quarantine','fail','fail','other.example');
INSERT INTO forensic_reports (id, dedupKey, domain, feedbackType, sourceIp, arrivalDate, reportedSubject, createdAt, updatedAt, reportAuthenticated) VALUES
  ('cfxxxxxxxxxxxxxxxxxxxxxxx','hash:xcds-test','xcds.net','auth-failure','203.0.113.9',1791331199000,'Your invoice is ready',1791331199000,1791331199000,1),
  ('cfyyyyyyyyyyyyyyyyyyyyyyy','hash:other-test','other.example','auth-failure','198.51.100.7',1791331199000,'Spoofed mail',1791331199000,1791331199000,0);
SQL
docker cp /tmp/scope.db "$CONTAINER:/app/data/auth-test.db" >/dev/null
docker start "$CONTAINER" >/dev/null
for _ in $(seq 1 40); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "  seeded 2 reports (2 records) and 2 forensic reports for xcds.net / other.example"

echo "== logins =="
login admin@test.local correct-horse-battery-staple "$JAR"
check "admin login" admin "$(json .user.role)"
login client@test.local another-long-secret "$CLIENT_JAR"
check "client login" client@test.local "$(json .user.email)"
login other@test.local a-long-enough-secret "$OTHER_JAR"
check "other login" other@test.local "$(json .user.email)"

code GET /api/reports "$JAR" >/dev/null
XCDS_REPORT=$(jq -r '[.data[] | select(.domain=="xcds.net")][0].id' /tmp/body.json)
OTHER_REPORT=$(jq -r '[.data[] | select(.domain=="other.example")][0].id' /tmp/body.json)
code GET /api/forensics "$JAR" >/dev/null
XCDS_FOR=$(jq -r '[.data[] | select(.domain=="xcds.net")][0].id' /tmp/body.json)
OTHER_FOR=$(jq -r '[.data[] | select(.domain=="other.example")][0].id' /tmp/body.json)

echo "== admin sees everything =="
check "reports total" 2 "$(code GET /api/reports "$JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "forensics total" 2 "$(code GET /api/forensics "$JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "summary report count" 2 "$(code GET /api/summary "$JAR" >/dev/null; jq -r .totalReports /tmp/body.json)"
check "forensic summary count" 2 "$(code GET /api/forensics/summary "$JAR" >/dev/null; jq -r .total /tmp/body.json)"
check "admin reads the other domain's report" 200 "$(code GET "/api/reports/$OTHER_REPORT" "$JAR")"
check "admin reads the other domain's forensic" 200 "$(code GET "/api/forensics/$OTHER_FOR" "$JAR")"

echo "== client (xcds.net only) =="
check "reports are filtered" 1 "$(code GET /api/reports "$CLIENT_JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "and it is the right domain" xcds.net "$(jq -r '.data[0].domain' /tmp/body.json)"
check "query filter cannot widen scope" 0 "$(code GET '/api/reports?domain=other.example' "$CLIENT_JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "own report detail is 200" 200 "$(code GET "/api/reports/$XCDS_REPORT" "$CLIENT_JAR")"
check "other report detail is 404" 404 "$(code GET "/api/reports/$OTHER_REPORT" "$CLIENT_JAR")"
check "forensics are filtered" 1 "$(code GET /api/forensics "$CLIENT_JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "own forensic detail is 200" 200 "$(code GET "/api/forensics/$XCDS_FOR" "$CLIENT_JAR")"
check "other forensic detail is 404" 404 "$(code GET "/api/forensics/$OTHER_FOR" "$CLIENT_JAR")"
check "forensic filter cannot widen scope" 0 "$(code GET '/api/forensics?domain=other.example' "$CLIENT_JAR" >/dev/null; jq -r .pagination.total /tmp/body.json)"
check "summary is scoped" 1 "$(code GET /api/summary "$CLIENT_JAR" >/dev/null; jq -r .totalReports /tmp/body.json)"
check "forensic summary is scoped" 1 "$(code GET /api/forensics/summary "$CLIENT_JAR" >/dev/null; jq -r .total /tmp/body.json)"
check "its messages are counted" 5 "$(code GET /api/summary "$CLIENT_JAR" >/dev/null; jq -r .totalMessages /tmp/body.json)"

echo "== other.example user =="
check "sees only its own report" other.example "$(code GET /api/reports "$OTHER_JAR" >/dev/null; jq -r '.data[0].domain' /tmp/body.json)"
check "sees only its own forensic" other.example "$(code GET /api/forensics "$OTHER_JAR" >/dev/null; jq -r '.data[0].domain' /tmp/body.json)"
check "cannot read the xcds report" 404 "$(code GET "/api/reports/$XCDS_REPORT" "$OTHER_JAR")"
check "cannot read the xcds forensic" 404 "$(code GET "/api/forensics/$XCDS_FOR" "$OTHER_JAR")"

echo "== forensic detail payload =="
check "detail includes processing logs" 0 "$(code GET "/api/forensics/$XCDS_FOR" "$JAR" >/dev/null; jq -r '.processingLogs | length' /tmp/body.json)"
check "detail carries the source IP" 203.0.113.9 "$(jq -r .sourceIp /tmp/body.json)"
check "detail flags an unverified report" false "$(code GET "/api/forensics/$OTHER_FOR" "$JAR" >/dev/null; jq -r .reportAuthenticated /tmp/body.json)"
check "list marks it authenticated" true "$(code GET "/api/forensics/$XCDS_FOR" "$JAR" >/dev/null; jq -r .reportAuthenticated /tmp/body.json)"

echo
echo "PART 2: $pass passed, $fail failed"
exit "$fail"
