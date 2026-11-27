import { describe, expect, mock, test } from 'bun:test';
import {
  buildTree,
  createRelease,
  createReleaseCommit,
  isLatest,
  nextVersion,
  resolveVersion,
} from './release.js';

const context = { repo: { owner: 'o', repo: 'r' }, sha: 'main-sha', serverUrl: 'https://github.com' };

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

function fakeCore() {
  const outputs = {};
  return {
    outputs,
    failed: undefined,
    notices: [],
    info: () => {},
    notice(message) {
      this.notices.push(message);
    },
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setFailed(message) {
      this.failed = message;
    },
  };
}

describe('nextVersion', () => {
  test('starts at v1.0.0 with no previous release', () => {
    expect(nextVersion('', '')).toEqual({ version: 'v1.0.0' });
  });

  test('bumps the minor version and resets the patch', () => {
    expect(nextVersion('', 'v1.4.2')).toEqual({ version: 'v1.5.0' });
  });

  test('takes a requested version, trimmed and v-prefixed', () => {
    expect(nextVersion('  2.0.1 ', 'v1.4.2')).toEqual({ version: 'v2.0.1' });
    expect(nextVersion('v3.0.0', '')).toEqual({ version: 'v3.0.0' });
  });

  test('treats a missing request as empty', () => {
    expect(nextVersion(undefined, '')).toEqual({ version: 'v1.0.0' });
  });

  test('rejects a requested version that is not full semver', () => {
    expect(nextVersion('1.4', '')).toEqual({ error: 'Version v1.4 is not vMAJOR.MINOR.PATCH' });
    expect(nextVersion('v1.4.0-rc1', '')).toHaveProperty('error');
  });

  test('rejects bumping a previous release that is not semver', () => {
    expect(nextVersion('', 'latest')).toEqual({
      error: 'Latest release latest is not vMAJOR.MINOR.PATCH; pass a version',
    });
  });

  test('ignores a non-semver previous release when a version is requested', () => {
    expect(nextVersion('v1.0.0', 'latest')).toEqual({ version: 'v1.0.0' });
  });
});

describe('isLatest', () => {
  test.each([
    ['v1.0.0', '', true],
    ['v1.0.0', 'not-semver', true],
    ['v1.5.0', 'v1.4.9', true],
    ['v2.0.0', 'v1.9.9', true],
    ['v1.4.10', 'v1.4.9', true],
    ['v1.3.9', 'v1.4.0', false],
    ['v1.10.0', 'v2.0.0', false],
    ['v1.4.0', 'v1.4.0', false],
  ])('%s after %p is %p', (version, previous, expected) => {
    expect(isLatest(version, previous)).toBe(expected);
  });
});

describe('resolveVersion', () => {
  function fakeGithub({ latest, existingTags = [] }) {
    return {
      rest: {
        repos: {
          getLatestRelease: mock(async () => {
            if (latest instanceof Error) throw latest;
            if (!latest) throw notFound();
            return { data: { tag_name: latest } };
          }),
        },
        git: {
          getRef: mock(async ({ ref }) => {
            if (existingTags.includes(ref.replace('tags/', ''))) return { data: { ref } };
            throw notFound();
          }),
        },
      },
    };
  }

  test('releases v1.0.0 as latest with no previous release', async () => {
    const core = fakeCore();
    await resolveVersion({ github: fakeGithub({}), context, core }, { requested: '' });
    expect(core.failed).toBeUndefined();
    expect(core.outputs).toEqual({ version: 'v1.0.0', previous: '', latest: 'true' });
  });

  test('bumps the latest release', async () => {
    const core = fakeCore();
    const github = fakeGithub({ latest: 'v1.2.3' });
    await resolveVersion({ github, context, core }, { requested: '' });
    expect(core.outputs).toEqual({ version: 'v1.3.0', previous: 'v1.2.3', latest: 'true' });
    expect(github.rest.git.getRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r', ref: 'tags/v1.3.0' });
  });

  test('marks a backport below the latest release as not latest', async () => {
    const core = fakeCore();
    await resolveVersion({ github: fakeGithub({ latest: 'v2.0.0' }), context, core }, { requested: '1.9.1' });
    expect(core.outputs).toEqual({ version: 'v1.9.1', previous: 'v2.0.0', latest: 'false' });
  });

  test('fails when the tag already exists', async () => {
    const core = fakeCore();
    const github = fakeGithub({ latest: 'v1.0.0', existingTags: ['v1.1.0'] });
    await resolveVersion({ github, context, core }, { requested: '' });
    expect(core.failed).toBe('Tag v1.1.0 already exists');
    expect(core.outputs).toEqual({});
  });

  test('fails on an invalid requested version without looking up the tag', async () => {
    const core = fakeCore();
    const github = fakeGithub({});
    await resolveVersion({ github, context, core }, { requested: 'one' });
    expect(core.failed).toBe('Version vone is not vMAJOR.MINOR.PATCH');
    expect(github.rest.git.getRef).not.toHaveBeenCalled();
  });

  test('rethrows API errors other than 404', async () => {
    const error = Object.assign(new Error('boom'), { status: 500 });
    const run = resolveVersion({ github: fakeGithub({ latest: error }), context, core: fakeCore() }, { requested: '' });
    await expect(run).rejects.toThrow('boom');
  });
});

describe('buildTree', () => {
  const trees = {
    'root-tree': [
      { path: 'LICENSE', mode: '100644', type: 'blob', sha: 'license', size: 1 },
      { path: 'README.md', mode: '100644', type: 'blob', sha: 'readme', size: 1 },
      { path: 'renovate.json', mode: '100644', type: 'blob', sha: 'renovate' },
      { path: '.github', mode: '040000', type: 'tree', sha: 'github-dir' },
      { path: 'ci-finished', mode: '040000', type: 'tree', sha: 'ci-finished-dir' },
      { path: 'paths-filter', mode: '040000', type: 'tree', sha: 'paths-filter-dir' },
      { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-dir' },
    ],
    'github-dir': [{ path: 'workflows', type: 'tree', sha: 'workflows-dir' }],
    'ci-finished-dir': [{ path: 'action.yml', type: 'blob', sha: 'a' }],
    'paths-filter-dir': [{ path: 'action.yaml', type: 'blob', sha: 'b' }],
    // A directory named action.yml is not an action.
    'docs-dir': [{ path: 'action.yml', type: 'tree', sha: 'c' }],
  };

  function fakeGithub({ releasedTree } = {}) {
    return {
      rest: {
        git: {
          getCommit: mock(async () => ({ data: { tree: { sha: 'root-tree' } } })),
          getTree: mock(async ({ tree_sha }) => ({ data: { tree: trees[tree_sha] } })),
          createTree: mock(async () => ({ data: { sha: 'stripped-tree' } })),
        },
        repos: {
          getCommit: mock(async () => ({ data: { commit: { tree: { sha: releasedTree } } } })),
        },
      },
    };
  }

  test('keeps only LICENSE, README.md and directories holding an action', async () => {
    const github = fakeGithub();
    const core = fakeCore();
    await buildTree({ github, context, core }, { previous: '' });

    expect(github.rest.git.getCommit).toHaveBeenCalledWith({ owner: 'o', repo: 'r', commit_sha: 'main-sha' });
    expect(github.rest.git.createTree).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      tree: [
        { path: 'LICENSE', mode: '100644', type: 'blob', sha: 'license' },
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'readme' },
        { path: 'ci-finished', mode: '040000', type: 'tree', sha: 'ci-finished-dir' },
        { path: 'paths-filter', mode: '040000', type: 'tree', sha: 'paths-filter-dir' },
      ],
    });
    expect(core.outputs).toEqual({ tree: 'stripped-tree', changed: 'true' });
    expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  test('reports a change when the previous release has a different tree', async () => {
    const github = fakeGithub({ releasedTree: 'older-tree' });
    const core = fakeCore();
    await buildTree({ github, context, core }, { previous: 'v1.0.0' });
    expect(github.rest.repos.getCommit).toHaveBeenCalledWith({ owner: 'o', repo: 'r', ref: 'v1.0.0' });
    expect(core.outputs).toEqual({ tree: 'stripped-tree', changed: 'true' });
  });

  test('skips the release when the previous release has the same tree', async () => {
    const core = fakeCore();
    await buildTree({ github: fakeGithub({ releasedTree: 'stripped-tree' }), context, core }, { previous: 'v1.0.0' });
    expect(core.outputs).toEqual({ tree: 'stripped-tree', changed: 'false' });
    expect(core.notices).toEqual(['Nothing changed since v1.0.0; skipping the release']);
  });
});

describe('createReleaseCommit', () => {
  test('commits the stripped tree on top of the released main commit', async () => {
    const createCommit = mock(async () => ({ data: { sha: 'release-sha' } }));
    const core = fakeCore();
    await createReleaseCommit(
      { github: { rest: { git: { createCommit } } }, context, core },
      { version: 'v1.2.0', tree: 'stripped-tree' },
    );
    expect(createCommit).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      message: 'Release v1.2.0\n\nStrip everything but the actions, LICENSE and README.md.',
      tree: 'stripped-tree',
      parents: ['main-sha'],
    });
    expect(core.outputs).toEqual({ commit: 'release-sha' });
  });
});

describe('createRelease', () => {
  function fakeGithub() {
    return {
      rest: {
        repos: {
          generateReleaseNotes: mock(async () => ({ data: { body: 'notes' } })),
          createRelease: mock(async () => ({ data: { html_url: 'https://github.com/o/r/releases/tag/v1.2.0' } })),
        },
      },
    };
  }

  test('links the two-dot diff against the previous release', async () => {
    const github = fakeGithub();
    const core = fakeCore();
    await createRelease(
      { github, context, core },
      { version: 'v1.2.0', previous: 'v1.1.0', latest: 'true', commit: 'release-sha' },
    );

    expect(github.rest.repos.generateReleaseNotes).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      tag_name: 'v1.2.0',
      target_commitish: 'release-sha',
      previous_tag_name: 'v1.1.0',
    });
    expect(github.rest.repos.createRelease).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      tag_name: 'v1.2.0',
      target_commitish: 'release-sha',
      name: 'v1.2.0',
      body: 'notes\n\n**Release diff**: https://github.com/o/r/compare/v1.1.0..v1.2.0',
      make_latest: 'true',
    });
    expect(core.notices).toEqual(['Released https://github.com/o/r/releases/tag/v1.2.0']);
  });

  test('omits the previous tag and diff for the first release', async () => {
    const github = fakeGithub();
    await createRelease(
      { github, context, core: fakeCore() },
      { version: 'v1.0.0', previous: '', latest: 'true', commit: 'release-sha' },
    );

    expect(github.rest.repos.generateReleaseNotes.mock.calls[0][0]).not.toHaveProperty('previous_tag_name');
    expect(github.rest.repos.createRelease.mock.calls[0][0].body).toBe('notes');
  });

  test('passes make_latest through for a release below the latest', async () => {
    const github = fakeGithub();
    await createRelease(
      { github, context, core: fakeCore() },
      { version: 'v1.0.1', previous: 'v2.0.0', latest: 'false', commit: 'release-sha' },
    );
    expect(github.rest.repos.createRelease.mock.calls[0][0].make_latest).toBe('false');
  });
});
