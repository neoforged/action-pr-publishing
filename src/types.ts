import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'

export type WorkflowRun =
  RestEndpointMethodTypes['actions']['getWorkflowRun']['response']['data']
export type PullRequest =
  RestEndpointMethodTypes['pulls']['get']['response']['data']
