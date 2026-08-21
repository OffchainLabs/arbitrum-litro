FROM scratch AS tokenbridge

FROM node:20-trixie-slim

RUN apt-get update && apt-get install -y git docker.io python3 make gcc g++ curl jq

WORKDIR /workspace

COPY --from=tokenbridge . /workspace

RUN rm -rf .git && \
	git init && \
	git add . && \
	git -c user.name="user" -c user.email="user@example.com" commit -m "Initial commit"

# The upstream token bridge scripts rely on gas estimation in two places that
# are flaky on the local L2->L3 path in this environment:
# - estimating max gas for deploying child-chain bridge contracts
# - estimating gas for direct contract creation on the parent chain
# Patch both sites to allow explicit overrides from this testnode.
RUN python3 - <<'PY'
from pathlib import Path

atomic_path = Path("/workspace/scripts/atomicTokenBridgeDeployer.ts")
atomic_source = atomic_path.read_text()
gas_needle = "  const maxGasForContracts = gasEstimateToDeployContracts.mul(2)\n"
gas_replacement = """  const maxGasForContracts =
    process.env['MAX_GAS_FOR_CONTRACTS'] !== undefined
      ? BigNumber.from(process.env['MAX_GAS_FOR_CONTRACTS'])
      : gasEstimateToDeployContracts.mul(2)
"""
if gas_needle not in atomic_source:
    raise SystemExit("expected maxGasForContracts line not found")
atomic_source = atomic_source.replace(gas_needle, gas_replacement, 1)
atomic_path.write_text(atomic_source)

creator_path = Path("/workspace/scripts/deployment/deployTokenBridgeCreator.ts")
creator_source = creator_path.read_text()
creator_import_needle = "import { BigNumber } from 'ethers'\n"
creator_import_replacement = "import { BigNumber, ethers } from 'ethers'\n"
if creator_import_needle not in creator_source:
    raise SystemExit("expected BigNumber import line not found")
creator_source = creator_source.replace(
    creator_import_needle,
    creator_import_replacement,
    1,
)
creator_needle = "  const l1Provider = new JsonRpcProvider(envVars.baseChainRpc)\n"
creator_replacement = """  const deployGasLimit = process.env['DEPLOY_GAS_LIMIT']
  if (deployGasLimit) {
    const fixedDeployGasLimit = BigNumber.from(deployGasLimit)
    const originalSendTransaction = ethers.Wallet.prototype.sendTransaction

    ethers.Wallet.prototype.sendTransaction = function (tx: any) {
      const nextTx =
        tx && (tx.to === undefined || tx.to === null) && tx.gasLimit === undefined
          ? { ...tx, gasLimit: fixedDeployGasLimit }
          : tx
      return originalSendTransaction.call(this, nextTx)
    }
  }

  const l1Provider = new JsonRpcProvider(envVars.baseChainRpc)
"""
if creator_needle not in creator_source:
    raise SystemExit("expected l1Provider line not found")
creator_source = creator_source.replace(creator_needle, creator_replacement, 1)
creator_path.write_text(creator_source)
PY

RUN yarn install && yarn cache clean
RUN yarn build

ENTRYPOINT ["yarn"]
