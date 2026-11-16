// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// Keeps a folder on this machine up to date with one on the host.
//
// It is "gocp --auto" by the client's own words: ssh starts a gosh session on
// the host whose job is to send the folder and then whatever changes in it,
// and a gosh client here receives.  Being a gosh session, it carries on
// through changes of network and sleep, and after an interruption sends
// only what is missing.
//
// It goes one way: what is changed here is not sent back.

const fs = require('fs');
const { spawn } = require('child_process');

const { ensureLocalClient } = require('./install');
const { probe, sshRunner, runRemote, relayCommand, shellQuote, DEFAULT_RELEASES } = require('./connect');

// Run on the host, with settings above it: starts the sending session and says where it is.
const REMOTE = `
report() { printf 'GOSHREMOTE %s==%s==\\n' "$1" "$2"; }
fail() { report error "$*"; exit 1; }
PATH="$HOME/.local/bin:$PATH"
export PATH
command -v gosh-server >/dev/null 2>&1 || fail "gosh is not installed on the host"
case "$SOURCE" in "~") SOURCE=$HOME ;; "~/"*) SOURCE="$HOME/\${SOURCE#??}" ;; esac
[ -d "$SOURCE" ] || fail "there is no folder $SOURCE on the host"
unit=$(printf '\\037')
stream="@copy\${unit}send\${unit}-r\${unit}--auto\${unit}--interval=$INTERVAL$DELETE\${unit}--\${unit}$SOURCE/."
started=
for locale in "" en_US.UTF-8 C.UTF-8; do # the server insists on a UTF-8 locale
    started=$(
        [ -n "$locale" ] && { LC_ALL=$locale; export LC_ALL; }
        gosh-server new -s -X "$stream" -- sh -c 'while :; do sleep 86400; done' 2>/dev/null </dev/null
    ) && case "$started" in *"MOSH CONNECT "*) break ;; esac
    started=
done
[ -n "$started" ] || fail "the gosh on the host would not start a copy"
set -- $(printf '%s\\n' "$started" | sed -n 's/^MOSH CONNECT \\([0-9][0-9]*\\) \\([A-Za-z0-9\\/+]*\\).*/\\1 \\2/p')
[ $# -eq 2 ] || fail "could not understand what gosh-server said"
report goshPort "$1"
report goshKey "$2"
set -- \${SSH_CONNECTION:-}
report goshAddress "\${3:-}"
report done yes
`;

/**
 * Starts keeping localDir the same as remotePath on the host.
 *
 * options:
 *   host, remotePath, localDir
 *   goshVersion, storageDir, releases, sshPath, relay   as for connect()
 *   remove        also remove here what is removed there [false]
 *   interval      seconds between looks for changes [2]
 *   log           function taking a line: what was copied, and what went wrong
 *   runner, shell, goshAddress, relayCommand            for tests, as for connect()
 *
 * Returns { dispose(), exited } once the session is started; exited
 * resolves with the client's exit status if it stops.
 */
async function mirror(options) {
    const log = options.log || (() => {});
    const interval = Math.max(0.2, Number(options.interval) || 2);
    if (/[\x00-\x1f]/.test(options.remotePath) || /[\x00-\x1f]/.test(options.localDir)) {
        throw new Error('A folder name with control characters in it cannot be copied.');
    }

    const client = await ensureLocalClient({
        version: options.goshVersion, releases: options.releases || DEFAULT_RELEASES, storageDir: options.storageDir, log,
    });
    const shell = options.shell || await probe(options.sshPath, options.host);
    if (shell !== 'sh') {
        throw new Error('Keeping local copies of folders is not available for Windows hosts yet.');
    }
    const runner = options.runner || sshRunner(options.sshPath);
    const settings = {
        SOURCE: options.remotePath.replace(/\/+$/, '') || '/',
        INTERVAL: Math.round(interval * 1000),
        DELETE: options.remove ? '\x1f--delete' : '',
    };
    const script = Object.entries(settings).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n') + REMOTE;
    const reported = await runRemote(runner, options.host, shell, script, log);
    const address = reported.goshAddress || options.goshAddress;
    if (!address || !reported.goshPort || !reported.goshKey) {
        throw new Error(`${options.host} did not say where its gosh session is.`);
    }

    fs.mkdirSync(options.localDir, { recursive: true });
    const receive = ['@copy', 'receive', '-r', '--auto', ...(options.remove ? ['--delete'] : []), '--',
        options.localDir.replace(/\\/g, '/')];

    const env = { ...process.env, MOSH_KEY: reported.goshKey }; // (mosh's own variable)
    delete env.GOSH_RELAY_COMMAND;
    const relay = ['always', 'never'].includes(options.relay) ? options.relay : 'auto';
    const words = relay === 'never' ? null
        : options.relayCommand ? options.relayCommand(address, reported.goshPort, reported)
        : options.runner ? null
        : relayCommand(options.sshPath, options.host, shell, reported, address);
    env.GOSH_RELAY = words ? relay : 'never';
    if (words) {
        env.GOSH_RELAY_COMMAND = words.join('\x1f');
    }

    const child = spawn(client, ['-X', receive.join('\x1f'), address, reported.goshPort], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        windowsHide: true,
    });
    let pending = '';
    child.stderr.on('data', data => {
        pending += data;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end).replace(/\r$/, '').replace(/^gocp: /, '');
            pending = pending.slice(end + 1);
            if (line.trim() && !/Interrupt \(Ctrl-C\)/.test(line)) {
                log(line);
            } else if (line.trim()) {
                log('watching for changes.');
            }
        }
    });
    const exited = new Promise(resolve => {
        child.on('close', code => resolve(code));
        child.on('error', error => {
            log(`could not start the gosh client: ${error.message}`);
            resolve(1);
        });
    });
    return {
        exited,
        dispose() {
            child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
        },
    };
}

/** Where on this machine the copy of a host's folder is kept, under root. */
function mirrorDirectory(root, host, remotePath) {
    const safe = part => part.replace(/[<>:"|?*\x00-\x1f\\]/g, '_').replace(/^\.+$/, '_');
    const parts = remotePath.split('/').filter(Boolean).map(safe);
    return require('path').join(root, safe(host), ...(parts.length ? parts : ['root']));
}

module.exports = { mirror, mirrorDirectory };
