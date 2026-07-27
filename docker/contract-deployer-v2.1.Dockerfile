# Nitro-contracts source is selectable so consumers can bake an image against
# their own branch/commit (NITRO_CONTRACTS_BRANCH) or a local checkout
# (NITRO_CONTRACTS_SOURCE=local + `--build-context nitrocontracts=<dir>`).
# Defaults reproduce the pinned upstream v2.1 commit.
ARG NITRO_CONTRACTS_SOURCE=git
ARG NITRO_CONTRACTS_BRANCH=f9cd1aa4b5bba209211e8df9993e0eba89eaedda

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

RUN cp scripts/config.ts.example scripts/config.ts
RUN yarn install --frozen-lockfile
# Hardhat compile produces the Solidity artifacts the deploy script consumes
# (hardhat run --no-compile). The forge SOL build is skipped because
# nitro-contracts v2.1.3 (Feb 2025) won't compile under foundry v1.3.1, but the
# forge YUL build is still required: deploymentUtils.ts loads the yul artifact
# out/yul/Reader4844.yul/Reader4844.json (compiled from yul/Reader4844.yul).
# forge v1.3.1 compiles the yul artifact successfully but then exits non-zero
# with a spurious "no Solidity sources" (because --skip *.sol leaves no .sol
# sources). Tolerate that exit, then assert the artifact was actually produced.
RUN yarn build && (yarn build:forge:yul || true) && test -f out/yul/Reader4844.yul/Reader4844.json

FROM node:20-trixie-slim

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

WORKDIR /workspace
COPY --from=nitro-builder /workspace/nitro-contracts /workspace/nitro-contracts
COPY deploy-rollup-creator-v2.1.ts /workspace/nitro-contracts/scripts/local-deployment/deployRollupCreatorOnly.ts

WORKDIR /workspace/nitro-contracts
ENTRYPOINT ["yarn"]
