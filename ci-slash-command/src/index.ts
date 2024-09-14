/**
 * This function listens for issue comments on GitHub repositories and triggers a GitHub Actions
 * workflow based on the comment. The comment should be in the format `/ci [module]` where `module`
 * is an optional parameter that specifies the module to trigger the workflow for. If no module is
 * specified, the workflow for all modules will be triggered.
 */
import crypto from 'node:crypto';
import * as functions from '@google-cloud/functions-framework';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

/**
 * The CI workflows for each module. The key is the module name and the value is the workflow ID.
 * The value is base64 encoded.
 * e.g. { "frontend": "ci-frontend.yaml", "backend": "ci-backend.yaml", "all": "ci.yaml" }
 */
const MODULE_CI_WORKFLOWS = JSON.parse(atob(process.env.MODULE_CI_WORKFLOWS || ''));

const MODULES = Object.keys(MODULE_CI_WORKFLOWS);
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_API_CALL_INTERVAL = Number.parseInt(process.env.GITHUB_API_INTERVAL || '10000', 10);

interface WebhookPayload {
  action: string;
  issue?: {
    number: number;
    pull_request?: {
      url: string;
    };
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
    res.status(400).send('Event not related to issue comments');
    return;
  }

  const payload = req.body as WebhookPayload;
  if (payload.action !== 'created' || !payload.issue?.pull_request || !payload.comment || !payload.issue) {
    console.log(`No action needed. Action: ${payload.action}. Issue: ${payload.issue?.number}`);
    res.status(200).send('No action needed');
    return;
  }

  const commentBody = payload.comment.body;
  const ciRegex = /^\/ci(?:\s+(\w+))?$/;
  const match = commentBody.match(ciRegex);
  if (!match) {
    console.log(`No CI command found. Issue: ${payload.issue.number}`);
    res.status(200).send('No CI command found');
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue?.number;
  const module = match[1] || 'all';
  if (module !== 'all' && !MODULES.includes(module)) {
    console.log(`Invalid module. Module: ${module}. Issue: ${issueNumber}`);
    res.status(400).send('Invalid module');
    return;
  }

  const prDetails = await getPullRequestDetails(owner, repo, issueNumber);
  if (!prDetails) {
    console.log(`Pull request not found or error occurred. issueNumber: ${issueNumber}`);
    res.status(400).send('Pull request not found or error occurred');
    return;
  }
  
  // GitHub Webhook requires a response within 10 seconds. So, we respond immediately and trigger the CI.
  res.status(202).send(`CI triggered for ${module} on branch ${prDetails.ref}`);

  const workflowId = MODULE_CI_WORKFLOWS[module];
  try {
    console.log(`Triggering workflow for ${workflowId} on branch ${prDetails.ref}`);
    const runId = await triggerWorkflow(owner, repo, workflowId, prDetails.ref, {});
    await monitorWorkflowJobs(owner, repo, runId, prDetails.sha);
  } catch (error) {
    console.error(`Error triggering workflow for ${module} on branch ${prDetails.ref}`, error);
  }
});
