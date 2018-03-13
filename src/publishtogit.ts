#!/usr/bin/env node

import * as _ from "lodash";
import {config as globalConfig} from "./publishToGitConfig";
import {Directory} from "./directory";
import {GitRepo} from "./gitRepo";
import {NodePackage} from "./nodePackage";
import * as yargs from "yargs";
import {Url} from "./url";
import {GitBranch} from "./gitBranch";
import {userInfo} from "os";


////////////////////////////////////////////////////////////////////////////////
// Types
////////////////////////////////////////////////////////////////////////////////

interface IInstanceConfig
{
    devRepo: GitRepo;
    pkg: NodePackage;
    dryRun: boolean;
    tags: Array<string>;
}


////////////////////////////////////////////////////////////////////////////////
// Helper Functions
////////////////////////////////////////////////////////////////////////////////

function getArgs(): yargs.Arguments
{
    return yargs
    .usage("Publishes a Node.js package to a project's Git repository.")
    .help()
    .option("tag",
        {
            demandOption: false,
            describe: "Apply the specified tag to the publish commit (can be used multiple times)."
        }
    )
    .option("tag-version",
        {
            type: "boolean",
            default: false,
            demandOption: false,
            describe: "Apply a tag with the project's version number (from package.json) to the publish commit"
        }
    )
    .option("dry-run",
        {
            type: "boolean",
            default: false,
            demandOption: false,
            describe: "Perform all operations but do not push to origin"
        }
    )
    .version()  // version will be read from package.json!
    .wrap(80)
    .argv;
}


async function getInstanceConfig(argv: yargs.Arguments): Promise<IInstanceConfig>
{
    const devDir = new Directory(".");
    const devRepo = await GitRepo.fromDirectory(devDir);
    const pkg = await NodePackage.fromDirectory(devDir);

    // Build the array of tags that will be applied to the publish commit.
    let tags: Array<string> = [].concat(argv.tag || []);
    if (argv["tag-version"])
    {
        tags.push(`v${pkg.config.version}`);
    }

    // Make sure we have at least 1 tag to apply.  Otherwise git might garbage
    // collect the publish commit we are about to create.
    if (tags.length === 0)
    {
        throw new Error("At least one tag must be applied by using either --tag-version or --tag.");
    }

    return {
        dryRun: argv["dry-run"],
        tags: tags,
        devRepo: devRepo,
        pkg: pkg
    };
}


async function checkInitialConditions(instanceConfig: IInstanceConfig): Promise<void>
{
    // Make sure there are no modified files.
    const modifiedFiles = await instanceConfig.devRepo.modifiedFiles();
    if (modifiedFiles.length > 0 )
    {
        throw new Error("This repository contains modified files.");
    }

    // Make sure there are no untracked files.
    const untrackedFiles = await instanceConfig.devRepo.untrackedFiles();
    if (untrackedFiles.length > 0 )
    {
        throw new Error("This repository contains untracked files.");
    }

    // Make sure the directory is a Node package.
    if (!instanceConfig.pkg.config.version)
    {
        throw new Error("Package does not have a version.");
    }

    // Check to see if the repo already has any of the new tags to be applied.
    const existingTags = await instanceConfig.devRepo.tags();
    const alreadyExist = _.intersection(existingTags, instanceConfig.tags);
    if (alreadyExist.length > 0)
    {
        throw new Error(`The following tags already exist: ${alreadyExist.join(", ")}`);
    }

}


async function main(): Promise<void>
{
    // Get the command line args first.  If the user is just doing --help, we
    // don't want to do anything else.
    const argv = getArgs();

    globalConfig.init();

    // Resolve the command line arguments into a concrete configuration for this
    // instance.
    const instanceConfig = await getInstanceConfig(argv);

    // Given the instance configuration, determine if everything is in a valid
    // state.
    await checkInitialConditions(instanceConfig);

    const devCommitHash = await instanceConfig.devRepo.currentCommitHash();

    // Clear out space for the publish repo.
    const publishDir = new Directory(globalConfig.tmpDir, instanceConfig.pkg.projectName);
    publishDir.deleteSync();

    // Create a clone of the repo for publishing purposes.
    const repoUrl = Url.fromString(instanceConfig.pkg.config.repository.url);
    if (!repoUrl)
    {
        throw new Error("Invalid repository URL.");
    }
    console.log(`Creating temporary repo clone at ${publishDir.toString()}...`);
    const publishRepo = await GitRepo.clone(repoUrl, globalConfig.tmpDir);

    // Checkout the commit the devRepo is at.
    publishRepo.checkoutCommit(devCommitHash);
    console.log(`Checking out current development commit ${devCommitHash}...`);

    // Create a temporary branch on which the published files will be committed.
    console.log("Creating temporary branch...");
    await checkoutTempBranch(publishRepo, "publishtogit");

    // Remove all files under version control and prune directories that are
    // empty.
    console.log("Deleting all files...");
    await deleteTrackedFiles(publishRepo);
    await publishRepo.directory.prune();

    // Publish the dev repo to the publish directory.
    console.log("Publishing package contents to publish repository...");
    await instanceConfig.pkg.publish(publishDir, false);

    // Stage and commit the published files.
    console.log("Commiting published files...");
    await publishRepo.stageAll();
    await publishRepo.commit("Published using publish-to-git.");

    // TODO: If the source repo has a CHANGELOG.md, add its contents as the annotated tag message.

    const publishCommitHash = publishRepo.currentCommitHash();

    // Apply tags.
    // We already know that none of the requested tags already exist.
    await Promise.all(_.map(instanceConfig.tags, (curTagName) => {
        console.log(`Creating tag ${curTagName}...`);
        return publishRepo.createTag(curTagName, "", false);
    }));

    // If doing a "dry run", stop.
    if (instanceConfig.dryRun)
    {
        const msg = [
            "Running in dry-run mode.  The repository in the following temporary directory",
            "has been left ready to push to a public server.",
            publishRepo.directory.toString()
        ];
        console.log(msg.join("\n"));
        return;
    }

    // Push all tags.
    await Promise.all(_.map(instanceConfig.tags, (curTagName) => {
        console.log(`Pushing tag ${curTagName} to origin.`);
        return publishRepo.pushTag(curTagName, "origin", true);
    }));

    //
    // Print a completion message.
    // Tell the user how to include the published repository into another
    // project's dependencies.
    //
    // TODO: Include install commands for commit hash and all tags.
    const dependencyUrl = repoUrl.replaceProtocol("git+https").toString();
    const doneMessage = [
        "Done.",
        "To include the published library in a Node.js project, execute the following command:"
    ].concat(_.map(instanceConfig.tags, (curTagName) => {
        return `npm install ${dependencyUrl}#${curTagName}`;
    }))
    .concat(`npm install ${dependencyUrl}#${publishCommitHash.toString()}`);
    console.log(doneMessage.join("\n"));
}


main();


async function checkoutTempBranch(repo: GitRepo, baseName: string): Promise<GitBranch>
{
    const now = new Date();
    const datestamp =
        now.getFullYear() + "_" + now.getMonth() + "_" + now.getDate() + "_" +
        now.getHours() + "_" + now.getMinutes() + "_" + now.getSeconds() + "." + now.getMilliseconds();

    const user = userInfo();

    const tmpBranchName = `${baseName}-${user.username}-${datestamp}`;
    const tmpBranch = await GitBranch.create(repo, tmpBranchName);
    await repo.checkoutBranch(tmpBranch, true);
    return tmpBranch;
}


/**
 * Deletes all tracked files within a repo.
 * @param repo - The repo to clear
 * @return A Promise that is resolved when all files have been deleted.
 */
async function deleteTrackedFiles(repo: GitRepo): Promise<void>
{
    const files = await repo.files();
    const deletePromises = _.map(files, (curFile) => {
        return curFile.delete();
    });

    await Promise.all(deletePromises);
}