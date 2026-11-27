# actions

Composite GitHub Actions shared across repositories.

A workflow that runs only when certain paths change still needs one check that always reports, so branch
protection can require it. `paths-filter` decides whether the run is needed; `ci-finished` is that one check.

## paths-filter

Outputs `pass: 'true'` when the change touches any of `filters`, or when `force` is `true`. Pull requests compare
against their base; a push to `main` compares against the last commit its workflow passed on, so work
a failed or cancelled run skipped is not lost. It checks the repository out itself.

```yaml
  paths-filter:
    name: Need to run?
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      pull-requests: read
    outputs:
      pass: ${{ steps.filter.outputs.pass }}
    steps:
      - id: filter
        uses: anton-matosov/actions/paths-filter@v1
        with:
          force: ${{ github.event_name == 'workflow_dispatch' }}
          filters: |
            - 'src/**'
            - '.github/workflows/ci.yml'
```

Gate each job on `needs.paths-filter.outputs.pass == 'true'`.

## ci-finished

Fails when any needed job failed or was cancelled. Skipped jobs pass, so a run the filter skipped is green.
Require this job's check in branch protection.

```yaml
  finished:
    name: CI finished
    needs: [paths-filter, build, publish]
    if: always()
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: anton-matosov/actions/ci-finished@v1
        with:
          needs: ${{ toJSON(needs) }}
```
