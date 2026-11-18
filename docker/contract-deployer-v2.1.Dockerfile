FROM ghcr.io/foundry-rs/foundry:v1.3.1 AS foundry

# The caller must override this stage with
# `--build-context nitrocontracts=<nitro-contracts v2.1.3 Git context>`.
FROM scratch AS nitrocontracts

FROM node:20-trixie-slim AS nitro-builder

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/nitro-contracts

COPY --from=nitrocontracts . /workspace/nitro-contracts

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
