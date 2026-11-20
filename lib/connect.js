// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// Setting up one connection: everything between "the user asked for a
// host" and "here is a local port the editor can talk to".
//
// It has no dependence on the editor, so that it can be tested without one.
//
//   1. the gosh client is installed on this machine if it is not;
//   2. over ssh, a script on the remote machine installs gosh there if
//      it is not, installs and starts the editor's server, and starts a
//      gosh session that forwards a local port to that server;
//   3. the gosh client is started here, with no terminal (-N), to
//      be the other end of that session.
//
// After that ssh is finished with.  The editor talks to a port on this
// machine; gosh carries it, and keeps carrying it when this machine
// changes network, sleeps, or loses its connection for a while.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { ensureLocalClient } = require('./install');

const DEFAULT_RELEASES = 'https://github.com/wmacevoy/gosh/releases/download';
const DEFAULT_SERVER_URL_TEMPLATE
    = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * A host as given to ssh, or a refusal: no host name begins with "-" (which ssh would take for one
 * of its options: "-oProxyCommand=..." runs a command on this machine), or has white space,
 * control characters or "/" in it.  (The review of 2026-11-16.)
 */
function checkHost(host) {
    if (typeof host !== 'string' || host === '' || host.startsWith('-') || /[\s\x00-\x1f\x7f/]/.test(host)) {
        throw new Error(`${JSON.stringify(String(host))} is not a host name.`);
    }
    return host;
}

/** Quotes a value for a Bourne shell assignment. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The script to run remotely: settings, then lib/remote.sh. */
function remoteScript(settings) {
    const assignments = Object.entries(settings).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n');
    return `${assignments}\n${fs.readFileSync(path.join(__dirname, 'remote.sh'), 'utf8')}`;
}

/** Quotes a value as a PowerShell string: its typographic single quotes end one too, so each is doubled. */
function powershellQuote(value) {
    return `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
}

/** A path for cmd.exe: quoted where it has anything cmd would read (spaces, &, |, ...); one with a " is refused. */
function cmdQuote(value) {
    if (value.includes('"')) {
        throw new Error(`${value} cannot be given to cmd.exe: it has a " in it.`);
    }
    return /[\s&|<>^%!()]/.test(value) ? `"${value}"` : value;
}

/** What to tell the user of a kind of host, whatever its script says. */
function platformNotes(shell) {
    return shell === 'powershell'
        ? ['This host runs Windows: a Windows host is experimental with Gosh-Remote, and nothing is promised of it (REQ4/EXT-2).']
        : [];
}

/**
 * The same for a Windows host: settings, then lib/remote.ps1, as what is
 * typed at a PowerShell reading its commands from standard input.
 *
 * Read that way PowerShell takes a line at a time, so the script is
 * sent as one line that decodes and runs the rest.
 */
function remotePowershell(settings) {
    const assignments = Object.entries(settings).map(([name, value]) => `$${name} = ${powershellQuote(value)}`).join('\n');
    const script = `${assignments}\n${fs.readFileSync(path.join(__dirname, 'remote.ps1'), 'utf8')}`;
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\r\nexit\r\n`;
}

const POWERSHELL = 'powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -';

/**
 * How a script reaches the remote machine: by default over ssh, piped
 * to a Bourne shell or, on a Windows host, to PowerShell.  ssh must be
 * able to log in without asking anything (keys or an agent), since
 * there is nowhere to ask.
 */
function sshRunner(sshPath) {
    return (host, shell) => spawn(sshPath || 'ssh', ['-T', '-o', 'BatchMode=yes', '--', checkHost(host), shell === 'powershell' ? POWERSHELL : 'sh'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * The command that reaches a relay on the host, for the gosh client to
 * carry the session through when UDP cannot get there: ssh again, to
 * "gosh-server relay", which passes datagrams between ssh and the gosh
 * server.  The client is given it as a list of words and runs it itself,
 * when and if it is needed.
 */
function relayCommand(sshPath, host, shell, reported, address) {
    let remote;
    if (shell === 'powershell') {
        // Run by whatever shell the host's ssh server uses.  A bare path means the
        // same to cmd.exe and PowerShell; one with spaces has to be quoted, cmd's way.
        const server = reported.goshServer;
        if (!server) {
            return null;
        }
        remote = `${cmdQuote(server)} relay ${address} ${reported.goshPort}`;
    } else {
        // (through sh, whatever the login shell: it is where gosh was installed)
        remote = `sh -c ${shellQuote(`PATH="$HOME/.local/bin:$PATH" exec gosh-server relay ${address} ${reported.goshPort}`)}`;
    }
    return [sshPath || 'ssh', '-T', '-o', 'BatchMode=yes', '--', checkHost(host), remote];
}

/**
 * Finds out what kind of machine the host is, by asking it something
 * that every kind of shell will answer one way or another.
 */
function probe(sshPath, host) {
    return new Promise((resolve, reject) => {
        checkHost(host);
        const child = spawn(sshPath || 'ssh', ['-T', '-o', 'BatchMode=yes', '--', host, 'uname -s'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let errors = '';
        child.stdout.on('data', data => (out += data));
        child.stderr.on('data', data => (errors += data));
        child.on('error', error => reject(new Error(`Could not run ssh: ${error.message}`)));
        child.on('close', code => {
            if (/\b(Linux|Darwin|FreeBSD)\b/.test(out)) {
                resolve('sh');
            } else if (code === 255) {
                // ssh's own failure: it could not connect or log in
                reject(new Error(`Could not log in to ${host}: ${errors.trim().split('\n').slice(-2).join(' ') || 'ssh failed'}`));
            } else {
                resolve('powershell'); // it has no uname: Windows
            }
        });
    });
}

/**
 * The shpool that comes with the extension for a kind of host, if there is one.
 * They come from a gosh-shpool release (see tools/build-shpool.js), in
 *     shpool/linux-x64/shpool  shpool/linux-arm64/shpool  shpool/darwin/shpool
 */
function bundledShpool(shpoolDir, platform) {
    if (!shpoolDir) {
        return null;
    }
    const kind = platform.startsWith('darwin-') ? 'darwin' // one binary serves both kinds of Mac
        : platform.replace(/^alpine-/, 'linux-'); // the Linux ones are static, so they run on Alpine too
    const file = path.join(shpoolDir, kind, 'shpool');
    return fs.existsSync(file) ? file : null;
}

/** Asks a host what it is and whether it has shpool. */
const SHPOOL_PROBE = `
PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) os=other ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch=other ;; esac
if [ "$os" = linux ] && grep -qs '^ID=alpine' /etc/os-release; then os=alpine; fi
printf 'GOSHREMOTE platform==%s==\n' "$os-$arch"
if command -v shpool >/dev/null 2>&1; then have=yes; else have=no; fi
printf 'GOSHREMOTE shpool==%s==\n' "$have"
printf 'GOSHREMOTE done==yes==\n'
`;

/** A script that puts a program on the host, in ~/.local/bin, and checks that it runs there. */
function uploadScript(file, name) {
    const encoded = fs.readFileSync(file).toString('base64').replace(/(.{76})/g, '$1\n');
    return `
mkdir -p "$HOME/.local/bin" || { printf 'GOSHREMOTE error==cannot create ~/.local/bin==\n'; exit 1; }
target="$HOME/.local/bin/${name}"
decode() { if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; else openssl base64 -d; fi; }
decode >"$target.new" <<'GOSH_REMOTE_END_OF_FILE'
${encoded}
GOSH_REMOTE_END_OF_FILE
chmod 755 "$target.new"
if "$target.new" version >/dev/null 2>&1; then
    mv -f "$target.new" "$target"
    printf 'GOSHREMOTE installed==yes==\n'
else
    rm -f "$target.new"
    printf 'GOSHREMOTE installed==no==\n'
fi
printf 'GOSHREMOTE done==yes==\n'
`;
}

/** What a host's script may report: nothing else it says is kept (the review of 2026-11-16). */
const REPORTED = new Set(['error', 'done', 'platform', 'shpool', 'installed', 'gosh', 'serverPort', 'token', 'terminals',
    'goshPort', 'goshKey', 'spec', 'goshAddress', 'goshServer']);

/** Runs the script and collects what it reports. */
function runRemote(start, host, shell, script, log) {
    return new Promise((resolve, reject) => {
        const child = start(host, shell);
        const reported = { notes: [] };
        let pending = '';
        let errors = '';

        child.stdout.on('data', data => {
            pending += data;
            let end;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end).replace(/\r$/, '');
                pending = pending.slice(end + 1);
                const match = /^GOSHREMOTE ([A-Za-z]+)==(.*)==$/.exec(line);
                if (!match) {
                    continue; // something a login script said
                }
                if (match[1] === 'status') {
                    log(`${host}: ${match[2]}...`);
                } else if (match[1] === 'note') {
                    log(`${host}: ${match[2]}`);
                    reported.notes.push(match[2]);
                } else if (REPORTED.has(match[1])) {
                    reported[match[1]] = match[2];
                }
            }
        });
        child.stderr.on('data', data => (errors += data));
        child.on('error', error => reject(new Error(`Could not reach ${host}: ${error.message}`)));
        child.on('close', code => {
            if (reported.error) {
                reject(new Error(`${host}: ${reported.error}`));
            } else if (reported.done !== 'yes') {
                const why = errors.trim().split('\n').slice(-3).join(' ') || `the remote script stopped (${code})`;
                reject(new Error(`Could not set up ${host}: ${why}`));
            } else {
                resolve(reported);
            }
        });
        child.stdin.on('error', () => {}); // if it dies early, 'close' says why
        child.stdin.end(script);
    });
}

/**
 * What the gosh client has said so far means: 'connected' once it says its forward is up; 'refused'
 * if it connected without the forward (a stock server, or one that would not forward), which is of
 * no use to the editor; null while neither.
 */
function clientOutcome(said) {
    if (said.includes('gosh: connected; forwarding.')) {
        return 'connected';
    }
    if (/gosh: connected(, but|\.)/.test(said)) {
        return 'refused';
    }
    return null;
}

/** The forward the client is given: this machine's port, to the host's server's port, on loopback only. */
function forwardSpec(localPort, reported) {
    const port = String(reported.serverPort);
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw new Error(`The host reported ${JSON.stringify(port)} as its server's port.`);
    }
    return `${localPort}:127.0.0.1:${Number(port)}`;
}

/** The client's environment: this one's, with the session's key, and a relay command only if it is this connection's. */
function clientEnvironment(base, key, relay, words) {
    const env = { ...base, MOSH_KEY: key }; // (MOSH_KEY is mosh's own variable, and keeps its name; GOSH_RELAY* are gosh's: REQ6/NAME-1)
    delete env.GOSH_RELAY_COMMAND;
    env.GOSH_RELAY = words ? relay : 'never';
    if (words) {
        env.GOSH_RELAY_COMMAND = words.join('\x1f');
    }
    return env;
}

/**
 * Connects to a host.
 *
 * options:
 *   host          what to give ssh: a name from ~/.ssh/config, user@host, ...
 *   product       from the editor's product.json: { version, release, commit, quality,
 *                 serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate }
 *   goshVersion   the gosh release to use at both ends
 *   storageDir    where this machine's gosh client is kept
 *   releases      where gosh releases are downloaded from [GitHub]
 *   sshPath       the ssh program [ssh]
 *   persistentTerminals   'shpool' to have the editor's terminals on the host outlive it; 'off' [off]
 *   shpoolDir     where the shpool programs that come with the extension are, for hosts without one
 *   relay         when UDP cannot reach the host, go through ssh instead: 'auto' (when
 *                 needed), 'always' (from the start, and no UDP) or 'never' [auto]
 *   relayCommand  for tests: (address, port, reported) => the words of the command that reaches a relay
 *   log           function taking a line of progress
 *   runner        for tests: replaces ssh
 *   shell         for tests: 'sh' or 'powershell', instead of asking the host which it has
 *   goshAddress   for tests: where to send the session's datagrams, if the remote can't say
 *
 * Returns { port, relayed, token, notes, dispose(), exited } where port is on
 * 127.0.0.1 of this machine, relayed says the session had to go through
 * ssh to connect, notes are things the user should be told,
 * and exited resolves if the gosh client stops.
 */
async function connect(options) {
    const log = options.log || (() => {});
    checkHost(options.host);
    const product = options.product;
    const releases = options.releases || DEFAULT_RELEASES;

    const client = await ensureLocalClient({ version: options.goshVersion, releases, storageDir: options.storageDir, log });
    const localPort = await freePort();

    const shell = options.shell || await probe(options.sshPath, options.host);
    const runner = options.runner || sshRunner(options.sshPath);
    log(`Setting up ${options.host}${shell === 'powershell' ? ' (Windows: experimental)' : ''}...`);

    // Persistent terminals need shpool on the host.  If it has none, give it the one we carry.
    if (options.persistentTerminals === 'shpool' && shell === 'sh') {
        const host = await runRemote(runner, options.host, shell, SHPOOL_PROBE, log);
        const ours = host.shpool === 'no' && bundledShpool(options.shpoolDir, host.platform || '');
        if (ours) {
            log(`${options.host}: installing shpool...`);
            const result = await runRemote(runner, options.host, shell, uploadScript(ours, 'shpool'), log);
            if (result.installed !== 'yes') {
                log(`${options.host}: the shpool that comes with this extension does not run there.`);
            }
        }
    }

    const reported = await runRemote(runner, options.host, shell, (shell === 'powershell' ? remotePowershell : remoteScript)({
        GOSH_VERSION: options.goshVersion,
        GOSH_RELEASES: releases,
        LOCAL_PORT: localPort,
        SERVER_VERSION: product.version,
        SERVER_RELEASE: product.release || '',
        SERVER_COMMIT: product.commit,
        SERVER_QUALITY: product.quality || 'stable',
        SERVER_APP_NAME: product.serverApplicationName || 'codium-server',
        SERVER_DATA_FOLDER: product.serverDataFolderName || '.vscodium-server',
        SERVER_URL_TEMPLATE: product.serverDownloadUrlTemplate || DEFAULT_SERVER_URL_TEMPLATE,
        PERSISTENT_TERMINALS: options.persistentTerminals || 'off',
        LAUNCHER_SCRIPT: fs.readFileSync(path.join(__dirname, 'terminal.sh'), 'utf8'),
    }), log);

    const address = reported.goshAddress || options.goshAddress;
    if (!address) {
        throw new Error(`${options.host} did not say what address it was reached at.`);
    }
    for (const needed of ['goshPort', 'goshKey', 'token', 'serverPort']) {
        if (!reported[needed]) {
            throw new Error(`${options.host} did not report its ${needed}.`);
        }
    }
    log(`${options.host} (${reported.platform}) has gosh ${reported.gosh} and the editor's server on port ${reported.serverPort}.`);

    // The other end of the session.  It needs no terminal, and says when the forward is up.
    // If UDP cannot reach the host the client goes through ssh instead, given the means.
    // The forward is the one worked out here, never the host's text: where this machine listens is
    // not the host's to choose (the review of 2026-11-16).
    const spec = forwardSpec(localPort, reported);
    if (!/^[0-9]{1,5}$/.test(String(reported.goshPort))) {
        throw new Error(`${options.host} reported ${JSON.stringify(reported.goshPort)} as its gosh port.`);
    }
    const relay = ['always', 'never'].includes(options.relay) ? options.relay : 'auto';
    const words = relay === 'never' ? null
        : options.relayCommand ? options.relayCommand(address, reported.goshPort, reported)
        : options.runner ? null // (a test standing in for ssh, with no stand-in for this)
        : relayCommand(options.sshPath, options.host, shell, reported, address);
    const env = clientEnvironment(process.env, reported.goshKey, relay, words);

    const child = spawn(client, ['-N', '-L', spec, address, reported.goshPort], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        windowsHide: true,
    });

    let said = '';
    let told = false; // that it went through ssh
    const exited = new Promise(resolve => child.on('close', code => resolve(code)));
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`gosh could not reach ${address} on UDP port ${reported.goshPort}`
                + (words ? ', nor through ssh. ' : '. ')
                + 'Is UDP allowed between this machine and the host? '
                + `(gosh uses ports 60000 to 61000 by default.) ${said.trim()}`));
        }, 45000);
        child.stderr.on('data', data => {
            said += data;
            if (!told && said.includes('through ssh')) {
                told = true;
                log(relay === 'always' ? 'Carrying the gosh session over ssh.'
                    : `No answer from ${address} by UDP: carrying the gosh session over ssh for now.`);
            }
            const outcome = clientOutcome(said);
            if (outcome === 'connected') {
                clearTimeout(timer);
                resolve();
            } else if (outcome === 'refused') {
                clearTimeout(timer);
                child.kill();
                reject(new Error(`gosh connected to ${options.host} but cannot forward the editor's port: ${said.trim()}`));
            }
        });
        child.on('error', error => {
            clearTimeout(timer);
            reject(new Error(`Could not start the gosh client: ${error.message}`));
        });
        exited.then(code => {
            clearTimeout(timer);
            reject(new Error(`The gosh client stopped (${code}) before connecting. ${said.trim()}`));
        });
    });
    log(`Connected: 127.0.0.1:${localPort} is forwarded to ${options.host} through gosh.`);

    return {
        port: localPort,
        relayed: told,
        token: reported.token,
        notes: [...platformNotes(shell), ...reported.notes],
        exited,
        dispose() {
            // Interrupting it ends the session cleanly, and the remote end of it with it.
            child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
        },
    };
}

module.exports = { connect, probe, sshRunner, runRemote, relayCommand, bundledShpool, remoteScript, remotePowershell, shellQuote, powershellQuote,
    cmdQuote, checkHost, clientOutcome, forwardSpec, clientEnvironment, platformNotes, freePort, DEFAULT_RELEASES, DEFAULT_SERVER_URL_TEMPLATE };
