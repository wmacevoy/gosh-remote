// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// End-to-end test of lib/connect.js, without an editor and without ssh.
//
// The "remote machine" is this one, with a throwaway home directory,
// reached by running the remote script in a local shell rather than
// over ssh.  Everything else is real: gosh is installed at both "ends"
// from a release, the editor's server is started, and a gosh session
// forwards a port to it.  (REQ1/EXT-1, REQ1/EXT-3, REQ1/EXT-4, REQ6/NAME-1)
//
//   GOSH_RELEASES=/path/to/releases GOSH_VERSION=0.2 \
//   SERVER_VERSION=1.143 SERVER_RELEASE=17232 node test/connect.test.js
//
// GOSH_RELEASES is a directory holding vVERSION/ with the release's files,
// or the URL releases are published at, to test against the real thing:
//   GOSH_RELEASES=https://github.com/wmacevoy/gosh/releases/download
// Or GOSH_BUILD, a gosh checkout with its programs built (tools/build.sh): a
// release is made here from its .build/bin and tools/install.sh, as gosh's
// release workflow lays one out, and nothing is downloaded for gosh.
//
// EDITOR_SERVER=standin puts a stand-in in place of the editor's real server
// (which is otherwise downloaded): it says what the real one says when it is
// listening, and answers /version.  So the editor's server itself is then not
// tested; everything around it is.

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
    assert.strictEqual(localPackage('1.0', 'linux', 'x64').archive, 'gosh-1.0-linux-x86_64.tar.gz');
    assert.strictEqual(localPackage('1.0', 'linux', 'arm64').archive, 'gosh-1.0-linux-aarch64.tar.gz');
    assert.strictEqual(localPackage('1.0', 'darwin', 'arm64').archive, 'gosh-1.0-macos-universal.tar.gz');
    assert.ok(localPackage('1.0', 'linux', 'x64').client.endsWith(path.join('bin', 'gosh-client')));
    assert.throws(() => localPackage('1.0', 'win32', 'x64'), /no gosh client package for win32 on x64 yet/);
    assert.throws(() => localPackage('1.0', 'sunos', 'x64'));
    const script = remoteScript({ A: 'x y', B: "q'q" });
    assert.ok(script.startsWith(`A='x y'\nB='q'\\''q'\n`));
    assert.strictEqual(powershellQuote("it's"), "'it''s'");
    const typed = remotePowershell({ A: "x'y" });
    assert.strictEqual(typed.split('\r\n').length, 3, 'one line to run, then exit');
    const decoded = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(typed)[1], 'base64').toString('utf8');
    assert.ok(decoded.startsWith("$A = 'x''y'\n") && decoded.includes('GOSHREMOTE'));
    const viaSsh = relayCommand('', 'me@host', 'sh', { goshPort: '60001' }, '10.0.0.5');
    assert.deepStrictEqual(viaSsh.slice(0, 5), ['ssh', '-T', '-o', 'BatchMode=yes', 'me@host']);
    assert.ok(viaSsh[5].startsWith("sh -c '") && viaSsh[5].includes('exec gosh-server relay 10.0.0.5 60001'));
    const win = (server) => relayCommand('C:\\ssh.exe', 'h', 'powershell', { goshPort: '60001', goshServer: server }, '::1');
    assert.strictEqual(win('C:\\g\\gosh-server.exe')[5], 'C:\\g\\gosh-server.exe relay ::1 60001');
    assert.strictEqual(win('C:\\a b\\gosh-server.exe')[5], '"C:\\a b\\gosh-server.exe" relay ::1 60001');
    assert.strictEqual(win('')  , null);
    assert.strictEqual(mirrorDirectory('/m', 'me@host', '/home/me/proj'), path.join('/m', 'me@host', 'home', 'me', 'proj'));
    assert.strictEqual(mirrorDirectory('/m', 'h', '/'), path.join('/m', 'h', 'root'));
    assert.strictEqual(mirrorDirectory('/m', 'a:b', '/x/../y'), path.join('/m', 'a_b', 'x', '_', 'y'));
    console.log('ok   unit tests');
}

/**
 * A folder on the host kept up to date in one on this machine, by a
 * gosh session of its own (lib/mirror.js).  The host already has gosh,
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
        goshVersion: options.goshVersion, releases: options.releases, storageDir: options.storageDir,
        runner: options.runner, shell: options.shell, goshAddress: options.goshAddress,
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
    const launcher = path.join(remoteHome, '.local', 'bin', 'remote-gosh-terminal');
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

/**
 * A gosh release in a directory, made from a gosh checkout's built programs, laid out as gosh's
 * release workflow lays one out: vVERSION/gosh-VERSION-OS-ARCH.tar.gz, SHA256SUMS and install.sh.
 */
function releaseFromBuild(gosh, version, where) {
    const { name } = localPackage(version);
    const out = path.join(where, `v${version}`);
    const stage = path.join(where, 'stage', name);
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    fs.mkdirSync(out, { recursive: true });
    for (const program of ['gosh-client', 'gosh-server']) {
        fs.copyFileSync(path.join(gosh, '.build', 'bin', program), path.join(stage, 'bin', program));
        fs.chmodSync(path.join(stage, 'bin', program), 0o755);
    }
    fs.symlinkSync('gosh-client', path.join(stage, 'bin', 'gosh'));
    fs.symlinkSync('gosh-client', path.join(stage, 'bin', 'gocp'));
    const archive = path.join(out, `${name}.tar.gz`);
    const tar = require('child_process').spawnSync('tar', ['-czf', archive, '-C', path.dirname(stage), name]);
    assert.strictEqual(tar.status, 0, String(tar.stderr));
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${digest}  ${name}.tar.gz\n`);
    const installer = fs.readFileSync(path.join(gosh, 'tools', 'install.sh'), 'utf8').replace('@VERSION@', version);
    fs.writeFileSync(path.join(out, 'install.sh'), installer);
    return where;
}

/**
 * A stand-in for the editor's server, as the tarball the host would download: it says what the
 * real one says once it is listening, answers /version, and has a node beside it (the host script
 * rewrites the server's settings with the node the server carries).
 */
function standInServer(where) {
    const top = path.join(where, 'server', 'standin');
    fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(top, 'bin', 'codium-server'), [
        '#!/bin/sh',
        'exec python3 -c \'',
        'import http.server, sys',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        body = b"standin\\n"',
        '        self.send_response(200 if self.path == "/version" else 404)',
        '        self.send_header("Content-Length", str(len(body)))',
        '        self.end_headers()',
        '        self.wfile.write(body)',
        '    def log_message(self, *a): pass',
        's = http.server.HTTPServer(("127.0.0.1", 0), H)',
        'print("Extension host agent listening on %d" % s.server_port, flush=True)',
        's.serve_forever()',
        '\'',
        '',
    ].join('\n'));
    fs.chmodSync(path.join(top, 'bin', 'codium-server'), 0o755);
    fs.writeFileSync(path.join(top, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    fs.chmodSync(path.join(top, 'node'), 0o755);
    const archive = path.join(where, 'server.tar.gz');
    const tar = require('child_process').spawnSync('tar', ['-czf', archive, '-C', path.dirname(top), 'standin']);
    assert.strictEqual(tar.status, 0, String(tar.stderr));
    return `file://${archive}`;
}

/** Stops, by process id, whatever is still running a program under dir: only what this test started there. */
function stopProgramsUnder(dir) {
    if (process.platform !== 'linux') {
        return;
    }
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        let exe;
        try {
            exe = fs.readlinkSync(`/proc/${pid}/exe`);
        } catch (error) {
            continue;
        }
        if (exe.startsWith(dir + path.sep)) {
            try { process.kill(Number(pid)); } catch (error) { /* gone already */ }
        }
    }
}

async function main() {
    unitTests();

    const windows = process.platform === 'win32';
    if (windows) {
        // gosh's releases have no Windows build yet (gosh's release workflow), so neither half runs here.
        console.log('skip end-to-end test (gosh has no Windows build yet)');
        return;
    }
    const goshVersion = process.env.GOSH_VERSION || '0.0.test';
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-gosh-test-'));
    let releases = process.env.GOSH_RELEASES;
    if (!releases && process.env.GOSH_BUILD) {
        releases = releaseFromBuild(path.resolve(process.env.GOSH_BUILD), goshVersion, path.join(scratch, 'releases'));
    }
    if (!releases) {
        console.log('skip end-to-end test (set GOSH_BUILD to a built gosh checkout, or GOSH_RELEASES to a directory of releases)');
        fs.rmSync(scratch, { recursive: true, force: true });
        return;
    }
    const serverUrl = process.env.EDITOR_SERVER === 'standin' ? standInServer(scratch) : undefined;

    const remoteHome = path.join(scratch, 'remote-home');
    fs.mkdirSync(remoteHome);
    const lines = [];
    const options = {
        host: 'pretend-host',
        goshVersion,
        releases: /^https?:/.test(releases) ? releases : `file://${path.resolve(releases)}`,
        storageDir: path.join(scratch, 'local-storage'),
        product: {
            version: process.env.SERVER_VERSION || '1.143',
            release: process.env.SERVER_RELEASE || '17232',
            commit: 'test-commit',
            quality: 'stable',
            ...(serverUrl ? { serverDownloadUrlTemplate: serverUrl } : {}),
        },
        log: line => { lines.push(line); console.log(`     | ${line}`); },
        // in place of ssh: a shell here, with another home (and a UTF-8 locale, as a login would have)
        shell: 'sh',
        runner: () => spawn('sh', [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            // (a bare PATH: whatever gosh or mosh this machine's user has installed is not the host's;
            // no Internet server is asked anything: GOSH_STUN=none)
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: remoteHome, LC_ALL: 'C.UTF-8', GOSH_STUN: 'none' },
        }),
        goshAddress: '127.0.0.1',
    };

    let first, second;
    try {
        // from nothing: both installs, a new server, a session
        first = await connect(options);
        assert.ok(fs.existsSync(path.join(options.storageDir, localPackage(goshVersion).client)), 'client installed locally');
        assert.ok(fs.existsSync(path.join(remoteHome, '.local', 'bin', 'gosh-server')), 'server installed remotely');
        assert.ok(lines.some(l => l.includes('installing gosh')) && lines.some(l => l.includes("installing the editor's server")));
        assert.ok(/^[0-9a-f]{32}$/.test(first.token), 'a connection token');
        console.log('ok   connects from nothing, installing gosh at both ends and the editor server');

        // the editor's server answers on the local port, through gosh
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
        assert.ok(windows || status === 0, 'the gosh client stops cleanly'); // (Windows can only kill it outright)
        await assert.rejects(get(first.port, '/version'));
        assert.strictEqual((await get(second.port, '/version')).status, 200);
        first = null;
        console.log('ok   closing a connection stops its gosh session and no other');

        // (Not on Windows.  There, with both ends on one machine and the relay started directly, the
        // relayed session's server ends within a tenth of a second of connecting, and why is not yet
        // known.  The fork's own tests of the relay passed on Windows.)
        if (!windows) {
            // UDP not getting through: the session is carried over a stream instead (ssh, in
            // real use; here the relay on the "host" is run directly), and found without being told
            const remoteServer = path.join(remoteHome, '.local', 'bin', 'gosh-server');
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
                reported.goshPort = String(nobody.address().port);
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
            process.kill(Number(pid));
        } catch (error) { /* it never started */ }
        // (and any gosh-server the test's sessions left: only programs under its own home, by pid,
        // never by name: other gosh and mosh sessions on this machine are not the test's)
        stopProgramsUnder(fs.realpathSync(scratch));
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main().then(() => console.log('all passed'), error => {
    console.error(`FAILED: ${error.stack || error}`);
    process.exit(1);
});
