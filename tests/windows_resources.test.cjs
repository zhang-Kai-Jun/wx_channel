const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-resource-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['build-resources.ps1', 'winres.json', 'icon.png']) {
    fs.copyFileSync(path.join(root, 'winres', name), path.join(dir, name));
  }
  return dir;
}

function run(dir, args) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(dir, 'build-resources.ps1'), ...args,
  ], { encoding: 'utf8' });
}

test('Windows resources use the single project version and product metadata', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = fixture(t);
  const result = run(dir, ['-VersionFile', path.join(root, 'internal/version/version.go')]);
  assert.equal(result.status, 0, result.stderr);
  const version = fs.readFileSync(path.join(root, 'internal/version/version.go'), 'utf8')
    .match(/^var Current = "([^"]+)"/m)[1];
  assert.equal(result.stdout.trim(), version);
  const bytes = fs.readFileSync(path.join(dir, 'winres.build.json'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const resource = JSON.parse(bytes.toString('utf8'));
  const info = resource.RT_VERSION['#1']['0000'].info['0409'];
  assert.equal(info.FileDescription, '视频号');
  assert.equal(info.ProductName, '视频号');
  assert.equal(info.FileVersion, version);
  assert.equal(info.ProductVersion, version);
  const fixed = version.split('.').concat(version.split('.').length === 3 ? ['0'] : []).join('.');
  assert.equal(resource.RT_VERSION['#1']['0000'].fixed.file_version, fixed);
  assert.equal(resource.RT_VERSION['#1']['0000'].fixed.product_version, fixed);
  assert.equal(resource.RT_MANIFEST['#1']['0409'].identity.version, fixed);

  const winres = path.join(process.env.USERPROFILE, 'go/bin/go-winres.exe');
  assert.ok(fs.existsSync(winres), 'Install go-winres to verify the resource object');
  const make = spawnSync(winres, ['make', '--in', path.join(dir, 'winres.build.json'),
    '--arch', 'amd64', '--out', path.join(dir, 'rsrc')], { encoding: 'utf8' });
  assert.equal(make.status, 0, make.stderr);
  const object = fs.readFileSync(path.join(dir, 'rsrc_windows_amd64.syso'));
  assert.equal(object.readUInt16LE(0), 0x8664);
  for (const value of [info.FileDescription, info.ProductName, version]) {
    assert.ok(object.includes(Buffer.from(value + '\0', 'utf16le')), `Missing resource value: ${value}`);
  }
});

test('Invalid project versions fail resource preparation', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = fixture(t);
  for (const version of ['1.2', '1.2.65536', '1.2.3-beta']) {
    const file = path.join(dir, 'version.go');
    fs.writeFileSync(file, `package version\nvar Current = "${version}"\n`);
    const result = run(dir, ['-VersionFile', file]);
    assert.equal(result.status, 1, `${version}: ${result.stdout} ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, 'winres.build.json')), false);
  }
});

test('Metadata verification rejects an executable with different metadata', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = fixture(t);
  const result = run(dir, ['-Mode', 'Verify', '-VersionFile',
    path.join(root, 'internal/version/version.go'), '-ExecutablePath', process.execPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FileDescription mismatch/);
});

test('Batch resource preparation includes the generated object without packaging', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'winres'));
  for (const name of ['build-resources.ps1', 'winres.json', 'icon.png']) {
    fs.renameSync(path.join(dir, name), path.join(dir, 'winres', name));
  }
  fs.mkdirSync(path.join(dir, 'internal/version'), { recursive: true });
  fs.copyFileSync(path.join(root, 'internal/version/version.go'), path.join(dir, 'internal/version/version.go'));
  const toolchain = fs.readFileSync(path.join(root, 'go.mod'), 'utf8').match(/^toolchain (\S+)/m)[1];
  fs.writeFileSync(path.join(dir, 'go.mod'), `module resourcecheck\n\ngo 1.23.0\n\ntoolchain ${toolchain}\n`);
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n');
  const batch = fs.readFileSync(path.join(root, 'build.bat'), 'utf8')
    .split('REM ---------- 4. Compute date / commit ----------')[0];
  assert.doesNotMatch(batch, /^\s*go build\b/m, 'The resource smoke test must not package the application');
  fs.writeFileSync(path.join(dir, 'build.bat'),
    (batch + '\nexit /b 0\n:fail\nexit /b 1\n').replace(/\r?\n/g, '\r\n'));
  for (const args of [[], ['--obfuscate']]) {
    const result = spawnSync('cmd.exe', ['/d', '/c', 'build.bat', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, args.includes('--obfuscate') ? /Protection: Garble v0\.14\.2/ : /Protection: OFF/);
    assert.match(result.stdout, /Generating Windows resources/);
    assert.equal(fs.existsSync(path.join(dir, 'video_channel.exe')), false);
  }
});
