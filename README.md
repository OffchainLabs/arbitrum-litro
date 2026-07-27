# Arbitrum Testnode

A snapshot-backed Arbitrum testnode that boots L1 + L2 + L3 with token bridges in seconds. Ships as both a local development CLI and a GitHub Action for CI.

## Quick Start

### One-Command Local L3

Use `start` when you want a disposable local `L1 + L2 + L3` stack from a published testnode image instead of rebuilding the full testnode locally. This is a local development path only; it does not deploy to Arbitrum Sepolia.

Minimal usage:

```bash
pnpm dev start
```

By default, `start` uses the CLI package version as the image version and resolves the `l3-eth` variant image:

```text
ghcr.io/offchainlabs/arbitrum-testnode-ci:v0.2.5-nc3.2-l3-eth
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
| `version` | CLI package version | Testnode image release version override |
| `l3Enabled` | `true` | Boot the L3-enabled testnode |
| `feeTokenDecimals` | — | Custom L3 fee token decimals (`6`, `16`, `18`, `20`) |
| `nitroContractsVersion` | `v3.2` | Nitro contracts version tag component |
| `imageRepository` | `ghcr.io/offchainlabs/arbitrum-testnode-ci` | testnode image repository |
| `containerName` | `arbitrum-testnode-<variant>` | Docker container name override |
| `outputDir` | `./.arbitrum-testnode/<version>/<variant>` | Export directory for config files |
| `startupTimeoutSeconds` | `120` | RPC readiness timeout |
| `timeboostEnabled` | `false` | Use the L2 Timeboost image variant and enable Timeboost sequencer args plus the `timeboost,auctioneer` HTTP APIs |
| `networkConfigPath` | — | One path or an array of paths to overwrite with `localNetwork.json` |

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
  ghcr.io/offchainlabs/arbitrum-testnode-ci:<tag>
```

The value is applied to `node.parent-chain-reader.poll-interval`,
`execution.parent-chain-reader.poll-interval`, and
`node.delayed-sequencer.rescan-interval` in every runtime config included in the image. Both
L2-only and L2+L3 images are supported. Values such as `100ms`, `1s`, and `2.5s` are accepted;
Nitro validates the value when it starts. When the variable is unset, the bundled runtime configs
and existing polling behavior are unchanged.

### GitHub Action

```yaml
- uses: OffchainLabs/arbitrum-testnode@v0.1.0
  with:
    version: v0.1.0
    l3-enabled: true
    timeboost-enabled: false
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

### Embedded token-bridge-contracts workspace

The published testnode image also contains a prebuilt `token-bridge-contracts` workspace, so
consumers can run scripts from that workspace without another image or build step:

```yaml
- uses: OffchainLabs/arbitrum-testnode@v0.2.10
  id: testnode
  with:
    version: v0.2.10
    github-token: ${{ secrets.GITHUB_TOKEN }}

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
      ghcr.io/offchainlabs/arbitrum-testnode-ci:v0.2.10-nc3.2-l2 \
      deploy:token-bridge-creator
```

The explicit entrypoint and working directory select the embedded workspace. Running the image
normally retains its single-purpose testnode entrypoint. `POLLING_INTERVAL=100` reduces JSON-RPC
polling to 100 ms for local deployments, while `DISABLE_CONTRACT_VERIFICATION=true` skips explorer
verification.

Snapshots built by `init --timeboost-enabled` deploy a local Timeboost `ExpressLaneAuction` contract on L2 and write its proxy address to `timeboost-auction.json`. The snapshot build starts a local compose Redis service only while building the snapshot. When `timeboost-enabled` / `timeboostEnabled` is true, the action and `start` command resolve the L2-only `l2-timeboost` image tag, for example `ghcr.io/offchainlabs/arbitrum-testnode-ci:v0.2.2-nc3.2-l2-timeboost`. The published image uses the deployed address by default; `TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS` can still override it. Published Timeboost stacks require an external Redis endpoint supplied through `TESTNODE_TIMEBOOST_REDIS_URL`; `start` and the action do not deploy Redis.

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
setup script against it (deploy contracts, seed activity, drop extra files into the
config dir), snapshot the result, and build a runnable Docker image. The stock CLI and
GitHub Action then boot those custom images.

### Setup-command environment contract

The setup command runs on the **host** against the already-booted base stack. It
receives these environment variables:

| Variable | Description |
|----------|-------------|
| `ARBITRUM_TESTNODE_L1_RPC_URL` | L1 (Anvil) RPC endpoint (`http://127.0.0.1:8545`) |
| `ARBITRUM_TESTNODE_L2_RPC_URL` | L2 (Nitro) RPC endpoint (`http://127.0.0.1:8547`) |
| `ARBITRUM_TESTNODE_L3_RPC_URL` | L3 (Orbit) RPC endpoint (`http://127.0.0.1:8549`) |
| `ARBITRUM_TESTNODE_CONFIG_DIR` | Config dir; files written here ride along into the snapshot and config export |
| `ARBITRUM_TESTNODE_DEPLOYMENT_JSON` | Path to the exported `deployment.json` in the config dir |

A non-zero exit from the setup command aborts the bake with a clear error.

### One-shot local bake

`testnode bake` boots the base stack (by default it restores the installed base
snapshot; `--rebuild` runs a full init instead), runs the setup command, captures a
snapshot, and builds the image:

```bash
pnpm dev bake \
  --setup-command "./scripts/deploy-and-seed.sh" \
  --image-ref ghcr.io/acme/arbitrum-testnode:governance \
  --snapshot-id custom \
  --push            # optional; docker login is your responsibility
```

When rebuilding, `init` and `bake` can build the contract-deployer image from a
nitro-contracts branch, tag, or commit instead of the Dockerfile's pinned commit:

```bash
pnpm dev init --rebuild --nitro-contracts-branch feature/my-change
pnpm dev bake --rebuild \
  --nitro-contracts-branch feature/my-change \
  --setup-command "./scripts/deploy-and-seed.sh" \
  --image-ref ghcr.io/acme/arbitrum-testnode:governance
```

For local development, set `NITRO_CONTRACTS_LOCAL_DIR` to a nitro-contracts checkout.
The local checkout takes precedence over `--nitro-contracts-branch`. The
`--nitro-contracts-version` option still selects the v2.1 or v3.2 deployer recipe;
the source override only replaces the checkout used by that recipe.

To bake straight from an existing snapshot (no setup step), use the à-la-carte
subcommand:

```bash
pnpm dev snapshot bake --id custom --image-ref ghcr.io/acme/arbitrum-testnode:governance --push
```

### CI bake via the composite action

The `bake` subdirectory action wraps the same flow. Registry login is the consumer's
job — log in before invoking it:

```yaml
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- uses: OffchainLabs/arbitrum-testnode/bake@v0.2.6
  with:
    setup-command: ./scripts/deploy-and-seed.sh
    image-ref: ghcr.io/acme/arbitrum-testnode:governance
    push: true
    github-token: ${{ secrets.GITHUB_TOKEN }}   # base snapshot download
```

By default the action installs a base snapshot release (via `github-token`) and
restores it; set `rebuild: true` to run a full init instead. Rebuilds also accept
`nitro-contracts-branch`, `nitro-contracts-version`, and `fee-token-decimals`.

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
- uses: OffchainLabs/arbitrum-testnode@v0.2.6
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

The `Publish Testnode` workflow publishes automatically when a `v*` tag is pushed.
Tag-triggered publishes use the `default` entry in `config/testnodes.json`, with the
Git tag as the image version. The workflow can also be run manually to publish one
variant or `all`. It builds image tags as:

```text
ghcr.io/<owner>/arbitrum-testnode-ci:<version>-nc<contracts-version>-<variant>
```

The `snapshot-version` workflow input provides the snapshot release tag used for every selected variant.
For automatic tag publishes, the snapshot release tag comes from `config/testnodes.json`.

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
nitro-contracts-version: v3.2
snapshot-version: v0.1.6
```

Publish every catalog entry by setting `variant` to `all`. Publish every supported Nitro contracts tag by setting `nitro-contracts-version` to `all`.

The default Timeboost publish target is `l2-timeboost`, which expects the `l2-timeboost` snapshot ID in the selected snapshot release. It can be published directly with `variant: l2-timeboost` or through the `name: timeboost` entry in `config/testnodes.json`.

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
| `l3-enabled` | No | `false` | Boot the L3-enabled testnode |
| `github-token` | No | — | Token for GHCR authentication |
| `image-repository` | No | `ghcr.io/offchainlabs/arbitrum-testnode-ci` | Container image repository |
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
