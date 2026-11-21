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
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { connect, relayCommand, shellQuote, powershellQuote, remoteScript, remotePowershell, checkHost, probe, sshRunner, runRemote,
    clientOutcome, forwardSpec, clientEnvironment, cmdQuote, platformNotes, bundledShpool,
    reconnect, editorAnswers, lineSplitter, freePort } = require('../lib/connect');
const { localPackage, ensureLocalClient, allowedUrl, fetchReleaseFile } = require('../lib/install');
const { mirror, mirrorDirectory } = require('../lib/mirror');
const pool = require('../lib/sessions');

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
    assert.deepStrictEqual(viaSsh.slice(0, 6), ['ssh', '-T', '-o', 'BatchMode=yes', '--', 'me@host']);
    assert.ok(viaSsh[6].startsWith("sh -c '") && viaSsh[6].includes('exec gosh-server relay 10.0.0.5 60001'));
    const win = (server) => relayCommand('C:\\ssh.exe', 'h', 'powershell', { goshPort: '60001', goshServer: server }, '::1');
    assert.strictEqual(win('C:\\g\\gosh-server.exe')[6], 'C:\\g\\gosh-server.exe relay ::1 60001');
    assert.strictEqual(win('C:\\a b\\gosh-server.exe')[6], '"C:\\a b\\gosh-server.exe" relay ::1 60001');
    assert.strictEqual(win('')  , null);
    assert.strictEqual(mirrorDirectory('/m', 'me@host', '/home/me/proj'), path.join('/m', 'me@host', 'home', 'me', 'proj'));
    assert.strictEqual(mirrorDirectory('/m', 'h', '/'), path.join('/m', 'h', 'root'));
    assert.strictEqual(mirrorDirectory('/m', 'a:b', '/x/../y'), path.join('/m', 'a_b', 'x', '_', 'y'));
    // the shpool carried for each kind of host: the static Linux ones serve Alpine too
    const carried = fs.mkdtempSync(path.join(os.tmpdir(), 'gosh-remote-carried-'));
    for (const kind of ['linux-x64', 'linux-arm64', 'darwin']) {
        fs.mkdirSync(path.join(carried, kind));
        fs.writeFileSync(path.join(carried, kind, 'shpool'), kind);
    }
    assert.strictEqual(bundledShpool(carried, 'linux-x64'), path.join(carried, 'linux-x64', 'shpool'));
    assert.strictEqual(bundledShpool(carried, 'alpine-x64'), path.join(carried, 'linux-x64', 'shpool'));
    assert.strictEqual(bundledShpool(carried, 'alpine-arm64'), path.join(carried, 'linux-arm64', 'shpool'));
    assert.strictEqual(bundledShpool(carried, 'darwin-arm64'), path.join(carried, 'darwin', 'shpool'));
    assert.strictEqual(bundledShpool(carried, 'linux-other'), null);
    assert.strictEqual(bundledShpool(null, 'linux-x64'), null);
    fs.rmSync(carried, { recursive: true, force: true });
    // pool terminals (gosh-remote #3): names, the script's settings, which session a terminal is in
    for (const good of ['editor-gosh-1', 'claude.review', 'a', 'x_y:z@h+1=2']) {
        assert.strictEqual(pool.checkSessionName(good), good);
    }
    for (const bad of ['', '-f', '.x', 'two words', 'a\nb', "it's", 'a/b', '$(x)', 'x'.repeat(65), 7, undefined]) {
        assert.throws(() => pool.checkSessionName(bad), /is not a session name/, String(bad));
    }
    const renaming = pool.sessionsScript('rename', 'editor-w-1', 'claude.review');
    assert.ok(renaming.startsWith("ACTION='rename'\nNAME='editor-w-1'\nNEW_NAME='claude.review'\n"));
    assert.ok(renaming.includes('shpool rename "$NAME" "$NEW_NAME"'));
    assert.throws(() => pool.sessionsScript('rename', 'a', '-x'), /is not a session name/);
    assert.throws(() => pool.sessionsScript('detach', "x'; rm -rf ~; '"), /is not a session name/);
    assert.throws(() => pool.sessionsScript('kill', 'a'), /no such action/);
    const listed = pool.parseList({
        home: '/home/me', launcher: 'yes', rename: 'yes', processes: '400 300,401 1,500 7,',
        sessions: Buffer.from(JSON.stringify({ sessions: [
            { name: 'editor-w-1', id: 1, status: 'Attached', started_at_unix_ms: 1000, attachments: [{ pid: 400 }] },
            { name: 'editor-w-2', id: 2, status: 'Disconnected', attachments: [] },
            { name: 'held', id: 3, status: 'Attached', attachments: [{ pid: 999 }] }, // its client not in ps
            { id: 4 }, // no name: left out
        ] })).toString('base64'),
    });
    assert.deepStrictEqual(listed.sessions.map(s => [s.name, s.attached, s.terminals]),
        [['editor-w-1', true, [300]], ['editor-w-2', false, []], ['held', true, []]]);
    assert.ok(listed.launcher && listed.rename && listed.home === '/home/me');
    assert.strictEqual(pool.sessionOfTerminal(listed, 300).name, 'editor-w-1');
    assert.strictEqual(pool.sessionOfTerminal(listed, 301), undefined);
    assert.strictEqual(pool.sessionOfTerminal(listed, undefined), undefined);
    assert.deepStrictEqual(pool.parseList({ sessions: Buffer.from('{"sessions":[]}').toString('base64') }).sessions, []);
    assert.throws(() => pool.parseList({ launcher: 'no' }), /could not be read/, 'no list reported is an error, not "no sessions"');
    assert.throws(() => pool.parseList({ sessions: Buffer.from('{not json').toString('base64') }), /could not be read/);
    assert.deepStrictEqual(pool.attachTerminal(listed, 'held', true),
        { shellPath: '/home/me/.local/bin/gosh-remote-terminal', shellArgs: ['--attach', 'held', '--force'] });
    assert.deepStrictEqual(pool.attachTerminal(listed, 'new', false).shellArgs, ['--attach', 'new']);
    assert.throws(() => pool.attachTerminal({ ...listed, home: 'relative' }, 'x'), /home directory/);
    console.log('ok   unit tests');
}

/**
 * REQ1/EXT-1: when the editor asks again for a host, a gosh session that still carries the forward
 * is kept, and one that does not is ended only once a new one is up.  (Found 2026-11-20: a lid
 * closed, the editor asked again, the live session was ended first, and the ssh setup that was to
 * replace it was cut off by sleep, leaving nothing.)
 */
async function reconnectTests() {
    const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const answering = http.createServer((request, response) => {
        response.writeHead(request.url === '/version' ? 200 : 404);
        response.end('commit');
    });
    const silent = net.createServer(() => {}); // takes the connection and says nothing, as a forward whose session is down
    const answerPort = await listen(answering);
    const silentPort = await listen(silent);
    const closedPort = await freePort();
    try {
        assert.strictEqual(await editorAnswers(answerPort, 2000), true);
        assert.strictEqual(await editorAnswers(silentPort, 300), false, 'silence until the wait is a no');
        assert.strictEqual(await editorAnswers(closedPort, 2000), false, 'a refused connection is a no');

        const made = [];
        const stub = port => ({ port, disposed: false, dispose() { this.disposed = true; } });
        const setUp = () => { const c = stub(9); made.push(c); return Promise.resolve(c); };

        // still carrying the forward: kept, and nothing set up
        const live = stub(answerPort);
        let result = await reconnect(live, setUp, { wait: 2000 });
        assert.ok(result.reused && result.connection === live && !live.disposed && made.length === 0);

        // not answering: a new one, and only then the old one ended
        const dead = stub(silentPort);
        result = await reconnect(dead, setUp, { wait: 300 });
        assert.ok(!result.reused && result.connection === made[0] && dead.disposed);

        // not answering, and the setup fails: the old one is left for the next ask
        const asleep = stub(silentPort);
        const refused = () => Promise.reject(new Error('Connection closed by host port 22'));
        await assert.rejects(reconnect(asleep, refused, { wait: 300 }), /Connection closed/);
        assert.ok(!asleep.disposed, 'a failed setup ends nothing');

        // the first time: no previous, set up
        result = await reconnect(undefined, setUp, { wait: 300 });
        assert.ok(!result.reused && result.connection === made[1]);
    } finally {
        answering.close();
        silent.close();
    }

    // what the gosh client says once connected arrives in pieces, and is passed on whole lines
    const said = [];
    const split = lineSplitter(line => said.push(line));
    split.push('gosh: last contact 12');
    split.push(' seconds ago\r\n\ngosh: re');
    split.push('connected\n');
    split.push('gosh: stopping');
    assert.deepStrictEqual(said, ['gosh: last contact 12 seconds ago', 'gosh: reconnected']);
    split.flush();
    assert.deepStrictEqual(said.slice(2), ['gosh: stopping']);
    console.log('ok   a reconnect keeps a live session, and ends a dead one only once replaced (REQ1/EXT-1)');
}

/** The review of 2026-11-16 (gosh's queue, item 11): each thing it found, held to account. */
async function reviewTests(scratch) {
    // 1. A host that would be an ssh option, or that no host name could be, is refused before ssh is run;
    //    and ssh is always told where its options end.
    const logged = path.join(scratch, 'ssh.log');
    const fakeSsh = path.join(scratch, 'fake-ssh');
    fs.writeFileSync(fakeSsh, `#!/bin/sh\nfor w in "$@"; do printf '[%s] ' "$w"; done >>'${logged}'\necho >>'${logged}'\necho Linux\n`);
    fs.chmodSync(fakeSsh, 0o755);
    for (const bad of ['-oProxyCommand=touch /tmp/owned', 'a host', 'a\nb', 'a/b', '', 'a\x07b']) {
        assert.throws(() => checkHost(bad), /is not a host name/, JSON.stringify(bad));
        await assert.rejects(probe(fakeSsh, bad), /is not a host name/);
        await assert.rejects(connect({ host: bad, product: {}, log: () => {} }), /is not a host name/);
        await assert.rejects(mirror({ host: bad, remotePath: '/x', localDir: path.join(scratch, 'm') }), /is not a host name/);
    }
    assert.ok(!fs.existsSync(logged), 'ssh was never run for them');
    for (const good of ['me@host', 'host.example.org', 'me@[2001:db8::1]', 'pretend-host', 'h_1:22']) {
        assert.strictEqual(checkHost(good), good);
    }
    assert.strictEqual(await probe(fakeSsh, 'me@host'), 'sh');
    sshRunner(fakeSsh)('me@host', 'sh').stdin.end();
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const line of fs.readFileSync(logged, 'utf8').trim().split('\n')) {
        assert.ok(line.includes('[--] [me@host]'), `ssh is told where its options end: ${line}`);
    }
    assert.ok(relayCommand('', 'me@host', 'sh', { goshPort: '60001' }, '10.0.0.5').join(' ').includes('-- me@host'));
    console.log('ok   review: a host that would be an ssh option is refused, and ssh is told where its options end');

    // 3. Connected means gosh's own line; "connected, but the server does not forward" is a failure.
    assert.strictEqual(clientOutcome('gosh: connected; forwarding.\n'), 'connected');
    assert.strictEqual(clientOutcome('gosh: connected, but the server does not forward: it is a stock mosh-server, or was not given\n'
        + 'the forwards.  None of them will be done.\n'), 'refused');
    assert.strictEqual(clientOutcome('gosh: connected.\n'), 'refused', 'connected, with no forward: of no use to the editor');
    assert.strictEqual(clientOutcome('gosh: no answer by UDP; trying through ssh as well.\n'), null);
    console.log('ok   review: only "gosh: connected; forwarding." is connected');

    // 4. The forward the client is given is the one computed here; the host's port is only a number.
    assert.strictEqual(forwardSpec(41000, { serverPort: '9', spec: '0.0.0.0:46011:127.0.0.1:9' }), '41000:127.0.0.1:9');
    for (const port of ['0', '65536', '9 -R x', '-1', '1e3', '']) {
        assert.throws(() => forwardSpec(41000, { serverPort: port }), /port/);
    }
    console.log('ok   review: the forward is ours, never the host\'s text');

    // 9. What the host may say is limited to what is asked of it; notes are only a list.
    const said = (lines) => () => {
        const child = spawn('sh', ['-c', `printf '%s\\n' ${lines.map(shellQuote).join(' ')}; cat >/dev/null`], { stdio: ['pipe', 'pipe', 'pipe'] });
        return child;
    };
    const got = await runRemote(said(['GOSHREMOTE notes==x==', 'GOSHREMOTE note==one==', 'GOSHREMOTE notAKey==y==',
        'GOSHREMOTE constructor==z==', 'GOSHREMOTE done==yes==']), 'h', 'sh', '', () => {});
    assert.deepStrictEqual(got.notes, ['one']);
    assert.ok(!Object.prototype.hasOwnProperty.call(got, 'notAKey') && !Object.prototype.hasOwnProperty.call(got, 'constructor'));
    console.log('ok   review: the host may report only what it is asked, and notes are a list');

    // 5. The client's environment never keeps a relay command that is not this connection's.
    const env = clientEnvironment({ GOSH_RELAY_COMMAND: 'stale', PATH: '/bin' }, 'KEY', 'auto', null);
    assert.ok(!('GOSH_RELAY_COMMAND' in env) && env.GOSH_RELAY === 'never' && env.MOSH_KEY === 'KEY' && env.PATH === '/bin');
    assert.strictEqual(clientEnvironment({}, 'K', 'always', ['a', 'b']).GOSH_RELAY_COMMAND, 'a\x1fb');
    console.log('ok   review: a stale relay command is not passed on');

    // 9. Quoting for PowerShell (typographic quotes end its strings too) and for cmd (& and the like).
    assert.strictEqual(powershellQuote('a\u2019b\u2018c\u201ad\u201be'), "'a\u2019\u2019b\u2018\u2018c\u201a\u201ad\u201b\u201be'");
    assert.strictEqual(cmdQuote('C:\\a&b\\gosh-server.exe'), '"C:\\a&b\\gosh-server.exe"');
    assert.strictEqual(cmdQuote('C:\\g\\gosh-server.exe'), 'C:\\g\\gosh-server.exe');
    assert.throws(() => cmdQuote('C:\\a"b\\x.exe'), /cannot/);
    console.log('ok   review: quoting for PowerShell and cmd');

    // 7. A Windows host is said to be experimental (REQ4/EXT-2).
    assert.ok(platformNotes('powershell').some(n => /experimental/i.test(n)));
    assert.deepStrictEqual(platformNotes('sh'), []);
    console.log('ok   review: a Windows host is labelled experimental when connected to');

    // 6. A host name cannot put a local copy outside its folder; 5. nor can a folder name with control characters.
    for (const host of ['a/../../../escaped', '..', '../x', 'a/b']) {
        const where = mirrorDirectory('/root/copies', host, '/p');
        assert.ok(path.relative('/root/copies', where).split(path.sep)[0] !== '..' && where.startsWith('/root/copies/'), `${host} -> ${where}`);
    }
    await assert.rejects(mirror({ host: 'h', remotePath: '/a\x07b', localDir: path.join(scratch, 'm') }), /control characters/);
    await assert.rejects(mirror({ host: 'h', remotePath: '/a', localDir: path.join(scratch, 'm\x01') }), /control characters/);
    console.log('ok   review: a local copy stays in its folder; control characters are refused');

    // 2. Downloads are by https only, and checked; 8. a client is the release it says it is.
    assert.ok(allowedUrl('https://github.com/x') && !allowedUrl('http://github.com/x') && !allowedUrl('ftp://x'));
    await assert.rejects(fetchReleaseFile('http://example.invalid/r', '1.0', 'SHA256SUMS', path.join(scratch, 'x')), /https/);
    const fake = version => {
        const where = fs.mkdtempSync(path.join(scratch, 'fake-release-'));
        const { name } = localPackage('1.0');
        fs.mkdirSync(path.join(where, 'stage', name, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(where, 'stage', name, 'bin', 'gosh-client'),
            `#!/bin/sh\necho 'gosh-client, of gosh ${version}'\necho 'mosh-client (mosh 1.4.0)'\n`);
        fs.chmodSync(path.join(where, 'stage', name, 'bin', 'gosh-client'), 0o755);
        fs.mkdirSync(path.join(where, 'v1.0'));
        const archive = path.join(where, 'v1.0', `${name}.tar.gz`);
        assert.strictEqual(require('child_process').spawnSync('tar', ['-czf', archive, '-C', path.join(where, 'stage'), name]).status, 0);
        const digest = require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
        return { where, archive, name, digest };
    };
    let r = fake('v1.0');
    fs.writeFileSync(path.join(r.where, 'v1.0', 'SHA256SUMS'), `${r.digest}  ${r.name}.tar.gz\n`);
    assert.ok((await ensureLocalClient({ version: '1.0', releases: r.where, storageDir: path.join(r.where, 's') })).endsWith('gosh-client'));
    r = fake('v1.0');
    fs.writeFileSync(path.join(r.where, 'v1.0', 'SHA256SUMS'), `${r.digest}  something-else.tar.gz\n`);
    await assert.rejects(ensureLocalClient({ version: '1.0', releases: r.where, storageDir: path.join(r.where, 's') }), /not listed/);
    r = fake('v1.0');
    fs.writeFileSync(path.join(r.where, 'v1.0', 'SHA256SUMS'), `${'0'.repeat(64)}  ${r.name}.tar.gz\n`);
    await assert.rejects(ensureLocalClient({ version: '1.0', releases: r.where, storageDir: path.join(r.where, 's') }), /does not match/);
    assert.ok(!fs.existsSync(path.join(r.where, 's', r.name)), 'nothing unpacked from a download that does not match');
    r = fake('v0.9');
    fs.writeFileSync(path.join(r.where, 'v1.0', 'SHA256SUMS'), `${r.digest}  ${r.name}.tar.gz\n`);
    await assert.rejects(ensureLocalClient({ version: '1.0', releases: r.where, storageDir: path.join(r.where, 's') }), /does not run|not gosh 1.0/);
    console.log('ok   review: releases by https only, checked, and the client is the release it says it is');
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
    const launcher = path.join(remoteHome, '.local', 'bin', 'gosh-remote-terminal');
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

    // ... but not through a claims directory that is not the user's own, nor a 65th name: an ordinary shell then.
    const plainShell = path.join(remoteHome, 'plain-shell');
    fs.writeFileSync(plainShell, `#!/bin/sh\necho plain >>'${path.join(remoteHome, 'plain-used')}'\n`);
    fs.chmodSync(plainShell, 0o755);
    const launchPlain = runtime => {
        const before = fs.readFileSync(path.join(remoteHome, 'shpool-attached'), 'utf8');
        try { fs.rmSync(path.join(remoteHome, 'plain-used')); } catch (error) { /* none yet */ }
        const result = require('child_process').spawnSync('sh', [launcher], {
            cwd: workspace, encoding: 'utf8',
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: remoteHome, XDG_RUNTIME_DIR: runtime, SHELL: plainShell },
        });
        return { plain: fs.existsSync(path.join(remoteHome, 'plain-used')),
            attached: fs.readFileSync(path.join(remoteHome, 'shpool-attached'), 'utf8') !== before, stderr: result.stderr };
    };
    const borrowed = path.join(remoteHome, 'borrowed-run');
    fs.mkdirSync(path.join(borrowed, 'elsewhere'), { recursive: true });
    fs.symlinkSync(path.join(borrowed, 'elsewhere'), path.join(borrowed, `gosh-remote-terminals-${process.getuid()}`));
    let ran = launchPlain(borrowed);
    assert.ok(ran.plain && !ran.attached, `a claims directory that is a link elsewhere is not used: ${ran.stderr}`);
    const full = Array.from({ length: 64 }, (_, i) => `editor-my_project-${i + 1}\t2026-01-01T00:00:00+00:00\tattached`).join('\n');
    fs.writeFileSync(path.join(remoteHome, 'shpool-sessions'), `NAME\tSTARTED_AT\tSTATUS\n${full}\n`);
    ran = launchPlain(path.join(remoteHome, 'run'));
    assert.ok(ran.plain && !ran.attached, `with every name taken, an ordinary shell, not a 65th attach: ${ran.stderr}`);
    console.log('ok   review: the launcher keeps to its own claims, and to its 64 names');

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
    const installer = fs.readFileSync(path.join(gosh, 'tools', 'install.sh'), 'utf8').replace('@VERSION@', version);
    fs.writeFileSync(path.join(out, 'install.sh'), installer);
    const installerDigest = require('crypto').createHash('sha256').update(installer).digest('hex');
    // (as gosh's release workflow lists them: the packages, and install.sh)
    fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${digest}  ${name}.tar.gz\n${installerDigest}  install.sh\n`);
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
        '\' "$@"', // (its arguments handed on, as the real server's launcher does)
        '',
    ].join('\n'));
    fs.chmodSync(path.join(top, 'bin', 'codium-server'), 0o755);
    fs.writeFileSync(path.join(top, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    fs.chmodSync(path.join(top, 'node'), 0o755);
    const archive = path.join(where, 'server.tar.gz');
    const tar = require('child_process').spawnSync('tar', ['-czf', archive, '-C', path.dirname(top), 'standin']);
    assert.strictEqual(tar.status, 0, String(tar.stderr));
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(`${archive}.sha256`, `${digest}  server.tar.gz\n`); // (as VSCodium publishes one beside each asset)
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
    await reconnectTests();
    const reviewScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gosh-remote-review-'));
    try {
        await reviewTests(reviewScratch);
    } finally {
        fs.rmSync(reviewScratch, { recursive: true, force: true });
    }

    const windows = process.platform === 'win32';
    if (windows) {
        // gosh's releases have no Windows build yet (gosh's release workflow), so neither half runs here.
        console.log('skip end-to-end test (gosh has no Windows build yet)');
        return;
    }
    // (the release's version is the one its programs say: gosh-server --version, since gosh 599429f)
    const built = process.env.GOSH_BUILD
        && /of gosh v(\S+)/.exec(require('child_process').spawnSync(path.join(path.resolve(process.env.GOSH_BUILD), '.build', 'bin', 'gosh-client'),
            ['--version'], { encoding: 'utf8' }).stdout || '');
    const goshVersion = process.env.GOSH_VERSION || (built ? built[1] : '0.0.test');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gosh-remote-test-'));
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
        const tokenMode = fs.statSync(path.join(remoteHome, '.vscodium-server', '.test-commit.token')).mode & 0o777;
        assert.strictEqual(tokenMode, 0o600, `the token is the user's alone (it is ${tokenMode.toString(8)})`);
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

        // A saved process id now someone else's: not taken for the editor's server, whose port it is not.
        {
            const data = path.join(remoteHome, '.vscodium-server');
            const oldPid = Number(fs.readFileSync(path.join(data, '.test-commit.pid'), 'utf8').trim());
            second.dispose();
            await second.exited;
            second = null;
            try { process.kill(oldPid); } catch (error) { /* gone */ }
            const other = spawn('sleep', ['120'], { stdio: 'ignore' }); // alive, the test's own, and not the server
            fs.writeFileSync(path.join(data, '.test-commit.pid'), `${other.pid}\n`);
            fs.writeFileSync(path.join(data, '.test-commit.log'), 'Extension host agent listening on 1\n');
            lines.length = 0;
            try {
                second = await connect(options);
                assert.ok(lines.some(l => l.includes('starting')), 'a new server was started');
                assert.strictEqual((await get(second.port, '/version')).status, 200);
            } finally {
                other.kill();
            }
            console.log('ok   review: a saved process id now another program\'s is not taken for the server');
        }

        // What the host downloads is checked before it is run: gosh's installer, and the editor's server.
        {
            const tampered = path.join(scratch, 'tampered');
            fs.cpSync(releases, tampered, { recursive: true });
            fs.appendFileSync(path.join(tampered, `v${goshVersion}`, 'install.sh'), '\n# changed after it was published\n');
            const otherHome = path.join(scratch, 'other-home');
            fs.mkdirSync(otherHome);
            const elsewhere = { ...options, releases: `file://${path.resolve(tampered)}`, runner: () => spawn('sh', [], {
                stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: otherHome, LC_ALL: 'C.UTF-8', GOSH_STUN: 'none' } }) };
            await assert.rejects(connect(elsewhere), /install\.sh.*(checksum|SHA256SUMS)/);
            assert.ok(!fs.existsSync(path.join(otherHome, '.local', 'bin', 'gosh-server')), 'and nothing of it was run');
            if (serverUrl) {
                const archive = serverUrl.replace(/^file:\/\//, '');
                fs.writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}  server.tar.gz\n`);
                await assert.rejects(connect({ ...elsewhere, releases: options.releases }), /editor's server.*checksum/);
                assert.ok(!fs.existsSync(path.join(otherHome, '.vscodium-server', 'bin', 'test-commit', 'bin')), 'and it was not unpacked');
                fs.writeFileSync(`${archive}.sha256`, `${require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  server.tar.gz\n`);
            }
            console.log('ok   review: the host runs nothing it downloaded until it matches its published checksum');
        }

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
        for (const home of [remoteHome, path.join(scratch, 'other-home')]) {
            try {
                const pid = fs.readFileSync(path.join(home, '.vscodium-server', '.test-commit.pid'), 'utf8').trim();
                process.kill(Number(pid));
            } catch (error) { /* it never started */ }
        }
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
