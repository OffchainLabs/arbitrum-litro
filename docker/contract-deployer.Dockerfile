FROM ghcr.io/foundry-rs/foundry:v1.3.1 AS foundry

# The caller must override this stage with
# `--build-context nitrocontracts=<local path or pinned Git context>`.
FROM scratch AS nitrocontracts

FROM node:26-trixie-slim AS nitro-builder

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
# Node 26 images no longer bundle Yarn.
RUN npm install -g yarn@1.22.22

WORKDIR /workspace/nitro-contracts

COPY --from=nitrocontracts . /workspace/nitro-contracts

RUN cp scripts/config.example.ts scripts/config.ts
RUN yarn install --frozen-lockfile
RUN yarn build:all

FROM node:26-trixie-slim

RUN npm install -g yarn@1.22.22

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

WORKDIR /workspace
COPY --from=nitro-builder /workspace/nitro-contracts /workspace/nitro-contracts
COPY deploy-rollup-creator.ts /workspace/nitro-contracts/scripts/local-deployment/deployRollupCreatorOnly.ts
COPY deploy-timeboost-auction.ts /workspace/nitro-contracts/scripts/local-deployment/deployTimeboostAuction.ts

WORKDIR /workspace/nitro-contracts
ENTRYPOINT ["yarn"]
