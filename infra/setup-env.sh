#!/usr/bin/env bash
# Generates infra/pds.env with fresh secrets for a LOCAL dev PDS. Never commit pds.env.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f pds.env ]; then echo "infra/pds.env exists; leaving it alone"; exit 0; fi
gen_hex() { openssl rand -hex "$1"; }
cat > pds.env <<ENV
PDS_HOSTNAME=localhost
PDS_JWT_SECRET=$(gen_hex 32)
PDS_ADMIN_PASSWORD=$(gen_hex 16)
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl ecparam -name secp256k1 -genkey -noout -outform DER | tail -c +8 | head -c 32 | xxd -p -c 32)
PDS_SERVICE_HANDLE_DOMAINS=.localhost
PDS_INVITE_REQUIRED=true
ENV
echo "wrote infra/pds.env (admin password inside)"
