// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// The part that talks to the editor.  The work is in lib/connect.js.
//
// A window on a remote machine has an address of the form
//     vscode-remote://gosh+HOST/path   (REQ6/NAME-1)
// and when the editor opens one it asks whoever registered for "gosh"
// how to reach HOST.  We answer with a port on this machine, which gosh
// forwards to the editor's server on HOST.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const { connect } = require('./lib/connect');
const { mirror, mirrorDirectory } = require('./lib/mirror');

const AUTHORITY = 'gosh';

// The editor lower-cases authorities and is particular about what is in
// them, so a host that is not plain is spelt out in hexadecimal.
function encodeHost(host) {
    return /^[a-z0-9._-]+$/.test(host) ? host : `hex-${Buffer.from(host, 'utf8').toString('hex')}`;
}

function decodeHost(encoded) {
    const match = /^hex-((?:[0-9a-f]{2})+)$/.exec(encoded);
    return match ? Buffer.from(match[1], 'hex').toString('utf8') : encoded;
}

function activate(context) {
    const output = vscode.window.createOutputChannel('Remote - Gosh');
    const connections = new Map(); // authority -> connection
    const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));

    // ---- Local copies: folders on the host kept up to date on this machine (lib/mirror.js).
    // Which folders, for each host, is remembered; they are copied while a window is on that host.

    const copies = new Map(); // "host\npath" -> { handle, stopped }
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    status.command = 'remoteGosh.localCopies';
    context.subscriptions.push(status);

    const copiesRoot = () => vscode.workspace.getConfiguration('remoteGosh').get('localCopies.folder')
        || path.join(os.homedir(), 'remote-gosh-copies');
    const wantedFor = host => (context.globalState.get('localCopies', {})[host] || []);

    function showCopies() {
        const count = copies.size;
        status.text = `$(sync) ${count} local ${count === 1 ? 'copy' : 'copies'}`;
        status.tooltip = `Remote-Gosh keeps ${count === 1 ? 'a folder' : 'folders'} from the host up to date under ${copiesRoot()}`;
        if (count) {
            status.show();
        } else {
            status.hide();
        }
    }

    function startCopy(host, remotePath) {
        const key = `${host}\n${remotePath}`;
        if (copies.has(key)) {
            return;
        }
        const settings = vscode.workspace.getConfiguration('remoteGosh');
        const localDir = mirrorDirectory(copiesRoot(), host, remotePath);
        const entry = { handle: null, stopped: false };
        copies.set(key, entry);
        showCopies();
        const say = line => output.appendLine(`[copy of ${remotePath}] ${line}`);
        say(`keeping ${localDir} up to date with ${host}:${remotePath}`);
        const again = why => {
            if (copies.get(key) !== entry) {
                return;
            }
            copies.delete(key);
            showCopies();
            if (!entry.stopped && wantedFor(host).includes(remotePath)) {
                say(`${why}; trying again in a minute.`);
                setTimeout(() => {
                    if (!entry.stopped && wantedFor(host).includes(remotePath)) {
                        startCopy(host, remotePath);
                    }
                }, 60000);
            }
        };
        mirror({
            host,
            remotePath,
            localDir,
            remove: settings.get('localCopies.delete'),
            interval: settings.get('localCopies.interval'),
            goshVersion: settings.get('goshVersion'),
            releases: settings.get('releasesUrl') || undefined,
            sshPath: settings.get('sshPath') || undefined,
            relay: settings.get('relay'),
            storageDir: context.globalStorageUri.fsPath,
            log: say,
        }).then(handle => {
            entry.handle = handle;
            if (entry.stopped) {
                handle.dispose();
            }
            handle.exited.then(code => again(`the copying stopped (${code})`));
        }, error => {
            again(error.message);
            if (!entry.stopped) {
                vscode.window.showWarningMessage(`Remote-Gosh could not copy ${remotePath}: ${error.message}`);
            }
        });
    }

    function stopCopy(key) {
        const entry = copies.get(key);
        if (entry) {
            entry.stopped = true;
            copies.delete(key);
            if (entry.handle) {
                entry.handle.dispose();
            }
            showCopies();
        }
    }

    /** Makes what is being copied for a host match what is wanted for it. */
    function reconcileCopies(host) {
        const wanted = wantedFor(host);
        for (const key of [...copies.keys()]) {
            const [itsHost, itsPath] = key.split('\n');
            if (itsHost === host && !wanted.includes(itsPath)) {
                stopCopy(key);
            }
        }
        wanted.forEach(remotePath => startCopy(host, remotePath));
    }

    async function setWanted(host, paths) {
        const all = { ...context.globalState.get('localCopies', {}) };
        if (paths.length) {
            all[host] = paths;
        } else {
            delete all[host];
        }
        await context.globalState.update('localCopies', all);
        reconcileCopies(host);
    }

    /** The host this window is on, if it is one of ours. */
    function windowHost() {
        const folder = (vscode.workspace.workspaceFolders || []).find(f => f.uri.scheme === 'vscode-remote'
            && f.uri.authority.startsWith(`${AUTHORITY}+`));
        return folder ? decodeHost(folder.uri.authority.slice(AUTHORITY.length + 1)) : undefined;
    }

    async function chooseCopies() {
        const host = windowHost();
        if (!host) {
            vscode.window.showInformationMessage('Local copies are of folders on a host: open a folder there with Remote-Gosh first.');
            return;
        }
        // The folders that are open, the folders directly inside them, and whatever is already being copied.
        const wanted = wantedFor(host);
        const candidates = new Set(wanted);
        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (folder.uri.scheme !== 'vscode-remote') {
                continue;
            }
            candidates.add(folder.uri.path);
            try {
                for (const [name, type] of await vscode.workspace.fs.readDirectory(folder.uri)) {
                    if (type & vscode.FileType.Directory) {
                        candidates.add(path.posix.join(folder.uri.path, name));
                    }
                }
            } catch (error) { /* then just the folder itself */ }
        }
        const picked = await vscode.window.showQuickPick(
            [...candidates].sort().map(remotePath => ({
                label: remotePath,
                description: wanted.includes(remotePath) ? mirrorDirectory(copiesRoot(), host, remotePath) : '',
                picked: wanted.includes(remotePath),
            })),
            {
                canPickMany: true,
                title: `Folders on ${host} to keep a copy of on this machine`,
                placeHolder: `Checked folders are kept up to date under ${copiesRoot()}`,
            });
        if (picked) {
            await setWanted(host, picked.map(item => item.label));
        }
    }

    async function copyThisFolder(uri) {
        const host = windowHost();
        if (!host || !uri || uri.scheme !== 'vscode-remote') {
            return chooseCopies();
        }
        const wanted = wantedFor(host);
        if (wanted.includes(uri.path)) {
            const stop = 'Stop Copying';
            const answer = await vscode.window.showInformationMessage(
                `${uri.path} is already kept up to date in ${mirrorDirectory(copiesRoot(), host, uri.path)}.`, stop);
            if (answer === stop) {
                await setWanted(host, wanted.filter(p => p !== uri.path));
            }
            return undefined;
        }
        await setWanted(host, [...wanted, uri.path]);
        vscode.window.showInformationMessage(
            `Keeping a copy of ${uri.path} up to date in ${mirrorDirectory(copiesRoot(), host, uri.path)}.`);
        return undefined;
    }

    const resolver = {
        async resolve(authority) {
            const host = decodeHost(authority.slice(authority.indexOf('+') + 1));
            const settings = vscode.workspace.getConfiguration('remoteGosh');

            // The editor asks again when it has lost the connection: start afresh.
            const previous = connections.get(authority);
            if (previous) {
                connections.delete(authority);
                previous.dispose();
            }

            try {
                const connection = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Gosh: ${host}` },
                    progress => connect({
                        host,
                        product: {
                            ...product,
                            serverDownloadUrlTemplate: settings.get('serverDownloadUrlTemplate') || product.serverDownloadUrlTemplate,
                        },
                        goshVersion: settings.get('goshVersion'),
                        releases: settings.get('releasesUrl') || undefined,
                        sshPath: settings.get('sshPath') || undefined,
                        persistentTerminals: settings.get('persistentTerminals'),
                        relay: settings.get('relay'),
                        shpoolDir: path.join(context.extensionPath, 'shpool'),
                        storageDir: context.globalStorageUri.fsPath,
                        log: line => {
                            output.appendLine(line);
                            progress.report({ message: line });
                        },
                    }));

                connections.set(authority, connection);
                reconcileCopies(host); // (gosh is on the host by now, which they need)
                for (const note of connection.notes) {
                    vscode.window.showWarningMessage(`${host}: ${note}`);
                }
                connection.exited.then(code => {
                    if (connections.get(authority) === connection) {
                        connections.delete(authority);
                        output.appendLine(`The gosh session to ${host} ended (${code}).`);
                    }
                });
                return new vscode.ResolvedAuthority('127.0.0.1', connection.port, connection.token);
            } catch (error) {
                output.appendLine(`Could not connect to ${host}: ${error.message}`);
                output.show(true);
                throw vscode.RemoteAuthorityResolverError.NotAvailable(error.message, true);
            }
        },
    };
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY, resolver));

    async function open(reuseWindow) {
        const recent = context.globalState.get('hosts', []);
        let host;
        if (recent.length) {
            const other = 'Another host...';
            const picked = await vscode.window.showQuickPick([...recent, other], { placeHolder: 'Connect with gosh to...' });
            if (!picked) {
                return;
            }
            host = picked === other ? undefined : picked;
        }
        if (!host) {
            host = await vscode.window.showInputBox({
                prompt: 'Host to connect to, as you would give it to ssh',
                placeHolder: 'user@host, or a name from your ssh configuration',
            });
        }
        host = host && host.trim();
        if (!host) {
            return;
        }
        await context.globalState.update('hosts', [host, ...recent.filter(h => h !== host)].slice(0, 10));
        await vscode.commands.executeCommand('vscode.newWindow', {
            remoteAuthority: `${AUTHORITY}+${encodeHost(host)}`,
            reuseWindow,
        });
    }

    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('remoteGosh.connect', () => open(false)),
        vscode.commands.registerCommand('remoteGosh.connectCurrentWindow', () => open(true)),
        vscode.commands.registerCommand('remoteGosh.showLog', () => output.show()),
        vscode.commands.registerCommand('remoteGosh.localCopies', chooseCopies),
        vscode.commands.registerCommand('remoteGosh.copyThisFolder', copyThisFolder),
        vscode.commands.registerCommand('remoteGosh.openLocalCopies',
            () => vscode.env.openExternal(vscode.Uri.file(copiesRoot()))),
        { dispose: () => [...copies.keys()].forEach(stopCopy) },
        { dispose: () => connections.forEach(connection => connection.dispose()) });
}

function deactivate() {}

module.exports = { activate, deactivate, encodeHost, decodeHost };
