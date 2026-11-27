// The release workflow's steps. Each step function takes github-script's injected { github, context, core } and
// the step's inputs, so tests can call it with fakes.

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHIPPED_FILES = ['LICENSE', 'README.md'];
const ACTION_FILES = ['action.yml', 'action.yaml'];

function parse(version) {
  return SEMVER.exec(version)?.slice(1).map(Number);
}

// Returns { version } for the release, or { error } when the requested or latest version is not vMAJOR.MINOR.PATCH.
function nextVersion(requested, previous) {
  let version = (requested ?? '').trim();
  if (version) {
    if (!version.startsWith('v')) version = `v${version}`;
    if (!parse(version)) return { error: `Version ${version} is not vMAJOR.MINOR.PATCH` };
    return { version };
  }
  if (!previous) return { version: 'v1.0.0' };
  const prev = parse(previous);
  if (!prev) return { error: `Latest release ${previous} is not vMAJOR.MINOR.PATCH; pass a version` };
  return { version: `v${prev[0]}.${prev[1] + 1}.0` };
}

// Only a version above the latest release becomes the latest, so the next bump starts from the highest.
function isLatest(version, previous) {
  const prev = parse(previous);
  if (!prev) return true;
  const next = parse(version);
  const differs = next.findIndex((part, i) => part !== prev[i]);
  return differs >= 0 && next[differs] > prev[differs];
}

async function ignoreNotFound(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error.status !== 404) throw error;
    return undefined;
  }
}

async function resolveVersion({ github, context, core }, { requested }) {
  const { owner, repo } = context.repo;

  const latestRelease = await ignoreNotFound(github.rest.repos.getLatestRelease({ owner, repo }));
  const previous = latestRelease?.data.tag_name ?? '';

  const { version, error } = nextVersion(requested, previous);
  if (error) {
    core.setFailed(error);
    return;
  }

  // Releases are immutable: a tag is never moved or overwritten.
  if (await ignoreNotFound(github.rest.git.getRef({ owner, repo, ref: `tags/${version}` }))) {
    core.setFailed(`Tag ${version} already exists`);
    return;
  }

  const latest = isLatest(version, previous);
  core.info(`Releasing ${version}${previous ? ` after ${previous}` : ''}${latest ? '' : ' (not latest)'}`);
  core.setOutput('version', version);
  core.setOutput('previous', previous);
  core.setOutput('latest', String(latest));
}

// The release ships only the actions (top-level directories holding an action.yml), LICENSE and README.md.
async function buildTree({ github, context, core }, { previous }) {
  const { owner, repo } = context.repo;
  const commit = (await github.rest.git.getCommit({ owner, repo, commit_sha: context.sha })).data;
  const root = (await github.rest.git.getTree({ owner, repo, tree_sha: commit.tree.sha })).data.tree;

  const kept = [];
  for (const entry of root) {
    if (entry.type === 'blob' && SHIPPED_FILES.includes(entry.path)) {
      kept.push(entry);
    } else if (entry.type === 'tree') {
      const files = (await github.rest.git.getTree({ owner, repo, tree_sha: entry.sha })).data.tree;
      if (files.some((file) => file.type === 'blob' && ACTION_FILES.includes(file.path))) {
        kept.push(entry);
      }
    }
  }
  core.info(`Shipping: ${kept.map((entry) => entry.path).join(', ')}`);

  const tree = (await github.rest.git.createTree({
    owner,
    repo,
    tree: kept.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
  })).data;
  core.setOutput('tree', tree.sha);

  // Identical contents hash to the identical tree, so an unchanged release is a tree SHA match.
  if (previous) {
    const released = (await github.rest.repos.getCommit({ owner, repo, ref: previous })).data;
    if (released.commit.tree.sha === tree.sha) {
      core.notice(`Nothing changed since ${previous}; skipping the release`);
      core.setOutput('changed', 'false');
      return;
    }
  }
  core.setOutput('changed', 'true');
}

// The release commit sits on top of the released main commit, so log and blame on a tag show the real history.
async function createReleaseCommit({ github, context, core }, { version, tree }) {
  const { owner, repo } = context.repo;
  const commit = (await github.rest.git.createCommit({
    owner,
    repo,
    message: `Release ${version}\n\nStrip everything but the actions, LICENSE and README.md.`,
    tree,
    parents: [context.sha],
  })).data;

  core.info(`Created release commit ${commit.sha}`);
  core.setOutput('commit', commit.sha);
}

// createRelease also creates the tag, so a failed run leaves neither behind and can simply be rerun.
async function createRelease({ github, context, core }, { version, previous, latest, commit }) {
  const { owner, repo } = context.repo;
  const notes = (await github.rest.repos.generateReleaseNotes({
    owner,
    repo,
    tag_name: version,
    target_commitish: commit,
    ...(previous && { previous_tag_name: previous }),
  })).data;

  let body = notes.body;
  if (previous) {
    // Two dots compare the stripped trees directly; three would diff against main and show every file the release
    // leaves out as deleted.
    body += `\n\n**Release diff**: ${context.serverUrl}/${owner}/${repo}/compare/${previous}..${version}`;
  }

  const release = (await github.rest.repos.createRelease({
    owner,
    repo,
    tag_name: version,
    target_commitish: commit,
    name: version,
    body,
    make_latest: latest,
  })).data;
  core.notice(`Released ${release.html_url}`);
}

module.exports = { nextVersion, isLatest, resolveVersion, buildTree, createReleaseCommit, createRelease };
