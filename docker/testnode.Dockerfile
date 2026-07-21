ARG NODE_IMAGE=node:20-bullseye-slim
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.3.5
ARG NITRO_IMAGE=offchainlabs/nitro-node:v3.9.5-66e42c4

FROM ${NODE_IMAGE} AS token-bridge-contracts

RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential ca-certificates git python3 \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

RUN git init . \
	&& git remote add origin https://github.com/OffchainLabs/token-bridge-contracts.git \
	&& git fetch --depth 1 origin feat/polling-interval-conditional-verification \
	&& git checkout --detach FETCH_HEAD

RUN yarn install --frozen-lockfile \
	&& yarn build \
	&& rm -rf .git

FROM ${FOUNDRY_IMAGE} AS foundry

FROM ${NITRO_IMAGE}

COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=token-bridge-contracts /usr/local/bin/node /usr/local/bin/node
COPY --from=token-bridge-contracts /opt/yarn-v1.22.22 /opt/yarn-v1.22.22
COPY --from=token-bridge-contracts --chown=user:user /workspace /workspace
COPY --chmod=755 docker/testnode-entrypoint.sh /usr/local/bin/arbitrum-testnode
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
