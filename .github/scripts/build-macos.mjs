import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

// Reuse the platform-independent payload already distributed in the public
// Windows release. Application source history remains in its private repository.
const version = process.env.APP_VERSION;
const arch = process.env.TARGET_ARCH;
if (version !== '0.4.1' || !['arm64','x64'].includes(arch)) throw new Error('Unsupported release target');
if (process.platform !== 'darwin' || process.arch !== arch) throw new Error('Build must run on a Mac of the target architecture');
const temp = process.env.RUNNER_TEMP;
const zip = path.join(temp, 'input', 'BasketDesktop-Windows-x64-v0.4.0.zip');
const expected = '73f4675d5af3b55180a6813b737c366d5ae61c09ec05256e434ad4b73ceba986';
const hash = data => createHash('sha256').update(data).digest('hex');
if (hash(fs.readFileSync(zip)) !== expected) throw new Error('Windows payload checksum does not match v0.4.0');
const input = path.join(temp, 'basket-input');
execFileSync('ditto', ['-x','-k',zip,input]);
const requireTools = createRequire(path.join(process.env.BASKET_TOOLS, 'package.json'));
const {extractAll, extractFile} = await import(pathToFileURL(requireTools.resolve('@electron/asar')).href);
const {packager} = await import(pathToFileURL(requireTools.resolve('@electron/packager')).href);
const source = path.join(temp, 'basket-app');
const windowsAsar = path.join(input, 'BasketDesktop', 'resources', 'app.asar');
extractAll(windowsAsar, source);
const pkg = JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
if (pkg.version !== '0.4.0') throw new Error('Unexpected input application version');
pkg.version = version;
fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const [folder] = await packager({
  dir: source, out: path.join(temp,'basket-build'), name: 'BasketDesktop',
  executableName: 'BasketDesktop', platform: 'darwin', arch,
  electronVersion: '44.5.1', appVersion: version,
  asar: true, prune: false, overwrite: true,
  icon: path.join(source,'assets','icon.icns'),
  appBundleId: 'fr.basketdesktop.app', appCategoryType: 'public.app-category.games',
  darwinDarkModeSupport: true,
  // Ad-hoc signing ensures local code integrity; this is not Apple notarization.
  osxSign: {
    identity: '-', identityValidation: false, continueOnError: false, gatekeeperAssess: false,
    // Ad-hoc identities have no Team ID. macOS 26 otherwise refuses Electron.
    // Preserve Hardened Runtime and scope this exception to the app's signed code.
    optionsForFile: () => ({hardenedRuntime: true, entitlements: [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.disable-library-validation',
    ]}),
  },
});
const app = path.join(folder,'BasketDesktop.app');
const executable = path.join(app,'Contents','MacOS','BasketDesktop');
const actualArch = execFileSync('lipo',['-archs',executable],{encoding:'utf8'}).trim();
if (actualArch !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error(`Wrong Mach-O architecture: ${actualArch}`);
execFileSync('codesign',['--verify','--deep','--strict','--verbose=2',app],{stdio:'inherit'});
const packagedAsar = path.join(app,'Contents','Resources','app.asar');
for (const file of ['src/main.cjs','src/physics.mjs','src/draw.mjs','src/stars.mjs','assets/sprites/ball.png','assets/sprites/hoop.png']) {
  if (hash(extractFile(packagedAsar,file)) !== hash(extractFile(windowsAsar,file))) throw new Error(`Changed app payload: ${file}`);
}
// Inspect actual signatures, not just configuration: the missing entitlement
// caused DYLD / different Team IDs on a downloaded macOS 26 installation.
function verifyEntitlements(bundle) {
  const entitlements = execFileSync('codesign', ['-d', '--entitlements', ':-', bundle], {encoding:'utf8'});
  const plistFile = path.join(temp, 'verify-entitlements.plist');
  fs.writeFileSync(plistFile, entitlements);
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']) {
    const flag = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistFile], {encoding:'utf8'}).trim();
    if (flag !== 'true') throw new Error(`Missing ${key} on ${bundle}`);
  }
  console.log('ENTITLEMENTS_OK', path.basename(bundle));
}
verifyEntitlements(app);
for (const name of fs.readdirSync(path.join(app, 'Contents', 'Frameworks'))) {
  if (name.endsWith('.app')) verifyEntitlements(path.join(app, 'Contents', 'Frameworks', name));
}
const minOS = execFileSync('plutil',['-extract','LSMinimumSystemVersion','raw','-o','-',path.join(app,'Contents','Info.plist')],{encoding:'utf8'}).trim();
fs.writeFileSync(path.join(folder,'LIRE-MOI-macOS.txt'), `BasketDesktop v${version} — ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}\n\nmacOS ${minOS} ou plus récent.\nDécompressez le ZIP, puis glissez BasketDesktop.app dans Applications.\nOuvrez l’application pour faire apparaître le ballon et le panier.\n\nVersion de test non notariée par Apple. Si macOS bloque son ouverture,\nconsultez Réglages Système > Confidentialité et sécurité > Ouvrir quand même.\n\nGlisser-relâcher : lancer. Double-clic sur le ballon : propulsion aléatoire.\nMode étoiles : tenir le ballon, haut/pause/haut/pause/bas/pause/bas/pause/gauche/pause/droite/pause/gauche/pause/droite, puis relâcher.\nMode actif jusqu’à fermeture ; chaque étoile dure 0,5 seconde.\nClic droit : options, orientation du panier, écrans et fermeture.\nCmd+Alt+B : masquer/afficher. Cmd+Alt+R : nouveau ballon.\n`);
fs.mkdirSync('dist',{recursive:true});
const filename = `BasketDesktop-macOS-${arch}-v${version}.zip`;
execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',folder,path.resolve('dist',filename)]);
// Test the archive users receive after a full unzip, including LaunchServices.
const extracted = path.join(temp, 'round-trip');
execFileSync('ditto', ['-x', '-k', path.resolve('dist', filename), extracted]);
const installedApp = path.join(extracted, path.basename(folder), 'BasketDesktop.app');
execFileSync('codesign', ['--verify', '--deep', '--strict', installedApp], {stdio:'inherit'});
verifyEntitlements(installedApp);
const launch = execFileSync(path.join(installedApp, 'Contents', 'MacOS', 'BasketDesktop'), ['--smoke-test'], {encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
if (!launch.includes('SMOKE_OK')) throw new Error('Extracted application did not report ready');
console.log(launch.trim());
const stdout = path.join(temp, 'launch-services.log');
const stderr = path.join(temp, 'launch-services-error.log');
execFileSync('open', ['-n', '-W', '--stdout', stdout, '--stderr', stderr, installedApp, '--args', '--smoke-test'], {timeout:45000});
const finderLaunch = fs.readFileSync(stdout, 'utf8');
if (!finderLaunch.includes('SMOKE_OK')) throw new Error('LaunchServices launch failed: ' + fs.readFileSync(stderr, 'utf8'));
console.log('LAUNCH_SERVICES_OK', finderLaunch.trim());
const testedOS = execFileSync('sw_vers', ['-productVersion'], {encoding:'utf8'}).trim();
const metadata = {version,arch,filename,minOS,testedOS,libraryValidationExceptionVerified:true,archiveLaunchVerified:true,launchServicesVerified:true,bytes:fs.statSync(path.join('dist',filename)).size,sha256:hash(fs.readFileSync(path.join('dist',filename))),nativeLaunchVerified:true,signing:'ad-hoc',notarized:false};
fs.writeFileSync(path.join('dist',`macos-${arch}.json`),JSON.stringify(metadata,null,2)+'\n');
console.log('MACOS_BUILD_OK', JSON.stringify(metadata));
