# action-pr-publishing 
An action for publishing PRs to a GitHub Packages.

## How it works
The action is split into two steps:

### Step 1 - the upload
This step can be part of a `pull_request` workflow, as it does not need secrets.  
The actions in this step:
1. Prepare a Gradle init script that adds a new, `_githubPackages_PRs` repository to all projects that have the `maven-publish` plugin applied, and that points to a local directory;
2. Run the `publishAllPublicationsTo_githubPackages_PRsRepository` Gradle task;
3. Pack the workflow event payload alongside the local maven directory into a workflow artifact named `maven-publish`.

### Step 2 - the publishing
This step must be run with a `workflow_run` dispatch listening for the workflow that runs the first step.  
Additionally, this step requires the following permissions:
```yml
permissions:
  packages: write # To upload the PR
  actions: write # To get information about the uploading workflow run and to delete the run artifacts
  contents: write # To download the `maven-publish` artifact, and to be able to create commit comments
  issues: write # To be able to create PR comments
  pull-requests: write # To be able to create PR comments
```
The actions in this step:
1. Process information about the uploading workflow run. If not successful, abort;
2. Download the `maven-publish` artifact that was uploaded by the uploading workflow;
3. Upload the (filtered) contents of the artifact to a GitHub sub-package of the repository, that has the `pr<number>.` prefix; delete the workflow artifact so that in the future re-publishing is not attempted;
4. **OPTIONAL STEP**, only if the repository's name is `NeoForge`: generate an MDK pointing to the published version of the PR (more information on mdk generation [below](#mdk-generation));
5. Comment on the PR with information on the published artifacts (and an MDK link and installer link if necessary), or update an existing comment;
6. Comment on the commit with the same message as above.

## MDK Generation
If the name of the repository this action runs on is `NeoForge` (case insensitive), the action will generate an MDK.  
The branch of the MDK being used as base will be decided based on the Minecraft component of the artifact version (i.e. the `20.2` in `20.2-beta-pr1`). The expected branch name is `1.<component>` (i.e. `1.20.2`).
If such branch is not found, the action will use the `main` branch as the base.

Replacements:
1. A line starting with _exactly_ `neo_version=` in the `gradle.properties` file will be updated with the published artifact version;
2. A line starting with _exactly_ `minecraft_version=` in the `gradle.properties` file will be updated with the correct Minecraft version (relevant if the base branch is `main`);
3. The PR repository declaration block will be added before a `dependencies {` line.
