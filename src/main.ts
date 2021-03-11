import * as core from '@actions/core'
import simpleGit from 'simple-git'
import {SimpleGit} from 'simple-git/promise'
import {URL} from 'url'
import workspacePath from './internal/workspacePath'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const RESULT = {
    NOTHING_CHANGED: 'nothing-changed',
    REMOTE_CHANGED: 'remote-changed',
    PUSHED_SUCCESSFULLY: 'pushed-successfully',
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const repositoryFullName = process.env.GITHUB_REPOSITORY
        if (!repositoryFullName) {
            throw new Error('GITHUB_REPOSITORY not defined')
        }

        const githubToken = core.getInput('githubToken', {required: true})
        core.setSecret(githubToken)

        const message = core.getInput('message', {required: true})

        const files = core.getInput('files').split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)


        if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
            require('debug').enable('simple-git')
        }
        const git = simpleGit(workspacePath, {
            timeout: {block: 300_000},
        })
        const currentBranch = await getCurrentBranchName(git)
        const targetBranch = (function () {
            const targetBranchInput = core.getInput('targetBranch')
            if (targetBranchInput) {
                return targetBranchInput
            }
            if (currentBranch === 'HEAD') {
                throw new Error("targetBranch' input parameter should be set, as HEAD is detached from any branch")
            }
            return currentBranch
        })()


        const filesToCommit = await core.group('Checking Git status', async () => {
            const changedFiles = await git.status(files)
                .then(response => response.files)
            core.info(`${changedFiles.length} files changed`)
            return changedFiles
        })
        if (filesToCommit.length === 0) {
            core.info('No files were changed, nothing to commit')
            core.setOutput('result', RESULT.NOTHING_CHANGED)
            return
        }


        const currentCommitSha = await core.group('Getting HEAD commit SHA', async () => {
            const sha = await getCurrentCommitSha(git)
            core.info(`HEAD commit SHA: ${sha}`)
            return sha
        })


        const pushRemoteName = 'push-back'
        const prevConfigValues: { [key: string]: string } = {}
        try {
            await core.group('Configuring Git committer info', async () => {
                const configuredName = await getGitConfig(git, 'user.name')
                if (configuredName) {
                    core.debug(`Configured committer name: ${configuredName}`)
                    prevConfigValues['user.name'] = configuredName
                }

                const name = core.getInput('committerName')
                    || configuredName
                    || process.env.GITHUB_ACTOR
                    || repositoryFullName.split('/')[0]
                core.info(`Committer name: ${name}`)
                await git.addConfig('user.name', name)

                const configuredEmail = await getGitConfig(git, 'user.email')
                if (configuredEmail) {
                    core.debug(`Configured committer email: ${configuredEmail}`)
                    prevConfigValues['user.email'] = configuredEmail
                }

                const email = core.getInput('committerEmail') || configuredEmail || `${name}@users.noreply.github.com`
                core.info(`Committer email: ${email}`)
                await git.addConfig('user.email', email)
            })


            await core.group(`Committing ${filesToCommit.length} files`, async () => {
                await git.raw(['add', '--all', ...files])
                await git.commit(message, files)
                core.info(`${filesToCommit.length} files committed`)
            })


            await core.group(`Adding '${pushRemoteName}' remote`, async () => {
                const configuredRemoteNames = await git.getRemotes()
                    .then(remotes => remotes.map(remote => remote.name))
                core.debug(`Configured remote names: ${configuredRemoteNames.join(', ')}`)
                if (configuredRemoteNames.includes(pushRemoteName)) {
                    throw new Error(`Remote already exists: ${pushRemoteName}`)
                }

                const serverUrl = new URL(
                    process.env['GITHUB_SERVER_URL']
                    || process.env['GITHUB_URL']
                    || 'https://github.com'
                )
                core.debug(`Server URL: ${serverUrl}`)
                const extraHeaderConfigKey = `http.${serverUrl.origin}/.extraheader`

                const configuredExtraHeader = await getGitConfig(git, extraHeaderConfigKey)
                if (configuredExtraHeader) {
                    prevConfigValues[extraHeaderConfigKey] = configuredExtraHeader
                }

                core.debug('Adding remote')
                const remoteUrl = new URL(serverUrl.toString())
                if (!remoteUrl.pathname.endsWith('/')) {
                    remoteUrl.pathname += '/'
                }
                remoteUrl.pathname += `${repositoryFullName}.git`
                remoteUrl.search = ''
                remoteUrl.hash = ''
                await git.addRemote(
                    pushRemoteName,
                    remoteUrl.toString()
                )
                core.info(`Remote added: ${remoteUrl.toString()}`)

                core.info('Setting up credentials')
                const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
                core.setSecret(basicCredentials)
                await git.addConfig(extraHeaderConfigKey, `Authorization: basic ${basicCredentials}`)
            })


            const forcePush = core.getInput('forcePush').toLowerCase() === 'true'
            const isRemoteChanged = await core.group(
                `Pushing changes to '${targetBranch}' branch${forcePush ? ' (force push enabled)' : ''}`,
                async () => {
                    if (!forcePush) {
                        const targetLatestCommitSha = await getLatestCommitSha(git, pushRemoteName, targetBranch)
                        if (targetLatestCommitSha) {
                            core.info(`Target remote branch last commit SHA: ${targetLatestCommitSha}`)
                            if (targetLatestCommitSha !== currentCommitSha) {
                                return true
                            }
                        } else {
                            core.info("Target branch doesn't exist")
                        }

                        await git.push(pushRemoteName, `HEAD:${targetBranch}`)

                    } else {
                        await git.push(pushRemoteName, `HEAD:${targetBranch}`, ['--force'])
                    }

                    return false
                }
            )
            if (isRemoteChanged) {
                core.warning(`Remote repository branch '${targetBranch}' has been changed, skipping push back`)
                core.setOutput('result', RESULT.REMOTE_CHANGED)
            } else {
                core.setOutput('result', RESULT.PUSHED_SUCCESSFULLY)
            }

        } catch (error) {
            core.setFailed(error)
        } finally {
            await core.group(`Removing '${pushRemoteName}' remote`, async () => {
                await git.removeRemote(pushRemoteName)
            })

            await core.group('Restoring previous config values', async () => {
                for (const key in prevConfigValues) {
                    const value = prevConfigValues[key]
                    await git.addConfig(key, value)
                }
            })
        }

    } catch (error) {
        core.setFailed(error)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function getGitConfig(git: SimpleGit, configKey: string, defaultValue: string = ''): Promise<string> {
    return git.raw('config', '--default', defaultValue, '--get', configKey)
        .then(text => text.trim())
}

async function getCurrentCommitSha(git: SimpleGit): Promise<string> {
    return git.raw('rev-parse', 'HEAD')
        .then(text => text.trim())
}

async function getCurrentBranchName(git: SimpleGit): Promise<string> {
    return git.raw('rev-parse', '--abbrev-ref', 'HEAD')
        .then(text => text.trim())
}

async function getLatestCommitSha(git: SimpleGit, remoteName: string, remoteBranch: string): Promise<string> {
    return git.listRemote([remoteName, `refs/heads/${remoteBranch}`])
        .then(text => text.trim())
        .then(text => text.split(/\s/)[0])
}
