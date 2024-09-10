import crypto from 'node:crypto';
import * as functions from '@google-cloud/functions-framework';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

const MODULES = ['frontend', 'backend'];
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_API_CALL_INTERVAL = Number.parseInt(process.env.GITHUB_API_INTERVAL || '10000', 10);

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

async function triggerWorkflow(
  owner: string,
  repo: string,
  workflow_id: string,
  ref: string,
  inputs: Record<string, string>
): Promise<number> {
  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id,
      ref,
      inputs
    });

    let runId: number | undefined;
    while (!runId) {
      const runs = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id,
        branch: ref,
        status: 'in_progress',
      });

      if (runs.data.workflow_runs.length > 0) {
        runId = runs.data.workflow_runs[0].id;
      } else {
        console.log('Waiting for workflow to start...');
        await new Promise(resolve => setTimeout(resolve, GITHUB_API_CALL_INTERVAL));
      }
    }

    return runId;
  } catch (error) {
    console.error('Error triggering workflow:', error);
    throw error;
  }
}


async function updateJobStatus(
  owner: string,
  repo: string,
  sha: string,
  workflowName: string | null | undefined,
  job: { name: string, status: string, conclusion: string | null, html_url: string | null }
): Promise<void> {
  const state: 'pending' | 'success' | 'failure' =
    job.conclusion === 'success' ? 'success' :
    job.conclusion === 'failure' ? 'failure' :
    'pending';

  const description = job.conclusion ? `${job.conclusion}` : 'In progress';
  const context = workflowName ? `${workflowName} / ${job.name}` : job.name;

  try {
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context,
      target_url: job.html_url,
    });

    console.log(`Updated status for "${context}" to "${state}"`);
  } catch (error) {
    console.error(`Error updating status for "${context}":`, error);
  }
}

async function getWorkflowName(
  owner: string,
  repo: string,
  runId: number
): Promise<string | null | undefined> {
  const run = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  return run.data.name;
}

async function getJobsForWorkflowRun(
  owner: string,
  repo: string,
  runId: number
): Promise<{ id: number, name: string, status: string, conclusion: string | null, html_url: string | null }[]> {
  try {
    const response = await octokit.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    const jobs = response.data.jobs.map(job => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      html_url: job.html_url,
    }));

    return jobs;
  } catch (error) {
    console.error('Error fetching jobs for workflow run:', error);
    throw error;
  }
}

async function monitorWorkflowJobs(
  owner: string,
  repo: string,
  runId: number,
  sha: string
): Promise<void> {
  let completed = false;
  const workflowName = await getWorkflowName(owner, repo, runId);

  while (!completed) {
    const jobs = await getJobsForWorkflowRun(owner, repo, runId);

    for (const job of jobs) {
      if (job.status === 'completed') {
        await updateJobStatus(owner, repo, sha, workflowName, job);
      } else if (job.status === 'in_progress') {
        await updateJobStatus(owner, repo, sha, workflowName, job);
      }
    }

    completed = jobs.every(job => job.status === 'completed');
    if (!completed) {
      await new Promise(resolve => setTimeout(resolve, GITHUB_API_CALL_INTERVAL));
    }
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
    const runId = await triggerWorkflow(owner, repo, workflowId, prDetails.ref, {});
    await monitorWorkflowJobs(owner, repo, runId, prDetails.sha);

    res.status(200).send(`CI triggered for ${module} on branch ${prDetails.ref}`);
  } catch (error) {
    console.error(`Error triggering workflow for ${module} on branch ${prDetails.ref}`, error);
    res.status(500).send('Error triggering workflow');
  }
});
