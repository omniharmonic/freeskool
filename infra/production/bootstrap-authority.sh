#!/usr/bin/env bash
# Runs ON the server after create-school: creates the skills authority account, seeds the 525-skill taxonomy, restarts the AppView with the school env. Idempotent.
set -euo pipefail
umask 077
cd /opt/freeskool
C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"
if [ ! -f infra/production/.authority.env ]; then
  $C run --rm -T -e PDS_URL=http://pds:3000 appview node --input-type=module -e '
import { randomBytes } from "node:crypto";
const pds = process.env.PDS_URL, admin = "Basic " + Buffer.from("admin:" + process.env.PDS_ADMIN_PASSWORD).toString("base64");
const x = async (m, b, h = {}) => { const r = await fetch(pds + "/xrpc/" + m, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(m + " " + r.status + " " + JSON.stringify(j)); return j };
const { code } = await x("com.atproto.server.createInviteCode", { useCount: 1 }, { authorization: admin });
const password = randomBytes(24).toString("base64url");
const handle = "skills." + process.env.PDS_HANDLE_DOMAIN;
const acct = await x("com.atproto.server.createAccount", { email: "skills-authority@example.org", handle, password, inviteCode: code });
process.stdout.write(`AUTHORITY_HANDLE=${handle}\nAUTHORITY_PASSWORD=${password}\nAUTHORITY_DID=${acct.did}\n`);
' </dev/null > infra/production/.authority.env.tmp
  grep -q '^AUTHORITY_PASSWORD=.' infra/production/.authority.env.tmp && mv infra/production/.authority.env.tmp infra/production/.authority.env
  echo "authority: $(grep -E '^AUTHORITY_(HANDLE|DID)=' infra/production/.authority.env | tr '\n' ' ')"
fi
. infra/production/.authority.env
echo "--- seeding skills"
$C run --rm -T -e PDS_URL=http://pds:3000 -e AUTHORITY_HANDLE="$AUTHORITY_HANDLE" -e AUTHORITY_PASSWORD="$AUTHORITY_PASSWORD" appview pnpm --filter @freeschool/lexicons seed:skills </dev/null 2>&1 | grep -E '^\{|FAIL' | tail -5
echo "--- restarting appview with the school env"
$C up -d --force-recreate appview </dev/null >/dev/null 2>&1
sleep 25
$C ps --format "table {{.Service}}\t{{.Status}}"
$C logs --no-log-prefix --tail 4 appview 2>&1 | cut -c1-260
