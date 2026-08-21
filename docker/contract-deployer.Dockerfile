FROM ghcr.io/foundry-rs/foundry:v1.3.1 AS foundry

# The caller must override this stage with
# `--build-context nitrocontracts=<local path or pinned Git context>`.
FROM scratch AS nitrocontracts

FROM node:20-trixie-slim AS nitro-builder

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/nitro-contracts

COPY --from=nitrocontracts . /workspace/nitro-contracts

RUN cp scripts/config.example.ts scripts/config.ts
RUN yarn install --frozen-lockfile
RUN yarn build:all

FROM node:20-trixie-slim AS token-bridge-builder

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

RUN apt-get update && \
    apt-get install -y git python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/token-bridge-contracts

RUN git init . \
    && git remote add origin https://github.com/OffchainLabs/token-bridge-contracts.git \
    && git fetch --depth 1 origin 5975d8f7360816341be7f94fd333ef240f4aec23 \
    && git checkout --detach FETCH_HEAD

RUN yarn install --frozen-lockfile
RUN yarn build

FROM node:20-trixie-slim

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

WORKDIR /workspace
COPY --from=nitro-builder /workspace/nitro-contracts /workspace/nitro-contracts
COPY --from=token-bridge-builder /workspace/token-bridge-contracts /workspace/token-bridge-contracts
COPY deploy-rollup-creator.ts /workspace/nitro-contracts/scripts/local-deployment/deployRollupCreatorOnly.ts
COPY deploy-timeboost-auction.ts /workspace/nitro-contracts/scripts/local-deployment/deployTimeboostAuction.ts

WORKDIR /workspace/nitro-contracts
ENTRYPOINT ["yarn"]
