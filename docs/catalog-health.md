# Catalog images and repair

Edit `packages/core/src/apps/catalog/<app>.json`, then run
`bun run --cwd packages/core scripts/gen-catalog.ts`. The generated catalog is
the GitHub overlay consumed by deployed instances; development uses its bundled
copy. Existing installed services retain their saved configuration.

The Catalog health workflow checks the registry manifests for all offered app
and companion-service images, including literal inline-build `FROM` and external
`COPY --from` dependencies, daily and on catalog changes. It does not pull
layers for the inventory check. A failed check means the image could not be
verified from that runner; inspect the registry/network response before changing
a template. It never changes customer services or automatically swaps registries.

MinIO additionally runs on native Linux AMD64 and ARM64 runners. The smoke test
uses the template's image, argv, readiness probe and bucket command. It verifies
console access, authenticated S3 and an object surviving container replacement.
Containers have no external network, capped CPU/RAM and disposable named volumes.
Run it locally with `bun scripts/smoke-catalog-minio.ts` against your test Docker
daemon. `CATALOG_TEST_PLATFORM` can select either architecture.

WordPress, Odoo Community, PostgreSQL + pgAdmin, MariaDB + Adminer, RabbitMQ,
Authentik, and Nextcloud have native AMD64 and ARM64 smoke jobs as well. They
materialize the canonical images, inline builds, environment, volumes, mounted
files with the engine's read-only binding semantics, and required setup hooks. Tests exercise application access and generated
credentials, write data, replace all containers, and verify persistence. Authentik
checks the stored administrator password through its authentication backend and
the public login page; it does not drive a browser SSO integration.

```sh
# Use a disposable test daemon. No customer API or Cloud purchase is involved.
DOCKER_CONTEXT=your-test-context bun scripts/smoke-catalog-apps.ts
# Or select individual stacks:
DOCKER_CONTEXT=your-test-context bun scripts/smoke-catalog-apps.ts wordpress odoo
# Test the actual retired images followed by an application-only replacement:
DOCKER_CONTEXT=your-test-context CATALOG_TEST_FROM_RETIRED_BUILD=1 bun scripts/smoke-catalog-apps.ts wordpress odoo
```

The stacks use their catalog CPU/RAM limits and loopback-only test UI ports.
Database and broker ports are not published. Networks, containers, named volumes,
and generated test images are removed afterward; pulled upstream images stay
cached. These tests validate stack recipes, not provider TLS issuance, billing,
or an application's optional integrations. The normal install, routing, build,
backup, and monitoring engines remain the deployment path.

The pinned Chainguard MinIO **development** image includes `sh` and `mc`, required
by the setup hook. The distroless image is not a drop-in substitute. It runs as
UID 65532: a populated volume from an older root-running distribution may require
a reviewed ownership migration. Test upgrades on a backup/clone first. Do not
recursively change production volume ownership as a generic repair step.

## Existing failed installs

From a checkout containing the updated catalog, set `OPENSHIP_URL` to the intended
instance and `OPENSHIP_TOKEN` to a token authorized for the project. Preview:

```sh
bun scripts/catalog-image-repair.ts --project PROJECT_ID --service SERVICE_ID
```

Add `--apply` to repair a **failed single-service install without an active
deployment**. The tool only accepts exact retired images listed in the template's
`replacesImages`, sends an image-only update through the SDK, starts the normal
deployment and waits for its result. It preserves environment, credentials,
commands, volumes and routing; no database access or infrastructure credentials
are needed. It refuses custom images, active projects and multi-service installs.
If deployment fails, the new image remains saved for inspection/retry; the tool
does not delete the data volume or cancel a deployment on an observation timeout.

Running installations need their normal reviewed image-update flow, including
storage compatibility and backup checks. A pinned digest fixes reproducibility,
not upstream availability: keep the scheduled check enabled and review replacement
images when the registry stops serving a digest. An Openship-maintained mirror
can be introduced separately after its publishing and maintenance are established.

## Existing WordPress and Odoo build recipes

New installs pull the official application image and mount the catalog's startup
helper as a read-only file. WordPress initializes its owner through its bundled PHP
installation API before starting Apache; Odoo uses its existing Python helper.
Neither needs BuildKit. PocketBase still builds because its recipe installs the
application binary.

Existing installed recipes are not rewritten by catalog updates. The same repair
command previews conversion of an exact retired recipe declared in `replacesBuilds`.
Add `--apply` after reviewing the target image, startup command and file paths.
The tool requires the same official base image, refuses customized recipes,
commands, build arguments and existing mounted files, and refuses an in-progress
deployment. It supports running, multi-service installs for these exact recipe
conversions; distribution replacements retain the stricter failed-install rules
above.

Conversion removes the saved inline build, adds the declared startup files and
command, and deploys only the application service through the normal engine.
Database siblings, credentials, environment, volumes, routing and unrelated
advanced settings are preserved. It does not upgrade the base application version
or reset an existing owner password. Review backups and test on a clone before
changing a stateful production installation. A failed deploy leaves the converted
recipe saved for normal inspection and retry.
