import crypto from 'node:crypto';
import * as functions from '@google-cloud/functions-framework';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

const MODULES = ['frontend', 'backend'];
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

interface WebhookPayload {
  action: string;
  issue?: {
    number: number;
  };
  comment?: {
    body: string;
  };
  repository: {
    owner: {
      login: string;
    };
    name: string;
  };
}

function verifyWebhookSignature(payload: string, signature: string): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.error('GITHUB_WEBHOOK_SECRET is not set');
    return false;
  }

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  const digest = Buffer.from(`sha256=${hmac.update(payload).digest('hex')}`, 'utf8');
  const checksum = Buffer.from(signature, 'utf8');

  if (checksum.length !== digest.length || !crypto.timingSafeEqual(digest, checksum)) {
    return false;
  }
  return true;
}

async function getPullRequestDetails(owner: string, repo: string, issueNumber: number) {
  try {
    const { data: pullRequest } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: issueNumber,
    });
    return {
      ref: pullRequest.head.ref,
      sha: pullRequest.head.sha,
    };
  } catch (error) {
    console.error('Error fetching pull request details:', JSON.stringify(error));
    return null;
  }
}

functions.http('githubWebhook', async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const signature = req.headers['x-hub-signature-256'] as string;
  if (!signature) {
    res.status(401).send('No signature found in request');
    return;
  }

  if (!verifyWebhookSignature(JSON.stringify(req.body), signature)) {
    res.status(401).send('Invalid signature');
    return;
  }

  const event = req.headers['x-github-event'] as string;
  if (event !== 'issue_comment') {
    res.status(200).send('Event not related to issue comments');
    return;
  }

  const payload = req.body as WebhookPayload;
  if (payload.action !== 'created' || !payload.comment || !payload.issue) {
    res.status(200).send('No action needed');
    return;
  }

  const commentBody = payload.comment.body;
  const ciRegex = /^\/ci(?:\s+(\w+))?$/;
  const match = commentBody.match(ciRegex);
  if (!match) {
    res.status(200).send('No CI command found');
    return;
  }

  const module = match[1] || 'all';
  if (module !== 'all' && !MODULES.includes(module)) {
    res.status(200).send('Invalid module');
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;
  const prDetails = await getPullRequestDetails(owner, repo, issueNumber);

  if (!prDetails) {
    res.status(200).send('Pull request not found or error occurred');
    return;
  }

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: `ci${module === 'all' ? '' : `-${module}`}.yml`,
      ref: prDetails.ref,
    });

    res.status(200).send(`CI triggered for ${module} on branch ${prDetails.ref}`);
  } catch (error) {
    console.error('Error triggering workflow:', error);
    res.status(500).send('Error triggering workflow');
  }
});
