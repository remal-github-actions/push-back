import * as core from '@actions/core'
import {context} from '@actions/github'
import simpleGit from 'simple-git'
import {SimpleGit} from 'simple-git/promise'
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
        const githubToken = core.getInput('githubToken', {required: true})
        core.setSecret(githubToken)

        const message = core.getInput('message', {required: true})

        const files = core.getInput('files').split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)


        if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
            require('debug').enable('simple-git')
        }
        const git = simpleGit(workspacePath)
        const filesToCommit = await core.group('Checking Git status', async () =>
            git.status(files)
                .then(response => response.files)
        )
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

                const name = core.getInput('committerName') || configuredName || context.actor || context.repo.owner
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


            await core.group('Commiting files', async () => {
                if (files.length > 0) {
                    await git.add(files)
                } else {
                    await git.add(['.'])
                }
                await git.commit(message, files)
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

                core.info('Setting up credentials')
                const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
                core.setSecret(basicCredentials)
                await git.addConfig(extraHeaderConfigKey, `Authorization: basic ${basicCredentials}`)

                core.debug('Adding remote')
                const remoteUrl = new URL(serverUrl.toString())
                if (!remoteUrl.pathname.endsWith('/')) {
                    remoteUrl.pathname += '/'
                }
                remoteUrl.pathname += `${context.repo.owner}/${context.repo.repo}.git`
                remoteUrl.search = ''
                remoteUrl.hash = ''
                await git.addRemote(
                    pushRemoteName,
                    remoteUrl.toString()
                )
                core.info(`Remote added: ${remoteUrl.toString()}`)
            })


            const targetBranch = core.getInput('targetBranch') || await getCurrentBranchName(git)
            const forcePush = core.getInput('forcePush').toLowerCase() === 'true'
            await core.group(
                `Pushing changes to '${targetBranch}' branch${forcePush ? ' (force push enabled)' : ''}`,
                async () => {
                    if (!forcePush) {
                        const targetLatestCommitSha = await git.listRemote([pushRemoteName, targetBranch])
                        if (targetLatestCommitSha) {
                            core.info(`Target branch last commit SHA: ${targetLatestCommitSha}`)
                            if (targetLatestCommitSha !== currentCommitSha) {
                                core.warning(`Remote repository branch '${targetBranch}' has been changed, skipping push back`)
                                core.setOutput('result', RESULT.REMOTE_CHANGED)
                                return
                            }
                        } else {
                            core.info("Target branch doesn't exist")
                        }

                        await git.push(pushRemoteName, `HEAD:${targetBranch}`)

                    } else {
                        await git.push(pushRemoteName, `HEAD:${targetBranch}`, ['--force'])
                    }

                    core.setOutput('result', RESULT.PUSHED_SUCCESSFULLY)
                }
            )


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
}

async function getCurrentBranchName(git: SimpleGit): Promise<string> {
    return git.raw('rev-parse', '--abbrev-ref', 'HEAD')
}
