import { GitHub } from '@actions/github/lib/utils'
import { PullRequest } from './types'
import { context } from '@actions/github'
import { PublishedArtifact } from './pr_publish'
import { getRunURL } from './utils'

export class CheckRun {
  private readonly octo: InstanceType<typeof GitHub>
  private readonly reference: string
  private id: number = 0
  public constructor(octo: InstanceType<typeof GitHub>, pr: PullRequest) {
    this.octo = octo
    this.reference = pr.head.sha
  }

  public async start() {
    this.id = (
      await this.octo.rest.checks.create({
        ...context.repo,
        head_sha: this.reference,
        name: 'PR Publishing',
        status: 'in_progress',
        details_url: getRunURL()
      })
    ).data.id
  }

  public async skipped(
    reason: string = "Publishing skipped as the publishing checkbox wasn't ticked"
  ) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      conclusion: 'skipped',
      output: {
        title: 'Publishing skipped',
        summary: reason
      }
    })
  }

  public async failed(err: Error) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      conclusion: 'failure',
      output: {
        title: 'Publishing failed',
        summary: `Publishing failure: \`${err.message}\``
      },
      details_url: getRunURL()
    })
  }

  public async succeed(
    deploymentUrl: string | undefined,
    message: string,
    artifacts: PublishedArtifact[]
  ) {
    const artifactsPlural = 'artifact' + (artifacts.length == 1 ? '' : 's')
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      details_url: deploymentUrl,
      conclusion: 'success',
      output: {
        title: `PR Publishing - ${artifacts.length} ${artifactsPlural}`,
        summary: `PR published ${
          artifacts.length
        } ${artifactsPlural}\n${artifacts
          .map(art => `\t\`${art.group}:${art.name}:${art.version}\``)
          .join('\n')}`,
        text: message
      }
    })
  }
}
