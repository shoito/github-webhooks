#!/bin/bash

npm run pre-build

# You can set the module ci workflows in the environment variable.
# key is the module name, value is the workflow file name.
MODULE_CI_WORKFLOWS='{"backend":"ci-backend.yml","frontend":"ci-frontend.yml","all":"ci.yml"}'
ENCODED_MODULE_CI_WORKFLOWS=$(echo "$MODULE_CI_WORKFLOWS" | base64)

PROJECT_ID=$(gcloud config get-value project)
SERVICE_ACCOUNT_NAME=github-webhooks
FUNCTION_NAME=githubWebhook

gcloud functions deploy ${FUNCTION_NAME} \
  --project ${PROJECT_ID} \
  --region asia-northeast1 \
  --gen2 \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point githubWebhook \
  --service-account ${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com \
  --set-env-vars GITHUB_API_INTERVAL=1000 \
  --set-env-vars MODULE_CI_WORKFLOWS=${ENCODED_MODULE_CI_WORKFLOWS} \
  --set-secrets GITHUB_TOKEN=projects/${PROJECT_ID}/secrets/GITHUB_TOKEN:latest,GITHUB_WEBHOOK_SECRET=projects/${PROJECT_ID}/secrets/GITHUB_WEBHOOK_SECRET:latest
