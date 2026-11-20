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
const pool = require('./lib/sessions');

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
    const output = vscode.window.createOutputChannel('Gosh - Remote');
    const connections = new Map(); // authority -> connection
    const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));

    // ---- Local copies: folders on the host kept up to date on this machine (lib/mirror.js).
    // Which folders, for each host, is remembered; they are copied while a window is on that host.

    const copies = new Map(); // "host\npath" -> { handle, stopped }
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    status.command = 'goshRemote.localCopies';
    context.subscriptions.push(status);

    const copiesRoot = () => vscode.workspace.getConfiguration('goshRemote').get('localCopies.folder')
        || path.join(os.homedir(), 'gosh-remote-copies');
    const wantedFor = host => (context.globalState.get('localCopies', {})[host] || []);

    function showCopies() {
        const count = copies.size;
        status.text = `$(sync) ${count} local ${count === 1 ? 'copy' : 'copies'}`;
        status.tooltip = `Gosh-Remote keeps ${count === 1 ? 'a folder' : 'folders'} from the host up to date under ${copiesRoot()}`;
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
        const settings = vscode.workspace.getConfiguration('goshRemote');
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
                vscode.window.showWarningMessage(`Gosh-Remote could not copy ${remotePath}: ${error.message}`);
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
            vscode.window.showInformationMessage('Local copies are of folders on a host: open a folder there with Gosh-Remote first.');
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
            const settings = vscode.workspace.getConfiguration('goshRemote');

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

    // ---- Pool terminals: the host's shpool sessions (lib/sessions.js; gosh-remote #3).  A terminal
    // can be attached to any of them, and the one a terminal is in renamed or detached.

    /** The host of this window, if it is one of ours, with or without a folder open. */
    function remoteHost() {
        const authority = vscode.env.remoteAuthority;
        if (authority && authority.startsWith(`${AUTHORITY}+`)) {
            return decodeHost(authority.slice(AUTHORITY.length + 1));
        }
        return windowHost();
    }

    function poolOptions(host) {
        return {
            host,
            sshPath: vscode.workspace.getConfiguration('goshRemote').get('sshPath') || undefined,
            log: line => output.appendLine(line),
        };
    }

    /** The host's sessions, and the session the active terminal is in; undefined if not to be had. */
    async function poolHere() {
        const host = remoteHost();
        if (!host) {
            vscode.window.showInformationMessage('Pool terminals are shpool sessions on a host: connect to one with Gosh-Remote first.');
            return undefined;
        }
        try {
            const list = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `shpool sessions on ${host}` },
                () => pool.listSessions(poolOptions(host)));
            const active = vscode.window.activeTerminal;
            const pid = active ? await active.processId : undefined;
            return { host, list, active, current: pool.sessionOfTerminal(list, pid) };
        } catch (error) {
            output.appendLine(`Could not list the shpool sessions on ${host}: ${error.message}`);
            vscode.window.showErrorMessage(`Could not list the shpool sessions on ${host}: ${error.message}`);
            return undefined;
        }
    }

    function ago(ms) {
        if (!ms) {
            return '';
        }
        const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
        if (minutes < 60) {
            return `started ${minutes} min ago`;
        }
        const hours = Math.round(minutes / 60);
        return hours < 48 ? `started ${hours} h ago` : `started ${Math.round(hours / 24)} days ago`;
    }

    function sessionItem(session, here) {
        const state = here.current === session ? 'this terminal'
            : session.attached ? 'attached elsewhere' : 'not attached';
        return { label: session.name, description: state, detail: ago(session.startedAt), session };
    }

    /** The terminals of this window that are in a session, found by their launcher's pid. */
    async function terminalsOf(session) {
        const found = [];
        for (const terminal of vscode.window.terminals) {
            if (session.terminals.includes(await terminal.processId)) {
                found.push(terminal);
            }
        }
        return found;
    }

    function nameCheck(list, except) {
        return value => {
            try {
                pool.checkSessionName(value);
            } catch (error) {
                return error.message;
            }
            return value !== except && list.sessions.some(s => s.name === value) ? `There is already a session called ${value}.` : undefined;
        };
    }

    async function attachSession() {
        const here = await poolHere();
        if (!here) {
            return;
        }
        const { host, list } = here;
        if (!list.launcher) {
            vscode.window.showWarningMessage(`${host} has no terminal launcher: set goshRemote.persistentTerminals to shpool and connect again.`);
            return;
        }
        const order = s => (s === here.current ? 2 : s.attached ? 1 : 0); // free ones first
        const items = [...list.sessions].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
            .map(s => sessionItem(s, here));
        items.push({ label: '$(add) New session...', alwaysShow: true });
        const picked = await vscode.window.showQuickPick(items, {
            title: `Attach a terminal to a shpool session on ${host}`,
            placeHolder: list.sessions.length ? 'A session keeps its shell, and whatever runs in it, when its terminal goes' : 'No sessions yet',
        });
        if (!picked) {
            return;
        }
        let name;
        let force = false;
        if (picked.session) {
            name = picked.session.name;
            if (picked.session === here.current) {
                here.active.show();
                return;
            }
            if (picked.session.attached) {
                const mine = await terminalsOf(picked.session);
                if (mine.length) {
                    mine[0].show(); // already in a terminal of this window
                    return;
                }
                const take = 'Take It Over';
                const answer = await vscode.window.showWarningMessage(
                    `${name} is attached to a terminal elsewhere (another window, or one that has gone). Attach it here instead? It is detached there.`,
                    { modal: true }, take);
                if (answer !== take) {
                    return;
                }
                force = true;
            }
        } else {
            name = await vscode.window.showInputBox({
                title: `A new shpool session on ${host}`,
                prompt: 'Its name',
                validateInput: nameCheck(list),
            });
            if (!name) {
                return;
            }
        }
        const folder = (vscode.workspace.workspaceFolders || []).find(f => f.uri.scheme === 'vscode-remote');
        const terminal = vscode.window.createTerminal({
            name,
            ...pool.attachTerminal(list, name, force),
            cwd: folder ? folder.uri : undefined,
            iconPath: new vscode.ThemeIcon('terminal-tmux'),
        });
        terminal.show();
    }

    async function renameSession() {
        const here = await poolHere();
        if (!here) {
            return;
        }
        const { host, list } = here;
        if (!list.rename) {
            vscode.window.showWarningMessage(`The shpool on ${host} cannot rename sessions: that needs gosh-shpool (0.11.7-gosh.1 or later), https://github.com/wmacevoy/gosh-shpool.`);
            return;
        }
        let session = here.current;
        if (!session) {
            if (!list.sessions.length) {
                vscode.window.showInformationMessage(`There are no shpool sessions on ${host}.`);
                return;
            }
            const picked = await vscode.window.showQuickPick(list.sessions.map(s => sessionItem(s, here)),
                { title: `Rename a shpool session on ${host}` });
            if (!picked) {
                return;
            }
            session = picked.session;
        }
        const name = await vscode.window.showInputBox({
            title: `Rename ${session.name}`,
            prompt: 'Its new name. A renamed session is attached only when asked for (Attach Terminal to Session...), not by a new terminal by itself.',
            value: session.name,
            validateInput: nameCheck(list, session.name),
        });
        if (!name || name === session.name) {
            return;
        }
        try {
            await pool.renameSession(poolOptions(host), session.name, name);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not rename ${session.name}: ${error.message}`);
            return;
        }
        // The terminals showing it take its name.  The editor renames only the active terminal.
        const terminals = session === here.current ? [here.active] : await terminalsOf(session);
        for (const terminal of terminals) {
            terminal.show(true);
            await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
        }
        if (here.active && !terminals.includes(here.active)) {
            here.active.show(true);
        }
    }

    async function detachSession() {
        const here = await poolHere();
        if (!here) {
            return;
        }
        const { host, list } = here;
        let session = here.current;
        if (!session) {
            const attached = list.sessions.filter(s => s.attached);
            if (!attached.length) {
                vscode.window.showInformationMessage(`No shpool session on ${host} is attached.`);
                return;
            }
            const picked = await vscode.window.showQuickPick(attached.map(s => sessionItem(s, here)), {
                title: `Detach a shpool session on ${host}`,
                placeHolder: 'Its terminal closes; the shell keeps running, to be attached again',
            });
            if (!picked) {
                return;
            }
            session = picked.session;
        }
        try {
            await pool.detachSession(poolOptions(host), session.name);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not detach ${session.name}: ${error.message}`);
            return;
        }
        vscode.window.showInformationMessage(
            `${session.name} is detached: its shell keeps running. Attach Terminal to Session... brings it back.`);
    }

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
        vscode.commands.registerCommand('goshRemote.connect', () => open(false)),
        vscode.commands.registerCommand('goshRemote.connectCurrentWindow', () => open(true)),
        vscode.commands.registerCommand('goshRemote.showLog', () => output.show()),
        vscode.commands.registerCommand('goshRemote.localCopies', chooseCopies),
        vscode.commands.registerCommand('goshRemote.copyThisFolder', copyThisFolder),
        vscode.commands.registerCommand('goshRemote.openLocalCopies',
            () => vscode.env.openExternal(vscode.Uri.file(copiesRoot()))),
        vscode.commands.registerCommand('goshRemote.attachSession', attachSession),
        vscode.commands.registerCommand('goshRemote.renameSession', renameSession),
        vscode.commands.registerCommand('goshRemote.detachSession', detachSession),
        { dispose: () => [...copies.keys()].forEach(stopCopy) },
        { dispose: () => connections.forEach(connection => connection.dispose()) });
}

function deactivate() {}

module.exports = { activate, deactivate, encodeHost, decodeHost };
