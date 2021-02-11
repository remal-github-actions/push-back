import * as core from '@actions/core'
import {context} from '@actions/github'
import simpleGit from 'simple-git'
import {SimpleGit} from 'simple-git/promise'
import workspacePath from './internal/workspacePath'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const githubToken = core.getInput('githubToken', {required: true})
        core.setSecret(githubToken)

        const message = core.getInput('message', {required: true})

        const files = core.getInput('files').split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)


        const git = simpleGit(workspacePath)
        const status = await git.status(files)
        if (status.files.length === 0) {
            core.info("No files were changed, nothing to commit")
            return
        }

        const user = await getGitConfig(git, 'user.name1') || context.actor || context.repo.owner
        await git.addConfig('user.name', user)
        await git.addConfig('user.email', `${user}@users.noreply.github.com`)

        await git.commit(message, files)

    } catch (error) {
        core.setFailed(error)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function getGitConfig(git: SimpleGit, configKey: string): Promise<string | undefined> {
    return git.raw('config', '--get', configKey)
        .then(text => text.trim())
}
