import { readFile } from 'node:fs/promises';

const packagePaths = [
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/providers/package.json',
  'packages/mcp/package.json',
  'packages/tui/package.json',
];
const packages = await Promise.all(
  packagePaths.map(async (path) => ({
    path,
    value: JSON.parse(await readFile(path, 'utf8')) as {
      name: string;
      version: string;
      private?: boolean;
      dependencies?: Record<string, string>;
    },
  })),
);
const versions = new Set(packages.map(({ value }) => value.version));
if (versions.size !== 1) throw new Error(`workspace versions differ: ${[...versions].join(', ')}`);

const source = await readFile('packages/core/src/version.ts', 'utf8');
const version = packages[0]?.value.version;
if (!version || !source.includes(`VERSION = '${version}'`)) {
  throw new Error(`packages/core/src/version.ts does not match package version ${version}`);
}

const cli = packages.find(({ value }) => value.name === '@raegent/earshot')?.value;
if (!cli || cli.private === true) throw new Error('the earshot package is not publishable');
for (const [name, range] of Object.entries(cli.dependencies ?? {})) {
  if (range.startsWith('workspace:')) throw new Error(`runtime dependency ${name} uses ${range}`);
}
for (const { path, value } of packages) {
  if (path !== 'packages/cli/package.json' && value.private !== true) {
    throw new Error(`${path} must stay private; only packages/cli is published`);
  }
}
console.log(`release metadata is consistent at ${version}`);
