import { getOcto, isAuthorMaintainer } from './utils'
import { context } from '@actions/github'
import { getBooleanInput, getInput } from '@actions/core'
import { runPR, shouldPublishCheckBox } from './pr_publish'
import { GitHub } from '@actions/github/lib/utils'
import { PullRequest, WorkflowRun } from './types'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'

export async function runFromTrigger() {
  console.debug(
    `Triggered by event '${context.eventName}', action '${context.payload.action}'`
  )
  const octo = getOcto()
  if (
    context.eventName == 'pull_request_target' &&
    context.payload.action == 'opened'
  ) {
    if (getBooleanInput('checkbox')) {
      // Only create the initial comment when the checkbox is enabled. Otherwise we don't need to create it this early
      await createInitialComment(
        octo,
        context.payload.pull_request! as PullRequest
      )
    }
  } else if (
    context.eventName == 'issue_comment' &&
    context.payload.action == 'edited'
  ) {
    const self = getInput('self-name')
    if (
      context.payload.comment!.user.login != self ||
      context.payload.sender!.login == self
    )
      return

    if (context.payload.issue!.pull_request == false) {
      console.log(`Not a PR, aborting`)
      return
    }

    const pr: PullRequest = await octo.rest.pulls
      .get({
        ...context.repo,
        pull_number: context.payload.issue!.number
      })
      .then(d => d.data)
    const prWorkflows = await getRunsOfPR(octo, pr.head.sha)
    const runName = getInput('uploader-workflow-name').replace(
      '$pr',
      pr.number.toString()
    )
    const run = prWorkflows.find(flow => flow.name == runName)
    if (!run) {
      console.log(`No run with name ${runName} found on PR #${pr.number}`)
      return
    }

    if (run.status == 'in_progress') {
      console.warn(`Workflow run (${run.html_url}) in progress, aborting`)
      return
    }

    await runPR(octo, pr, pr.head.sha, run.id)
  }
}

export async function createInitialComment(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest
): Promise<
  RestEndpointMethodTypes['issues']['createComment']['response']['data']
> {
  return await octo.rest.issues
    .createComment({
      ...context.repo,
      issue_number: pr.number,
      body: `- [ ] ${shouldPublishCheckBox}` // PR publishing is always disabled by default, at least for now, to avoid too many unused artifacts
      // body: `- [${
      //   (await isAuthorMaintainer(octo, pr)) && !pr.user.login.endsWith('-l10n')
      //     ? 'X'
      //     : ' '
      // }] ${shouldPublishCheckBox}`
    })
    .then(res => res.data)
}

export async function getRunsOfPR(
  octo: InstanceType<typeof GitHub>,
  sha: string
): Promise<WorkflowRun[]> {
  // Obtain the check runs for the head SHA1 of this pull request.
  const check_runs = (
    await octo.rest.checks.listForRef({
      ...context.repo,
      ref: sha
    })
  ).data.check_runs

  const res: WorkflowRun[] = []
  // For every relevant run:
  for (const run of check_runs) {
    if (run.app!.slug == 'github-actions') {
      // Get the corresponding Actions job.
      // The Actions job ID is the same as the Checks run ID
      // (not to be confused with the Actions run ID).
      const job = (
        await octo.rest.actions.getJobForWorkflowRun({
          ...context.repo,
          job_id: run.id
        })
      ).data

      // Now, get the Actions run that this job is in.
      const actions_run = (
        await octo.rest.actions.getWorkflowRun({
          ...context.repo,
          run_id: job.run_id
        })
      ).data

      if (actions_run.event == 'pull_request') {
        res.push(actions_run)
      }
    }
  }
  return res
}
