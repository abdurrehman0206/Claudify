'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

// Apple Silicon refuses to run a binary with no signature at all, and macOS
// reports that refusal as "Claudify is damaged and can't be opened" -- which
// reads like a corrupt download rather than a signing problem.
//
// electron-builder skips signing entirely when `identity` is null, and the
// signatures Electron shipped with are invalidated as soon as the bundle is
// repacked. So ad-hoc sign the finished app ourselves. That is not a Developer
// ID signature and does not avoid Gatekeeper's first-run prompt, but it turns
// "damaged" into the ordinary "unidentified developer" dialog, which
// right-click -> Open resolves.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
      { stdio: 'inherit' }
    );
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: 'inherit',
    });
    console.log(`  • ad-hoc signed ${appName}.app`);
  } catch (error) {
    // Better to ship an unsigned build with a documented workaround than to
    // fail the whole release.
    console.warn(`  • ad-hoc signing failed: ${error.message}`);
  }
};
