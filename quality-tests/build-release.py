"""Build and verify reproducible Skill and Plugin release archives."""
from pathlib import Path
import argparse
import hashlib
import os
import shutil
import re
import zipfile
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'healthy-fitness-coach'
EXCLUDED_TESTS = {'paired-evaluation.test.js'}
BUILD_EXCLUDES = {'node_modules', '__pycache__', 'fitness-reports', '.tmp-preview', '.git', '.env', 'thumbs.db'}
CHECKOUT_TEXT = {'.js', '.md', '.json', '.py', '.ps1', '.yml', '.yaml', '.html', '.feature', '.txt'}
CHECKOUT_SECRET_RULES = {'GitHub token', 'private key', 'OpenAI key', 'AWS access key'}

PRIVATE_DATA_PATTERNS = (
    ('GitHub token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})')),
    ('WeChat account id', re.compile(r'wxid_[a-zA-Z0-9]+')),
    ('WeChat local cache', re.compile(r'(?:^|[/\\])xwechat_files(?:[/\\]|$)', re.IGNORECASE)),
    ('Windows user home', re.compile(r'(?<![A-Za-z0-9+.-])[A-Za-z]:[/\\]+Users[/\\]+(?!Public(?:[/\\]|$))[^/\\\s<>"|?*]+', re.IGNORECASE)),
    ('Windows WeChat home', re.compile(r'(?<![A-Za-z0-9+.-])[A-Za-z]:[/\\]+WeChat(?: Files)?(?:[/\\]|$)', re.IGNORECASE)),
    ('macOS user home', re.compile(r'(?<![A-Za-z0-9+.-])/Users/(?!Shared(?:/|$)|Public(?:/|$))[^/\s]+')),
    ('Linux user home', re.compile(r'(?<![A-Za-z0-9+.-])/home/(?!shared?(?:/|$)|public(?:/|$))[^/\s]+', re.IGNORECASE)),
    ('private key', re.compile(r'-----BEGIN (?:[A-Z][A-Z0-9 ]+ )?PRIVATE KEY-----')),
    ('OpenAI key', re.compile(r'\bsk-[A-Za-z0-9]{24,}')),
    ('AWS access key', re.compile(r'\bAKIA[A-Z0-9]{16}')),
)

def find_private_data(text):
    """Return the first matched privacy rule name, or None for clean text."""
    for name, pattern in PRIVATE_DATA_PATTERNS:
        if pattern.search(text):
            return name
    return None

def audited_bytes(file):
    if file.is_symlink():
        raise ValueError(f'Symbolic link in release input: {file.name}')
    text = file.read_bytes().decode('utf-8').replace('\r\n', '\n')
    privacy_match = find_private_data(text)
    if privacy_match:
        raise ValueError(f'Private data pattern ({privacy_match}) in {file.name}')
    return text.encode('utf-8')


def audit_checkout():
    files = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT,
        timeout=30
    ).decode('utf-8').split('\0')
    for name in sorted(set(filter(None, files))):
        relative = Path(name)
        file = ROOT / relative
        filename = relative.name.lower()
        if not file.exists():
            continue
        if (filename == '.env' or (filename.startswith('.env.') and filename != '.env.example')
                or relative.suffix.lower() in {'.dpapi', '.pem', '.key'}
                or any(part.lower() in {'fitness-reports', 'xunji-cache', 'write-operations'} for part in relative.parts)):
            raise ValueError(f'Private file in checkout: {relative}')
        if relative.suffix.lower() not in CHECKOUT_TEXT or not file.is_file():
            continue
        if file.is_symlink():
            raise ValueError(f'Symbolic link in checkout: {relative}')
        contents = file.read_text(encoding='utf-8')
        for rule, pattern in PRIVATE_DATA_PATTERNS:
            if rule in CHECKOUT_SECRET_RULES and pattern.search(contents):
                raise ValueError(f'Potential credential ({rule}) in {relative}')


def report_source_revision():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, timeout=30).strip()
    changes = subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, timeout=30)
    print(f"Source checkout {revision} ({'local changes included' if changes else 'clean'})")


def write_archive(target, entries):
    names = set()
    for name, _ in entries:
        if (not name or '\\' in name or ':' in name
                or any(part in {'', '.', '..'} for part in name.split('/'))
                or name.casefold() in names):
            raise ValueError(f'Invalid or duplicate archive path: {name}')
        names.add(name.casefold())
    with zipfile.ZipFile(target, 'w') as archive:
        for name, data in sorted(entries):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(entries):
            raise ValueError(f'Invalid generated archive: {target.name}')
        for name, data in entries:
            if archive.read(name) != data:
                raise ValueError(f'Archive content mismatch: {name}')


def release_entries(source, allowed):
    entries = []
    for directory, dirs, names in os.walk(source):
        base = Path(directory)
        dirs[:] = sorted(
            name for name in dirs
            if name.lower() not in BUILD_EXCLUDES
            and not name.lower().startswith('.env.')
            and allowed((base / name).relative_to(source).parts)
        )
        for name in dirs:
            if (base / name).is_symlink():
                raise ValueError(f'Symbolic link in release input: {name}')
        for name in sorted(names):
            file = base / name
            if (name.lower() in BUILD_EXCLUDES or name.lower().startswith('.env.')
                    or file.suffix.lower() in {'.pyc', '.pyo', '.dpapi', '.pem', '.key'}):
                continue
            if allowed(file.relative_to(source).parts):
                entries.append((f'{source.name}/{file.relative_to(source).as_posix()}', audited_bytes(file)))
    return entries


def standalone_path(parts):
    return parts[0] in {'SKILL.md', 'LICENSE', 'agents', 'assets', 'references', 'scripts', 'tests'} and parts[-1] not in EXCLUDED_TESTS


def plugin_path(parts):
    if parts[0] == 'mcp':
        return len(parts) == 1 or parts[1] == 'xunji' and (
            len(parts) == 2 or parts[2] in {'src', 'scripts', 'test', 'package.json', 'package-lock.json'}
        )
    return parts[0] in {'.codex-plugin', '.mcp.json', 'README.md', 'scripts', 'skills'}


def build_packages(directory):
    skill = directory / 'healthy-fitness-coach.zip'
    plugin = directory / 'healthy-fitness-coach-plugin.zip'
    write_archive(skill, release_entries(SOURCE, standalone_path))
    write_archive(plugin, release_entries(ROOT / 'healthy-fitness-coach-plugin', plugin_path))
    skill_upload = skill.with_suffix('.skill')
    shutil.copyfile(skill, skill_upload)
    return [skill, skill_upload, plugin]


def run_tests(directory, test_dir, allowed_skips=frozenset()):
    tests = sorted((directory / test_dir).glob('*.test.js'))
    if not tests:
        raise ValueError(f'No tests found in {test_dir}')
    result = subprocess.run(
        ['node', '--test', '--test-reporter=tap', *map(str, tests)], cwd=directory, capture_output=True,
        text=True, encoding='utf-8', errors='replace', check=False, timeout=180
    )
    summaries = dict(re.findall(r'^# (tests|pass|fail|todo|cancelled|skipped) (\d+)$', result.stdout, re.MULTILINE))
    skipped_tests = re.findall(r'^ok \d+ - (.*?) # SKIP\b', result.stdout, re.MULTILINE)
    if (result.returncode or not int(summaries.get('pass', 0))
            or any(summaries.get(field) != '0' for field in ('fail', 'todo', 'cancelled'))
            or int(summaries.get('skipped', -1)) != len(skipped_tests)
            or len(skipped_tests) != len(allowed_skips) or set(skipped_tests) != allowed_skips):
        print(result.stdout)
        print(result.stderr)
        raise ValueError(f'Packaged {test_dir} failed or had unexpected test skips')
    print(f"PASS packaged {directory.name}: {summaries['pass']} passed, {summaries['skipped']} known skips")


def verify(skill_archive, plugin_archive):
    with tempfile.TemporaryDirectory(prefix='fitness-release-check-') as temporary:
        output = Path(temporary)
        for target in (skill_archive, plugin_archive):
            with zipfile.ZipFile(target) as archive:
                archive.extractall(output)
        # Keep the Skill isolated so its explicitly known cross-package cases still skip.
        standalone = output / 'standalone'
        standalone.mkdir()
        skill = standalone / SOURCE.name
        (output / SOURCE.name).rename(skill)
        run_tests(skill, 'tests', {
            'plugin visual CLI is independently runnable and can explicitly embed a photo',
            'plugin visual compiler is independently runnable from the plugin root',
            'release privacy scanner catches local user paths without relying on wxid',
        })

        plugin = output / 'healthy-fitness-coach-plugin'
        mcp = plugin / 'mcp' / 'xunji'
        npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
        if not npm:
            raise RuntimeError('npm is required to verify the extracted Plugin')
        # Start with the shipped lockfile and no dependencies or account data in the package.
        subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
                       cwd=mcp, check=True, timeout=180)
        run_tests(mcp, 'test')
        subprocess.run(['node', 'scripts/compile-visual-brief.js', '--list-recipes'],
                       cwd=plugin, stdout=subprocess.DEVNULL, check=True, timeout=30)
        for component in (skill, plugin):
            for script in (component / 'scripts').glob('*.py'):
                compile(script.read_text(encoding='utf-8-sig'), script.name, 'exec')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true', help='test both archives after isolated extraction')
    parser.add_argument('--check', action='store_true', help='compare committed artifacts without changing them')
    args = parser.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if not args.check:
        subprocess.run(['node', 'quality-tests/run-plugin-sync.js', '--write'],
                       cwd=ROOT, check=True, timeout=60)
    audit_checkout()
    report_source_revision()
    with tempfile.TemporaryDirectory(prefix='fitness-build-') as temporary:
        directory = Path(temporary)
        packages = build_packages(directory)
        repeat_dir = directory / 'repeat'
        repeat_dir.mkdir()
        repeated = build_packages(repeat_dir)
        for package, repeat in zip(packages, repeated):
            if package.read_bytes() != repeat.read_bytes():
                raise ValueError(f'Nonreproducible build: {package.name}')
        if args.verify:
            verify(packages[0], packages[2])
        destination = ROOT / 'dist'
        destination.mkdir(exist_ok=True)
        for package in packages:
            bundled = destination / package.name
            data = package.read_bytes()
            if args.check:
                if not bundled.is_file() or bundled.read_bytes() != data:
                    raise ValueError(f'Out-of-date release artifact: {package.name}')
            else:
                shutil.copyfile(package, bundled)
            print(f'PASS {package.name} SHA256 {hashlib.sha256(data).hexdigest()}')


if __name__ == '__main__':
    main()
