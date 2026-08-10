# Arbitrum Testnode

A snapshot-backed Arbitrum testnode that boots L1 + L2 + L3 with token bridges in seconds. Ships as both a local development CLI and a GitHub Action for CI.

## Quick Start

### One-Command Local L3

Use `start` when you want a disposable local `L1 + L2 + L3` stack from a published testnode image instead of rebuilding the full testnode locally. This is a local development path only; it does not deploy to Arbitrum Sepolia.

Minimal usage:

```bash
pnpm dev start
```

By default, `start` resolves the latest published `l3-eth` bundle:

```text
offchainlabs/arbitrum-litro:latest-l3-eth
```

Config-driven usage can pin a different image version:

```json
{
  "version": "v0.2.3",
  "l3Enabled": true
}
```

Save that as `testnode.start.json`, then run:

```bash
pnpm dev start
```

Optional config fields:

| Field | Default | Description |
|-------|---------|-------------|
| `version` | `latest` | Published bundle version override |
| `l3Enabled` | `true` | Boot the L3-enabled testnode |
| `feeTokenDecimals` | — | Custom L3 fee token decimals (`6`, `16`, `18`, `20`) |
| `nitroContractsVersion` | `v3.2` | Nitro contracts version tag component |
| `imageRepository` | `offchainlabs/arbitrum-litro` | testnode image repository |
| `containerName` | `arbitrum-testnode-<variant>` | Docker container name override |
| `outputDir` | `./.arbitrum-testnode/<version>/<variant>` | Export directory for config files |
| `startupTimeoutSeconds` | `120` | RPC readiness timeout |
| `timeboostEnabled` | `false` | Use the L2 Timeboost image variant and enable Timeboost sequencer args plus the `timeboost,auctioneer` HTTP APIs |
| `networkConfigPath` | — | One path or an array of paths to overwrite with `localNetwork.json` |
| `nitroImage` | — | Nitro image to rebase the testnode image onto before booting (see [Booting your own Nitro build](#booting-your-own-nitro-build)) |

Start exports config under `outputDir/config` and boots these host RPCs:

| Chain | URL |
|------|-----|
| L1 | `http://127.0.0.1:8545` |
| L2 | `http://127.0.0.1:8547` |
| L3 | `http://127.0.0.1:3347` |

### Docker image configuration

Set `TESTNODE_PARENT_CHAIN_POLL_INTERVAL` to a Go duration to override Nitro's parent-chain
polling interval when the container starts:

```bash
docker run \
  -e TESTNODE_PARENT_CHAIN_POLL_INTERVAL=100ms \
  offchainlabs/arbitrum-litro:<tag>
```

The value is applied to `node.parent-chain-reader.poll-interval`,
`execution.parent-chain-reader.poll-interval`, and
`node.delayed-sequencer.rescan-interval` in every runtime config included in the image. Both
L2-only and L2+L3 images are supported. Values such as `100ms`, `1s`, and `2.5s` are accepted;
Nitro validates the value when it starts. When the variable is unset, the bundled runtime configs
and existing polling behavior are unchanged.

### GitHub Action

```yaml
- uses: OffchainLabs/arbitrum-litro@v0.2.10
  with:
    version: v0.2.10
    l3-enabled: true
    timeboost-enabled: false
```

The default image repository is `offchainlabs/arbitrum-litro` on Docker Hub, which is
public, so no registry credentials are needed. `github-token` is only required when
`image-repository` points at a private registry, such as the GHCR package holding
releases up to `v0.2.10`:

```yaml
- uses: OffchainLabs/arbitrum-litro@v0.2.10
  with:
    version: v0.2.9
    image-repository: ghcr.io/offchainlabs/arbitrum-testnode-ci
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action starts a fully initialized testnode and exports environment variables for RPC URLs and contract addresses:

| Variable | Description |
|----------|-------------|
| `ARBITRUM_TESTNODE_L1_RPC_URL` | L1 (Anvil) RPC endpoint |
| `ARBITRUM_TESTNODE_L2_RPC_URL` | L2 (Nitro) RPC endpoint |
| `ARBITRUM_TESTNODE_L3_RPC_URL` | L3 (Orbit) RPC endpoint |
| `ARBITRUM_TESTNODE_LOCAL_NETWORK_PATH` | Path to `localNetwork.json` with all deployed contract addresses |
| `ARBITRUM_TESTNODE_CONFIG_DIR` | Directory with all exported config files |
| `ARBITRUM_TESTNODE_VARIANT` | Resolved variant name, such as `l3-eth` |

### Booting your own Nitro build

The published images bake a pinned Nitro in as their base layer, so by default a
consumer's CI exercises *that* Nitro rather than one it built itself. `nitro-image`
(action) / `nitroImage` (`start`) closes that gap: the resolved testnode image is
rebased onto the Nitro image you supply, and the rebased image is what boots.

This is what lets a Nitro PR check that the Nitro it just built actually starts
under the testnode's flags and config:

```yaml
- name: Build nitro-node-dev
  uses: docker/build-push-action@v6
  with:
    target: nitro-node-dev
    load: true
    context: .
    tags: nitro-node-dev:latest

- uses: OffchainLabs/arbitrum-litro@v0.2.10
  id: testnode
  with:
    version: v0.2.10
    nitro-image: nitro-node-dev:latest
```

Locally:

```bash
pnpm dev start --nitro-image nitro-node-dev:latest
```

How it works: `docker/testnode.Dockerfile` builds the published image as
`FROM ${NITRO_IMAGE}` plus a fixed set of testnode artifacts (anvil, the
token-bridge workspace, the entrypoint scripts, and the baked snapshot under
`/opt/arbitrum-testnode`). Because Nitro is the *base* layer,
`docker/testnode-rebase.Dockerfile` can graft exactly those artifacts onto a
different Nitro image. Registry behavior keys off the base image — the resolved
image is still pulled and authenticated as usual, and the rebased result is tagged
`local/arbitrum-testnode-rebase:<variant>-<digest>` — the digest covers the base
and Nitro refs, so different inputs get distinct tags — and is never pushed
or pulled. Each rebased image carries the `org.offchainlabs.testnode-rebase=true`
label, and every rebase first garbage-collects unused rebases older than a week
(`docker image prune --all --force --filter
"label=org.offchainlabs.testnode-rebase=true" --filter "until=168h"` — the same
command works standalone or on a schedule for a tighter bound). Images a
container still uses are never touched. The action exposes both refs as the
`base-image-ref` and `image-ref` outputs.

The Nitro image you supply must provide `/usr/local/bin/nitro`, a `user` account,
`python3`, `jq`, and `curl` (the container health check depends on it). The
`offchainlabs/nitro-node` images and Nitro's own `nitro-node-dev` target all
satisfy this.

Two caveats worth knowing:

- **Rebasing adds a build step.** The rebase is a thin, cached-friendly image
  build on top of two existing images, but it is not free the way a plain snapshot
  restore is.
- **It is a startup and compatibility check, not a proving check.** The snapshot's
  chain data and the `wasmModuleRoot` recorded on-chain come from the Nitro that
  produced the snapshot. The stack boots with the block validator disabled, so a
  module-root mismatch against your Nitro build does not block startup — but do
  not read a passing rebase run as validation of proving or of that module root.

### Embedded token-bridge-contracts workspace

The published testnode image also contains a prebuilt `token-bridge-contracts` workspace, so
consumers can run scripts from that workspace without another image or build step:

```yaml
- uses: OffchainLabs/arbitrum-litro@v0.2.10
  id: testnode
  with:
    version: v0.2.10

- name: Run contract deployment command
  run: |
    docker run --rm --network host \
      --workdir /workspace \
      --entrypoint yarn \
      -e BASECHAIN_RPC=http://127.0.0.1:8545 \
      -e BASECHAIN_DEPLOYER_KEY="$BASECHAIN_DEPLOYER_KEY" \
      -e BASECHAIN_WETH="$BASECHAIN_WETH" \
      -e GAS_LIMIT_FOR_L2_FACTORY_DEPLOYMENT=10000000 \
      -e POLLING_INTERVAL=100 \
      -e DISABLE_CONTRACT_VERIFICATION=true \
      offchainlabs/arbitrum-litro:v0.2.10-nc3.2-l2 \
      deploy:token-bridge-creator
```

The explicit entrypoint and working directory select the embedded workspace. Running the image
normally retains its single-purpose testnode entrypoint. `POLLING_INTERVAL=100` reduces JSON-RPC
polling to 100 ms for local deployments, while `DISABLE_CONTRACT_VERIFICATION=true` skips explorer
verification.

Snapshots built by `init --timeboost-enabled` deploy a local Timeboost `ExpressLaneAuction` contract on L2 and write its proxy address to `timeboost-auction.json`. The snapshot build starts a local compose Redis service only while building the snapshot. When `timeboost-enabled` / `timeboostEnabled` is true, the action and `start` command resolve the L2-only `l2-timeboost` image tag, for example `offchainlabs/arbitrum-litro:<version>-nc3.2-l2-timeboost`. The published image uses the deployed address by default; `TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS` can still override it. Published Timeboost stacks require an external Redis endpoint supplied through `TESTNODE_TIMEBOOST_REDIS_URL`; `start` and the action do not deploy Redis.

### Local Development

```bash
pnpm install
pnpm dev start           # Boot the published testnode image
pnpm dev init           # First run: deploys everything from scratch (~12 min)
pnpm dev init           # Subsequent runs: restores from snapshot (~10 sec)
pnpm dev stop           # Stop all services
pnpm dev clean          # Remove containers and saved data
pnpm dev status         # Show service and init state
```

## Custom snapshots

Downstream repos can bake their **own** testnode images: boot the base stack, run a
setup script against it (deploy contracts, seed activity, or add exported config),
then commit the customized state as a runnable Docker image. The stock CLI and GitHub
Action then boot those custom images.

### Setup-command environment contract

The setup command runs on the **host** against the already-booted base stack. It
receives these environment variables:

| Variable | Description |
|----------|-------------|
| `ARBITRUM_TESTNODE_L1_RPC_URL` | L1 (Anvil) RPC endpoint (`http://127.0.0.1:8545`) |
| `ARBITRUM_TESTNODE_L2_RPC_URL` | L2 (Nitro) RPC endpoint (`http://127.0.0.1:8547`) |
| `ARBITRUM_TESTNODE_L3_RPC_URL` | L3 (Orbit) RPC endpoint (`http://127.0.0.1:8549`) |
| `ARBITRUM_TESTNODE_CONFIG_DIR` | Exported config dir; files written here ride along into the customized image |
| `ARBITRUM_TESTNODE_DEPLOYMENT_JSON` | Path to the exported `deployment.json` in the config dir |

A non-zero exit from the setup command aborts the bake with a clear error.

### One-shot local bake

`testnode bake` boots the latest published bundle, runs the setup command, stops the
stack cleanly so Anvil and Nitro flush their state, and commits the container as the
custom image:

```bash
pnpm dev bake \
  --setup-command "./scripts/deploy-and-seed.sh" \
  --image-ref ghcr.io/acme/arbitrum-testnode:governance \
  --push            # optional; docker login is your responsibility
```

The bundle composes the runtime, initialized chain state, Nitro contracts, and Token
Bridge contracts. Consumers never clone or rebuild either contracts repository.
Override the published base with `--image-version` or `--base-image-ref`.

Local base development still supports prepared contracts workspaces through
`NITRO_CONTRACTS_LOCAL_DIR` and `TOKEN_BRIDGE_LOCAL_DIR`:

```bash
NITRO_CONTRACTS_LOCAL_DIR=../nitro-contracts pnpm dev init --rebuild
```

Those source settings are used only by `init` and release production. New releases
default to Nitro contracts v3.2.0 and the compatible pinned Token Bridge commit.

To bake straight from an existing snapshot (no setup step), use the à-la-carte
subcommand:

```bash
pnpm dev snapshot bake --id custom --image-ref ghcr.io/acme/arbitrum-testnode:governance --push
```

This path also layers the snapshot onto the latest published bundle; it does not
compile contract sources.

### CI bake via the composite action

The `bake` subdirectory action wraps the same flow. Registry login is the consumer's
job — log in before invoking it:

```yaml
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- uses: OffchainLabs/arbitrum-litro/bake@v0.2.6
  with:
    setup-command: ./scripts/deploy-and-seed.sh
    image-ref: ghcr.io/acme/arbitrum-testnode:governance
    push: true
    github-token: ${{ secrets.GITHUB_TOKEN }}   # published bundle pull
```

By default the action uses the latest composed bundle. Set `bundle-version` to pin a
release or `bundle-image-ref` to use another already-published bundle. There is no
consumer rebuild path.

### Booting a custom image

Both the CLI and the action accept a full `image-ref` that bypasses variant/version
tag resolution. Existing runtime options still govern ports and services, so set
L3, fee-token, and Timeboost options to match the contents of the custom image.
The CLI retains its L3-enabled default; the action retains its L2-only default.

Locally:

```bash
pnpm dev start --image-ref ghcr.io/acme/arbitrum-testnode:governance
```

In CI:

```yaml
- uses: OffchainLabs/arbitrum-litro@v0.2.6
  with:
    image-ref: ghcr.io/acme/arbitrum-testnode:governance
    l3-enabled: false
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Architecture

```
apps/
└── cli/                  # `testnode` CLI entry point and command parsing

packages/
├── core/                 # Chain, Docker, snapshot, bridge, state, and init helpers
├── testnode/             # Image resolution and Docker launcher helpers
└── action/               # Composite GitHub Action Node scripts

docker/                   # Testnode, token bridge, and compose assets
scripts/ci/               # Release image context preparation helpers
action.yml                # Root composite action contract (boot an image)
bake/action.yml           # Composite action for baking a custom image
```

## Published Variants

Published images are driven by the `VARIANTS` catalog exported by `@arbitrum/testnode`.
Each entry defines a named variant:

- `name`: the variant users select, and the final image tag suffix
- `snapshotId`: the local snapshot directory to install and bake into the image
- `hostPorts`: the host RPC ports exposed by `start` and the action
- `l3Enabled`: whether the image includes an L3 node
- `timeboostEnabled`: whether the variant automatically starts the L2 sequencer with Timeboost enabled

Cut a release with `pnpm release <version>`, which bumps every `package.json` and
tags in one step, then push. The tag and `apps/cli/package.json` must agree — the
tag names the published images while that file feeds `DEFAULT_START_IMAGE_VERSION`,
so a tag that runs ahead publishes images `start` will not default to. The publish
workflow fails fast if they disagree.

```bash
pnpm release 0.2.11          # bump + commit + tag
pnpm release 0.2.11 --push   # ...and push, starting the publish
```

The `Publish Testnode` workflow publishes automatically when a `v*` tag is pushed.
The Git tag becomes the image version, and every current v3.2 variant is published.
The workflow can also be run manually to publish one variant or `all`. Each build is
pushed to two registries under the same tag suffix:

```text
ghcr.io/<owner>/arbitrum-litro:<version>-nc<contracts-version>-<variant>
offchainlabs/arbitrum-litro:<version>-nc<contracts-version>-<variant>
```

Both carry identical images: the workflow builds once and pushes the same digest to
each. The Docker Hub repository is public, so pulling it needs no credentials; the
GHCR package is private and requires a token. Publishing requires the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets, and refuses to
replace a Docker Hub tag that already exists unless the manual run sets
`overwrite`.

After every variant succeeds, a tag-triggered release also updates the corresponding
`latest-<variant>` aliases, in both registries. These canonical aliases deliberately
omit a contracts version: consumers follow the composed bundle, while its exact Nitro
and Token Bridge refs and commits remain recorded as OCI labels.

Releases up to `v0.2.10` live in a separate GHCR package,
`ghcr.io/<owner>/arbitrum-testnode-ci`, which still serves those tags. Resolving one
needs `image-repository` plus a token, since that package is private.

Publish the default testnode image automatically:

```bash
git tag v0.2.3
git push origin v0.2.3
```

Publish one variant image from GitHub Actions:

```text
workflow: Publish Testnode
version: v0.2.3
variant: l3-eth
```

Publish every current catalog entry by setting `variant` to `all`. Existing v2.1
images remain resolvable but are not rebuilt by new releases.

The default Timeboost publish target is `l2-timeboost`; publish it directly with
`variant: l2-timeboost` or as part of `all`.

## Init Sequence

The `init` command runs 14 steps to deploy a complete L1 + L2 + L3 stack:

| # | Step | Description |
|---|------|-------------|
| 1 | `start-l1` | Start Anvil (L1) with the official testnode mnemonic |
| 2 | `wait-l1` | Wait for L1 RPC readiness |
| 3 | `deploy-l2-rollup` | Deploy L2 rollup contracts on L1 via RollupCreator |
| 4 | `generate-l2-config` | Generate Nitro node config for L2 |
| 5 | `start-l2` | Start L2 sequencer and validator (Docker) |
| 6 | `wait-l2` | Wait for L2 RPC readiness |
| 7 | `deposit-eth-to-l2` | Bridge ETH from L1 to L2 via inbox |
| 8 | `deploy-l2-token-bridge` | Deploy L1-L2 token bridge contracts |
| 9 | `deploy-l3-rollup` | Deploy L3 rollup contracts on L2 |
| 10 | `generate-l3-config` | Generate Nitro node config for L3 |
| 11 | `start-l3` | Start L3 node (Docker) |
| 12 | `wait-l3` | Wait for L3 RPC readiness |
| 13 | `deposit-eth-to-l3` | Bridge ETH from L2 to L3 via inbox |
| 14 | `deploy-l3-token-bridge` | Deploy L2-L3 token bridge contracts |

When `init --timeboost-enabled` is set, three Timeboost steps are inserted after `wait-l2`: `deploy-timeboost-auction`, `restart-l2-timeboost`, and `wait-l2-timeboost`.

State is persisted to `config/state.json` after each step, enabling automatic resume on failure.

## Chain Configuration

| Property | L1 | L2 | L3 |
|----------|----|----|-----|
| Chain ID | 1337 | 412346 | 333333 |
| Chain Name | — | arb-dev-test | orbit-dev-test |
| RPC Port | 8545 | 8547 | 8549 |
| Runtime | Anvil | Nitro (Docker) | Nitro (Docker) |

## Accounts

Derived from the official nitro-testnode mnemonic. All accounts are pre-funded on L1.

| Index | Role | Address |
|-------|------|---------|
| 0 | `funnel` (funder) | `0x3f1Eae7D46d88F08fc2F8ed27FCb2AB183EB2d0E` |
| 1 | `sequencer` (L2) | `0xe2148eE53c0755215Df69b2616E552154EdC584f` |
| 2 | `validator` (L2) | `0x6A568afe0f82d34759347bb36F14A6bB171d2CBe` |
| 3 | `l3owner` | `0x863c904166E801527125D8672442D736194A3362` |
| 4 | `l3sequencer` | `0x3E6134aAD4C4d422FF2A4391Dc315c4DDf98D1a5` |
| 5 | `l2owner` | `0x5E1497dD1f08C87b2d8FE23e9AAB6c1De833D927` |

## Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Conditional | — | Release version for catalog images; omit when `image-ref` is set |
| `image-ref` | No | — | Full image reference that bypasses catalog tag resolution |
| `nitro-image` | No | — | Nitro image to rebase the testnode image onto before booting |
| `l3-enabled` | No | `false` | Boot the L3-enabled testnode |
| `github-token` | No | — | Token for private GHCR images; unused for the public Docker Hub default |
| `image-repository` | No | `offchainlabs/arbitrum-litro` | Container image repository |
| `fee-token-decimals` | No | — | Custom fee token decimals (6, 16, 18, or 20) |
| `nitro-contracts-version` | No | `v3.2` | Nitro contracts version tag component |
| `output-dir` | No | — | Directory where exported config files should be written |
| `container-name` | No | — | Docker container name override |
| `startup-timeout-seconds` | No | `120` | Max wait time for RPC readiness |
| `timeboost-enabled` | No | `false` | Use the L2 Timeboost image variant and enable Timeboost sequencer args plus the `timeboost,auctioneer` HTTP APIs |
| `network-config-path` | No | — | Comma-separated path(s) to overwrite with exported `localNetwork.json` |

## Action Outputs

| Output | Description |
|--------|-------------|
| `image-ref` | Testnode image that was booted |
| `base-image-ref` | Testnode image that was resolved (and pulled when remote); the rebase source when `nitro-image` is set |
| `container-name` | Name of the booted testnode container |
| `config-dir` | Directory containing exported config files |
| `local-network-path` | Path to `localNetwork.json` |
| `l1l2-network-path` | Path to `l1l2_network.json` |
| `l2l3-network-path` | Path to `l2l3_network.json` |
| `l1-bridge-ui-config-path` | Path to the L1/L2 bridge UI config |
| `l2-bridge-ui-config-path` | Path to the L2/L3 bridge UI config |
| `l1-rpc-url` | Host RPC URL for L1 |
| `l2-rpc-url` | Host RPC URL for L2 |
| `l3-rpc-url` | Host RPC URL for L3 |
| `variant` | Resolved variant name |
| `nitro-contracts-version` | Resolved Nitro contracts version |

## Development

```bash
pnpm install              # Install dependencies
pnpm dev                  # Run CLI in dev mode (tsx)
pnpm build                # Build all workspace packages
pnpm test:run             # Run tests once
pnpm lint                 # Lint check (Biome)
pnpm lint:fix             # Auto-fix lint issues
pnpm typecheck            # Type check
pnpm validate             # Full validation (lint + build + typecheck + test)
```

## External Dependencies

- [Anvil](https://book.getfoundry.sh/anvil/) (Foundry) for L1
- [Nitro](https://github.com/OffchainLabs/nitro) node Docker images for L2/L3
- Docker for running Nitro nodes

## License

Apache-2.0
