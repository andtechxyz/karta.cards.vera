#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Vera AWS infrastructure setup
#
# Idempotent: safe to re-run.  Creates or updates secrets, task definitions,
# target groups, ALB listener rules, and ECS services for all five Vera
# micro-services (tap, activation, pay, vault, admin).
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials that can manage ECS, ELB, Secrets
#     Manager, CloudWatch Logs, and ECR in ap-southeast-2.
#   - jq installed.
# ---------------------------------------------------------------------------
set -euo pipefail

# ===========================================================================
# Constants
# ===========================================================================
REGION="ap-southeast-2"
ACCOUNT="600743178530"
VPC="vpc-09484084ef246d4a0"
CLUSTER="vera"
EXEC_ROLE="arn:aws:iam::${ACCOUNT}:role/vera-ecs-execution"
PUBLIC_ALB_ARN="arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/vera-public/f71842c99b11992c"
INTERNAL_ALB_ARN="arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/vera-internal/f607108ee78ebe20"
PRIVATE_SUBNETS="subnet-0d475c49f65f05e86,subnet-0397a18095049f972"
ECS_SG="sg-086e7b16e5351f155"
ECR_BASE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
INTERNAL_ALB_DNS="internal-vera-internal-886106335.${REGION}.elb.amazonaws.com"

# Tracking arrays for the final summary
CREATED_SECRETS=()
MIGRATED_SECRETS=()
PLACEHOLDER_SECRETS=()
CREATED_LOG_GROUPS=()
REGISTERED_TASK_DEFS=()
CREATED_TGS=()
CREATED_RULES=()
CREATED_SERVICES=()
SKIPPED_SERVICES=()

# ===========================================================================
# Helper functions
# ===========================================================================
secret_arn() {
  # Return the ARN of a Secrets Manager secret, or empty string if missing.
  local name="$1"
  aws secretsmanager describe-secret \
    --secret-id "$name" \
    --region "$REGION" \
    --query 'ARN' --output text 2>/dev/null || true
}

secret_value() {
  # Read plaintext value of a secret.
  local name="$1"
  aws secretsmanager get-secret-value \
    --secret-id "$name" \
    --region "$REGION" \
    --query 'SecretString' --output text 2>/dev/null || true
}

ensure_secret() {
  # Create a secret if it doesn't already exist.
  # Usage: ensure_secret <name> <value>
  local name="$1"
  local value="$2"
  local arn
  arn=$(secret_arn "$name")
  if [ -n "$arn" ] && [ "$arn" != "None" ]; then
    echo "  [exists] $name"
  else
    aws secretsmanager create-secret \
      --name "$name" \
      --secret-string "$value" \
      --region "$REGION" \
      --output text --query 'ARN' > /dev/null
    CREATED_SECRETS+=("$name")
    if [ "$value" = "CHANGEME" ]; then
      PLACEHOLDER_SECRETS+=("$name")
    fi
    echo "  [created] $name"
  fi
}

migrate_secret() {
  # Copy value from an old secret name to a new one (if old exists and new
  # does not).  Falls back to a placeholder if the old secret is missing too.
  local old_name="$1"
  local new_name="$2"
  local new_arn
  new_arn=$(secret_arn "$new_name")
  if [ -n "$new_arn" ] && [ "$new_arn" != "None" ]; then
    echo "  [exists] $new_name (skipping migration)"
    return
  fi

  local old_val
  old_val=$(secret_value "$old_name")
  if [ -n "$old_val" ] && [ "$old_val" != "None" ]; then
    aws secretsmanager create-secret \
      --name "$new_name" \
      --secret-string "$old_val" \
      --region "$REGION" \
      --output text --query 'ARN' > /dev/null
    MIGRATED_SECRETS+=("$old_name -> $new_name")
    echo "  [migrated] $old_name -> $new_name"
  else
    ensure_secret "$new_name" "CHANGEME"
    echo "  [warning] Old secret $old_name not found; created $new_name with placeholder"
  fi
}

ensure_log_group() {
  local name="$1"
  if aws logs describe-log-groups \
       --log-group-name-prefix "$name" \
       --region "$REGION" \
       --query "logGroups[?logGroupName=='$name'].logGroupName" \
       --output text 2>/dev/null | grep -q "$name"; then
    echo "  [exists] Log group $name"
  else
    aws logs create-log-group --log-group-name "$name" --region "$REGION"
    aws logs put-retention-policy --log-group-name "$name" --retention-in-days 30 --region "$REGION"
    CREATED_LOG_GROUPS+=("$name")
    echo "  [created] Log group $name (30-day retention)"
  fi
}

get_secret_arn() {
  # Like secret_arn but fatal if missing — used when building task defs.
  local name="$1"
  local arn
  arn=$(aws secretsmanager describe-secret \
    --secret-id "$name" \
    --region "$REGION" \
    --query 'ARN' --output text 2>/dev/null)
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    echo "FATAL: secret $name not found" >&2
    exit 1
  fi
  echo "$arn"
}

# ===========================================================================
echo ""
echo "============================================================"
echo " 1. SECRETS MANAGER — migrate and create secrets"
echo "============================================================"
# ===========================================================================

echo ""
echo "--- Migrating renamed secrets ---"
migrate_secret "vera/VAULT_KEY_V1"              "vera/VAULT_PAN_DEK_V1"
migrate_secret "vera/VAULT_KEY_ACTIVE_VERSION"   "vera/VAULT_PAN_DEK_ACTIVE_VERSION"
migrate_secret "vera/VAULT_FINGERPRINT_KEY"      "vera/VAULT_PAN_FINGERPRINT_KEY"

echo ""
echo "--- Ensuring all required secrets exist ---"
# Secrets that should already exist (from previous setup)
ensure_secret "vera/DATABASE_URL"                "CHANGEME"
ensure_secret "vera/VERA_ROOT_ARQC_SEED"         "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_PAY_SECRET"      "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_ACTIVATION_SECRET" "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_ADMIN_SECRET"    "CHANGEME"
ensure_secret "vera/ADMIN_API_KEY"               "CHANGEME"
ensure_secret "vera/WEBAUTHN_RP_ID"              "CHANGEME"
ensure_secret "vera/WEBAUTHN_ORIGINS"            "CHANGEME"
ensure_secret "vera/PAYMENT_PROVIDER"            "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_KEYS"           "CHANGEME"

# New secrets that never existed
ensure_secret "vera/CARD_FIELD_DEK_V1"           "CHANGEME"
ensure_secret "vera/CARD_FIELD_DEK_ACTIVE_VERSION" "CHANGEME"
ensure_secret "vera/CARD_UID_FINGERPRINT_KEY"    "CHANGEME"
ensure_secret "vera/TAP_HANDOFF_SECRET"          "CHANGEME"
ensure_secret "vera/PROVISION_AUTH_KEYS"         "CHANGEME"
ensure_secret "vera/CORS_ORIGINS"                "CHANGEME"
ensure_secret "vera/WEBAUTHN_RP_NAME"            "CHANGEME"
ensure_secret "vera/STRIPE_SECRET_KEY"           "CHANGEME"
ensure_secret "vera/STRIPE_PUBLISHABLE_KEY"      "CHANGEME"
ensure_secret "vera/TRANSACTION_TTL_SECONDS"     "CHANGEME"
ensure_secret "vera/RETRIEVAL_TOKEN_TTL_SECONDS" "CHANGEME"

# New secrets for provisioning services
ensure_secret "vera/KMS_SAD_KEY_ARN"            "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_PROVISIONING_SECRET" "CHANGEME"
# Mock-mode toggle for data-prep — "true" bypasses AWS Payment Cryptography
# (deterministic fake iCVV + mock key ARNs).  Safe only for non-prod.
ensure_secret "vera/DATA_PREP_MOCK_EMV"         "false"
ensure_secret "vera/DATA_PREP_SERVICE_URL"      "http://internal-vera-internal-886106335.ap-southeast-2.elb.amazonaws.com:3006"
ensure_secret "vera/RCA_SERVICE_URL"            "http://internal-vera-internal-886106335.ap-southeast-2.elb.amazonaws.com:3007"
ensure_secret "vera/CALLBACK_HMAC_SECRET"       "CHANGEME"

# Batch processor — parses uploaded embossing files from S3 and routes records
# to activation.  Shares EMBOSSING_KEY_V1 with the admin service (both read the
# same EmbossingTemplate rows).  SERVICE_AUTH_BATCH_PROCESSOR_SECRET must also
# be registered in vera/PROVISION_AUTH_KEYS under keyId "batch-processor".
ensure_secret "vera/EMBOSSING_KEY_V1"           "CHANGEME"
ensure_secret "vera/EMBOSSING_KEY_ACTIVE_VERSION" "1"
ensure_secret "vera/EMBOSSING_BUCKET"           "karta-embossing-files-${ACCOUNT}"
ensure_secret "vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET" "CHANGEME"
ensure_secret "vera/POLL_INTERVAL_MS"           "30000"
ensure_secret "vera/ACTIVATION_SERVICE_URL"     "http://internal-vera-internal-886106335.ap-southeast-2.elb.amazonaws.com:3002"

# SFTP service — self-hosted SFTP ingestion endpoint for partner embossing
# files.  SFTP_USERS is a JSON array of {username, uid, sshPublicKey}; each
# username MUST match a FinancialInstitution.slug.  Rotate keys by updating
# the secret and restarting the ECS service.
ensure_secret "vera/SFTP_USERS"                 "[]"
ensure_secret "vera/SFTP_POLL_INTERVAL_MS"      "30000"
ensure_secret "vera/SFTP_STABILITY_MS"          "15000"

# ===========================================================================
echo ""
echo "============================================================"
echo " 2. CLOUDWATCH LOG GROUPS"
echo "============================================================"
# ===========================================================================

for svc in tap activation pay vault admin data-prep rca batch-processor sftp; do
  ensure_log_group "/ecs/vera-${svc}"
done

# ===========================================================================
echo ""
echo "============================================================"
echo " 3. ECS TASK DEFINITIONS"
echo "============================================================"
# ===========================================================================

# Resolve all secret ARNs up-front so failures happen early.
echo ""
echo "--- Resolving secret ARNs ---"
ARN_DATABASE_URL=$(get_secret_arn "vera/DATABASE_URL")
ARN_CARD_FIELD_DEK_V1=$(get_secret_arn "vera/CARD_FIELD_DEK_V1")
ARN_CARD_FIELD_DEK_ACTIVE_VERSION=$(get_secret_arn "vera/CARD_FIELD_DEK_ACTIVE_VERSION")
ARN_TAP_HANDOFF_SECRET=$(get_secret_arn "vera/TAP_HANDOFF_SECRET")
ARN_CARD_UID_FINGERPRINT_KEY=$(get_secret_arn "vera/CARD_UID_FINGERPRINT_KEY")
ARN_PROVISION_AUTH_KEYS=$(get_secret_arn "vera/PROVISION_AUTH_KEYS")
ARN_SERVICE_AUTH_ACTIVATION_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_ACTIVATION_SECRET")
ARN_SERVICE_AUTH_PAY_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_PAY_SECRET")
ARN_SERVICE_AUTH_ADMIN_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_ADMIN_SECRET")
ARN_CORS_ORIGINS=$(get_secret_arn "vera/CORS_ORIGINS")
ARN_WEBAUTHN_RP_ID=$(get_secret_arn "vera/WEBAUTHN_RP_ID")
ARN_WEBAUTHN_ORIGINS=$(get_secret_arn "vera/WEBAUTHN_ORIGINS")
ARN_WEBAUTHN_RP_NAME=$(get_secret_arn "vera/WEBAUTHN_RP_NAME")
ARN_PAYMENT_PROVIDER=$(get_secret_arn "vera/PAYMENT_PROVIDER")
ARN_STRIPE_SECRET_KEY=$(get_secret_arn "vera/STRIPE_SECRET_KEY")
ARN_STRIPE_PUBLISHABLE_KEY=$(get_secret_arn "vera/STRIPE_PUBLISHABLE_KEY")
ARN_TRANSACTION_TTL_SECONDS=$(get_secret_arn "vera/TRANSACTION_TTL_SECONDS")
ARN_VERA_ROOT_ARQC_SEED=$(get_secret_arn "vera/VERA_ROOT_ARQC_SEED")
ARN_VAULT_PAN_DEK_V1=$(get_secret_arn "vera/VAULT_PAN_DEK_V1")
ARN_VAULT_PAN_DEK_ACTIVE_VERSION=$(get_secret_arn "vera/VAULT_PAN_DEK_ACTIVE_VERSION")
ARN_VAULT_PAN_FINGERPRINT_KEY=$(get_secret_arn "vera/VAULT_PAN_FINGERPRINT_KEY")
ARN_SERVICE_AUTH_KEYS=$(get_secret_arn "vera/SERVICE_AUTH_KEYS")
ARN_RETRIEVAL_TOKEN_TTL_SECONDS=$(get_secret_arn "vera/RETRIEVAL_TOKEN_TTL_SECONDS")
ARN_ADMIN_API_KEY=$(get_secret_arn "vera/ADMIN_API_KEY")
ARN_KMS_SAD_KEY_ARN=$(get_secret_arn "vera/KMS_SAD_KEY_ARN")
ARN_DATA_PREP_MOCK_EMV=$(get_secret_arn "vera/DATA_PREP_MOCK_EMV")
ARN_SERVICE_AUTH_PROVISIONING_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_PROVISIONING_SECRET")
ARN_CALLBACK_HMAC_SECRET=$(get_secret_arn "vera/CALLBACK_HMAC_SECRET")
ARN_EMBOSSING_KEY_V1=$(get_secret_arn "vera/EMBOSSING_KEY_V1")
ARN_EMBOSSING_KEY_ACTIVE_VERSION=$(get_secret_arn "vera/EMBOSSING_KEY_ACTIVE_VERSION")
ARN_EMBOSSING_BUCKET=$(get_secret_arn "vera/EMBOSSING_BUCKET")
ARN_SERVICE_AUTH_BATCH_PROCESSOR_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET")
ARN_POLL_INTERVAL_MS=$(get_secret_arn "vera/POLL_INTERVAL_MS")
ARN_ACTIVATION_SERVICE_URL=$(get_secret_arn "vera/ACTIVATION_SERVICE_URL")
ARN_SFTP_USERS=$(get_secret_arn "vera/SFTP_USERS")
ARN_SFTP_POLL_INTERVAL_MS=$(get_secret_arn "vera/SFTP_POLL_INTERVAL_MS")
ARN_SFTP_STABILITY_MS=$(get_secret_arn "vera/SFTP_STABILITY_MS")
echo "  All secret ARNs resolved."

# ---- tap (port 3001) ----
echo ""
echo "--- Registering task definition: vera-tap ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-tap",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-tap",
      "image": "${ECR_BASE}/vera-tap:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3001, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "ACTIVATION_URL", "value": "https://activation.karta.cards" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",                "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "CARD_FIELD_DEK_V1",           "valueFrom": "${ARN_CARD_FIELD_DEK_V1}" },
        { "name": "CARD_FIELD_DEK_ACTIVE_VERSION","valueFrom": "${ARN_CARD_FIELD_DEK_ACTIVE_VERSION}" },
        { "name": "TAP_HANDOFF_SECRET",          "valueFrom": "${ARN_TAP_HANDOFF_SECRET}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-tap",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-tap")

# ---- activation (port 3002) ----
echo ""
echo "--- Registering task definition: vera-activation ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-activation",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-activation",
      "image": "${ECR_BASE}/vera-activation:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3002, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "PAY_URL",            "value": "https://pay.karta.cards" },
        { "name": "VAULT_SERVICE_URL",   "value": "http://${INTERNAL_ALB_DNS}:3004" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",                   "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "CARD_FIELD_DEK_V1",              "valueFrom": "${ARN_CARD_FIELD_DEK_V1}" },
        { "name": "CARD_FIELD_DEK_ACTIVE_VERSION",  "valueFrom": "${ARN_CARD_FIELD_DEK_ACTIVE_VERSION}" },
        { "name": "CARD_UID_FINGERPRINT_KEY",       "valueFrom": "${ARN_CARD_UID_FINGERPRINT_KEY}" },
        { "name": "PROVISION_AUTH_KEYS",             "valueFrom": "${ARN_PROVISION_AUTH_KEYS}" },
        { "name": "TAP_HANDOFF_SECRET",             "valueFrom": "${ARN_TAP_HANDOFF_SECRET}" },
        { "name": "SERVICE_AUTH_ACTIVATION_SECRET",  "valueFrom": "${ARN_SERVICE_AUTH_ACTIVATION_SECRET}" },
        { "name": "CORS_ORIGINS",                    "valueFrom": "${ARN_CORS_ORIGINS}" },
        { "name": "WEBAUTHN_RP_ID",                  "valueFrom": "${ARN_WEBAUTHN_RP_ID}" },
        { "name": "WEBAUTHN_ORIGINS",                "valueFrom": "${ARN_WEBAUTHN_ORIGINS}" },
        { "name": "WEBAUTHN_RP_NAME",                "valueFrom": "${ARN_WEBAUTHN_RP_NAME}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-activation",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-activation")

# ---- pay (port 3003) ----
echo ""
echo "--- Registering task definition: vera-pay ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-pay",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-pay",
      "image": "${ECR_BASE}/vera-pay:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3003, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "VAULT_SERVICE_URL", "value": "http://${INTERNAL_ALB_DNS}:3004" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",              "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "CORS_ORIGINS",              "valueFrom": "${ARN_CORS_ORIGINS}" },
        { "name": "SERVICE_AUTH_PAY_SECRET",   "valueFrom": "${ARN_SERVICE_AUTH_PAY_SECRET}" },
        { "name": "PAYMENT_PROVIDER",          "valueFrom": "${ARN_PAYMENT_PROVIDER}" },
        { "name": "STRIPE_SECRET_KEY",         "valueFrom": "${ARN_STRIPE_SECRET_KEY}" },
        { "name": "STRIPE_PUBLISHABLE_KEY",    "valueFrom": "${ARN_STRIPE_PUBLISHABLE_KEY}" },
        { "name": "TRANSACTION_TTL_SECONDS",   "valueFrom": "${ARN_TRANSACTION_TTL_SECONDS}" },
        { "name": "VERA_ROOT_ARQC_SEED",      "valueFrom": "${ARN_VERA_ROOT_ARQC_SEED}" },
        { "name": "WEBAUTHN_RP_ID",            "valueFrom": "${ARN_WEBAUTHN_RP_ID}" },
        { "name": "WEBAUTHN_ORIGINS",          "valueFrom": "${ARN_WEBAUTHN_ORIGINS}" },
        { "name": "WEBAUTHN_RP_NAME",          "valueFrom": "${ARN_WEBAUTHN_RP_NAME}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-pay",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-pay")

# ---- vault (port 3004) ----
echo ""
echo "--- Registering task definition: vera-vault ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-vault",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-vault",
      "image": "${ECR_BASE}/vera-vault:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3004, "protocol": "tcp" }
      ],
      "environment": [],
      "secrets": [
        { "name": "DATABASE_URL",                 "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "VAULT_PAN_DEK_V1",             "valueFrom": "${ARN_VAULT_PAN_DEK_V1}" },
        { "name": "VAULT_PAN_DEK_ACTIVE_VERSION", "valueFrom": "${ARN_VAULT_PAN_DEK_ACTIVE_VERSION}" },
        { "name": "VAULT_PAN_FINGERPRINT_KEY",    "valueFrom": "${ARN_VAULT_PAN_FINGERPRINT_KEY}" },
        { "name": "SERVICE_AUTH_KEYS",             "valueFrom": "${ARN_SERVICE_AUTH_KEYS}" },
        { "name": "RETRIEVAL_TOKEN_TTL_SECONDS",   "valueFrom": "${ARN_RETRIEVAL_TOKEN_TTL_SECONDS}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-vault",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-vault")

# ---- admin (port 3005) ----
echo ""
echo "--- Registering task definition: vera-admin ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-admin",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-admin",
      "image": "${ECR_BASE}/vera-admin:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3005, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "VAULT_SERVICE_URL",  "value": "http://${INTERNAL_ALB_DNS}:3004" },
        { "name": "WEBAUTHN_ORIGIN",    "value": "https://manage.karta.cards" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",               "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "CORS_ORIGINS",               "valueFrom": "${ARN_CORS_ORIGINS}" },
        { "name": "ADMIN_API_KEY",              "valueFrom": "${ARN_ADMIN_API_KEY}" },
        { "name": "SERVICE_AUTH_ADMIN_SECRET",  "valueFrom": "${ARN_SERVICE_AUTH_ADMIN_SECRET}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-admin",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-admin")

# --- data-prep (port 3006, internal, HMAC-gated) ---
aws ecs register-task-definition --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-data-prep",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-data-prep",
      "image": "${ECR_BASE}/vera-data-prep:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3006, "protocol": "tcp" }
      ],
      "environment": [],
      "secrets": [
        { "name": "DATABASE_URL",                   "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "PROVISION_AUTH_KEYS",             "valueFrom": "${ARN_PROVISION_AUTH_KEYS}" },
        { "name": "KMS_SAD_KEY_ARN",                "valueFrom": "${ARN_KMS_SAD_KEY_ARN}" },
        { "name": "DATA_PREP_MOCK_EMV",             "valueFrom": "${ARN_DATA_PREP_MOCK_EMV}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-data-prep",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-data-prep")

# --- rca (port 3007, internal, WebSocket + HMAC-gated) ---
aws ecs register-task-definition --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-rca",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-rca",
      "image": "${ECR_BASE}/vera-rca:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3007, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "DATA_PREP_SERVICE_URL", "value": "http://${INTERNAL_ALB_DNS}:3006" },
        { "name": "ACTIVATION_CALLBACK_URL", "value": "http://${INTERNAL_ALB_DNS}:3002" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",                   "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "PROVISION_AUTH_KEYS",             "valueFrom": "${ARN_PROVISION_AUTH_KEYS}" },
        { "name": "CALLBACK_HMAC_SECRET",           "valueFrom": "${ARN_CALLBACK_HMAC_SECRET}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-rca",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-rca")

# --- batch-processor (port 3008, internal — pure worker, polls DB + S3) ---
# No ALB routing — the service only exposes /api/health for target-group
# health checks.  It reads EmbossingBatch rows in RECEIVED status, decrypts
# the linked template, downloads the batch file from S3, parses it, and
# HMAC-signs calls to activation's /api/cards/register.
echo ""
echo "--- Registering task definition: vera-batch-processor ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-batch-processor",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-batch-processor",
      "image": "${ECR_BASE}/vera-batch-processor:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3008, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "AWS_REGION", "value": "${REGION}" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",                         "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "EMBOSSING_KEY_V1",                     "valueFrom": "${ARN_EMBOSSING_KEY_V1}" },
        { "name": "EMBOSSING_KEY_ACTIVE_VERSION",         "valueFrom": "${ARN_EMBOSSING_KEY_ACTIVE_VERSION}" },
        { "name": "EMBOSSING_BUCKET",                     "valueFrom": "${ARN_EMBOSSING_BUCKET}" },
        { "name": "SERVICE_AUTH_BATCH_PROCESSOR_SECRET",  "valueFrom": "${ARN_SERVICE_AUTH_BATCH_PROCESSOR_SECRET}" },
        { "name": "ACTIVATION_SERVICE_URL",               "valueFrom": "${ARN_ACTIVATION_SERVICE_URL}" },
        { "name": "POLL_INTERVAL_MS",                     "valueFrom": "${ARN_POLL_INTERVAL_MS}" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -q -O- http://localhost:3008/api/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-batch-processor",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-batch-processor")

# --- sftp (port 22, public via NLB) -----------------------------------------
# Runs sshd + the Node ingester in one container.  SFTP_USERS env is a JSON
# array of partner accounts, each mapping to a FinancialInstitution.slug.
# The ingester uploads received files to the shared embossing-files S3
# bucket (same bucket admin + partner API write to) and creates RECEIVED
# EmbossingBatch rows for the batch-processor to pick up.
echo ""
echo "--- Registering task definition: vera-sftp ---"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$(cat <<TASKJSON
{
  "family": "vera-sftp",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "vera-sftp",
      "image": "${ECR_BASE}/vera-sftp:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 22, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "AWS_REGION", "value": "${REGION}" },
        { "name": "SFTP_HOME_BASE", "value": "/home" }
      ],
      "secrets": [
        { "name": "DATABASE_URL",             "valueFrom": "${ARN_DATABASE_URL}" },
        { "name": "EMBOSSING_BUCKET",         "valueFrom": "${ARN_EMBOSSING_BUCKET}" },
        { "name": "SFTP_USERS",               "valueFrom": "${ARN_SFTP_USERS}" },
        { "name": "SFTP_POLL_INTERVAL_MS",    "valueFrom": "${ARN_SFTP_POLL_INTERVAL_MS}" },
        { "name": "SFTP_STABILITY_MS",        "valueFrom": "${ARN_SFTP_STABILITY_MS}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/vera-sftp",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
TASKJSON
)" --query 'taskDefinition.taskDefinitionArn' --output text
REGISTERED_TASK_DEFS+=("vera-sftp")

# ===========================================================================
echo ""
echo "============================================================"
echo " 4. TARGET GROUPS"
echo "============================================================"
# ===========================================================================

svc_port() {
  case "$1" in
    tap) echo 3001 ;; activation) echo 3002 ;; pay) echo 3003 ;;
    vault) echo 3004 ;; admin) echo 3005 ;; data-prep) echo 3006 ;;
    rca) echo 3007 ;; batch-processor) echo 3008 ;; sftp) echo 22 ;;
  esac
}

for svc in tap activation pay vault admin data-prep rca batch-processor sftp; do
  # batch-processor is a pure worker (no inbound traffic) — no TG needed.
  # ECS uses a container-level healthCheck instead.
  if [ "$svc" = "batch-processor" ]; then
    echo "  [skip] Target group for $svc (pure worker — uses container healthCheck)"
    continue
  fi
  # sftp uses a TCP target group attached to an NLB — handled separately
  # below so the loop stays HTTP-only.
  if [ "$svc" = "sftp" ]; then
    continue
  fi
  TG_NAME="vera-${svc}"
  PORT=$(svc_port "$svc")

  EXISTING_TG=$(aws elbv2 describe-target-groups \
    --names "$TG_NAME" \
    --region "$REGION" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text 2>/dev/null || true)

  if [ -n "$EXISTING_TG" ] && [ "$EXISTING_TG" != "None" ]; then
    echo "  [exists] Target group $TG_NAME ($EXISTING_TG)"
  else
    EXISTING_TG=$(aws elbv2 create-target-group \
      --name "$TG_NAME" \
      --protocol HTTP \
      --port "$PORT" \
      --vpc-id "$VPC" \
      --target-type ip \
      --health-check-protocol HTTP \
      --health-check-path "/api/health" \
      --health-check-interval-seconds 30 \
      --healthy-threshold-count 2 \
      --unhealthy-threshold-count 3 \
      --region "$REGION" \
      --query 'TargetGroups[0].TargetGroupArn' \
      --output text)
    CREATED_TGS+=("$TG_NAME")
    echo "  [created] Target group $TG_NAME ($EXISTING_TG)"
  fi

  # Store the ARN for later use (sanitize hyphen for bash variable name)
  local var_name="${svc//-/_}"
  eval "TG_ARN_${var_name}=\$EXISTING_TG"
done

# ---- SFTP — TCP target group for NLB (TCP health check on port 22) ----
echo ""
echo "--- SFTP target group (TCP / NLB) ---"

SFTP_TG_ARN=$(aws elbv2 describe-target-groups \
  --names "vera-sftp" \
  --region "$REGION" \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text 2>/dev/null || true)

if [ -n "$SFTP_TG_ARN" ] && [ "$SFTP_TG_ARN" != "None" ]; then
  echo "  [exists] Target group vera-sftp ($SFTP_TG_ARN)"
else
  SFTP_TG_ARN=$(aws elbv2 create-target-group \
    --name "vera-sftp" \
    --protocol TCP \
    --port 22 \
    --vpc-id "$VPC" \
    --target-type ip \
    --health-check-protocol TCP \
    --health-check-interval-seconds 30 \
    --healthy-threshold-count 3 \
    --unhealthy-threshold-count 3 \
    --region "$REGION" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)
  CREATED_TGS+=("vera-sftp")
  echo "  [created] Target group vera-sftp ($SFTP_TG_ARN)"
fi

# ===========================================================================
echo ""
echo "============================================================"
echo " 5. ALB LISTENER RULES"
echo "============================================================"
# ===========================================================================

# ---- Public ALB listener (HTTP:80) ----
echo ""
echo "--- Public ALB (HTTP:80) ---"

# Find or fail on the public HTTP:80 listener
PUBLIC_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$PUBLIC_ALB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" \
  --output text)

if [ -z "$PUBLIC_LISTENER_ARN" ] || [ "$PUBLIC_LISTENER_ARN" = "None" ]; then
  echo "  [error] No HTTP:80 listener found on public ALB. Creating one..."
  PUBLIC_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$PUBLIC_ALB_ARN" \
    --protocol HTTP \
    --port 80 \
    --default-actions "Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=Not Found}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] Public HTTP:80 listener"
fi
echo "  Public listener: $PUBLIC_LISTENER_ARN"

# Fetch existing rules to avoid duplicates
EXISTING_RULES=$(aws elbv2 describe-rules \
  --listener-arn "$PUBLIC_LISTENER_ARN" \
  --region "$REGION" \
  --output json)

create_host_rule() {
  local listener_arn="$1"
  local host="$2"
  local tg_arn="$3"
  local priority="$4"
  local existing_rules_json="$5"

  # Check if a rule for this host already exists
  local existing
  existing=$(echo "$existing_rules_json" | jq -r \
    --arg host "$host" \
    '.Rules[] | select(.Conditions[]? | select(.Field=="host-header") | .Values[]? == $host) | .RuleArn' \
    2>/dev/null || true)

  if [ -n "$existing" ]; then
    echo "  [exists] Rule for host $host -> $tg_arn"
  else
    aws elbv2 create-rule \
      --listener-arn "$listener_arn" \
      --priority "$priority" \
      --conditions "Field=host-header,Values=$host" \
      --actions "Type=forward,TargetGroupArn=$tg_arn" \
      --region "$REGION" \
      --output text --query 'Rules[0].RuleArn' > /dev/null
    CREATED_RULES+=("$host -> $(echo "$tg_arn" | grep -o 'vera-[a-z]*')")
    echo "  [created] Rule priority=$priority: $host -> target group"
  fi
}

create_host_rule "$PUBLIC_LISTENER_ARN" "tap.karta.cards"        "$TG_ARN_tap"        1 "$EXISTING_RULES"
create_host_rule "$PUBLIC_LISTENER_ARN" "activation.karta.cards" "$TG_ARN_activation" 2 "$EXISTING_RULES"
create_host_rule "$PUBLIC_LISTENER_ARN" "pay.karta.cards"        "$TG_ARN_pay"        3 "$EXISTING_RULES"
create_host_rule "$PUBLIC_LISTENER_ARN" "manage.karta.cards"      "$TG_ARN_admin"      4 "$EXISTING_RULES"

# ---- Internal ALB listener (HTTP:80) ----
echo ""
echo "--- Internal ALB (HTTP:80) ---"

INTERNAL_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$INTERNAL_ALB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$INTERNAL_LISTENER_ARN" ] || [ "$INTERNAL_LISTENER_ARN" = "None" ]; then
  echo "  [creating] Internal HTTP:80 listener with default -> vera-vault"
  INTERNAL_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$INTERNAL_ALB_ARN" \
    --protocol HTTP \
    --port 80 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_vault}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] Internal HTTP:80 listener -> vera-vault"
else
  echo "  [exists] Internal HTTP:80 listener ($INTERNAL_LISTENER_ARN)"
  echo "  Updating default action to forward to vera-vault..."
  aws elbv2 modify-listener \
    --listener-arn "$INTERNAL_LISTENER_ARN" \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_vault}" \
    --region "$REGION" \
    --output text > /dev/null
  echo "  [updated] Default action -> vera-vault"
fi

# Also create a listener on port 3004 for the internal ALB so that
# http://<internal-alb>:3004 works as the VAULT_SERVICE_URL used by
# activation, pay, and admin services.
echo ""
echo "--- Internal ALB (HTTP:3004 for vault) ---"

INTERNAL_3004_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$INTERNAL_ALB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`3004\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$INTERNAL_3004_LISTENER_ARN" ] || [ "$INTERNAL_3004_LISTENER_ARN" = "None" ]; then
  INTERNAL_3004_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$INTERNAL_ALB_ARN" \
    --protocol HTTP \
    --port 3004 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_vault}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] Internal HTTP:3004 listener -> vera-vault"
else
  echo "  [exists] Internal HTTP:3004 listener ($INTERNAL_3004_LISTENER_ARN)"
  aws elbv2 modify-listener \
    --listener-arn "$INTERNAL_3004_LISTENER_ARN" \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_vault}" \
    --region "$REGION" \
    --output text > /dev/null
  echo "  [updated] HTTP:3004 default action -> vera-vault"
fi

# ---- Internal ALB (HTTP:3006 for data-prep) ----
echo ""
echo "--- Internal ALB (HTTP:3006 for data-prep) ---"

INTERNAL_3006_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$INTERNAL_ALB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`3006\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$INTERNAL_3006_LISTENER_ARN" ] || [ "$INTERNAL_3006_LISTENER_ARN" = "None" ]; then
  INTERNAL_3006_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$INTERNAL_ALB_ARN" \
    --protocol HTTP \
    --port 3006 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_data_prep}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] Internal HTTP:3006 listener -> vera-data-prep"
else
  echo "  [exists] Internal HTTP:3006 listener ($INTERNAL_3006_LISTENER_ARN)"
  aws elbv2 modify-listener \
    --listener-arn "$INTERNAL_3006_LISTENER_ARN" \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_data_prep}" \
    --region "$REGION" \
    --output text > /dev/null
  echo "  [updated] HTTP:3006 default action -> vera-data-prep"
fi

# ---- Internal ALB (HTTP:3007 for rca) ----
echo ""
echo "--- Internal ALB (HTTP:3007 for rca) ---"

INTERNAL_3007_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$INTERNAL_ALB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`3007\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$INTERNAL_3007_LISTENER_ARN" ] || [ "$INTERNAL_3007_LISTENER_ARN" = "None" ]; then
  INTERNAL_3007_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$INTERNAL_ALB_ARN" \
    --protocol HTTP \
    --port 3007 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_rca}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] Internal HTTP:3007 listener -> vera-rca"
else
  echo "  [exists] Internal HTTP:3007 listener ($INTERNAL_3007_LISTENER_ARN)"
  aws elbv2 modify-listener \
    --listener-arn "$INTERNAL_3007_LISTENER_ARN" \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN_rca}" \
    --region "$REGION" \
    --output text > /dev/null
  echo "  [updated] HTTP:3007 default action -> vera-rca"
fi

# ---- Public ALB HTTPS:443 listener (requires validated ACM cert) ----
echo ""
echo "--- Public ALB (HTTPS:443) ---"

ACM_CERT_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='karta.cards' && Status=='ISSUED'].CertificateArn | [0]" \
  --output text 2>/dev/null || true)

if [ -n "$ACM_CERT_ARN" ] && [ "$ACM_CERT_ARN" != "None" ]; then
  PUBLIC_HTTPS_LISTENER_ARN=$(aws elbv2 describe-listeners \
    --load-balancer-arn "$PUBLIC_ALB_ARN" \
    --region "$REGION" \
    --query "Listeners[?Port==\`443\`].ListenerArn | [0]" \
    --output text 2>/dev/null || true)

  if [ -z "$PUBLIC_HTTPS_LISTENER_ARN" ] || [ "$PUBLIC_HTTPS_LISTENER_ARN" = "None" ]; then
    PUBLIC_HTTPS_LISTENER_ARN=$(aws elbv2 create-listener \
      --load-balancer-arn "$PUBLIC_ALB_ARN" \
      --protocol HTTPS \
      --port 443 \
      --certificates "CertificateArn=${ACM_CERT_ARN}" \
      --default-actions "Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=Not Found}" \
      --region "$REGION" \
      --query 'Listeners[0].ListenerArn' \
      --output text)
    echo "  [created] Public HTTPS:443 listener"
  else
    echo "  [exists] Public HTTPS:443 listener ($PUBLIC_HTTPS_LISTENER_ARN)"
  fi

  # Add the same host-header rules to the HTTPS listener
  EXISTING_HTTPS_RULES=$(aws elbv2 describe-rules \
    --listener-arn "$PUBLIC_HTTPS_LISTENER_ARN" \
    --region "$REGION" \
    --output json)

  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "tap.karta.cards"        "$TG_ARN_tap"        1 "$EXISTING_HTTPS_RULES"
  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "activation.karta.cards" "$TG_ARN_activation" 2 "$EXISTING_HTTPS_RULES"
  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "pay.karta.cards"        "$TG_ARN_pay"        3 "$EXISTING_HTTPS_RULES"
  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "manage.karta.cards"      "$TG_ARN_admin"      4 "$EXISTING_HTTPS_RULES"

  # Redirect HTTP:80 → HTTPS:443 by updating the default action
  echo ""
  echo "  Updating HTTP:80 default action to redirect -> HTTPS"
  aws elbv2 modify-listener \
    --listener-arn "$PUBLIC_LISTENER_ARN" \
    --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
    --region "$REGION" \
    --output text > /dev/null 2>&1 || true
else
  echo "  [skip] No validated ACM cert for karta.cards in $REGION"
  echo "  Run this script again after the certificate is issued."
fi

# ===========================================================================
echo ""
echo "============================================================"
echo " 5b. NLB — SFTP endpoint (public, TCP:22)"
echo "============================================================"
# ===========================================================================

# Public subnets derived from the public ALB so we don't have to hard-code
# subnet IDs.  NLB must be in public subnets because partners dial in from
# the internet.  Tasks behind it stay in private subnets (outbound via NAT).
PUBLIC_SUBNETS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$PUBLIC_ALB_ARN" \
  --region "$REGION" \
  --query "LoadBalancers[0].AvailabilityZones[].SubnetId" \
  --output text | tr '[:space:]' ',' | sed 's/,$//')

SFTP_NLB_ARN=$(aws elbv2 describe-load-balancers \
  --names "vera-sftp" \
  --region "$REGION" \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text 2>/dev/null || true)

if [ -n "$SFTP_NLB_ARN" ] && [ "$SFTP_NLB_ARN" != "None" ]; then
  echo "  [exists] NLB vera-sftp ($SFTP_NLB_ARN)"
else
  # Create as a network load balancer.  elastic-load-balancer-class-of-2018
  # NLBs take a few minutes to provision.  internet-facing scheme makes the
  # NLB publicly reachable.
  # shellcheck disable=SC2086
  SFTP_NLB_ARN=$(aws elbv2 create-load-balancer \
    --name "vera-sftp" \
    --type network \
    --scheme internet-facing \
    --ip-address-type ipv4 \
    --subnets ${PUBLIC_SUBNETS//,/ } \
    --region "$REGION" \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)
  echo "  [created] NLB vera-sftp ($SFTP_NLB_ARN)"
  echo "  NLB provisioning takes ~3 min before it's routable — first DNS"
  echo "  lookup will NXDOMAIN until AWS finishes setup."
fi

SFTP_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$SFTP_NLB_ARN" \
  --region "$REGION" \
  --query "Listeners[?Port==\`22\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$SFTP_LISTENER_ARN" ] || [ "$SFTP_LISTENER_ARN" = "None" ]; then
  SFTP_LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn "$SFTP_NLB_ARN" \
    --protocol TCP \
    --port 22 \
    --default-actions "Type=forward,TargetGroupArn=${SFTP_TG_ARN}" \
    --region "$REGION" \
    --query 'Listeners[0].ListenerArn' \
    --output text)
  echo "  [created] NLB TCP:22 listener -> vera-sftp TG"
else
  echo "  [exists] NLB TCP:22 listener ($SFTP_LISTENER_ARN)"
fi

SFTP_NLB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$SFTP_NLB_ARN" \
  --region "$REGION" \
  --query 'LoadBalancers[0].DNSName' \
  --output text)
echo "  NLB DNS: $SFTP_NLB_DNS"
echo "  Add a CNAME: sftp.karta.cards -> $SFTP_NLB_DNS"

# ===========================================================================
echo ""
echo "============================================================"
echo " 6. ECS SERVICES"
echo "============================================================"
# ===========================================================================

for svc in tap activation pay vault admin data-prep rca batch-processor sftp; do
  SVC_NAME="vera-${svc}"
  PORT=$(svc_port "$svc")
  local var_name="${svc//-/_}"
  # sftp's TG is a TCP/NLB group — separately tracked in SFTP_TG_ARN above.
  if [ "$svc" = "sftp" ]; then
    TG_ARN="$SFTP_TG_ARN"
  else
    eval "TG_ARN=\$TG_ARN_${var_name}"
  fi

  # Check if the service already exists
  EXISTING_SVC=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SVC_NAME" \
    --region "$REGION" \
    --query "services[?status=='ACTIVE'].serviceName | [0]" \
    --output text 2>/dev/null || true)

  if [ -n "$EXISTING_SVC" ] && [ "$EXISTING_SVC" != "None" ]; then
    echo "  [exists] ECS service $SVC_NAME — updating to latest task definition"
    aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$SVC_NAME" \
      --task-definition "$SVC_NAME" \
      --force-new-deployment \
      --region "$REGION" \
      --output text --query 'service.serviceName' > /dev/null
    SKIPPED_SERVICES+=("$SVC_NAME (updated)")
  else
    echo "  [creating] ECS service $SVC_NAME"
    # batch-processor has no ALB attachment — container healthCheck gates
    # deployments.  All other services attach to their target group.
    if [ "$svc" = "batch-processor" ]; then
      aws ecs create-service \
        --cluster "$CLUSTER" \
        --service-name "$SVC_NAME" \
        --task-definition "$SVC_NAME" \
        --desired-count 1 \
        --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[${PRIVATE_SUBNETS}],securityGroups=[${ECS_SG}],assignPublicIp=DISABLED}" \
        --region "$REGION" \
        --output text --query 'service.serviceName' > /dev/null
    else
      aws ecs create-service \
        --cluster "$CLUSTER" \
        --service-name "$SVC_NAME" \
        --task-definition "$SVC_NAME" \
        --desired-count 1 \
        --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[${PRIVATE_SUBNETS}],securityGroups=[${ECS_SG}],assignPublicIp=DISABLED}" \
        --load-balancers "targetGroupArn=${TG_ARN},containerName=${SVC_NAME},containerPort=${PORT}" \
        --health-check-grace-period-seconds 120 \
        --region "$REGION" \
        --output text --query 'service.serviceName' > /dev/null
    fi
    CREATED_SERVICES+=("$SVC_NAME")
    echo "  [created] ECS service $SVC_NAME"
  fi
done

# ===========================================================================
echo ""
echo ""
echo "============================================================"
echo " SUMMARY"
echo "============================================================"
echo ""

if [ ${#MIGRATED_SECRETS[@]} -gt 0 ]; then
  echo "Migrated secrets (old -> new):"
  for s in "${MIGRATED_SECRETS[@]}"; do echo "  - $s"; done
  echo ""
fi

if [ ${#CREATED_SECRETS[@]} -gt 0 ]; then
  echo "Created secrets:"
  for s in "${CREATED_SECRETS[@]}"; do echo "  - $s"; done
  echo ""
fi

if [ ${#CREATED_LOG_GROUPS[@]} -gt 0 ]; then
  echo "Created log groups:"
  for g in "${CREATED_LOG_GROUPS[@]}"; do echo "  - $g"; done
  echo ""
fi

if [ ${#REGISTERED_TASK_DEFS[@]} -gt 0 ]; then
  echo "Registered task definitions:"
  for t in "${REGISTERED_TASK_DEFS[@]}"; do echo "  - $t"; done
  echo ""
fi

if [ ${#CREATED_TGS[@]} -gt 0 ]; then
  echo "Created target groups:"
  for t in "${CREATED_TGS[@]}"; do echo "  - $t"; done
  echo ""
fi

if [ ${#CREATED_RULES[@]} -gt 0 ]; then
  echo "Created ALB listener rules:"
  for r in "${CREATED_RULES[@]}"; do echo "  - $r"; done
  echo ""
fi

if [ ${#CREATED_SERVICES[@]} -gt 0 ]; then
  echo "Created ECS services:"
  for s in "${CREATED_SERVICES[@]}"; do echo "  - $s"; done
  echo ""
fi

if [ ${#SKIPPED_SERVICES[@]} -gt 0 ]; then
  echo "Updated existing ECS services:"
  for s in "${SKIPPED_SERVICES[@]}"; do echo "  - $s"; done
  echo ""
fi

if [ ${#PLACEHOLDER_SECRETS[@]} -gt 0 ]; then
  echo "============================================================"
  echo " ACTION REQUIRED: Update these placeholder secrets"
  echo "============================================================"
  echo ""
  echo "The following secrets were created with the value 'CHANGEME'."
  echo "Update them before deploying:"
  echo ""
  for s in "${PLACEHOLDER_SECRETS[@]}"; do
    echo "  aws secretsmanager put-secret-value --secret-id $s --secret-string '<real value>' --region $REGION"
  done
  echo ""
fi

echo "============================================================"
echo " OTHER MANUAL STEPS"
echo "============================================================"
echo ""
echo "1. Ensure the ECS security group ($ECS_SG) allows:"
echo "   - Inbound from the public ALB SG on ports 3001-3003, 3005"
echo "   - Inbound from the internal ALB SG on port 3004"
echo "   - Outbound to the internet (for ECR image pulls and Secrets Manager)"
echo ""
echo "2. Ensure the internal ALB SG allows inbound from $ECS_SG on port 3004"
echo ""
echo "3. Ensure DNS records point to the public ALB:"
echo "   - tap.karta.cards        -> $(echo "$PUBLIC_ALB_ARN" | sed 's/.*\///')"
echo "   - activation.karta.cards -> (same)"
echo "   - pay.karta.cards        -> (same)"
echo "   - manage.karta.cards      -> (same)"
echo ""
echo "4. Ensure ECR repositories exist for each service:"
echo "   vera-tap, vera-activation, vera-pay, vera-vault, vera-admin,"
echo "   vera-data-prep, vera-rca, vera-batch-processor"
echo ""
echo "5. Ensure the execution role ($EXEC_ROLE) has:"
echo "   - secretsmanager:GetSecretValue for vera/* secrets"
echo "   - logs:CreateLogStream, logs:PutLogEvents for /ecs/vera-* groups"
echo "   - ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer"
echo ""
echo "6. Ensure the vera-batch-processor task role has:"
echo "   - s3:GetObject on arn:aws:s3:::karta-embossing-files-${ACCOUNT}/*"
echo "   - kms:Decrypt on the KMS key used for the embossing bucket SSE"
echo ""
echo "7. Ensure the vera-sftp task role has:"
echo "   - s3:PutObject on arn:aws:s3:::karta-embossing-files-${ACCOUNT}/*"
echo "   - kms:Encrypt, kms:GenerateDataKey on the bucket SSE-KMS key"
echo ""
echo "8. Update the ECS security group ($ECS_SG) to allow partner SFTP:"
echo "   - Inbound TCP:22 from 0.0.0.0/0 (or specific partner CIDRs if known)"
echo "   NLB targets preserve source IP and have no SG of their own."
echo ""
echo "9. Seed vera/SFTP_USERS with the real partner list.  Format:"
echo "     [{\"username\":\"<fi-slug>\",\"uid\":1001,\"sshPublicKey\":\"ssh-ed25519 ...\"}]"
echo "   Username MUST equal the FinancialInstitution.slug.  Any change"
echo "   requires an ECS service restart to re-provision Linux accounts:"
echo "     aws ecs update-service --cluster $CLUSTER --service vera-sftp \\"
echo "       --force-new-deployment --region $REGION"
echo ""
echo "10. Create DNS:  sftp.karta.cards  CNAME  <NLB DNS from above>"
echo ""
echo "11. Merge the 'batch-processor' key into vera/PROVISION_AUTH_KEYS."
echo "   The JSON must contain BOTH provision-agent and batch-processor:"
echo ""
echo "     CURRENT=\$(aws secretsmanager get-secret-value \\"
echo "       --secret-id vera/PROVISION_AUTH_KEYS --region $REGION \\"
echo "       --query SecretString --output text)"
echo "     NEW=\$(echo \"\$CURRENT\" | jq --arg k \"\$(aws secretsmanager \\"
echo "       get-secret-value --secret-id vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET \\"
echo "       --region $REGION --query SecretString --output text)\" \\"
echo "       '. + {\"batch-processor\": \$k}')"
echo "     aws secretsmanager put-secret-value \\"
echo "       --secret-id vera/PROVISION_AUTH_KEYS \\"
echo "       --secret-string \"\$NEW\" --region $REGION"
echo ""
echo "Done."
