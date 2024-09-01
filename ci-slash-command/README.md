# Example: GitHub Webhooks for GitHub Actions

## Setup

1. Generate a new Personal Access Token (GITHUB_TOKEN) in your GitHub settings and copy it to your clipboard.
   - Select the following scopes: `workflow`, `repo`.
2. Generate a random string to use as `GITHUB_WEBHOOK_SECRET` and copy it to your clipboard:

```sh
openssl rand -hex 32 | pbcopy
```

3. Configure your Google Cloud project:
```sh
gcloud config set project $YOUR_PROJECT_ID
gcloud auth login
gcloud auth application-default login
gcloud services enable secretmanager.googleapis.com

echo -n "YOUR_GITHUB_TOKEN" | \
gcloud secrets create GITHUB_TOKEN \
    --replication-policy="automatic" \
    --data-file=-

echo -n "YOUR_GITHUB_WEBHOOK_SECRET" | \
gcloud secrets create GITHUB_WEBHOOK_SECRET \
    --replication-policy="automatic" \
    --data-file=-

PROJECT_ID=$(gcloud config get-value project)
SERVICE_ACCOUNT_NAME="github-webhooks"

gcloud iam service-accounts create ${SERVICE_ACCOUNT_NAME} \
    --display-name "GitHub Webhooks service account"

gcloud secrets add-iam-policy-binding GITHUB_TOKEN \
    --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding GITHUB_WEBHOOK_SECRET \
    --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

4. Add a GitHub Webhook to your repository:
   - Payload URL: `https://$REGION-$PROJECT_ID.cloudfunctions.net/$FUNCTION_NAME`
     - For example: `https://asia-northeast-1-my-project-id.cloudfunctions.net/githubWebhook`
   - Content type: `application/json`
   - Select specific events to trigger the webhook:
     - `Let me select individual events.`
       - `Issue comments`
       - `Pull requests`

## Deployment

```sh
pnpm install
sh deploy.sh
```
