ARG NODE_IMAGE=node:26-bookworm-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.3.5
# slim-stripped: the same nitro build without debug symbols, 30 MB compressed instead of 98 MB.
ARG NITRO_IMAGE=offchainlabs/nitro-node:v3.12.4-960ca0a-slim-stripped
# Must match the Debian release NITRO_IMAGE is built on: the copied nitro binary
# links its glibc.
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG BUNDLE_VERSION=dev
ARG BUNDLE_VARIANT=unknown

# No defaults on purpose: these label the contracts the snapshot in
# .testnode-context was deployed from, which a default cannot follow, so it would
# eventually label an image with a commit it does not contain. Callers pass them
# from external-pins.ts.
ARG NITRO_CONTRACTS_REF
ARG NITRO_CONTRACTS_COMMIT
ARG TOKENBRIDGE_REF
ARG TOKENBRIDGE_COMMIT

FROM ${NODE_IMAGE} AS node

FROM ${FOUNDRY_IMAGE} AS foundry

FROM ${NITRO_IMAGE} AS nitro

# Not FROM ${NITRO_IMAGE}: that image carries ~1.2 GB of tools, contracts and
# binaries the testnode never runs. Only the nitro binary is taken: the validators
# run without a block validator, so the WASM module roots (314 MB) go unused.
FROM ${RUNTIME_IMAGE}

ARG BUNDLE_VERSION
ARG BUNDLE_VARIANT
ARG NITRO_CONTRACTS_REF
ARG NITRO_CONTRACTS_COMMIT
ARG TOKENBRIDGE_REF
ARG TOKENBRIDGE_COMMIT
ARG IMAGE_SOURCE="https://github.com/OffchainLabs/arbitrum-litro"

# GHCR links a package to a repository through image.source; without it the
# package starts orphaned and this repository's workflows lose access.
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
	io.arbitrum.testnode.bundle.version="${BUNDLE_VERSION}" \
	io.arbitrum.testnode.bundle.variant="${BUNDLE_VARIANT}" \
	io.arbitrum.testnode.nitro-contracts.ref="${NITRO_CONTRACTS_REF}" \
	io.arbitrum.testnode.nitro-contracts.commit="${NITRO_CONTRACTS_COMMIT}" \
	io.arbitrum.testnode.token-bridge.ref="${TOKENBRIDGE_REF}" \
	io.arbitrum.testnode.token-bridge.commit="${TOKENBRIDGE_COMMIT}"

# The first install is what the copied node binary links; testnode-rebase.Dockerfile
# probes for exactly these. The second is what the scripts and consumers run in
# the container (curl, jq, python3; pgrep from procps), which the Nitro images
# the rebase targets already carry.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
	&& apt-get install -y --no-install-recommends ca-certificates curl jq procps python3 \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd -m -s /bin/bash user \
	&& mkdir -p /tokenbridge-data && chown user:user /tokenbridge-data

COPY --from=nitro /usr/local/bin/nitro /usr/local/bin/nitro
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --chmod=755 docker/testnode-entrypoint.sh /usr/local/bin/arbitrum-testnode
COPY docker/configure-parent-chain-poll-interval.mjs /usr/local/bin/configure-parent-chain-poll-interval.mjs
COPY --chmod=755 docker/testnode-healthcheck.sh /usr/local/bin/healthcheck.sh
COPY docker/testnode-server.py /usr/local/bin/config-server.py
# Sequencer feature helpers (Timeboost, Fast Feed, PGA) live under /opt/arbitrum-testnode, which
# testnode-rebase.Dockerfile copies whole, so an image rebased onto another Nitro keeps them.
COPY --from=foundry /usr/local/bin/cast /opt/arbitrum-testnode/bin/cast
COPY docker/fast-feed-relay.mjs /opt/arbitrum-testnode/bin/fast-feed-relay.mjs
COPY --chmod=755 docker/configure-pga.sh /opt/arbitrum-testnode/bin/configure-pga.sh
COPY docker/configure-sequencer.mjs /opt/arbitrum-testnode/bin/configure-sequencer.mjs
COPY docker/processes.sh /opt/arbitrum-testnode/bin/processes.sh
COPY docker/sequencer-features.sh /opt/arbitrum-testnode/bin/sequencer-features.sh
COPY docker/observability.sh /opt/arbitrum-testnode/bin/observability.sh
COPY docker/chain-exporter.mjs /opt/arbitrum-testnode/bin/chain-exporter.mjs
COPY .testnode-context/export-config /opt/arbitrum-testnode/export-config
COPY .testnode-context/metadata.json /opt/arbitrum-testnode/metadata.json
COPY --chown=user:user .testnode-context/runtime /opt/arbitrum-testnode/runtime
COPY --chown=user:user .testnode-context/runtime-config /opt/arbitrum-testnode/runtime-config
RUN nitro --version && node --version && anvil --version
USER user
WORKDIR /home/user

EXPOSE 8545 8547 8548 8549 8550 8080 9642 9646 6070-6075 6080

# --start-interval probes every 250ms until the first pass, so healthy follows readiness instead of
# the next 3s tick. Docker Engine < 25 ignores it and probes every 3s.
HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --start-interval=250ms --retries=10 \
	CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]
