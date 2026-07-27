# Nitro-contracts source is selectable so consumers can bake an image against
# their own branch/commit (NITRO_CONTRACTS_BRANCH) or a local checkout
# (NITRO_CONTRACTS_SOURCE=local + `--build-context nitrocontracts=<dir>`).
# Defaults reproduce the pinned upstream commit.
ARG NITRO_CONTRACTS_SOURCE=git
ARG NITRO_CONTRACTS_BRANCH=cd4eb69e3c4cb87161b1433ad238902ea5c32ebd

FROM ghcr.io/foundry-rs/foundry:v1.3.1 AS foundry

# Source stage: fetch nitro-contracts from git at the requested ref.
FROM node:20-trixie-slim AS nitro-src-git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/nitro-contracts
ARG NITRO_CONTRACTS_BRANCH
RUN git init . \
    && git remote add origin https://github.com/OffchainLabs/nitro-contracts.git \
    && git fetch --depth 1 origin "$NITRO_CONTRACTS_BRANCH" \
    && git checkout --detach FETCH_HEAD \
    && git submodule update --init --recursive --depth 1

# Fallback for builds without a named context. Passing
# `--build-context nitrocontracts=<dir>` overrides this same-named stage.
FROM scratch AS nitrocontracts

# Source stage: use a local checkout supplied via `--build-context nitrocontracts=<dir>`.
FROM node:20-trixie-slim AS nitro-src-local
WORKDIR /workspace/nitro-contracts
COPY --from=nitrocontracts . /workspace/nitro-contracts

# Select the active source (git by default, local when NITRO_CONTRACTS_SOURCE=local).
FROM nitro-src-${NITRO_CONTRACTS_SOURCE} AS nitro-src

FROM node:20-trixie-slim AS nitro-builder

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/nitro-contracts

COPY --from=nitro-src /workspace/nitro-contracts /workspace/nitro-contracts

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
