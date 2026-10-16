/**
 * Public configuration for ReliefLedger.
 *
 * EVERYTHING IN THIS FILE IS PUBLIC. It ships to every visitor's browser. Never put a
 * private key, seed phrase, mnemonic or API secret here, and never put one in a Vercel
 * environment variable that the frontend reads, because those are public too.
 *
 * The site runs in one of three modes, decided at load time:
 *
 *   demo   fundAddress is blank. Clearly labelled sample data is shown so the interface can
 *          be explored before any contract exists. No sample value is ever mixed into a
 *          figure presented as on-chain.
 *   live   fundAddress is set and reachable. Every number comes from the chain.
 *   error  fundAddress is set but unreachable. An error and a retry are shown. The site
 *          never silently falls back to sample data, because a visitor could not tell the
 *          difference and would be misled about real money.
 *
 * To go live: deploy the contracts (see docs/DEPLOYMENT.md), paste the addresses below,
 * commit, and redeploy. Addresses can also be supplied at runtime via URL query parameters
 * (?fund=0x...&token=0x...&dao=0x...) which is handy for testing a redeployment without a
 * new commit. Query parameters never override a configured address unless it is blank.
 */
window.RELIEF_CONFIG = {
  /* ---------------------------------------------------------------------
   * Contract addresses. Leave blank to run in demo mode.
   * ------------------------------------------------------------------ */
  fundAddress: "0xAedb8b6c3d49eD78493C244978a413594CDB3446",
  tokenAddress: "0xe99dD8A957b2A087cD38AF56f9656754421d6F00",
  daoAddress: "0x010b44fd470432D3615125f3d5932d5b7d188e70",

  /* ---------------------------------------------------------------------
   * Network: Ethereum Sepolia (public test network).
   * Chain ID 11155111 (0xaa36a7). Native coin is Sepolia ETH, which has no
   * monetary value. MetaMask includes Sepolia; enable "Show test networks".
   * To use Polygon Amoy instead, set chainId 80002, chainIdHex "0x13882",
   * networkName "Polygon Amoy", symbol "POL" and the Amoy RPC and explorer.
   * ------------------------------------------------------------------ */
  chainId: 11155111,
  chainIdHex: "0xaa36a7",
  networkName: "Ethereum Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },

  /**
   * Read-only RPC used before a wallet is connected. Public endpoints rate-limit
   * and restrict block ranges; if history fails to load, try another from the
   * fallback list or add your own provider URL (it is public, so no secrets).
   */
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  fallbackRpcUrls: [
    "https://sepolia.drpc.org",
    "https://1rpc.io/sepolia",
  ],

  explorerUrl: "https://sepolia.etherscan.io",

  /* ---------------------------------------------------------------------
   * Event history. Public RPCs reject unbounded eth_getLogs ranges, so history is
   * fetched in chunks walking backwards from the current head rather than from
   * block 0 in one request.
   * ------------------------------------------------------------------ */
  eventChunkSize: 2000,
  eventMaxChunks: 25,

  /** Milliseconds between dashboard refreshes. Raise it if you hit RPC rate limits. */
  pollIntervalMs: 30000,

  /**
   * Block the contracts were deployed in. Setting this stops history queries from
   * walking back further than necessary. Leave 0 if unknown.
   */
  deploymentBlock: 0,
};
