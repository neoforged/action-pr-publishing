import * as core from '@actions/core'
import { context } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import axios, { AxiosRequestConfig } from 'axios'
import JSZip from 'jszip'
import * as process from 'process'
import { getInput } from '@actions/core'
import { XMLParser } from 'fast-xml-parser'
import { getOcto, isAuthorMaintainer } from './utils'
import { PullRequest } from './types'
import { CheckRun } from './check_runs'
import { createInitialComment } from './pr_triggers'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'

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
  const possiblePrs = await octo.rest.pulls
    .list({
      ...context.repo,
      head:
        workflow_run.head_repository.owner.login +
        ':' +
        workflow_run.head_branch,
      state: 'open',
      sort: 'long-running'
    })
    .then(d => d.data)
  if (possiblePrs.length < 1) {
    console.log(`No open PR associated...`)
    return
  }
  const pr = possiblePrs[0]

  await runPR(
    octo,
    await octo.rest.pulls
      .get({
        ...context.repo,
        pull_number: pr.number
      })
      .then(d => d.data),
    workflow_run.head_sha,
    workflow_run.id
  )
}

export async function runPR(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest,
  headSha: string,
  runId: number
) {
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
    const filter = getInput('artifacts-base-path')
    const toUpload = zip.filter((_relativePath, file) => {
      return !file.dir && file.name.startsWith(filter)
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

    let uploadAmount = 0
    for (const file of toUpload) {
      try {
        console.debug(`Uploading ${file.name}`)
        await uploader(file.name, await file.async('arraybuffer'))
        console.debug(`Uploaded ${file.name}`)
        uploadAmount++
      } catch (err) {
        console.error(`Failed to upload file ${file.name}: ${err}`)
        throw err
      }

      if (file.name.endsWith('maven-metadata.xml')) {
        const metadata = new XMLParser().parse(
          await file.async('string')
        ).metadata

        // Use the path as the artifact name and group just in case
        const split = file.name.split('/')
        split.pop()
        const name = split.pop()
        const artifact: PublishedArtifact = {
          group: split.join('.'),
          name: name!,
          version: metadata.versioning.latest
        }
        artifacts.push(artifact)

        const alreadyPublished: RestEndpointMethodTypes['packages']['getAllPackageVersionsForPackageOwnedByOrg']['response']['data'] =
          await octo.rest.packages
            .getAllPackageVersionsForPackageOwnedByOrg({
              org: context.repo.owner,
              package_type: 'maven',
              package_name: getPackageName(prNumber, artifact)
            })
            .then(e => e.data)
            .catch(_ => [])

        const existingPackage = alreadyPublished.find(
          val => val.name == artifact.version
        )
        if (existingPackage) {
          console.warn(
            `Deleting existing package version '${existingPackage.name}', ID: ${existingPackage.id}`
          )
          await octo.rest.packages.deletePackageVersionForOrg({
            org: context.repo.owner,
            package_type: 'maven',
            package_name: getPackageName(prNumber, artifact),
            package_version_id: existingPackage.id
          })
        }
      }
    }

    console.log(`Finished uploading ${uploadAmount} items`)
    console.log()

    console.log(`Published artifacts:`)
    artifacts.forEach(art =>
      console.log(`\t${art.group}:${art.name}:${art.version}`)
    )

    // Delete the artifact so that we don't try to re-publish in the future
    await octo.rest.actions.deleteArtifact({
      ...context.repo,
      artifact_id: artifact.id
    })

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

    // Step 6
    await octo.rest.repos.createCommitComment({
      ...context.repo,
      commit_sha: headSha,
      body: comment
    })

    await check.succeed(firstPublishUrl, oldComment, artifacts)
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
    const artifact = await octo.rest.packages.getPackageForOrganization({
      org: context.repo.owner,
      package_type: 'maven',
      package_name: getPackageName(prNumber, artifactName)
    })

    comment += `\n- :package: [\`${artifactName.group}:${artifactName.name}:${artifactName.version}\`](${artifact.data.html_url})`
    if (!firstPublishUrl) {
      firstPublishUrl = artifact.data.html_url
    }
  }
  comment += `  \n\n### Repository Declaration\nIn order to use the artifacts published by the PR, add the following repository to your buildscript:`
  const includeModules = artifacts
    .map(art => `includeModule('${art.group}', '${art.name}')`)
    .map(a => `            ${a}`) // Indent
    .join('\n')
  const repoBlock = `repositories {
    maven {
        name 'Maven for PR #${prNumber}' // https://github.com/${
          context.repo.owner
        }/${context.repo.repo}/pull/${prNumber}
        url '${getInput('base-maven-url')}/${context.repo.repo}/pr${prNumber}'
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

  const config = {
    responseType: 'arraybuffer'
  } as AxiosRequestConfig
  let response = await axios
    .get(`https://github.com/neoforged/mdk/zipball/${mcVersion}`, config)
    .catch(_ =>
      axios.get('https://github.com/neoforged/mdk/zipball/main', config)
    )
  if (response.status != 200) {
    response = await axios.get(
      'https://github.com/neoforged/mdk/zipball/main',
      config
    )
  }

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

  const path = `${artifact.group}/${artifact.name}/${artifact.version}/mdk-pr${prNumber}.zip`
  await uploader(
    path,
    await zip.generateAsync({
      type: 'arraybuffer'
    })
  )

  console.log(`Generated and uploaded MDK`)

  return `
### MDK installation
In order to setup a MDK using the latest PR version, run the following commands in a terminal.  
The script works on both *nix and Windows as long as you have the JDK \`bin\` folder on the path.  
The script will clone the MDK in a folder named \`${
    context.repo.repo
  }-pr${prNumber}\`.
\`\`\`sh
mkdir ${context.repo.repo}-pr${prNumber}
cd ${context.repo.repo}-pr${prNumber}
curl -L ${getInput('base-maven-url')}/${
    context.repo.repo
  }/pr${prNumber}/${path} -o mdk.zip
jar xf mdk.zip
rm mdk.zip
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
  head_repository: {
    owner: {
      login: string
    }
  }
  head_sha: string
}

export interface PublishedArtifact {
  group: string
  name: string
  version: string
}

function getPackageName(prNumber: number, artifact: PublishedArtifact) {
  return `pr${prNumber}.${artifact.group}.${artifact.name}`
}
