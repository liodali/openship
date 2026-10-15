# Build cache

Docker deployments retain reusable build state independently of release images.
Deleting a deployment image does not mean the corresponding BuildKit cache must
be deleted. Release retention still protects active, pinned and rollback images.

## Generated builds

On compatible BuildKit hosts with supported stock build images, generated Dockerfiles mount package download caches
for npm, Bun, pnpm, pip, pipenv, Poetry, uv, Composer, Bundler, Cargo,
Go, Maven, Gradle, NuGet and Hex. Known pure framework caches and Turborepo's local
cache use the same mechanism. These mounts do not become application image layers.

Cache identities include the project, repository, branch, app root, build image,
package manager and runtime selection. Compilation cache identities also account
for commands and build environment. Commit and session IDs do not create new
cache namespaces. BuildKit uses content checks for layer reuse; each tool remains
responsible for invalidating its own cached entries. Environment values are hashed
in mount identities and are not written to cache ownership labels or logs.

A cache mount being restored is not a guarantee that a particular task will hit
its cache. Turborepo must actually be invoked, and its task inputs, environment
dependencies and outputs must be declared correctly.

Installation and build commands keep their original order and source context.
Generated Dockerfiles are excluded from application copies so session-specific
filenames do not invalidate unchanged source layers. Existing ignore rules remain.
Custom install scripts can need source files, so OpenShip does not automatically
move them ahead of the source copy. Installed dependencies, compiled executables,
`.nuxt` and other required outputs are not automatically mounted as caches.
Repository Dockerfiles remain the source of truth and can declare their own cache
mounts. Native/bare builds are unchanged.
Custom build images retain layer caching without automatic cache mounts, preserving
their configured users, home directories and any preseeded offline dependencies.
Yarn package archives also stay in image layers: both Classic and modern
Plug'n'Play loaders can need the global cache at runtime. Yarn builds still reuse
Docker layers and supported framework/Turborepo build-only caches.

Legacy Docker builders use the original recipes. Engine-API builds with explicit
CPU/RAM limits also retain their original builder behavior; enabling cache mounts
must not silently remove those limits. Set `OPENSHIP_BUILD_CACHE_MOUNTS=false` on
the OpenShip API/worker, or in a project's build environment, to disable automatic
mounts. This also accommodates custom clean scripts that remove entire mounted
cache directories. Docker layer caching remains available.

## Cloud worker lifecycle

Each project has its own BuildKit state volume, labeled as build cache rather
than application data. Temporary workers stop after successful, failed and
cancelled builds. Their CPU/RAM limits are still applied on each recreation.
Recovery verifies both legacy and current workers have stopped before releasing
build capacity. Older unlabeled state is never adopted as a managed cache.

Cache collection and worker attachment share the physical host provisioning lock
across API/worker processes. The worker's attached Docker volume then pins the
state while the build runs outside that lock. Collection skips attached volumes
and caches protected by durable pending commands, including a lost bootstrap reply,
and uses non-force deletion as an additional Docker guard. Ownership is checked
again before deletion. Project deletion removes its idle cache regardless of the
application-data volume wipe option.

BuildKit layer records use its normal publication semantics. Tool cache mounts
are mutable: a failed build can update them. They are disposable optimization
data, not release artifacts or a transaction that rolls back every cache write.
New release images keep unique tags; cached builds pass the existing build and
deployment gates before cutover.

## Storage policy

Managed Cloud caches have a 5 GiB host retention target and a seven-day idle
expiry. Collection removes the least recently used idle state first. BuildKit
workers also receive cache size and free-space GC policies. Collection runs
before and after builds and in the daily cache sweep. Project deletion handles
deleted-project state; the daily Cloud sweep also discovers ready owned hosts
whose last project was moved or deleted.
The same sweep also bounds legacy Docker Engine cache records separately at
5 GiB; current Cloud builds store their cache in the project workers instead.

Native Docker caches use the existing 5 GiB daily retention target, with an
additional bounded prune before Docker builds on their actual daemon. Docker
protects active build records. Ordinary native maintenance failures are logged
without rejecting a build; disk pressure must still be resolved before proceeding.
When a build host executor is available, free storage is measured on Docker's
filesystem. Disk pressure triggers unused-cache cleanup; a build is refused when
free storage remains below 10% of the filesystem, capped at a 2 GiB reserve, or
when filesystem inodes are exhausted. Cloud state collection sizes only recognized
cache volumes, avoiding scans of application/database volumes.
Attached or command-protected caches are not walked for size while their files
can change. They enter the reclaimable retention budget after confirmed exit;
project deletion sizes only the requested project's idle state.

These are GC targets and admission checks, not filesystem quotas: active builds,
images and application data can exceed the cache target. Concurrent builds and
application writes can consume space after a measurement. The collector does not
delete active or retained release images, database volumes, or arbitrary Docker
resources to make a build fit. The existing release-image retention collector
continues to remove expired managed images separately.
