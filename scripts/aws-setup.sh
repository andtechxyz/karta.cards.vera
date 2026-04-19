#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Vera AWS infrastructure setup (post-split)
#
# Post-split scope: pay (3003), vault (3004), admin (3005).  The
# card-domain services (tap, activation, data-prep, rca, batch-processor,
# sftp) moved to the Palisade repo and are provisioned by Palisade's own
# aws-setup.sh against the same AWS account.  Secrets for moved services
# live under the palisade/ prefix and are not touched by this script.
#
# Idempotent: safe to re-run.  Creates or updates secrets, task
# definitions, target groups, ALB listener rules, and ECS services for
# the three Vera-owned services only.
#
# ALB host rule for manage.karta.cards defaults to vera-admin.  Palisade's
# script is expected to add a higher-priority path-condition rule routing
# /palisade-api/* to palisade-admin; until it runs, those paths 404.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials that can manage ECS, ELB,
#     Secrets Manager, CloudWatch Logs, and ECR in ap-southeast-2.
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
# Legacy VAULT_KEY_* → VAULT_PAN_DEK_* rename.  Idempotent after first run.
migrate_secret "vera/VAULT_KEY_V1"              "vera/VAULT_PAN_DEK_V1"
migrate_secret "vera/VAULT_KEY_ACTIVE_VERSION"   "vera/VAULT_PAN_DEK_ACTIVE_VERSION"
migrate_secret "vera/VAULT_FINGERPRINT_KEY"      "vera/VAULT_PAN_FINGERPRINT_KEY"

echo ""
echo "--- Ensuring all required secrets exist ---"
# Shared infrastructure.
ensure_secret "vera/DATABASE_URL"                "CHANGEME"
ensure_secret "vera/CORS_ORIGINS"                "CHANGEME"

# pay secrets.
ensure_secret "vera/SERVICE_AUTH_PAY_SECRET"      "CHANGEME"
ensure_secret "vera/VERA_ROOT_ARQC_SEED"          "CHANGEME"
ensure_secret "vera/PAYMENT_PROVIDER"             "CHANGEME"
ensure_secret "vera/STRIPE_SECRET_KEY"            "CHANGEME"
ensure_secret "vera/STRIPE_PUBLISHABLE_KEY"       "CHANGEME"
ensure_secret "vera/TRANSACTION_TTL_SECONDS"      "CHANGEME"
# WebAuthn step-up challenge config — pay issues biometric assertions for
# above-threshold transactions, so it shares the relying-party config with
# activation (now Palisade-side).  Keep names stable across the split.
ensure_secret "vera/WEBAUTHN_RP_ID"               "CHANGEME"
ensure_secret "vera/WEBAUTHN_ORIGINS"             "CHANGEME"
ensure_secret "vera/WEBAUTHN_RP_NAME"             "CHANGEME"

# vault secrets.
ensure_secret "vera/SERVICE_AUTH_KEYS"            "CHANGEME"
ensure_secret "vera/RETRIEVAL_TOKEN_TTL_SECONDS"  "CHANGEME"

# admin secrets.
ensure_secret "vera/ADMIN_API_KEY"                "CHANGEME"
ensure_secret "vera/SERVICE_AUTH_ADMIN_SECRET"    "CHANGEME"

# ===========================================================================
echo ""
echo "============================================================"
echo " 2. CLOUDWATCH LOG GROUPS"
echo "============================================================"
# ===========================================================================

for svc in pay vault admin; do
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
ARN_CORS_ORIGINS=$(get_secret_arn "vera/CORS_ORIGINS")
ARN_SERVICE_AUTH_PAY_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_PAY_SECRET")
ARN_SERVICE_AUTH_ADMIN_SECRET=$(get_secret_arn "vera/SERVICE_AUTH_ADMIN_SECRET")
ARN_PAYMENT_PROVIDER=$(get_secret_arn "vera/PAYMENT_PROVIDER")
ARN_STRIPE_SECRET_KEY=$(get_secret_arn "vera/STRIPE_SECRET_KEY")
ARN_STRIPE_PUBLISHABLE_KEY=$(get_secret_arn "vera/STRIPE_PUBLISHABLE_KEY")
ARN_TRANSACTION_TTL_SECONDS=$(get_secret_arn "vera/TRANSACTION_TTL_SECONDS")
ARN_VERA_ROOT_ARQC_SEED=$(get_secret_arn "vera/VERA_ROOT_ARQC_SEED")
ARN_WEBAUTHN_RP_ID=$(get_secret_arn "vera/WEBAUTHN_RP_ID")
ARN_WEBAUTHN_ORIGINS=$(get_secret_arn "vera/WEBAUTHN_ORIGINS")
ARN_WEBAUTHN_RP_NAME=$(get_secret_arn "vera/WEBAUTHN_RP_NAME")
ARN_VAULT_PAN_DEK_V1=$(get_secret_arn "vera/VAULT_PAN_DEK_V1")
ARN_VAULT_PAN_DEK_ACTIVE_VERSION=$(get_secret_arn "vera/VAULT_PAN_DEK_ACTIVE_VERSION")
ARN_VAULT_PAN_FINGERPRINT_KEY=$(get_secret_arn "vera/VAULT_PAN_FINGERPRINT_KEY")
ARN_SERVICE_AUTH_KEYS=$(get_secret_arn "vera/SERVICE_AUTH_KEYS")
ARN_RETRIEVAL_TOKEN_TTL_SECONDS=$(get_secret_arn "vera/RETRIEVAL_TOKEN_TTL_SECONDS")
ARN_ADMIN_API_KEY=$(get_secret_arn "vera/ADMIN_API_KEY")
echo "  All secret ARNs resolved."

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
# HAS_PALISADE gates the cross-repo capability flag served by
# /api/capabilities (unauthenticated).  The admin SPA reads it pre-login
# to decide which tab groups to render; set to "false" in environments
# where Palisade isn't deployed so the Palisade-backed tabs stay hidden.
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
        { "name": "WEBAUTHN_ORIGIN",    "value": "https://manage.karta.cards" },
        { "name": "HAS_PALISADE",       "value": "true" }
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

# ===========================================================================
echo ""
echo "============================================================"
echo " 4. TARGET GROUPS"
echo "============================================================"
# ===========================================================================

svc_port() {
  case "$1" in
    pay) echo 3003 ;; vault) echo 3004 ;; admin) echo 3005 ;;
  esac
}

for svc in pay vault admin; do
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

  eval "TG_ARN_${svc}=\$EXISTING_TG"
done

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

# Host-based routing.  Palisade's aws-setup.sh adds its own rules for
# the card-domain hostnames (tap/activation) and, expected, a higher-
# priority path-condition rule on manage.karta.cards for /palisade-api/*.
create_host_rule "$PUBLIC_LISTENER_ARN" "pay.karta.cards"        "$TG_ARN_pay"   3 "$EXISTING_RULES"
create_host_rule "$PUBLIC_LISTENER_ARN" "manage.karta.cards"     "$TG_ARN_admin" 4 "$EXISTING_RULES"

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
# pay and admin.
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

  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "pay.karta.cards"     "$TG_ARN_pay"   3 "$EXISTING_HTTPS_RULES"
  create_host_rule "$PUBLIC_HTTPS_LISTENER_ARN" "manage.karta.cards"  "$TG_ARN_admin" 4 "$EXISTING_HTTPS_RULES"

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
echo " 6. ECS SERVICES"
echo "============================================================"
# ===========================================================================

for svc in pay vault admin; do
  SVC_NAME="vera-${svc}"
  PORT=$(svc_port "$svc")
  eval "TG_ARN=\$TG_ARN_${svc}"

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

# ===========================================================================
echo ""
echo "============================================================"
echo " 7. ECS SECURITY GROUP — INBOUND RULES"
echo "============================================================"
# ===========================================================================

INTERNAL_ALB_SG=$(aws elbv2 describe-load-balancers \
  --names vera-internal --region "$REGION" \
  --query 'LoadBalancers[0].SecurityGroups[0]' --output text 2>/dev/null || true)

ensure_sg_ingress() {
  # Idempotent — adds an inbound rule on $ECS_SG for $port from $src_sg.
  local port="$1" src_sg="$2" desc="$3"
  local exists
  exists=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$ECS_SG" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`$port\` && contains(UserIdGroupPairs[].GroupId, \`$src_sg\`)].IpProtocol" \
    --output text 2>/dev/null)
  if [ -n "$exists" ]; then
    echo "  [exists] $ECS_SG inbound :$port from $src_sg"
  else
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$ECS_SG" \
      --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,UserIdGroupPairs=[{GroupId=$src_sg,Description=$desc}]" \
      --query 'SecurityGroupRules[0].SecurityGroupRuleId' --output text >/dev/null
    echo "  [added] $ECS_SG :$port from $src_sg ($desc)"
  fi
}

if [ -n "$INTERNAL_ALB_SG" ] && [ "$INTERNAL_ALB_SG" != "None" ]; then
  ensure_sg_ingress 3004 "$INTERNAL_ALB_SG" "internal-alb-vault"
fi

echo ""
echo "============================================================"
echo " OTHER MANUAL STEPS"
echo "============================================================"
echo ""
echo "1. Verify the ECS security group ($ECS_SG) allows:"
echo "   - Inbound from the public ALB SG on ports 3003, 3005"
echo "     (existing manual rules — not managed by this script)"
echo "   - Inbound from the internal ALB SG on port 3004"
echo "     (managed by step 7 above — idempotent)"
echo "   - Outbound to the internet (for ECR image pulls and Secrets Manager)"
echo ""
echo "2. Ensure the internal ALB SG allows inbound from $ECS_SG on port 3004"
echo ""
echo "3. Ensure DNS records point to the public ALB:"
echo "   - pay.karta.cards    -> $(echo "$PUBLIC_ALB_ARN" | sed 's/.*\///')"
echo "   - manage.karta.cards -> (same)"
echo ""
echo "4. Ensure ECR repositories exist: vera-pay, vera-vault, vera-admin"
echo ""
echo "5. Ensure the execution role ($EXEC_ROLE) has:"
echo "   - secretsmanager:GetSecretValue for vera/* secrets"
echo "   - logs:CreateLogStream, logs:PutLogEvents for /ecs/vera-* groups"
echo "   - ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer"
echo ""
echo "6. Palisade's aws-setup.sh provisions the card-domain services"
echo "   (tap/activation/data-prep/rca/batch-processor/sftp) and is"
echo "   expected to register a higher-priority ALB rule on manage.karta.cards"
echo "   routing /palisade-api/* to palisade-admin.  Until that script runs,"
echo "   /palisade-api/* will 404 via the vera-admin fallback above."
echo ""
echo "Done."
