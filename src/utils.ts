import { context, getOctokit } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'
import process from 'process'
import { PullRequest } from './types'

export async function isAuthorMaintainer(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest
): Promise<boolean> {
  const perm = await octo.rest.repos.getCollaboratorPermissionLevel({
    ...context.repo,
    username: pr.user.login
  })
  return perm.data.permission == 'write' || perm.data.permission == 'admin'
}

export function getOcto(): InstanceType<typeof GitHub> {
  return getOctokit(process.env['GITHUB_TOKEN']!)
}
