// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// Pool terminals: the shpool sessions on a host, for the extension's commands to attach a terminal
// to any of them, rename one and detach one (gosh-remote #3).  Each asks the host over ssh, with
// lib/sessions.sh.  No dependence on the editor, so that it can be tested without one.
//
// Which session a terminal is in: shpool lists, for each attached session, the pid of the
// "shpool attach" holding it, and that process's parent is the terminal launcher
// (lib/terminal.sh), the process the editor knows the terminal by (Terminal.processId).  So it
// holds after a rename, and for a terminal opened before the extension asked.

const fs = require('fs');
const path = require('path');

const { runRemote, sshRunner, shellQuote } = require('./connect');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'sessions.sh'), 'utf8');

/**
 * A session name, or a refusal.  Narrower than shpool's own rule: no white space (shpool list's
 * columns, and the launcher, are split on it), nothing a shell or ssh would take for an option.
 */
function checkSessionName(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._:@+=-]{0,63}$/.test(name)) {
        throw new Error(`${JSON.stringify(String(name))} is not a session name: up to 64 letters, digits and . _ : @ + = -, not starting with - . : @ + =`);
    }
    return name;
}

/** The script for an action: its settings, shell-quoted, then lib/sessions.sh. */
function sessionsScript(action, name = '', newName = '') {
    if (!['list', 'rename', 'detach'].includes(action)) {
        throw new Error(`no such action: ${action}`);
    }
    if (action !== 'list') {
        checkSessionName(name);
    }
    if (action === 'rename') {
        checkSessionName(newName);
    }
    return `ACTION=${shellQuote(action)}\nNAME=${shellQuote(name)}\nNEW_NAME=${shellQuote(newName)}\n${SCRIPT}`;
}

/**
 * What the host reported for "list", made usable:
 *   { home, launcher, rename, sessions: [{ name, id, attached, startedAt, terminals: [pid, ...] }] }
 * where terminals are the pids of the launchers attached to the session (normally one).
 */
function parseList(reported) {
    let listed;
    try {
        listed = JSON.parse(Buffer.from(reported.sessions || '', 'base64').toString('utf8'));
    } catch (error) {
        throw new Error(`The host's shpool list could not be read: ${error.message}`);
    }
    const parents = new Map();
    for (const pair of String(reported.processes || '').split(',')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(pair);
        if (match) {
            parents.set(Number(match[1]), Number(match[2]));
        }
    }
    const sessions = (Array.isArray(listed && listed.sessions) ? listed.sessions : [])
        .filter(s => s && typeof s.name === 'string')
        .map(s => {
            const attachments = Array.isArray(s.attachments) ? s.attachments : [];
            return {
                name: s.name,
                id: s.id,
                attached: String(s.status).toLowerCase() === 'attached',
                startedAt: Number(s.started_at_unix_ms) || undefined,
                terminals: attachments.map(a => parents.get(Number(a && a.pid))).filter(Boolean),
            };
        });
    return {
        home: reported.home,
        launcher: reported.launcher === 'yes',
        rename: reported.rename === 'yes',
        sessions,
    };
}

/** The session a terminal is in, from its launcher's pid (Terminal.processId), if any. */
function sessionOfTerminal(list, terminalPid) {
    return terminalPid ? list.sessions.find(s => s.terminals.includes(terminalPid)) : undefined;
}

/** The launcher on the host, and its arguments, for a terminal attached to a session. */
function attachTerminal(list, name, force) {
    checkSessionName(name);
    if (!list.home || !list.home.startsWith('/')) {
        throw new Error('The host did not say where its home directory is.');
    }
    return {
        shellPath: path.posix.join(list.home, '.local', 'bin', 'gosh-remote-terminal'),
        shellArgs: ['--attach', name, ...(force ? ['--force'] : [])],
    };
}

/**
 * options: { host, sshPath, log, run }   (run: how a script reaches the host; ssh by default)
 */
function ask(options, script) {
    const run = options.run || sshRunner(options.sshPath);
    return runRemote(run, options.host, 'sh', script, options.log || (() => {}));
}

async function listSessions(options) {
    return parseList(await ask(options, sessionsScript('list')));
}

async function renameSession(options, name, newName) {
    await ask(options, sessionsScript('rename', name, newName));
}

async function detachSession(options, name) {
    await ask(options, sessionsScript('detach', name));
}

module.exports = {
    checkSessionName, sessionsScript, parseList, sessionOfTerminal, attachTerminal, listSessions, renameSession, detachSession,
};
