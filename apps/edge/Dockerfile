# syntax=docker/dockerfile:1
# ─── openship-edge ──────────────────────────────────────────────────────────
# The routing/TLS edge, run as a CONTAINER on :80/:443 (network_mode: host)
# instead of bare OpenResty on the host. Cleaner than apt-installing OpenResty +
# certbot on the box: the edge ships as an image.
#
# The api container drives this edge via the Docker socket (see
# DockerEdgeExecutor): it drops vhost `<slug>.conf` files into the shared
# sites-enabled volume and runs `openresty -s reload` / `certbot` via
# `docker exec`. Three dirs are SHARED VOLUMES (api writes, edge reads):
#   • /usr/local/openresty/nginx/conf/sites-enabled  — managed vhosts
#   • /etc/letsencrypt                                — issued certs
# nginx.conf + the openship Lua are BAKED here (complete, no runtime edits), so
# the api never installs OpenResty or Lua in docker mode.
# ─────────────────────────────────────────────────────────────────────────────
#
# INTERIM FROM-SOURCE OPENRESTY — nginx2root (2026-11, openresty/openresty#1166):
# nginx 1.31.9 / 1.30.7 (2026-11-18) fix ten CVEs, incl. two HTTP/2 RCEs with a
# PUBLIC working PoC and a container-escape chain (CVE-2026-123007 /
# CVE-2026-123633). OpenResty master carries the fixes as 1.31.9.1, but the
# official tag + Docker image are an unpublished manual release step, so this
# file COMPILES the pinned master commit below using the official
# docker-openresty Alpine recipe (patched OpenSSL 3.5.8 + PCRE2 10.49 + the
# official configure flags). The commit was built and smoke-tested upstream
# (issue #1166: all patches applied, no .rej, HTTP/2 + Lua + TLS 1.3 OK) before
# pinning, and the source archive is sha256-verified.
#
# WHEN openresty/openresty:1.31.9.1-alpine publishes: delete the
# `openresty-build` stage + the global ARGs, `FROM openresty/openresty:1.31.9.1-alpine`
# directly, and drop the stage-build branch in apps/api/test/helpers/docker-e2e.ts
# (edgeBaseImage) — it detects the regime from this file automatically.
ARG OPENRESTY_COMMIT=0b91f30b31a9c711ff763f63807ae95d2fe2ceed
ARG OPENRESTY_SHA256=740193a1995a062a79fda329698d268d4f3085451c89f065479a3d070c7db6d8

FROM alpine:3.24.3 AS openresty-build
ARG OPENRESTY_COMMIT
ARG OPENRESTY_SHA256

# Mirrors docker-openresty/alpine/Dockerfile (the recipe behind the official
# openresty/openresty:*-alpine images), with three deliberate deltas:
#   - the OpenResty source is the pinned master COMMIT (sha256-verified) instead
#     of a release tarball, assembled into a release tree by util/mirror-tarballs
#     (which fetches nginx 1.31.9 + every bundled component and applies the
#     OpenResty patch set — needs bash/perl/patch/wget/unix2dos/git);
#   - the OpenSSL cosocket-yield patch is pinned to the SAME commit, not master
#     HEAD, so the build is reproducible;
#   - -j$(nproc) instead of the recipe's conservative RESTY_J=1.
# perl stays installed at runtime (the resty CLI is perl; the official recipe
# drops it with .build-deps, which we don't need to replicate byte-for-byte).
RUN apk add --no-cache --virtual .build-deps \
        build-base binutils coreutils curl wget gd-dev geoip-dev libxslt-dev \
        linux-headers make perl-dev readline-dev zlib-dev bash patch dos2unix git \
    && apk add --no-cache gd geoip libgcc libxslt tzdata zlib perl \
    && apk add --no-cache --upgrade ca-certificates-bundle \
    && cd /tmp \
    # OpenSSL 3.5.8 + OpenResty's sess_set_get_cb_yield patch (cosocket TLS must
    # yield the worker; without it Lua HTTPS handshakes block).
    && curl -fSL "https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz" -o openssl-3.5.8.tar.gz \
    && tar xzf openssl-3.5.8.tar.gz && cd openssl-3.5.8 \
    && curl -fsSL "https://raw.githubusercontent.com/openresty/openresty/${OPENRESTY_COMMIT}/patches/openssl-3.5.5-sess_set_get_cb_yield.patch" | patch -p1 \
    && ./config shared zlib -g \
        --prefix=/usr/local/openresty/openssl3 --libdir=lib \
        -Wl,-rpath,/usr/local/openresty/openssl3/lib \
        enable-camellia enable-seed enable-rfc3779 enable-cms enable-md2 enable-rc5 \
        enable-weak-ssl-ciphers enable-ssl3 enable-ssl3-method enable-md2 enable-ktls enable-fips \
    && make -j"$(nproc)" && make -j"$(nproc)" install_sw \
    && cd /tmp \
    # PCRE2 10.49, the official recipe's pin + sha256 + options.
    && curl -fSL "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.49/pcre2-10.49.tar.gz" -o pcre2-10.49.tar.gz \
    && echo "929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae  pcre2-10.49.tar.gz" | shasum -a 256 --check \
    && tar xzf pcre2-10.49.tar.gz && cd pcre2-10.49 \
    && CFLAGS="-g -O3" ./configure \
        --prefix=/usr/local/openresty/pcre2 --libdir=/usr/local/openresty/pcre2/lib \
        --enable-jit --enable-pcre2grep-jit --disable-bsr-anycrlf --disable-coverage --disable-ebcdic --disable-fuzz-support \
        --disable-jit-sealloc --disable-never-backslash-C --enable-newline-is-lf --enable-pcre2-8 --enable-pcre2-16 --enable-pcre2-32 \
        --enable-pcre2grep-callout --enable-pcre2grep-callout-fork --disable-pcre2grep-libbz2 --disable-pcre2grep-libz --disable-pcre2test-libedit \
        --enable-percent-zt --disable-rebuild-chartables --enable-shared --disable-static --disable-silent-rules --enable-unicode --disable-valgrind \
    && CFLAGS="-g -O3" make -j"$(nproc)" && CFLAGS="-g -O3" make -j"$(nproc)" install \
    && cd /tmp \
    # OpenResty 1.31.9.1 (nginx 1.31.9) at the pinned commit.
    && curl -fSL "https://codeload.github.com/openresty/openresty/tar.gz/${OPENRESTY_COMMIT}" -o openresty-src.tar.gz \
    && echo "${OPENRESTY_SHA256}  openresty-src.tar.gz" | shasum -a 256 --check \
    && tar xzf openresty-src.tar.gz && cd "openresty-${OPENRESTY_COMMIT}" \
    && MIRROR_JOBS="$(nproc)" util/mirror-tarballs \
    && cd "openresty-$(util/ver)" \
    # The official RESTY_CONFIG_OPTIONS / _RESTY_CONFIG_DEPS / LUAJIT / PCRE flags.
    && ./configure -j"$(nproc)" \
        --with-pcre \
        --with-cc-opt='-DNGX_LUA_ABORT_AT_PANIC -I/usr/local/openresty/pcre2/include -I/usr/local/openresty/openssl3/include' \
        --with-ld-opt='-L/usr/local/openresty/pcre2/lib -L/usr/local/openresty/openssl3/lib -Wl,-rpath,/usr/local/openresty/pcre2/lib:/usr/local/openresty/openssl3/lib' \
        --with-compat \
        --without-http_rds_json_module \
        --without-http_rds_csv_module \
        --without-lua_rds_parser \
        --without-mail_pop3_module \
        --without-mail_imap_module \
        --without-mail_smtp_module \
        --with-http_addition_module \
        --with-http_auth_request_module \
        --with-http_dav_module \
        --with-http_flv_module \
        --with-http_geoip_module=dynamic \
        --with-http_gunzip_module \
        --with-http_gzip_static_module \
        --with-http_image_filter_module=dynamic \
        --with-http_mp4_module \
        --with-http_random_index_module \
        --with-http_realip_module \
        --with-http_secure_link_module \
        --with-http_slice_module \
        --with-http_ssl_module \
        --with-http_stub_status_module \
        --with-http_sub_module \
        --with-http_v2_module \
        --with-http_v3_module \
        --with-http_xslt_module=dynamic \
        --with-ipv6 \
        --with-mail \
        --with-mail_ssl_module \
        --with-md5-asm \
        --with-sha1-asm \
        --with-stream \
        --with-stream_ssl_module \
        --with-stream_ssl_preread_module \
        --with-threads \
        --with-luajit-xcflags='-DLUAJIT_NUMMODE=2 -DLUAJIT_ENABLE_LUA52COMPAT' \
        --with-pcre-jit \
    && make -j"$(nproc)" && make -j"$(nproc)" install \
    && cd /tmp && rm -rf openssl-3.5.8* pcre2-10.49* openresty-* \
    && apk del .build-deps \
    && mkdir -p /var/run/openresty \
    && ln -sf /dev/stdout /usr/local/openresty/nginx/logs/access.log \
    && ln -sf /dev/stderr /usr/local/openresty/nginx/logs/error.log

ENV PATH=$PATH:/usr/local/openresty/luajit/bin:/usr/local/openresty/nginx/sbin:/usr/local/openresty/bin

# The edge layer rides the built openresty (its runtime libs — gd/geoip/libxslt/
# zlib/libgcc — are already installed above, matching the official image).
FROM openresty-build

# certbot → managed TLS via http-01 STANDALONE: certbot binds a loopback alt-port
# (49180) transiently and the edge proxies /.well-known/acme-challenge/ to it
# (see nginx.conf) — zero downtime, no webroot, no port-80 fight.
# procps → `pkill` for the reload command's restart fallback.
# curl   → the mgmt-API exec transport (edge-management.ts execMgmt) reaches
#          127.0.0.1:9145 from INSIDE this container, since network_mode: host
#          puts that loopback out of the api container's reach.
# openssl → the CLI (the base image ships only the libraries) for the temporary
#           self-signed certs a domain serves until its real one is issued, so a
#           routed host never refuses a TLS handshake. See ensureBootstrapCert in
#           packages/adapters/src/infra/nginx.ts; without it that falls back to an
#           HTTP-only vhost, which is what Cloudflare reports as error 525.
# libmaxminddb → the C library geo_country.lua's FFI binding loads. WITHOUT IT
#           every country lookup returns nil: no per-country analytics is ever
#           recorded, and rules_guard.lua's country rules fail CLOSED (a country
#           ban blocks all traffic). It was never installed here, and the only
#           installer (installGeoDeps) probed apt/dnf/yum but never apk — so geo
#           has been silently dark on every containerized edge.
RUN apk add --no-cache certbot procps curl openssl libmaxminddb

# Openship Lua (rules engine + analytics + logging + webhook) plus the vendored
# maxminddb FFI binding. Baked in at the path lua_package_path resolves
# (`require "openship.rules_lib"`, `require "openship.maxminddb"` etc.).
COPY packages/adapters/src/infra/lua/ /usr/local/openresty/site/lualib/openship/

# GeoLite2-Country, from the copy we already vendor and already treat as the
# source of truth for the API's own lookups (apps/api/assets/geoip/README.md:
# "production reads this shipped copy — the running server never depends on a
# third-party mirror"). Baking it holds that line for the edge too: no runtime
# download, and nothing to lose when the container is recreated on upgrade.
# Refresh both copies together with `bun run update:geoip`.
COPY apps/api/assets/geoip/GeoLite2-Country.mmdb /usr/share/GeoIP/GeoLite2-Country.mmdb

# Complete config: shared dicts, lua path, ACME/default catch-all, the loopback
# management API, and the dynamic sites-enabled include. No runtime sed.
COPY apps/edge/nginx.conf /usr/local/openresty/nginx/conf/nginx.conf

# Create the shared-volume mount points so a first boot (before the api writes
# anything) still validates + starts.
RUN mkdir -p /usr/local/openresty/nginx/conf/sites-enabled /var/www/acme /etc/letsencrypt

# The placeholder certificate the :443 catch-all presents for hostnames this box
# does NOT route, so the handshake completes and the visitor gets the branded
# "service not found" page instead of ERR_SSL_UNRECOGNIZED_NAME_ALERT (Cloudflare
# reports that refusal as error 525). Nothing trusts this cert and nothing is meant
# to: it belongs to no domain, and the block that serves it is a dead end with no
# proxy_pass and no root, so it cannot become the cross-serving the 443
# default_server exists to prevent.
#
# Built HERE rather than at container start because nginx refuses to LOAD a config
# whose ssl_certificate is missing — a generate-on-boot step that failed would not
# degrade one page, it would crash-loop the whole edge and take every routed site on
# the box down with it. Baked into the image filesystem (not one of the bind mounts),
# so nothing on the host can mask or delete it either.
#
# EC P-256, not the RSA-2048 used for per-domain placeholders: refusing the
# handshake cost no asymmetric work at all, so serving a certificate here turns every
# connection to an unrouted host into a real signature — and the scenario this is for
# is wildcard DNS aimed at the box, i.e. unbounded hostnames all landing on this one
# block. P-256 keeps that ~10x cheaper than RSA. Kept identical to the bare edge's
# ensureEdgeDefaultCert so both paths present the same kind of key.
#
# The path is generated into nginx.conf from edgeDefaultCertPaths() in
# packages/adapters/src/infra/openresty-lua.ts — a test asserts this file still
# agrees with it.
RUN mkdir -p /usr/local/openresty/nginx/conf/openship-default-cert && \
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
      -subj /CN=openship-edge-default \
      -keyout /usr/local/openresty/nginx/conf/openship-default-cert/privkey.pem \
      -out /usr/local/openresty/nginx/conf/openship-default-cert/fullchain.pem && \
    chmod 600 /usr/local/openresty/nginx/conf/openship-default-cert/privkey.pem

# Fail the BUILD on a config the edge could not boot with, rather than shipping it.
# The catch-all's not-found page is a ~1.6 KB HTML body inlined in a `return`
# directive: one stray quote in it ends the token early and the whole config is
# invalid, which at runtime means a crash-looping edge (fresh container) or a
# reload that `openresty -t` refuses forever (existing one). This is the gate that
# turns both into a red build.
RUN openresty -t

EXPOSE 80 443
# Graceful OpenResty stop.
STOPSIGNAL SIGQUIT
CMD ["openresty", "-g", "daemon off;"]
