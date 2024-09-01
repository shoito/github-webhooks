#!/bin/bash

npm run pre-build

PROJECT_ID=$(gcloud config get-value project)
SERVICE_ACCOUNT_NAME=github-actions
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
  --set-secrets="GITHUB_TOKEN=projects/${PROJECT_ID}/secrets/GITHUB_TOKEN:latest,GITHUB_WEBHOOK_SECRET=projects/${PROJECT_ID}/secrets/GITHUB_WEBHOOK_SECRET:latest"
