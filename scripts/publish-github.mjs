import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read package.json
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tagName = `v${version}`;

// Get Git credentials / token
let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  try {
    const creds = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    });
    const match = creds.match(/password=(.+)/);
    if (match) {
      token = match[1].trim();
    }
  } catch (e) {
    console.error('Failed to retrieve GitHub credentials via git-credential:', e.message);
  }
}

if (!token) {
  console.error('Error: GITHUB_TOKEN environment variable or stored GitHub credentials not found.');
  process.exit(1);
}

// Get remote URL and parse owner/repo
let remoteUrl = '';
try {
  remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('Failed to get remote origin URL:', e.message);
  process.exit(1);
}

const githubUrlRegex = /(?:github\.com[:\/])([^\/]+)\/([^\/\.]+)(?:\.git)?/;
const match = remoteUrl.match(githubUrlRegex);
if (!match) {
  console.error('Error: Could not parse owner/repo from remote URL:', remoteUrl);
  process.exit(1);
}
const [, owner, repo] = match;
console.log(`Repository target: ${owner}/${repo}`);
console.log(`Release version: ${tagName}`);

// 1. Create and push Git tag
try {
  console.log(`Checking if tag ${tagName} exists...`);
  const tagExists = execSync(`git tag -l "${tagName}"`, { encoding: 'utf8' }).trim();
  if (tagExists) {
    console.log(`Tag ${tagName} already exists locally.`);
  } else {
    console.log(`Creating tag ${tagName}...`);
    execSync(`git tag -a ${tagName} -m "Release ${tagName}"`);
    console.log(`Pushing tag ${tagName} to origin...`);
    execSync(`git push origin ${tagName}`);
  }
} catch (e) {
  console.warn('Warning during tagging/pushing (it might already exist on remote):', e.message);
}

// 2. Create release via GitHub API
async function createRelease() {
  console.log(`Creating GitHub Release for ${tagName}...`);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Node-Fetch-Publisher',
    },
    body: JSON.stringify({
      tag_name: tagName,
      target_commitish: 'main',
      name: tagName,
      body: `Release version ${version}\n\nAutomated release built and uploaded via publisher script.`,
      draft: false,
      prerelease: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // If release already exists, try to get it
    if (response.status === 422 && errorText.includes('already_exists')) {
      console.log(`Release ${tagName} already exists. Fetching existing release...`);
      return getReleaseByTag();
    }
    throw new Error(`Failed to create release: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response.json();
}

async function getReleaseByTag() {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Node-Fetch-Publisher',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch release: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function uploadAsset(uploadUrl, filePath, fileName) {
  console.log(`Uploading asset ${fileName} (${filePath})...`);
  const fileBuffer = fs.readFileSync(filePath);
  const size = fileBuffer.length;

  // Clean the upload URL template (remove `{?name,label}`)
  const cleanUrl = uploadUrl.replace(/\{\?name,label\}/, '') + `?name=${encodeURIComponent(fileName)}`;

  const response = await fetch(cleanUrl, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': size.toString(),
      'User-Agent': 'Node-Fetch-Publisher',
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    // If asset already exists, print warning (maybe delete and re-upload, but for now we skip or log)
    if (response.status === 422 && errText.includes('already_exists')) {
      console.log(`Asset ${fileName} already exists in this release. Skipping.`);
      return;
    }
    throw new Error(`Failed to upload asset ${fileName}: ${response.status} ${response.statusText}\n${errText}`);
  }

  console.log(`Successfully uploaded ${fileName}`);
}

async function main() {
  try {
    const release = await createRelease();
    const uploadUrl = release.upload_url;
    console.log(`Upload URL: ${uploadUrl}`);

    // Files to upload
    const filesToUpload = [
      {
        path: path.join(rootDir, 'release', `AI Traffic Light-${version}-arm64.dmg`),
        name: `AI Traffic Light-${version}-arm64.dmg`,
      },
      {
        path: path.join(rootDir, 'release', `AI Traffic Light-${version}-arm64-mac.zip`),
        name: `AI Traffic Light-${version}-arm64-mac.zip`,
      },
    ];

    for (const file of filesToUpload) {
      if (fs.existsSync(file.path)) {
        await uploadAsset(uploadUrl, file.path, file.name);
      } else {
        console.warn(`Warning: Asset file not found at ${file.path}`);
      }
    }

    console.log(`\n🎉 Successfully published release ${tagName} to GitHub!`);
    console.log(`URL: ${release.html_url}`);
  } catch (error) {
    console.error('Publishing failed:', error.message);
    process.exit(1);
  }
}

main();
