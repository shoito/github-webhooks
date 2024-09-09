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

async function waitForWorkflowCompletion(
  owner: string,
  repo: string,
  workflow_id: string,
  ref: string
): Promise<{ conclusion: string, runId: number }> {
  let runId: number | undefined;
  
  while (!runId) {
    const runs = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id,
      branch: ref,
      status: 'in_progress'
    });

    if (runs.data.workflow_runs.length > 0) {
      runId = runs.data.workflow_runs[0].id;
    } else {
      console.log('Waiting for workflow to start...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  let completed = false;
  let conclusion = '';
  
  while (!completed) {
    const run = await octokit.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId
    });

    if (run.data.status === 'completed') {
      completed = true;
      conclusion = run.data.conclusion || '';
    } else {
      console.log('Workflow still in progress...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  return { conclusion, runId };
}

async function updateStatus(
  owner: string,
  repo: string,
  sha: string,
  state: 'pending' | 'success' | 'failure',
  description: string,
  runId?: number
): Promise<void> {
  const target_url = runId ? `https://github.com/${owner}/${repo}/actions/runs/${runId}` : undefined;
  try {
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context: 'CI Pipeline',
      target_url
    });
    console.log(`Updated status to "${state}" for ${target_url || sha}`);
  } catch (error) {
    console.error(`Error updating status to "${state}" for ${target_url || sha}`, error);
  }
}

functions.http('githubWebhook', async (req, res) => {
  if (req.method !== 'POST') {
    console.log(`${req.method} is not allowed. Only POST requests are accepted.`);
    res.status(405).send('Method Not Allowed');
    return;
  }

  const signature = req.headers['x-hub-signature-256'] as string;
  if (!signature) {
    console.log('No signature found in request.');
    res.status(401).send('No signature found in request');
    return;
  }

  if (!verifyWebhookSignature(JSON.stringify(req.body), signature)) {
    console.log('Invalid signature.');
    res.status(401).send('Invalid signature');
    return;
  }

  const event = req.headers['x-github-event'] as string;
  if (event !== 'issue_comment') {
    console.log(`Event not related to issue comments. Event: ${event}`);
    res.status(200).send('Event not related to issue comments');
    return;
  }

  const payload = req.body as WebhookPayload;
  if (payload.action !== 'created' || !payload.comment || !payload.issue) {
    console.log(`No action needed. Action: ${payload.action}. Comment: ${payload.comment}. Issue: ${payload.issue?.number}`);
    res.status(200).send('No action needed');
    return;
  }

  const commentBody = payload.comment.body;
  const ciRegex = /^\/ci(?:\s+(\w+))?$/;
  const match = commentBody.match(ciRegex);
  if (!match) {
    console.log(`No CI command found. Comment: ${commentBody}. Issue: ${payload.issue.number}`);
    res.status(200).send('No CI command found');
    return;
  }

  const module = match[1] || 'all';
  const workflowId= `ci${module === 'all' ? '' : `-${module}`}.yml`
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;

  if (module !== 'all' && !MODULES.includes(module)) {
    console.log(`Invalid module. Module: ${module}. Issue: ${issueNumber}`);
    res.status(200).send('Invalid module');
    return;
  }

  const prDetails = await getPullRequestDetails(owner, repo, issueNumber);
  if (!prDetails) {
    console.log(`Pull request not found or error occurred. workflowId: ${workflowId}, issueNumber: ${issueNumber}`);
    res.status(200).send('Pull request not found or error occurred');
    return;
  }

  try {
    console.log(`Triggering workflow for ${workflowId} on branch ${prDetails.ref}`);
    await updateStatus(owner, repo, prDetails.sha, 'pending', `${workflowId} execution started`);
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref: prDetails.ref,
    });

    const { conclusion, runId } = await waitForWorkflowCompletion(owner, repo, workflowId, prDetails.ref);

    if (conclusion === 'success') {
      await updateStatus(owner, repo, prDetails.sha, 'success', `${workflowId} completed successfully`, runId);
    } else {
      await updateStatus(owner, repo, prDetails.sha, 'failure', `${workflowId} failed`, runId);
    }

    console.log(`${workflowId} completed with conclusion: ${conclusion}, for ${module} on branch ${prDetails.ref}`);
    res.status(200).send(`CI triggered for ${module} on branch ${prDetails.ref}`);
  } catch (error) {
    console.error(`Error triggering workflow for ${module} on branch ${prDetails.ref}`, error);
    await updateStatus(owner, repo, prDetails.sha, 'failure', `${workflowId} failed`);
    res.status(500).send('Error triggering workflow');
  }
});
