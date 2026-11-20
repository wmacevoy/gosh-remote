// Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
'use strict';

// Puts the shpool that the extension carries for hosts without one into
//
//     shpool/linux-x64/shpool   shpool/linux-arm64/shpool   shpool/darwin/shpool
//
// along with shpool's licence, from a gosh-shpool release
// (https://github.com/wmacevoy/gosh-shpool): shpool with session rename and
// fixes to its session restore, built for each kind of host.  The Linux ones
// are linked statically, so they run on any Linux, Alpine's included; the
// Mac one serves both kinds of processor.  Each archive is checked against
// the SHA-256 written here before anything in it is used, so a release file
// that changed since this was written is refused.
//
// Fetches all three on any machine; needs only Node.js and tar.
// GOSH_SHPOOL_RELEASES=DIR takes the archives from DIR/vVERSION/ instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchReleaseFile, sha256 } = require('../lib/install');

const VERSION = '0.11.7-gosh.2';
const RELEASES = process.env.GOSH_SHPOOL_RELEASES || 'https://github.com/wmacevoy/gosh-shpool/releases/download';

// kind of host (lib/connect.js) -> gosh-shpool's name for the build, and its archive's SHA-256
const BUILDS = {
    'linux-x64': { platform: 'linux-x86_64-musl', sha256: '81d0a34f36e43cd9568607efeb84270da9679061d4d4f03640bf75d43a6a7cf9' },
    'linux-arm64': { platform: 'linux-aarch64-musl', sha256: '339b3d7be109bf4f2f9bae9a5ae956afb5fbb900d8fc8718085e1e9529b6d940' },
    'darwin': { platform: 'macos-universal', sha256: '1e2d4ed6c89525c28d1f48bdfdfe9b467b32ec84a7b171a9fc00f0721efb62fa' },
};

const root = path.join(__dirname, '..');

function tar(args) {
    const result = spawnSync('tar', args, { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`tar ${args.join(' ')} failed`);
    }
}

async function main() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gosh-remote-shpool-'));
    try {
        let licence;
        for (const [kind, build] of Object.entries(BUILDS)) {
            const name = `gosh-shpool-${VERSION}-${build.platform}`;
            const archive = path.join(work, `${name}.tar.gz`);
            await fetchReleaseFile(RELEASES, VERSION, `${name}.tar.gz`, archive);
            const sum = await sha256(archive);
            if (sum !== build.sha256) {
                throw new Error(`${name}.tar.gz is not the file this was written for: its SHA-256 is ${sum}, not ${build.sha256}`);
            }
            tar(['-xzf', archive, '-C', work, `${name}/shpool`, `${name}/LICENSE`]);

            const destination = path.join(root, 'shpool', kind);
            fs.mkdirSync(destination, { recursive: true });
            fs.copyFileSync(path.join(work, name, 'shpool'), path.join(destination, 'shpool'));
            fs.chmodSync(path.join(destination, 'shpool'), 0o755);
            licence = path.join(work, name, 'LICENSE');
            console.log(`shpool for ${kind} hosts: ${name} (sha256 ${sum})`);
        }

        // Its licence goes wherever it does.
        fs.copyFileSync(licence, path.join(root, 'shpool', 'LICENSE'));
        fs.writeFileSync(path.join(root, 'shpool', 'README.md'),
            `gosh-shpool ${VERSION} (https://github.com/wmacevoy/gosh-shpool): shpool with session\n`
            + 'rename and fixes to its session restore.  Its licence is in LICENSE beside this file.\n'
            + 'The extension copies it to hosts that have no shpool when persistent terminals are\n'
            + 'turned on.\n');

        // The one for this machine, if there is one, should run.
        const here = process.platform === 'darwin' ? 'darwin'
            : process.platform === 'linux' ? `linux-${process.arch}` : null;
        if (here && BUILDS[here]) {
            const result = spawnSync(path.join(root, 'shpool', here, 'shpool'), ['version'], { stdio: 'inherit' });
            if (result.status !== 0) {
                throw new Error(`the shpool for ${here} hosts did not run here`);
            }
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(`build-shpool: ${error.message}`);
    process.exit(1);
});
