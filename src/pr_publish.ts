import * as core from '@actions/core'
import { context } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import axios, { AxiosRequestConfig } from 'axios'
import JSZip, { JSZipObject } from 'jszip'
import * as process from 'process'
import { getInput } from '@actions/core'
import { XMLParser } from 'fast-xml-parser'
import { getOcto, isAuthorMaintainer } from './utils'
import { PullRequest } from './types'
import { CheckRun } from './check_runs'
import { createInitialComment } from './pr_triggers'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'
import * as async from 'async'
import axiosRetry from 'axios-retry'

// 50mb
const artifactLimit = 50 * 1000000
export const shouldPublishCheckBox = 'Publish PR to GitHub Packages'

export async function runFromWorkflow(): Promise<void> {
  const octo = getOcto()

  const workflow_run = context.payload.workflow_run as WorkflowRun

  // Step 1
  if (workflow_run.conclusion != 'success') {
    console.log('Aborting, workflow run was not successful')
    return
  }

  if (!workflow_run.head_branch) {
    console.log(`Unknown head branch...`)
    return
  }

  console.log(
    `Workflow run head branch: ${workflow_run.head_branch} and repository owner: ${workflow_run.head_repository.owner.login}`
  )
  const linked = await getLinkedPR(
    octo,
    workflow_run.head_repository,
    workflow_run.head_branch
  )
  if (!linked) {
    console.log(`No open PR associated found...`)
    return
  }

  await runPR(
    octo,
    await octo.rest.pulls
      .get({
        ...context.repo,
        pull_number: linked
      })
      .then(d => d.data),
    workflow_run.head_sha,
    workflow_run.id
  )
}

async function getLinkedPR(
  octo: InstanceType<typeof GitHub>,
  repo: Repository,
  head: string
): Promise<number | undefined> {
  const headLabel = repo.owner.login + ':' + head
  if (repo.name != context.repo.repo) {
    for await (const prs of octo.paginate.iterator(octo.rest.pulls.list, {
      ...context.repo,
      state: 'open',
      per_page: 100
    })) {
      const pr = prs.data.find(p => p.head.label == headLabel)
      if (pr) {
        return pr.number
      }
      return undefined
    }
  } else {
    // This is the ideal and efficient solution, but it only works if the base and head repo names are identical
    const possiblePrs = await octo.rest.pulls
      .list({
        ...context.repo,
        head: headLabel,
        state: 'open',
        sort: 'long-running'
      })
      .then(d => d.data)
    if (possiblePrs.length < 1) {
      console.log(`No open PR associated...`)
      return undefined
    }
    return possiblePrs[0].number
  }
}

export async function runPR(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest,
  headSha: string,
  runId: number
) {
  // Retry requests thrice
  axiosRetry(axios, {
    retries: 3,
    retryDelay: retryCount => retryCount * 2000,
    retryCondition: error => error.response?.status == 500
  })
  const check = new CheckRun(octo, pr)

  try {
    await check.start()

    const prNumber = pr.number
    console.log(`PR number: ${prNumber}`)

    const publishingToken =
      getInput('publishing-token') ?? process.env['GITHUB_TOKEN']!

    let selfComment = await getSelfComment(octo, prNumber)
    if (!selfComment) {
      selfComment = await createInitialComment(octo, pr)
    }

    if (!(await shouldPublish(octo, pr, selfComment))) {
      await check.skipped()
      console.log(`PR is not published as checkbox is not ticked`)
      return
    }

    // Step 2
    const artifact = await octo.rest.actions
      .listWorkflowRunArtifacts({
        ...context.repo,
        run_id: runId
      })
      .then(art => art.data.artifacts.find(ar => ar.name == 'maven-publish'))
    if (!artifact) {
      await check.succeed(
        undefined,
        `Found no artifacts to publish`,
        [] as PublishedArtifact[]
      )
      console.log(`Found no artifact to publish from run #${runId}`)
      return
    }

    if (artifact!.size_in_bytes > artifactLimit) {
      const msg = `Artifact is bigger than maximum allowed ${
        artifactLimit / 1000000
      }mb!`
      await check.failed(new Error(msg))
      core.setFailed(msg)
      return
    }

    console.log(`Found artifact: ${artifact!.archive_download_url}`)

    const response = await axios.get(artifact!!.archive_download_url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env['GITHUB_TOKEN']!}`
      }
    })

    const zip = await JSZip.loadAsync(response.data)

    // Step 3
    const filters = getInput('artifacts-base-path').split('|')
    const toUpload = zip.filter((_relativePath, file) => {
      return !file.dir && filters.some(filter => file.name.startsWith(filter))
    })

    const artifacts: PublishedArtifact[] = []
    const basePath = `https://maven.pkg.github.com/${context.repo.owner}/${context.repo.repo}/pr${prNumber}/`

    const uploader = async (path: string, bf: ArrayBuffer) => {
      await axios.put(basePath + path, bf, {
        auth: {
          username: 'actions',
          password: publishingToken
        }
      })
    }

    const uploadFile = async (file: JSZipObject) => {
      try {
        console.debug(`Uploading ${file.name}`)
        await uploader(file.name, await file.async('arraybuffer'))
        console.debug(`Uploaded ${file.name}`)
      } catch (err) {
        if ((err as any).response?.status === 409) {
          // 3 retries, maybe one of them succeeded but didn't reply with 200... just ignore it
          return
        }

        console.error(`Failed to upload file ${file.name}: ${err}`)
        throw err
      }
    }

    // Read pom metadata first and delete versions that are about to be overwritten
    const poms = toUpload.filter(file => file.name.endsWith('.pom'))
    await async.forEachOf(poms, async file => {
      const pom = new XMLParser().parse(await file.async('string')).project

      const artifact: PublishedArtifact = {
        group: pom.groupId!,
        name: pom.artifactId!,
        version: pom.version!
      }
      artifacts.push(artifact)

      const packageName = getPackageName(prNumber, artifact)
      const alreadyPublished: RestEndpointMethodTypes['packages']['getAllPackageVersionsForPackageOwnedByOrg']['response']['data'] =
        await octo.rest.packages
          .getAllPackageVersionsForPackageOwnedByOrg({
            org: context.repo.owner,
            package_type: 'maven',
            package_name: packageName
          })
          .then(e => e.data)
          .catch(_ => [])

      const existingPackage = alreadyPublished.find(
        val => val.name == artifact.version
      )
      if (existingPackage) {
        // If we only published one artifact in the past we have to delete the whole package
        if (alreadyPublished.length == 1) {
          console.warn(`Deleting existing package '${packageName}'`)

          await octo.rest.packages.deletePackageForOrg({
            org: context.repo.owner,
            package_type: 'maven',
            package_name: packageName
          })
        } else {
          console.warn(
            `Deleting existing package version '${existingPackage.name}', ID: ${existingPackage.id}`
          )

          await octo.rest.packages.deletePackageVersionForOrg({
            org: context.repo.owner,
            package_type: 'maven',
            package_name: packageName,
            package_version_id: existingPackage.id
          })
        }
      }
    })

    await async.forEachOfLimit(toUpload, 5, async item => {
      await uploadFile(item)
    })

    console.log(`Finished uploading ${toUpload.length} items`)
    console.log()

    console.log(`Published artifacts:`)
    artifacts.forEach(art =>
      console.log(`\t${art.group}:${art.name}:${art.version}`)
    )

    let { comment, repoBlock, firstPublishUrl } = await generateComment(
      octo,
      prNumber,
      artifacts
    )

    // Step 4
    if (context.repo.repo.toLowerCase() == 'neoforge') {
      const neoArtifact = artifacts.find(
        art => art.group == 'net.neoforged' && art.name == 'neoforge'
      )
      if (neoArtifact != null) {
        comment += await generateMDK(
          uploader,
          prNumber,
          neoArtifact,
          repoBlock!
        )
      }
    }

    const oldComment = comment
    comment = `
- [x] ${shouldPublishCheckBox}

Last commit published: [${headSha}](https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${headSha}).

<details>

<summary>PR Publishing</summary>

${oldComment}

</details>`

    // Step 5
    if (selfComment) {
      await octo.rest.issues.updateComment({
        ...context.repo,
        comment_id: selfComment!.id,
        body: comment
      })
    } else {
      await octo.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body: comment
      })
    }

    await check.succeed(firstPublishUrl, oldComment, artifacts)

    // Delete the artifact so that we don't try to re-publish in the future
    await octo.rest.actions.deleteArtifact({
      ...context.repo,
      artifact_id: artifact.id
    })
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      await check.failed(error)
      console.log(`Error: ${error.message}`)
      console.log(error.stack)
      core.setFailed(error.message)
    }
  }
}

async function generateComment(
  octo: InstanceType<typeof GitHub>,
  prNumber: number,
  artifacts: PublishedArtifact[]
): Promise<{
  comment: string
  repoBlock: string
  firstPublishUrl?: string
}> {
  let comment = `### The artifacts published by this PR:  `
  let firstPublishUrl: string | undefined = undefined
  for (const artifactName of artifacts) {
    const artifact = await (context.payload.repository?.owner?.type == 'User'
      ? octo.rest.packages.getPackageForUser({
          username: context.repo.owner,
          package_type: 'maven',
          package_name: getPackageName(prNumber, artifactName)
        })
      : octo.rest.packages.getPackageForOrganization({
          org: context.repo.owner,
          package_type: 'maven',
          package_name: getPackageName(prNumber, artifactName)
        }))

    comment += `\n- :package: [\`${artifactName.group}:${artifactName.name}:${
      artifactName.version
    }\`](${artifact.data.html_url + '?version=' + artifactName.version})`
    if (!firstPublishUrl) {
      firstPublishUrl = artifact.data.html_url
    }
  }
  comment += `  \n\n### Repository Declaration\nIn order to use the artifacts published by the PR, add the following repository to your buildscript:`
  const includeModules = unique(
    artifacts
      .map(art => `includeModule("${art.group}", "${art.name}")`)
      .map(a => `            ${a}`)
  ) // Indent
    .join('\n')
  const repoBlock = `repositories {
    maven {
        name = "Maven for PR #${prNumber}" // https://github.com/${
          context.repo.owner
        }/${context.repo.repo}/pull/${prNumber}
        url = uri("${getInput('base-maven-url')}/${
          context.repo.repo
        }/pr${prNumber}")
        content {
${includeModules}
        }
    }
}`
  comment += `
\`\`\`gradle
${repoBlock}
\`\`\``
  return { comment, repoBlock, firstPublishUrl }
}

// NeoForge repo specific
async function generateMDK(
  uploader: (path: string, bf: ArrayBuffer) => Promise<void>,
  prNumber: number,
  artifact: PublishedArtifact,
  repoBlock: string
): Promise<string> {
  const versions = artifact.version.split('.')
  const mcVersion = `1.${versions[0]}.${versions[1]}`

  console.log(`Generating MDK for version ${mcVersion}`)

  const config = {
    responseType: 'arraybuffer'
  } as AxiosRequestConfig
  const response = await attemptToFindMDK(
    parseInt(versions[0]),
    parseInt(versions[1]),
    config
  )

  let zip = await JSZip.loadAsync(response.data)
  // Find first root folder
  zip = zip.folder(zip.filter((_, f) => f.dir)[0].name)!

  const gradleProperties = (
    await zip.file('gradle.properties')!.async('string')
  ).split('\n')
  const neoVersionIndex = gradleProperties.findIndex(value =>
    value.startsWith('neo_version=')
  )
  gradleProperties[neoVersionIndex] = `neo_version=${artifact.version}`

  const mcVersionIndex = gradleProperties.findIndex(value =>
    value.startsWith('minecraft_version=')
  )
  gradleProperties[mcVersionIndex] = `minecraft_version=${mcVersion}`

  zip.file('gradle.properties', gradleProperties.join('\n'))

  const buildGradle = (await zip.file('build.gradle')!.async('string')).split(
    new RegExp('\r\n|\n')
  )
  buildGradle[
    buildGradle.indexOf('dependencies {')
  ] = `// PR repository \n${repoBlock}\ndependencies {`
  zip.file('build.gradle', buildGradle.join('\n'))

  const path = `${artifact.group.replace('.', '/')}/${artifact.name}/${
    artifact.version
  }/mdk-pr${prNumber}.zip`
  await uploader(
    path,
    await zip.generateAsync({
      type: 'arraybuffer'
    })
  )

  console.log(`Generated and uploaded MDK`)

  const mdkUrl = `${getInput('base-maven-url')}/${
    context.repo.repo
  }/pr${prNumber}/${path}`

  return `
### MDK installation
In order to setup a MDK using the latest PR version, run the following commands in a terminal.  
The script works on both *nix and Windows as long as you have the JDK \`bin\` folder on the path.  
The script will clone the MDK in a folder named \`${
    context.repo.repo
  }-pr${prNumber}\`.  
On Powershell you will need to remove the \`-L\` flag from the \`curl\` invocation.
\`\`\`sh
mkdir ${context.repo.repo}-pr${prNumber}
cd ${context.repo.repo}-pr${prNumber}
curl -L ${mdkUrl} -o mdk.zip
jar xf mdk.zip
rm mdk.zip || del mdk.zip
\`\`\`

To test a production environment, you can download the installer from [here](${getInput(
    'base-maven-url'
  )}/${context.repo.repo}/pr${prNumber}/${artifact.group}/${artifact.name}/${
    artifact.version
  }/${artifact.name}-${artifact.version}-installer.jar).`
}

async function shouldPublish(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest,
  comment?: Comment
): Promise<boolean> {
  if (comment?.body) {
    // First line
    const firstLine = comment.body.trimStart().split('\n')[0]

    // Check if the first line matches what we expect and that the box is ticked
    // Both upper and lower case are valid
    return (
      firstLine.trim() == `- [x] ${shouldPublishCheckBox}` ||
      firstLine.trim() == `- [X] ${shouldPublishCheckBox}`
    )
  }

  return await isAuthorMaintainer(octo, pr)
}

async function getSelfComment(
  octo: InstanceType<typeof GitHub>,
  prNumber: number
): Promise<Comment | undefined> {
  const self = getInput('self-name')

  for await (const comments of octo.paginate.iterator(
    octo.rest.issues.listComments,
    {
      ...context.repo,
      issue_number: prNumber
    }
  )) {
    for (const comment of comments.data) {
      if (comment.user!.login == self) {
        return comment
      }
    }
  }
  return undefined
}

interface Comment {
  id: number
  body?: string | undefined
}

interface WorkflowRun {
  id: number
  conclusion: 'success' | 'failure'
  head_branch: string | undefined
  pull_requests: {
    number: number
  }[]
  head_repository: Repository
  head_sha: string
  event: string
}

interface Repository {
  owner: {
    login: string
  }
  name: string
}

export interface PublishedArtifact {
  group: string
  name: string
  version: string
}

function getPackageName(prNumber: number, artifact: PublishedArtifact) {
  return `pr${prNumber}.${artifact.group}.${artifact.name}`
}

async function attemptToFindMDK(
  mcMajor: number,
  mcMinor: number,
  config: AxiosRequestConfig,
  mdg: boolean = true
): Promise<axios.AxiosResponse> {
  const fallback = async () => {
    // We first try MDG, now let's try NG
    if (mdg) {
      return attemptToFindMDK(mcMajor, mcMinor, config, false)
    }

    // If we've tried everything for this major, try the .0 version of the closest major
    if (mcMinor < 0) {
      return attemptToFindMDK(mcMajor - 1, 0, config)
    }
    // First try to find a MDK for the closest minor of the same major version
    // Since 1.21.0 and 1.21 are technically the same, the case when the MDK branch isn't suffixed by a .0 is caught by the minor being -1
    return attemptToFindMDK(mcMajor, mcMinor - 1, config)
  }
  const version = `1.${mcMajor}${mcMinor == -1 ? '' : '.' + mcMinor}`
  const response = await axios
    .get(
      `https://github.com/neoforgemdks/mdk-${version}-${
        mdg ? 'moddevgradle' : 'neogradle'
      }/zipball/main`,
      config
    )
    .catch(_ => fallback())
  if (response.status != 200) {
    return fallback()
  }
  return response
}

function unique<T>(arr: T[]): T[] {
  const array: T[] = []

  arr.forEach(el => {
    if (!array.includes(el)) {
      array.push(el)
    }
  })

  return array
}
