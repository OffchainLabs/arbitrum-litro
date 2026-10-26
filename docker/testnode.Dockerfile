ARG NODE_IMAGE=node:26-bookworm-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.3.5
ARG NITRO_IMAGE=offchainlabs/nitro-node:v3.12.1-70fa99a
ARG BUNDLE_VERSION=dev
ARG BUNDLE_VARIANT=unknown

# No defaults on purpose: the contracts arrive through the `tokenbridge` build
# context, which a default cannot follow, so it would eventually label an image
# with a commit it does not contain. Callers pass them from external-pins.ts.
ARG NITRO_CONTRACTS_REF
ARG NITRO_CONTRACTS_COMMIT
ARG TOKENBRIDGE_REF
ARG TOKENBRIDGE_COMMIT

FROM scratch AS tokenbridge

FROM ${NODE_IMAGE} AS token-bridge-contracts

RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential ca-certificates git python3 \
	&& rm -rf /var/lib/apt/lists/*

# Node 26 images no longer bundle Yarn; the runtime stage copies this prefix.
RUN npm install -g --prefix /opt/yarn-v1.22.22 yarn@1.22.22 \
	&& ln -s /opt/yarn-v1.22.22/bin/yarn /usr/local/bin/yarn

WORKDIR /workspace

COPY --from=tokenbridge . /workspace

RUN rm -rf .git && \
	git init && \
	git add . && \
	git -c user.name="user" -c user.email="user@example.com" commit -m "Initial commit"

RUN yarn install --frozen-lockfile \
	&& yarn build \
	&& rm -rf .git node_modules/.cache

FROM ${FOUNDRY_IMAGE} AS foundry

FROM ${NITRO_IMAGE}

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

COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=token-bridge-contracts /usr/local/bin/node /usr/local/bin/node
COPY --from=token-bridge-contracts /opt/yarn-v1.22.22 /opt/yarn-v1.22.22
COPY --from=token-bridge-contracts --chown=user:user /workspace /workspace
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
COPY docker/sequencer-features.sh /opt/arbitrum-testnode/bin/sequencer-features.sh
COPY .testnode-context/export-config /opt/arbitrum-testnode/export-config
COPY .testnode-context/metadata.json /opt/arbitrum-testnode/metadata.json
COPY .testnode-context/runtime /opt/arbitrum-testnode/runtime
COPY .testnode-context/runtime-config /opt/arbitrum-testnode/runtime-config
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
	&& rm -rf /var/lib/apt/lists/*
RUN ln -s /opt/yarn-v1.22.22/bin/yarn /usr/local/bin/yarn
RUN chown -R user:user /opt/arbitrum-testnode/runtime /opt/arbitrum-testnode/runtime-config
RUN mkdir -p /tokenbridge-data && chown user:user /tokenbridge-data
USER user

EXPOSE 8545 8547 8548 8549 8550 8080 9642 9646

HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=10 \
	CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]
