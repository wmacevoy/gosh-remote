'use strict';

// End-to-end test of lib/connect.js, without an editor and without ssh.
//
// The "remote machine" is this one, with a throwaway home directory,
// reached by running the remote script in a local shell rather than
// over ssh.  Everything else is real: mosh is installed at both "ends"
// from a release, the editor's actual server is downloaded and started,
// and a mosh session forwards a port to it.
//
//   MOSH_RELEASES=/path/to/releases MOSH_VERSION=1.4.0-pf.2 \
//   SERVER_VERSION=1.143 SERVER_RELEASE=17232 node test/connect.test.js
//
// MOSH_RELEASES is a directory holding mosh-VERSION/ with the release's files,
// or the URL releases are published at, to test against the real thing:
//   MOSH_RELEASES=https://github.com/wmacevoy/mosh/releases/download

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { connect, relayCommand, shellQuote, powershellQuote, remoteScript, remotePowershell } = require('../lib/connect');
const { localPackage, ensureLocalClient } = require('../lib/install');
const { mirror, mirrorDirectory } = require('../lib/mirror');

function get(port, pathname) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 15000 }, response => {
            let body = '';
            response.on('data', data => (body += data));
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('timed out')));
    });
}

function unitTests() {
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
    assert.strictEqual(localPackage('1.0', 'linux', 'x64').archive, 'mosh-1.0-linux-x86_64.tar.gz');
    assert.strictEqual(localPackage('1.0', 'linux', 'arm64').archive, 'mosh-1.0-linux-aarch64.tar.gz');
    assert.strictEqual(localPackage('1.0', 'darwin', 'arm64').archive, 'mosh-1.0-macos-universal.tar.gz');
    assert.strictEqual(localPackage('1.0', 'win32', 'x64').archive, 'mosh-1.0-msys2.zip');
    assert.ok(localPackage('1.0', 'win32', 'x64').client.endsWith('mosh-client.exe'));
    assert.throws(() => localPackage('1.0', 'sunos', 'x64'));
    const script = remoteScript({ A: 'x y', B: "q'q" });
    assert.ok(script.startsWith(`A='x y'\nB='q'\\''q'\n`));
    assert.strictEqual(powershellQuote("it's"), "'it''s'");
    const typed = remotePowershell({ A: "x'y" });
    assert.strictEqual(typed.split('\r\n').length, 3, 'one line to run, then exit');
    const decoded = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(typed)[1], 'base64').toString('utf8');
    assert.ok(decoded.startsWith("$A = 'x''y'\n") && decoded.includes('MOSHREMOTE'));
    const viaSsh = relayCommand('', 'me@host', 'sh', { moshPort: '60001' }, '10.0.0.5');
    assert.deepStrictEqual(viaSsh.slice(0, 5), ['ssh', '-T', '-o', 'BatchMode=yes', 'me@host']);
    assert.ok(viaSsh[5].startsWith("sh -c '") && viaSsh[5].includes('exec mosh-server relay 10.0.0.5 60001'));
    const win = (server) => relayCommand('C:\\ssh.exe', 'h', 'powershell', { moshPort: '60001', moshServer: server }, '::1');
    assert.strictEqual(win('C:\\m\\mosh-server.exe')[5], 'C:\\m\\mosh-server.exe relay ::1 60001');
    assert.strictEqual(win('C:\\a b\\mosh-server.exe')[5], '"C:\\a b\\mosh-server.exe" relay ::1 60001');
    assert.strictEqual(win('')  , null);
    assert.strictEqual(mirrorDirectory('/m', 'me@host', '/home/me/proj'), path.join('/m', 'me@host', 'home', 'me', 'proj'));
    assert.strictEqual(mirrorDirectory('/m', 'h', '/'), path.join('/m', 'h', 'root'));
    assert.strictEqual(mirrorDirectory('/m', 'a:b', '/x/../y'), path.join('/m', 'a_b', 'x', '_', 'y'));
    console.log('ok   unit tests');
}

/**
 * A folder on the host kept up to date in one on this machine, by a
 * mosh session of its own (lib/mirror.js).  The host already has mosh,
 * from connecting.
 */
async function keepsLocalCopies(options, remoteHome, scratch) {
    const there = path.join(remoteHome, 'project');
    const here = path.join(scratch, 'copies', 'project');
    fs.mkdirSync(path.join(there, 'out'), { recursive: true });
    fs.writeFileSync(path.join(there, 'README.md'), 'one\n');
    fs.writeFileSync(path.join(there, 'out', 'result.bin'), Buffer.alloc(300000, 7));
    const read = name => { try { return fs.readFileSync(path.join(here, name), 'utf8'); } catch (error) { return null; } };
    const until = async (what, said) => {
        for (let i = 0; i < 150 && !what(); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(what(), said);
    };

    const lines = [];
    const copying = await mirror({
        host: options.host, remotePath: there, localDir: here, remove: true, interval: 0.3,
        moshVersion: options.moshVersion, releases: options.releases, storageDir: options.storageDir,
        runner: options.runner, shell: options.shell, moshAddress: options.moshAddress,
        log: line => lines.push(line),
    });
    try {
        await until(() => read('README.md') === 'one\n' && fs.existsSync(path.join(here, 'out', 'result.bin')), 'the folder arrives');
        assert.strictEqual(fs.statSync(path.join(here, 'out', 'result.bin')).size, 300000);
        fs.writeFileSync(path.join(there, 'README.md'), 'two, and longer\n');
        fs.writeFileSync(path.join(there, 'new.txt'), 'new\n');
        fs.unlinkSync(path.join(there, 'out', 'result.bin'));
        await until(() => read('README.md') === 'two, and longer\n' && read('new.txt') === 'new\n'
            && !fs.existsSync(path.join(here, 'out', 'result.bin')), 'and then what changes, appears and goes');
        assert.ok(lines.some(l => l.includes('README.md')), 'and says what it copied');
    } finally {
        copying.dispose();
        await copying.exited;
    }
    await assert.rejects(mirror({ ...options, remotePath: path.join(remoteHome, 'no-such'), localDir: here, log: () => {} }),
        /no folder/);
    console.log('ok   keeps a local copy of a folder on the host up to date');
}

/**
 * The opt-in setting that has the editor's terminals attach to shpool
 * sessions.  shpool itself is played by a stand-in that says what it is
 * told to and records what it is asked, so this tests our side of the
 * arrangement, not shpool.
 */
async function persistentTerminals(options, remoteHome) {
    const settingsFile = path.join(remoteHome, '.vscodium-server', 'data', 'Machine', 'settings.json');
    const launcher = path.join(remoteHome, '.local', 'bin', 'remote-mosh-terminal');
    const standIn = path.join(remoteHome, '.local', 'bin', 'shpool');
    const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const reconnect = async extra => {
        const connection = await connect({ ...options, ...extra });
        connection.dispose();
        await connection.exited;
        return connection;
    };

    // asked for, but shpool is not on the host: say so, and leave terminals alone
    let connection = await reconnect({ persistentTerminals: 'shpool' });
    assert.ok(connection.notes.some(note => note.includes('shpool is not on the host')), 'a note that shpool is missing');
    assert.ok(!fs.existsSync(settingsFile) || !('terminal.integrated.defaultProfile.linux' in readSettings()));
    console.log('ok   persistent terminals: says so when the host has no shpool');

    // the extension carries a shpool for hosts like this one: it is put there
    const bundle = path.join(remoteHome, '..', 'bundled-shpool');
    const kind = process.platform === 'darwin' ? 'darwin' : `linux-${process.arch}`;
    fs.mkdirSync(path.join(bundle, kind), { recursive: true });
    fs.writeFileSync(path.join(bundle, kind, 'shpool'), [
        '#!/bin/sh',
        '# a stand-in for shpool, padded so that sending it takes more than a line or two',
        `# ${'x'.repeat(4000)}`,
        'case "$1" in',
        '  list) cat "$HOME/shpool-sessions" 2>/dev/null ;;',
        '  attach) shift; printf "%s\\n" "$*" >>"$HOME/shpool-attached" ;;',
        'esac',
        '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ 'editor.fontSize': 15 }));
    connection = await reconnect({ persistentTerminals: 'shpool', shpoolDir: bundle });
    assert.deepStrictEqual(connection.notes, []);
    assert.strictEqual(fs.readFileSync(standIn, 'utf8'), fs.readFileSync(path.join(bundle, kind, 'shpool'), 'utf8'), 'copied exactly');
    fs.accessSync(standIn, fs.constants.X_OK);
    console.log('ok   persistent terminals: installs the shpool it carries on a host without one');
    const key = process.platform === 'darwin' ? 'osx' : 'linux';
    let settings = readSettings();
    assert.strictEqual(settings['editor.fontSize'], 15, "the user's own settings are kept");
    assert.strictEqual(settings[`terminal.integrated.defaultProfile.${key}`], 'shpool (persistent)');
    assert.strictEqual(settings[`terminal.integrated.profiles.${key}`]['shpool (persistent)'].path, launcher);
    fs.accessSync(launcher, fs.constants.X_OK);
    console.log('ok   persistent terminals: the host editor is set to start terminals through shpool');

    // the launcher: a session named after the workspace, the first that no terminal has
    fs.mkdirSync(path.join(remoteHome, 'my project'));
    // (as the shell will see it: on macOS the temporary directory is behind a symbolic link)
    const workspace = fs.realpathSync(path.join(remoteHome, 'my project'));
    const launch = () => {
        const result = require('child_process').spawnSync('sh', [launcher], {
            cwd: workspace, encoding: 'utf8',
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: remoteHome, XDG_RUNTIME_DIR: path.join(remoteHome, 'run') },
        });
        assert.strictEqual(result.status, 0, result.stderr);
        return fs.readFileSync(path.join(remoteHome, 'shpool-attached'), 'utf8').trim().split('\n').pop();
    };
    fs.mkdirSync(path.join(remoteHome, 'run'));
    fs.writeFileSync(path.join(remoteHome, 'shpool-sessions'),
        'NAME\tSTARTED_AT\tSTATUS\neditor-my_project-1\t2026-01-01T00:00:00+00:00\tattached\n'
        + 'editor-my_project-2\t2026-01-01T00:00:00+00:00\tdisconnected\nother-1\t2026-01-01T00:00:00+00:00\tattached\n');
    assert.strictEqual(launch(), `--dir ${workspace} editor-my_project-2`, 'takes the session a terminal left');
    assert.strictEqual(launch(), `--dir ${workspace} editor-my_project-3`, 'and does not hand the same one to two terminals at once');
    console.log('ok   persistent terminals: each terminal gets its own session, reusing ones left behind');

    // turned off again: our entries go, and nothing else
    await reconnect({ persistentTerminals: 'off' });
    settings = readSettings();
    assert.deepStrictEqual(settings, { 'editor.fontSize': 15 });
    console.log('ok   persistent terminals: turning it off puts the settings back');

    // settings we cannot safely rewrite (they have comments in) are left exactly as they are
    const commented = '{\n    // mine\n    "editor.fontSize": 15\n}\n';
    fs.writeFileSync(settingsFile, commented);
    connection = await reconnect({ persistentTerminals: 'shpool' });
    assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), commented);
    assert.ok(connection.notes.some(note => note.includes('could not be rewritten')));
    console.log('ok   persistent terminals: leaves settings it cannot parse untouched, and says so');
    fs.rmSync(standIn);

    // the real thing, if it has been built here (pixi run shpool): it arrives whole and runs
    const real = path.join(__dirname, '..', 'shpool');
    if (fs.existsSync(path.join(real, kind, 'shpool'))) {
        fs.writeFileSync(settingsFile, '{}');
        connection = await reconnect({ persistentTerminals: 'shpool', shpoolDir: real });
        assert.deepStrictEqual(connection.notes, []);
        assert.ok(fs.readFileSync(standIn).equals(fs.readFileSync(path.join(real, kind, 'shpool'))), 'copied exactly');
        const said = require('child_process').spawnSync(standIn, ['version'], { encoding: 'utf8' });
        assert.strictEqual(said.status, 0);
        console.log(`ok   persistent terminals: installs the real ${said.stdout.trim()} it carries`);
    } else {
        console.log('skip installing the real shpool (none built here; pixi run shpool builds one)');
    }
}

async function main() {
    unitTests();

    const releases = process.env.MOSH_RELEASES;
    if (!releases) {
        console.log('skip end-to-end test (set MOSH_RELEASES to a directory of mosh releases to run it)');
        return;
    }
    const moshVersion = process.env.MOSH_VERSION || '1.4.0-pf.2';

    const windows = process.platform === 'win32';
    if (windows && !(Number(/-pf\.(\d+)/.exec(moshVersion)?.[1]) >= 2)) {
        // Before 1.4.0-pf.2 there was no mosh server for Windows, so a Windows
        // machine could not be the host; only its half as the editor's machine is tested.
        const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mosh-test-'));
        try {
            const client = await ensureLocalClient({
                version: moshVersion,
                releases: /^https?:/.test(releases) ? releases : path.resolve(releases),
                storageDir,
                log: line => console.log(`     | ${line}`),
            });
            assert.ok(fs.existsSync(client));
            console.log('ok   installs a mosh client that runs on Windows');
            console.log(`skip the connection test (mosh ${moshVersion} has no server for Windows)`);
        } finally {
            fs.rmSync(storageDir, { recursive: true, force: true });
        }
        return;
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mosh-test-'));
    const remoteHome = path.join(scratch, 'remote-home');
    fs.mkdirSync(remoteHome);
    const lines = [];
    const options = {
        host: 'pretend-host',
        moshVersion,
        releases: /^https?:/.test(releases) ? releases : `file://${path.resolve(releases)}`,
        storageDir: path.join(scratch, 'local-storage'),
        product: {
            version: process.env.SERVER_VERSION || '1.143',
            release: process.env.SERVER_RELEASE || '17232',
            commit: 'test-commit',
            quality: 'stable',
        },
        log: line => { lines.push(line); console.log(`     | ${line}`); },
        // in place of ssh: a shell here, with another home (and a UTF-8 locale, as a login would have)
        shell: windows ? 'powershell' : 'sh',
        runner: (host, shell) => (shell === 'powershell'
            ? spawn('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                // (without PSModulePath: one inherited from a newer PowerShell stops this one finding its own commands)
                env: { ...process.env, PSModulePath: undefined, USERPROFILE: remoteHome,
                    HOMEDRIVE: path.parse(remoteHome).root.slice(0, 2), HOMEPATH: remoteHome.slice(2),
                    LOCALAPPDATA: path.join(remoteHome, 'AppData', 'Local') },
            })
            : spawn('sh', [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                // (a bare PATH: whatever mosh this machine's user has installed is not the host's)
                env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: remoteHome, LC_ALL: 'C.UTF-8' },
            })),
        moshAddress: '127.0.0.1',
    };

    let first, second;
    try {
        // from nothing: both installs, a new server, a session
        first = await connect(options);
        assert.ok(fs.existsSync(path.join(options.storageDir, localPackage(moshVersion).client)), 'client installed locally');
        assert.ok(fs.existsSync(windows
            ? path.join(remoteHome, 'AppData', 'Local', 'remote-mosh', `mosh-${moshVersion}-msys2`, 'mosh-server.exe')
            : path.join(remoteHome, '.local', 'bin', 'mosh-server')), 'server installed remotely');
        assert.ok(lines.some(l => l.includes('installing mosh')) && lines.some(l => l.includes("installing the editor's server")));
        assert.ok(/^[0-9a-f]{32}$/.test(first.token), 'a connection token');
        console.log('ok   connects from nothing, installing mosh at both ends and the editor server');

        // the editor's server answers on the local port, through mosh
        const version = await get(first.port, '/version');
        assert.strictEqual(version.status, 200);
        assert.ok(version.body.trim().length > 0);
        console.log(`ok   the editor's server answers through the forward (it says "${version.body.trim().slice(0, 40)}")`);

        // again: nothing to install, the running server is used, a second session beside the first
        lines.length = 0;
        second = await connect(options);
        assert.ok(!lines.some(l => l.includes('installing')), 'nothing installed the second time');
        assert.ok(!lines.some(l => l.includes('starting')), 'the running server was reused');
        assert.strictEqual(second.token, first.token);
        assert.notStrictEqual(second.port, first.port);
        assert.strictEqual((await get(second.port, '/version')).status, 200);
        console.log('ok   connects again, reusing what is installed and running');

        // closing one leaves the other
        first.dispose();
        const status = await first.exited;
        assert.ok(windows || status === 0, 'the mosh client stops cleanly'); // (Windows can only kill it outright)
        await assert.rejects(get(first.port, '/version'));
        assert.strictEqual((await get(second.port, '/version')).status, 200);
        first = null;
        console.log('ok   closing a connection stops its mosh session and no other');

        // (Not on Windows.  There, with both ends on one machine and the relay started directly, the
        // relayed session's server ends within a tenth of a second of connecting, and why is not yet
        // known.  mosh's own tests of the relay pass on Windows; see the README.)
        if (!windows) {
            // UDP not getting through: the session is carried over a stream instead (ssh, in
            // real use; here the relay on the "host" is run directly), and found without being told
            const remoteServer = path.join(remoteHome, '.local', 'bin', 'mosh-server');
            const relayCommand = (address, port) => [remoteServer, 'relay', address, port];
            assert.strictEqual(second.relayed, false, 'UDP was enough until now');
            let relayed = await connect({ ...options, relay: 'always', relayCommand });
            try {
                assert.strictEqual(relayed.relayed, true);
                assert.strictEqual((await get(relayed.port, '/version')).status, 200);
            } finally {
                relayed.dispose();
                await relayed.exited;
            }
            console.log('ok   connects with the session carried by the relay and no UDP');

            // (a port on this machine where nothing answers stands for a network that drops UDP)
            const dgram = require('dgram');
            const nobody = dgram.createSocket('udp4');
            await new Promise(resolve => nobody.bind(0, '127.0.0.1', resolve));
            lines.length = 0;
            relayed = await connect({ ...options, relayCommand: (address, port, reported) => {
                const words = relayCommand(address, port);
                reported.moshPort = String(nobody.address().port);
                return words;
            } });
            try {
                assert.strictEqual(relayed.relayed, true);
                assert.ok(lines.some(l => l.includes('No answer') && l.includes('over ssh')), 'and says so');
                assert.strictEqual((await get(relayed.port, '/version')).status, 200);
            } finally {
                relayed.dispose();
                await relayed.exited;
                nobody.close();
            }
            console.log('ok   finds its own way to the relay when UDP gets no answer');
        }

        if (!windows) {
            await keepsLocalCopies(options, remoteHome, scratch);
        }

        if (!windows) {
            await persistentTerminals(options, remoteHome);
        }
    } finally {
        for (const connection of [first, second]) {
            if (connection) {
                connection.dispose();
                await connection.exited;
            }
        }
        try {
            const pid = fs.readFileSync(path.join(remoteHome, '.vscodium-server', '.test-commit.pid'), 'utf8').trim();
            if (windows) {
                require('child_process').spawnSync('taskkill', ['/F', '/T', '/PID', pid]);
                require('child_process').spawnSync('taskkill', ['/F', '/IM', 'mosh-server.exe']);
            } else {
                process.kill(Number(pid));
            }
        } catch (error) { /* it never started */ }
        try {
            fs.rmSync(scratch, { recursive: true, force: true });
        } catch (error) { /* Windows will not delete what is still open; the runner is thrown away anyway */ }
    }
}

main().then(() => console.log('all passed'), error => {
    console.error(`FAILED: ${error.stack || error}`);
    process.exit(1);
});
