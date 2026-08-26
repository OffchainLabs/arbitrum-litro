ARG NODE_IMAGE=node:20-bullseye-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.3.5
ARG NITRO_IMAGE=offchainlabs/nitro-node:v3.9.5-66e42c4
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
COPY .testnode-context/export-config /opt/arbitrum-testnode/export-config
COPY .testnode-context/metadata.json /opt/arbitrum-testnode/metadata.json
COPY .testnode-context/runtime /opt/arbitrum-testnode/runtime
COPY .testnode-context/runtime-config /opt/arbitrum-testnode/runtime-config
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libstdc++6 \
	&& rm -rf /var/lib/apt/lists/*
RUN ln -s /opt/yarn-v1.22.22/bin/yarn /usr/local/bin/yarn
RUN chown -R user:user /opt/arbitrum-testnode/runtime /opt/arbitrum-testnode/runtime-config
RUN mkdir -p /tokenbridge-data && chown user:user /tokenbridge-data
USER user

EXPOSE 8545 8547 8548 8549 8550 8080

HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=10 \
	CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]
