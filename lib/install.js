// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// Getting the gosh client onto the machine the editor runs on.
//
// It comes from a gosh release (gosh's tools/package-release.sh): one archive
// per kind of machine, listed with its SHA-256 in the release's SHA256SUMS.  It is kept in the
// extension's own storage, so nothing is installed system-wide and
// nothing needs to be on the PATH.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** Which release archive suits this machine, and where the client is inside it. */
function localPackage(version, platform = process.platform, arch = process.arch) {
    if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
        const name = `gosh-${version}-linux-${arch === 'x64' ? 'x86_64' : 'aarch64'}`;
        return { name, archive: `${name}.tar.gz`, client: path.join(name, 'bin', 'gosh-client') };
    }
    if (platform === 'darwin') {
        const name = `gosh-${version}-macos-universal`;
        return { name, archive: `${name}.tar.gz`, client: path.join(name, 'bin', 'gosh-client') };
    }
    // (Windows: gosh's releases have no Windows build yet; the fork's MSYS2 one is not carried.)
    throw new Error(`There is no gosh client package for ${platform} on ${arch}${platform === 'win32' ? ' yet' : ''}.`);
}

/** Whether a download may come from here: by https only, so that what arrives is what was published there. */
function allowedUrl(url) {
    return /^https:\/\//i.test(url);
}

/** Fetches a file of a release.  "releases" is an https URL, or a directory holding copies. */
function fetchReleaseFile(releases, version, file, destination) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(releases) && !/^file:\/\//i.test(releases) && !allowedUrl(releases)) {
        return Promise.reject(new Error(`Releases are fetched by https only, not from ${releases}.`));
    }
    if (!/^https:\/\//i.test(releases)) {
        const local = releases.replace(/^file:\/\//, '');
        return fs.promises.copyFile(path.join(local, `v${version}`, file), destination);
    }
    return download(`${releases.replace(/\/$/, '')}/v${version}/${file}`, destination, 5);
}

function download(url, destination, redirectsLeft) {
    return new Promise((resolve, reject) => {
        if (!allowedUrl(url)) { // (a redirection too: never from https to anything less)
            reject(new Error(`Releases are fetched by https only, not from ${url}.`));
            return;
        }
        const request = https.get(url, { headers: { 'User-Agent': 'gosh-remote' } }, response => {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error(`Too many redirections fetching ${url}`));
                    return;
                }
                resolve(download(new URL(response.headers.location, url).toString(), destination, redirectsLeft - 1));
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`Could not download ${url}: the server answered ${status}`));
                return;
            }
            const out = fs.createWriteStream(destination);
            response.pipe(out);
            out.on('finish', () => out.close(error => (error ? reject(error) : resolve())));
            out.on('error', reject);
        });
        request.on('error', error => reject(new Error(`Could not download ${url}: ${error.message}`)));
        request.setTimeout(60000, () => request.destroy(new Error('timed out')));
    });
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
    });
}

function run(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
        let output = '';
        child.stdout.on('data', data => (output += data));
        child.stderr.on('data', data => (output += data));
        child.on('error', error => reject(new Error(`Could not run ${command}: ${error.message}`)));
        child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(`${command} failed (${code}): ${output.trim()}`))));
    });
}

/**
 * Makes sure the gosh client for this machine is in storageDir, and returns its path.
 *
 * options: { version, releases, storageDir, log }
 */
async function ensureLocalClient(options) {
    const { version, releases, storageDir } = options;
    const log = options.log || (() => {});
    const pkg = localPackage(version);
    const client = path.join(storageDir, pkg.client);

    if (await works(client, version)) {
        return client;
    }

    log(`Installing the gosh ${version} client for this machine...`);
    await fs.promises.mkdir(storageDir, { recursive: true });
    const work = await fs.promises.mkdtemp(path.join(storageDir, 'download-'));
    try {
        const archive = path.join(work, pkg.archive);
        const sums = path.join(work, 'SHA256SUMS');
        await fetchReleaseFile(releases, version, 'SHA256SUMS', sums);
        await fetchReleaseFile(releases, version, pkg.archive, archive);

        // Only what the release says it published is unpacked and run.
        const listed = (await fs.promises.readFile(sums, 'utf8')).split('\n')
            .map(line => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
            .filter(match => match && match[2] === pkg.archive)
            .map(match => match[1])[0];
        if (!listed) {
            throw new Error(`${pkg.archive} is not listed in the release's SHA256SUMS.`);
        }
        const actual = await sha256(archive);
        if (actual !== listed) {
            throw new Error(`${pkg.archive} does not match its published checksum (expected ${listed}, got ${actual}).`);
        }

        // tar reads zip files too on Windows and macOS, and every archive here but the Windows one is a tarball.
        await fs.promises.rm(path.join(storageDir, pkg.name), { recursive: true, force: true });
        await run('tar', ['-xf', archive, '-C', storageDir]);
    } finally {
        await fs.promises.rm(work, { recursive: true, force: true });
    }

    if (!(await works(client, version))) {
        throw new Error(`The gosh client was installed in ${storageDir} but does not run on this machine, or is not gosh ${version}.`);
    }
    log(`Installed ${client}`);
    return client;
}

// Whether the client there runs and is the release asked for: since gosh 599429f its first line of
// --version says which gosh it is ("gosh-client, of gosh vVERSION").
async function works(client, version) {
    try {
        await fs.promises.access(client, fs.constants.X_OK);
        const said = await run(client, ['--version'], { timeout: 20000 });
        return said.split('\n')[0].trim() === `gosh-client, of gosh v${version}`;
    } catch (error) {
        return false;
    }
}

module.exports = { ensureLocalClient, localPackage, fetchReleaseFile, allowedUrl, sha256, tmpdir: os.tmpdir };
