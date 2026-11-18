import {
	http,
	type Address,
	createPublicClient,
	createWalletClient,
	defineChain,
	parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const l1Chain = defineChain({
	id: 1337,
	name: "L1 Local",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const l2Chain = defineChain({
	id: 412346,
	name: "L2 Local",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: ["http://127.0.0.1:8547"] } },
});

const l3Chain = defineChain({
	id: 333333,
	name: "L3 Local",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: ["http://127.0.0.1:8549"] } },
});

function chainForRpc(rpcUrl: string) {
	if (rpcUrl.includes(":8547")) {
		return l2Chain;
	}
	if (rpcUrl.includes(":8549")) {
		return l3Chain;
	}
	return l1Chain;
}

export function publicClient(rpcUrl: string) {
	return createPublicClient({ chain: chainForRpc(rpcUrl), transport: http(rpcUrl) });
}

export function walletClient(rpcUrl: string, privateKey: `0x${string}`) {
	return createWalletClient({
		account: privateKeyToAccount(privateKey),
		chain: chainForRpc(rpcUrl),
		transport: http(rpcUrl),
	});
}

export const erc20Abi = parseAbi([
	"function balanceOf(address) view returns (uint256)",
	"function transfer(address, uint256) returns (bool)",
	"function approve(address, uint256) returns (bool)",
	"function deposit() payable",
]);

export const inboxAbi = parseAbi([
	"function depositEth() payable",
	"function depositERC20(uint256 amount) returns (uint256)",
]);

export const rollupAbi = parseAbi([
	"function baseStake() view returns (uint256)",
	"function amountStaked(address) view returns (uint256)",
	"function getStaker(address) view returns (uint256, bytes32, uint64, bool, address)",
	"function outbox() view returns (address)",
	"function rollupEventInbox() view returns (address)",
	"function challengeManager() view returns (address)",
	"function isValidator(address) view returns (bool)",
	"function setValidator(address[], bool[])",
	"function minimumAssertionPeriod() view returns (uint256)",
	"function setMinimumAssertionPeriod(uint256)",
]);

export const upgradeExecutorAbi = parseAbi(["function executeCall(address, bytes) payable"]);

export const arbOwnerAbi = parseAbi([
	"function addChainOwner(address)",
	"function removeChainOwner(address)",
]);

export const validatorWalletCreatorAbi = parseAbi([
	"function createWallet(address[]) returns (address)",
	"event WalletCreated(address indexed walletAddress, address indexed executorAddress, address indexed ownerAddress, address adminProxy)",
]);

export const validatorWalletAbi = parseAbi([
	"function executeTransactions(bytes[], address[], uint256[])",
]);

export const gatewayRouterAbi = parseAbi(["function getGateway(address) view returns (address)"]);

export const arbSysAbi = parseAbi([
	"function withdrawEth(address destination) payable returns (uint256)",
	"function sendMerkleTreeState() view returns (uint256 size, bytes32 root, bytes32[] partials)",
	"event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
]);

export const nodeInterfaceAbi = parseAbi([
	"function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)",
]);

export const outboxAbi = parseAbi([
	"function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
]);

export async function getBalanceWei(address: Address, rpcUrl: string): Promise<bigint> {
	return publicClient(rpcUrl).getBalance({ address });
}

export async function readContractOrZero(
	contractAddress: Address,
	abi: readonly unknown[],
	functionName: string,
	rpcUrl: string,
	args?: readonly unknown[],
): Promise<Address> {
	try {
		return (await publicClient(rpcUrl).readContract({
			address: contractAddress,
			abi,
			functionName,
			args,
		})) as Address;
	} catch {
		return "0x0000000000000000000000000000000000000000";
	}
}
