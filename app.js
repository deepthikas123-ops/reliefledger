/**
 * ReliefLedger application logic.
 *
 * Structure, roughly top to bottom:
 *   1. formatting and DOM helpers
 *   2. application state
 *   3. notices, toasts and confirmation
 *   4. blockchain access (provider, wallet, contracts, reads, event history)
 *   5. demo-mode data loading
 *   6. views
 *   7. actions (write transactions)
 *   8. router and startup
 *
 * Blockchain access is kept in section 4 and nothing below it talks to ethers directly
 * except through those functions, so the rendering code works identically on live data and
 * on sample data.
 *
 * Browser validation here is for usability only. The smart contract is the security
 * boundary: anything the interface prevents, the contract also prevents.
 */
(function () {
  "use strict";

  const CFG = window.RELIEF_CONFIG;
  const SYM = CFG.nativeCurrency.symbol; // native coin label, driven by config.js
  const ABI = window.RELIEF_ABI;
  const DEMO = window.RELIEF_DEMO;

  const CATEGORIES = ["Food", "Medical", "Shelter", "Rescue", "Rebuilding", "Other"];

  /* ===========================================================================
     1. Helpers
     ======================================================================== */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Escapes text before it goes anywhere near innerHTML. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * Formats wei as POL. Uses ethers' string formatting rather than Number arithmetic,
   * because 18-decimal values exceed the precision of a JavaScript double and would be
   * silently rounded.
   */
  function pol(wei, decimals) {
    if (wei == null) return "—";
    const dp = decimals == null ? 4 : decimals;
    const s = ethers.formatEther(wei);
    const [whole, frac = ""] = s.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const trimmed = frac.slice(0, dp).replace(/0+$/, "");
    return trimmed ? `${grouped}.${trimmed}` : grouped;
  }

  const polUnit = (wei, dp) => `${pol(wei, dp)} ${SYM}`;

  /** Formats a USD value carried with 8 decimals. */
  function usd(value8) {
    if (value8 == null) return null;
    const s = ethers.formatUnits(value8, 8);
    const n = Number(s);
    if (!isFinite(n)) return null;
    return n.toLocaleString("en-US", {
      style: "currency", currency: "USD",
      minimumFractionDigits: n >= 100 ? 0 : 2,
      maximumFractionDigits: n >= 100 ? 0 : 2,
    });
  }

  const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");

  function timeAgo(ts) {
    if (!ts) return "—";
    const diff = Math.floor(Date.now() / 1000) - Number(ts);
    if (diff < 0) return "just now";
    const units = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (const [secs, name] of units) {
      if (diff >= secs) {
        const n = Math.floor(diff / secs);
        return `${n} ${name}${n === 1 ? "" : "s"} ago`;
      }
    }
    return "moments ago";
  }

  const dateStr = (ts) =>
    ts ? new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

  /** Human countdown to a future unix timestamp. */
  function countdown(target) {
    const left = Number(target) - Math.floor(Date.now() / 1000);
    if (left <= 0) return null;
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  const txLink = (hash) => `${CFG.explorerUrl}/tx/${hash}`;
  const addrLink = (a) => `${CFG.explorerUrl}/address/${a}`;

  function explorerAddr(a, label) {
    if (!a) return "—";
    if (state.mode === "demo") return `<span class="addr">${esc(shortAddr(a))}</span>`;
    return `<a class="addr" href="${esc(addrLink(a))}" target="_blank" rel="noopener noreferrer">${esc(label || shortAddr(a))}</a>`;
  }

  /** Percentage of target reached, clamped for the bar but not for the label. */
  function pct(raisedUsd8, targetUsd8) {
    if (raisedUsd8 == null || !targetUsd8 || targetUsd8 === 0n) return null;
    return Number((raisedUsd8 * 10000n) / targetUsd8) / 100;
  }

  /* ===========================================================================
     2. State
     ======================================================================== */

  const state = {
    mode: "loading",       // loading | demo | live | error
    errorMessage: "",
    provider: null,        // read-only JsonRpcProvider
    browserProvider: null, // wallet
    signer: null,
    account: null,
    walletChainId: null,
    wrongNetwork: false,
    contracts: { fund: null, token: null, dao: null },
    addresses: { fund: "", token: "", dao: "" },
    priceUsd8: null,       // USD per 1 native coin, 8 decimals, or null if the oracle is unavailable
    data: null,
    wallet: { balance: null, tokenBalance: null, votes: null, delegate: null, isSigner: false },
    loading: false,
    pollTimer: null,
    tickTimer: null,
    route: "/overview",
  };

  /** Query parameters can supply addresses when config leaves them blank. */
  function resolveAddresses() {
    const q = new URLSearchParams(window.location.search);
    const pick = (cfgValue, key) => {
      const v = (cfgValue || "").trim() || (q.get(key) || "").trim();
      if (!v) return "";
      return ethers.isAddress(v) ? ethers.getAddress(v) : "";
    };
    state.addresses = {
      fund: pick(CFG.fundAddress, "fund"),
      token: pick(CFG.tokenAddress, "token"),
      dao: pick(CFG.daoAddress, "dao"),
    };
  }

  /* ===========================================================================
     3. Notices, toasts, confirmation
     ======================================================================== */

  function renderNotices() {
    const host = $("#notices");
    const parts = [];

    if (state.mode === "demo") {
      parts.push(`
        <div class="banner banner--demo">
          <h3>Sample data — not live blockchain data</h3>
          <p>No contract address is configured, so this page is showing made-up figures to
          demonstrate the interface. Nothing here reflects any real donation or payout.
          Deploy the contracts and set <code>fundAddress</code> in <code>config.js</code> to
          switch to live mode.</p>
        </div>`);
    }

    if (state.mode === "error") {
      parts.push(`
        <div class="banner banner--error">
          <h3>Cannot reach the contract</h3>
          <p>${esc(state.errorMessage || "The configured contract did not respond.")}</p>
          <div class="banner__actions">
            <button class="btn btn--small" data-action="retry">Try again</button>
          </div>
        </div>`);
    }

    if (state.wrongNetwork) {
      parts.push(`
        <div class="banner banner--warn">
          <h3>Wallet is on the wrong network</h3>
          <p>Your wallet is connected to chain ${esc(state.walletChainId)}, but this site uses
          ${esc(CFG.networkName)} (chain ${esc(CFG.chainId)}). Reading works, but transactions
          will fail until you switch.</p>
          <div class="banner__actions">
            <button class="btn btn--small" data-action="switch-network">Switch to ${esc(CFG.networkName)}</button>
          </div>
        </div>`);
    }

    if (state.mode === "live" && state.data && state.data.stats.paused) {
      parts.push(`
        <div class="banner banner--warn">
          <h3>The contract is paused</h3>
          <p>A signer has paused the fund. Donations and disbursements are stopped. The full
          record below stays readable.</p>
        </div>`);
    }

    if (state.mode === "live" && state.priceUsd8 == null) {
      parts.push(`
        <div class="banner banner--warn">
          <h3>Price feed unavailable</h3>
          <p>The Chainlink price feed did not return a usable answer, so US dollar values and
          progress percentages are hidden. ${SYM} amounts are unaffected, and donations still
          work — the fund never lets a price feed block incoming money.</p>
        </div>`);
    }

    host.innerHTML = parts.join("");
  }

  let toastId = 0;
  function toast(kind, title, body, opts) {
    const id = `toast-${++toastId}`;
    const node = document.createElement("div");
    node.className = `toast toast--${kind}`;
    node.id = id;
    node.innerHTML = `
      <button class="toast__close" aria-label="Dismiss">×</button>
      <div class="toast__title">${kind === "pending" ? '<span class="spinner" aria-hidden="true"></span>' : ""}${esc(title)}</div>
      ${body ? `<div class="toast__body">${body}</div>` : ""}`;
    $("#toasts").appendChild(node);
    $(".toast__close", node).addEventListener("click", () => node.remove());
    if (!(opts && opts.sticky)) setTimeout(() => node.remove(), kind === "error" ? 12000 : 7000);
    return node;
  }

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      const dlg = $("#confirm-dialog");
      $("#confirm-title").textContent = title;
      $("#confirm-body").textContent = body;
      const ok = $("#confirm-ok");
      const cancel = $("#confirm-cancel");
      const done = (result) => {
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        dlg.close();
        resolve(result);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      dlg.showModal();
    });
  }

  /* ===========================================================================
     4. Blockchain access
     ======================================================================== */

  /** Tries the primary RPC, then each fallback, and keeps the first that answers. */
  async function buildProvider() {
    const urls = [CFG.rpcUrl].concat(CFG.fallbackRpcUrls || []);
    let lastError = null;
    for (const url of urls) {
      try {
        const p = new ethers.JsonRpcProvider(url, {
          chainId: CFG.chainId,
          name: CFG.networkName,
        });
        await p.getBlockNumber();
        return p;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("No RPC endpoint responded.");
  }

  function buildContracts(runner) {
    const c = { fund: null, token: null, dao: null };
    if (state.addresses.fund) c.fund = new ethers.Contract(state.addresses.fund, ABI.DisasterReliefFund, runner);
    if (state.addresses.token) c.token = new ethers.Contract(state.addresses.token, ABI.DonorToken, runner);
    if (state.addresses.dao) c.dao = new ethers.Contract(state.addresses.dao, ABI.AllocationDAO, runner);
    return c;
  }

  /**
   * Adds a margin to the estimated gas limit of every write.
   *
   * This is not belt-and-braces padding, it fixes a real failure. The governance token
   * records voting checkpoints keyed by timestamp. Gas is estimated against the current
   * block, but the transaction mines a moment later, and if that moment falls in the next
   * second the checkpoint goes from updating an existing storage slot to writing a new one,
   * which costs around 20,000 gas more than was estimated. A wallet that submits the bare
   * estimate then fails with out-of-gas. A donation is the last thing that should fail for
   * an avoidable reason, so every write carries a 25% margin.
   *
   * Unused gas is refunded, so the margin costs the donor nothing.
   */
  function withGasBuffer(contract) {
    return new Proxy(contract, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function" || typeof prop !== "string") return original;

        const fragment = target.interface.fragments.find(
          (f) => f.type === "function" && f.name === prop);
        if (!fragment || fragment.stateMutability === "view" || fragment.stateMutability === "pure") {
          return original;
        }

        return async function (...args) {
          const last = args[args.length - 1];
          const hasOverrides = last && typeof last === "object" && !Array.isArray(last) && !("_isBigNumber" in last);
          try {
            const estimate = await target[prop].estimateGas(...args);
            const buffered = (estimate * 125n) / 100n;
            if (hasOverrides) {
              if (last.gasLimit == null) last.gasLimit = buffered;
              return original.apply(target, args);
            }
            return original.apply(target, args.concat([{ gasLimit: buffered }]));
          } catch {
            // Estimation failed, usually because the call would revert. Send it anyway and
            // let the wallet surface the contract's own error, which is more useful than ours.
            return original.apply(target, args);
          }
        };
      },
    });
  }

  /** Read contracts use the public provider; writes are rebound to the wallet signer. */
  function writeContract(which) {
    if (!state.signer) throw new Error("Connect a wallet first.");
    const addr = state.addresses[which];
    const abi = which === "fund" ? ABI.DisasterReliefFund : which === "token" ? ABI.DonorToken : ABI.AllocationDAO;
    if (!addr) throw new Error(`No ${which} address is configured.`);
    return withGasBuffer(new ethers.Contract(addr, abi, state.signer));
  }

  /** One oracle read for the whole page; everything else converts locally. */
  async function loadPrice(fund) {
    try {
      state.priceUsd8 = await fund.getUsdValue(10n ** 18n);
    } catch {
      state.priceUsd8 = null; // stale or broken feed: hide USD rather than guess
    }
  }

  const usdOf = (wei) =>
    state.priceUsd8 == null || wei == null ? null : (BigInt(wei) * state.priceUsd8) / 10n ** 18n;

  /**
   * Reads contract history in bounded block ranges.
   *
   * Public RPC endpoints reject large eth_getLogs ranges, so this walks backwards from the
   * head a chunk at a time and stops as soon as it has enough rows. Requesting block 0 to
   * latest in one call is the single most common way a dashboard like this breaks in
   * production.
   */
  async function loadEvents(limit) {
    const want = limit || 60;
    const rows = [];
    if (!state.contracts.fund) return rows;

    const iface = new ethers.Interface(ABI.DisasterReliefFund);
    const daoIface = state.contracts.dao ? new ethers.Interface(ABI.AllocationDAO) : null;
    const head = await state.provider.getBlockNumber();
    const floor = Math.max(0, Number(CFG.deploymentBlock) || 0);
    const chunk = Number(CFG.eventChunkSize) || 2000;
    const maxChunks = Number(CFG.eventMaxChunks) || 25;

    let to = head;
    const blockTimes = new Map();

    for (let i = 0; i < maxChunks && to >= floor && rows.length < want; i++) {
      const from = Math.max(floor, to - chunk + 1);
      const targets = [{ address: state.addresses.fund, iface }];
      if (state.addresses.dao) targets.push({ address: state.addresses.dao, iface: daoIface });

      for (const t of targets) {
        let logs;
        try {
          logs = await state.provider.getLogs({ address: t.address, fromBlock: from, toBlock: to });
        } catch {
          continue; // a chunk that the RPC refuses should not kill the whole history
        }
        for (const log of logs) {
          let parsed;
          try { parsed = t.iface.parseLog(log); } catch { continue; }
          if (!parsed) continue;
          rows.push({ log, parsed });
        }
      }
      to = from - 1;
    }

    rows.sort((a, b) =>
      b.log.blockNumber - a.log.blockNumber || b.log.index - a.log.index);

    const out = [];
    for (const r of rows.slice(0, want)) {
      if (!blockTimes.has(r.log.blockNumber)) {
        try {
          const b = await state.provider.getBlock(r.log.blockNumber);
          blockTimes.set(r.log.blockNumber, b ? b.timestamp : null);
        } catch {
          blockTimes.set(r.log.blockNumber, null);
        }
      }
      out.push(describeEvent(r.parsed, r.log, blockTimes.get(r.log.blockNumber)));
    }
    return out;
  }

  /** Turns a decoded log into the row shape the activity table renders. */
  function describeEvent(parsed, log, timestamp) {
    const a = parsed.args;
    const row = {
      type: parsed.name,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      timestamp,
      address: null,
      amount: null,
      detail: "",
    };
    switch (parsed.name) {
      case "DonationReceived":
        row.address = a.donor; row.amount = a.amount; row.detail = `Campaign ${a.campaignId}`; break;
      case "GeneralPoolDonationReceived":
        row.address = a.donor; row.amount = a.amount; row.detail = "General relief pool"; break;
      case "CampaignCreated":
        row.address = a.createdBy; row.detail = a.name; break;
      case "CampaignStatusChanged":
        row.address = a.changedBy; row.detail = `Campaign ${a.campaignId} ${a.active ? "reopened" : "closed"}`; break;
      case "BeneficiaryRegistered":
        row.address = a.beneficiary; row.detail = a.name; break;
      case "BeneficiaryApprovalCast":
        row.address = a.signer; row.detail = `Approved ${shortAddr(a.beneficiary)} (${a.approvalCount})`; break;
      case "BeneficiaryApproved":
        row.address = a.beneficiary; row.detail = "Reached approval threshold"; break;
      case "ProposalCreated":
        row.address = a.proposer; row.amount = a.amount; row.detail = `Proposal ${a.proposalId} — ${CATEGORIES[Number(a.category)] || "Other"}`; break;
      case "ProposalApproved":
        row.address = a.signer; row.detail = `Proposal ${a.proposalId} at ${a.approvalCount} approvals`; break;
      case "ApprovalRevoked":
        row.address = a.signer; row.detail = `Proposal ${a.proposalId} back to ${a.approvalCount} approvals`; break;
      case "ProposalReady":
        row.detail = `Proposal ${a.proposalId} executable after ${dateStr(a.executableAfter)}`; break;
      case "DisbursementExecuted":
        row.address = a.beneficiary; row.amount = a.amount; row.detail = `Proposal ${a.proposalId} paid out`; break;
      case "UtilisationProofSubmitted":
        row.address = a.submittedBy; row.detail = `Proof for proposal ${a.proposalId}`; break;
      case "GeneralPoolAllocated":
        row.amount = a.amount; row.detail = `Allocated to campaign ${a.campaignId}`; break;
      case "GovernanceTokensMinted":
        row.address = a.donor; row.detail = `${pol(a.tokenAmount, 2)} RLF minted`; break;
      case "GovernanceTokenMintSkipped":
        row.address = a.donor; row.amount = a.amount; row.detail = "No token minted — price feed unavailable"; break;
      case "AllocationProposed":
        row.address = a.proposer; row.amount = a.amount; row.detail = `Allocation ${a.allocationId} proposed`; break;
      case "AllocationVoteCast":
        row.address = a.voter; row.detail = `Voted ${a.support ? "for" : "against"} allocation ${a.allocationId}`; break;
      case "AllocationFinalized":
        row.detail = `Allocation ${a.allocationId} ${a.passed ? "passed" : "failed"}`; break;
      case "AllocationExecuted":
        row.amount = a.amount; row.detail = `Allocation ${a.allocationId} applied`; break;
      case "Paused":
        row.address = a.account; row.detail = "Contract paused"; break;
      case "Unpaused":
        row.address = a.account; row.detail = "Contract unpaused"; break;
      default:
        row.detail = "";
    }
    return row;
  }

  /** Reads everything the dashboard needs from the chain. */
  async function loadLive() {
    const fund = state.contracts.fund;

    const [stats, signers, required, timelock, expiry] = await Promise.all([
      fund.getStats(),
      fund.getSigners(),
      fund.requiredApprovals(),
      fund.timelockDelay(),
      fund.proposalExpiry(),
    ]);

    await loadPrice(fund);

    const campaignCount = Number(stats[4]);
    const proposalCount = Number(stats[5]);

    const rawCampaigns = campaignCount > 0 ? await fund.getCampaigns(1, campaignCount) : [];
    const rawProposals = proposalCount > 0 ? await fund.getProposals(1, proposalCount) : [];

    const campaigns = rawCampaigns.map((c, i) => ({
      id: i + 1,
      name: c.name, region: c.region, description: c.description,
      targetUsd: c.targetUsd, raised: c.raised, allocated: c.allocated,
      disbursed: c.disbursed, donorCount: c.donorCount, createdAt: Number(c.createdAt),
      active: c.active,
    }));

    const proposals = rawProposals.map((p, i) => ({
      id: i + 1,
      campaignId: Number(p.campaignId), beneficiary: p.beneficiary, amount: p.amount,
      category: Number(p.category), purpose: p.purpose, proposer: p.proposer,
      approvalCount: p.approvalCount, createdAt: Number(p.createdAt),
      executableAfter: Number(p.executableAfter), expiresAt: Number(p.expiresAt),
      executedAt: Number(p.executedAt), executed: p.executed,
      proofHash: p.proofHash, proofUri: p.proofUri,
    })).reverse();

    const benAddrs = await fund.getBeneficiaryList();
    const beneficiaries = await Promise.all(
      benAddrs.slice(0, 60).map(async (addr) => {
        const b = await fund.getBeneficiary(addr);
        return { address: addr, name: b.name, registered: b.registered, approved: b.approved, approvalCount: b.approvalCount };
      })
    );

    let allocations = [];
    if (state.contracts.dao) {
      try {
        const n = Number(await state.contracts.dao.allocationCount());
        if (n > 0) {
          const raw = await state.contracts.dao.getAllocations(1, n);
          allocations = raw.map((a, i) => ({
            id: i + 1, campaignId: Number(a.campaignId), amount: a.amount,
            proposer: a.proposer, rationale: a.rationale, snapshot: Number(a.snapshot),
            voteEnd: Number(a.voteEnd), forVotes: a.forVotes, againstVotes: a.againstVotes,
            quorumRequired: a.quorumRequired, executableAfter: Number(a.executableAfter),
            finalized: a.finalized, passed: a.passed, executed: a.executed,
          })).reverse();
        }
      } catch (e) {
        console.warn("Allocation proposals could not be read:", e);
      }
    }

    let token = null;
    if (state.contracts.token) {
      try {
        token = { totalSupply: await state.contracts.token.totalSupply(), symbol: "RLF" };
      } catch { token = null; }
    }

    const events = await loadEvents(60);

    return {
      isDemo: false,
      stats: {
        totalDonated: stats[0], totalDisbursed: stats[1], available: stats[2],
        generalPool: stats[3], campaignCount: stats[4], proposalCount: stats[5],
        pendingProposals: stats[6], donationCount: stats[7], paused: stats[8],
      },
      governance: { signers, requiredApprovals: required, timelockDelay: timelock, proposalExpiry: expiry },
      campaigns, proposals, beneficiaries, allocations, events, token,
    };
  }

  /** Per-wallet figures, refreshed whenever the account changes. */
  async function loadWalletData() {
    state.wallet = { balance: null, tokenBalance: null, votes: null, delegate: null, isSigner: false };
    if (!state.account) return;

    if (state.mode === "demo") {
      state.wallet.isSigner = false;
      return;
    }
    try {
      state.wallet.balance = await state.provider.getBalance(state.account);
    } catch { /* non-fatal */ }

    if (state.data && state.data.governance && state.data.governance.signers) {
      state.wallet.isSigner = state.data.governance.signers
        .some((s) => s.toLowerCase() === state.account.toLowerCase());
    }
    if (state.contracts.token) {
      try {
        const [bal, votes, delegate] = await Promise.all([
          state.contracts.token.balanceOf(state.account),
          state.contracts.token.getVotes(state.account),
          state.contracts.token.delegates(state.account),
        ]);
        state.wallet.tokenBalance = bal;
        state.wallet.votes = votes;
        state.wallet.delegate = delegate;
      } catch { /* token not linked yet */ }
    }
  }

  /* ---- wallet ---- */

  function hasWallet() {
    return typeof window.ethereum !== "undefined";
  }

  async function connectWallet(interactive) {
    if (!hasWallet()) {
      toast("error", "No wallet detected", "Install MetaMask, then reload this page to donate or to act as a signer. You can keep reading the ledger without one.");
      return;
    }
    try {
      const accounts = interactive
        ? await window.ethereum.request({ method: "eth_requestAccounts" })
        : await window.ethereum.request({ method: "eth_accounts" });
      if (!accounts || accounts.length === 0) return;

      state.browserProvider = new ethers.BrowserProvider(window.ethereum);
      state.signer = await state.browserProvider.getSigner();
      state.account = ethers.getAddress(accounts[0]);

      const net = await state.browserProvider.getNetwork();
      state.walletChainId = Number(net.chainId);
      state.wrongNetwork = state.walletChainId !== Number(CFG.chainId);

      await loadWalletData();
      renderChrome();
      render();
    } catch (e) {
      if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) {
        toast("error", "Connection cancelled", "You dismissed the wallet prompt.");
      } else {
        toast("error", "Could not connect", esc(e && e.message ? e.message : String(e)));
      }
    }
  }

  function disconnectWallet() {
    state.signer = null;
    state.account = null;
    state.browserProvider = null;
    state.wrongNetwork = false;
    state.wallet = { balance: null, tokenBalance: null, votes: null, delegate: null, isSigner: false };
    renderChrome();
    render();
  }

  async function switchNetwork() {
    if (!hasWallet()) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CFG.chainIdHex }],
      });
    } catch (e) {
      // 4902 means the wallet does not know this chain yet, so offer to add it.
      if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CFG.chainIdHex,
              chainName: CFG.networkName,
              nativeCurrency: CFG.nativeCurrency,
              rpcUrls: [CFG.rpcUrl],
              blockExplorerUrls: [CFG.explorerUrl],
            }],
          });
        } catch (addErr) {
          toast("error", "Could not add the network", "Add it manually in your wallet using the details on the About page.");
        }
      } else if (e && e.code === 4001) {
        toast("error", "Network switch cancelled", "Transactions will fail until your wallet is on " + esc(CFG.networkName) + ".");
      } else {
        toast("error", "Could not switch network", esc(e && e.message ? e.message : String(e)));
      }
    }
  }

  /* ---- transactions ---- */

  /** Maps contract and wallet failures onto something a person can act on. */
  function explainError(err) {
    const e = err || {};
    if (e.code === "ACTION_REJECTED" || e.code === 4001) return "You rejected the transaction in your wallet.";
    if (e.code === "INSUFFICIENT_FUNDS") return `This account does not have enough ${SYM} to cover the amount plus gas. Use a faucet for this test network to top it up.`;
    if (e.code === "NETWORK_ERROR") return "The network did not respond. Check your connection and try again.";

    let name = e.revert && e.revert.name ? e.revert.name : null;
    if (!name && e.data) {
      try { name = new ethers.Interface(ABI.DisasterReliefFund).parseError(e.data)?.name; } catch { /* not ours */ }
      if (!name) {
        try { name = new ethers.Interface(ABI.AllocationDAO).parseError(e.data)?.name; } catch { /* not ours */ }
      }
    }
    const messages = {
      NotSigner: "Only a configured signer can do this.",
      NotDeployer: "Only the deploying account can do this.",
      NotAllocationDAO: "Only the allocation DAO can move general pool funds, and only between internal balances.",
      NotMinter: "Only the relief fund contract can mint governance tokens.",
      ZeroAmount: "Enter an amount greater than zero.",
      ZeroAddress: "That address is not valid.",
      CampaignNotFound: "That campaign does not exist.",
      CampaignNotActive: "That campaign is closed and is not accepting this action.",
      BeneficiaryNotApproved: "That beneficiary has not been approved by enough signers yet.",
      BeneficiaryAlreadyRegistered: "That address is already registered.",
      BeneficiaryNotRegistered: "Register the beneficiary before approving them.",
      ProposalNotFound: "That proposal does not exist.",
      AlreadyApproved: "You have already approved this.",
      NotApproved: "You have not approved this, so there is nothing to revoke.",
      ThresholdNotMet: "This proposal does not have enough signer approvals yet.",
      TimelockActive: "The timelock has not finished. Wait for the countdown to reach zero.",
      ProposalExpired: "This proposal has expired and can no longer be executed.",
      AlreadyExecuted: "This proposal has already been executed.",
      InsufficientCampaignFunds: "The campaign does not hold enough funds for this amount.",
      InsufficientGeneralPool: "The general pool does not hold that much.",
      TransferExecutionError: "The transfer to the beneficiary failed.",
      ContractPaused: "The contract is paused. A signer must unpause it first.",
      ProofAlreadySubmitted: "A utilisation proof has already been recorded for this disbursement.",
      InvalidPrice: "The price feed returned an unusable value.",
      StalePrice: "The price feed answer is too old to trust.",
      DirectPaymentNotAllowed: "Send donations through the donate form so they can be attributed to a campaign.",
      ReentrancyGuardReentrantCall: "Re-entrant call blocked.",
      BelowProposalThreshold: "You need more voting power to open an allocation proposal. Donate and delegate to yourself first.",
      AlreadyVoted: "You have already voted on this proposal.",
      NoVotingPower: "You had no voting power when this proposal was created. Delegate to yourself before the next one.",
      VotingClosed: "Voting on this proposal has closed.",
      VotingNotClosed: "Voting is still open. Wait for the countdown to finish.",
      AlreadyFinalized: "This proposal has already been finalised.",
      NotFinalized: "Finalise the vote before executing it.",
      ProposalDidNotPass: "This allocation did not pass, so it cannot be executed.",
      AllocationAlreadyExecuted: "This allocation has already been applied.",
      ExecutionTimelockActive: "The execution delay has not finished yet.",
      AmountExceedsGeneralPool: "The general pool does not hold that much.",
      InvalidThreshold: "The approval threshold must be more than one and no more than the number of signers.",
      DuplicateSigner: "The same signer address appears twice.",
    };
    if (name && messages[name]) return `${messages[name]} (${name})`;
    if (name) return `The contract rejected this with ${name}.`;
    if (e.shortMessage) return e.shortMessage;
    return e.message ? String(e.message).slice(0, 220) : "The transaction failed.";
  }

  /**
   * Runs a write transaction with visible states throughout: awaiting the wallet, pending
   * on chain, then confirmed. Nothing is reported as done before a confirmation arrives.
   */
  async function sendTx(label, build) {
    if (!state.signer) {
      await connectWallet(true);
      if (!state.signer) return false;
    }
    if (state.wrongNetwork) {
      toast("error", "Wrong network", `Switch your wallet to ${esc(CFG.networkName)} before sending transactions.`);
      return false;
    }

    const waiting = toast("pending", "Confirm in your wallet", esc(label), { sticky: true });
    let tx;
    try {
      tx = await build();
    } catch (e) {
      waiting.remove();
      toast("error", "Transaction not sent", esc(explainError(e)));
      return false;
    }
    waiting.remove();

    const pending = toast("pending", "Transaction pending",
      `${esc(label)}<br><a href="${esc(txLink(tx.hash))}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(tx.hash))}</a>`,
      { sticky: true });

    try {
      const receipt = await tx.wait(1);
      pending.remove();
      if (receipt && receipt.status === 0) {
        toast("error", "Transaction failed", "The transaction was mined but reverted.");
        return false;
      }
      toast("ok", "Confirmed",
        `${esc(label)}<br><a href="${esc(txLink(tx.hash))}" target="_blank" rel="noopener noreferrer">View on the block explorer</a>`);
      await refresh();
      return true;
    } catch (e) {
      pending.remove();
      toast("error", "Transaction failed", esc(explainError(e)));
      return false;
    }
  }

  /* ===========================================================================
     5. Loading and refresh
     ======================================================================== */

  async function boot() {
    resolveAddresses();

    if (!state.addresses.fund) {
      state.mode = "demo";
      state.data = DEMO;
      state.priceUsd8 = DEMO.polUsd;
      renderChrome();
      render();
      return;
    }

    state.mode = "loading";
    renderChrome();
    render();

    try {
      state.provider = await buildProvider();
      state.contracts = buildContracts(state.provider);

      const code = await state.provider.getCode(state.addresses.fund);
      if (!code || code === "0x") {
        throw new Error(`No contract is deployed at ${state.addresses.fund} on ${CFG.networkName}. Check the address and the network in config.js.`);
      }

      state.data = await loadLive();
      state.mode = "live";
      await loadWalletData();
    } catch (e) {
      console.error(e);
      state.mode = "error";
      state.errorMessage = e && e.message ? e.message : String(e);
      state.data = null;
    }

    renderChrome();
    render();
    startPolling();
  }

  async function refresh() {
    if (state.mode !== "live" || state.loading) return;
    state.loading = true;
    try {
      state.data = await loadLive();
      await loadWalletData();
      state.mode = "live";
    } catch (e) {
      console.warn("Refresh failed:", e);
    } finally {
      state.loading = false;
      renderChrome();
      render();
    }
  }

  function startPolling() {
    stopPolling();
    if (state.mode !== "live") return;
    state.pollTimer = setInterval(refresh, Number(CFG.pollIntervalMs) || 30000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /** Repaints countdowns once a second without re-reading the chain. */
  function startTicker() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
      $$("[data-countdown]").forEach((node) => {
        const left = countdown(node.getAttribute("data-countdown"));
        node.textContent = left || "ready";
      });
    }, 1000);
  }

  /* ===========================================================================
     6. Views
     ======================================================================== */

  function renderChrome() {
    const pill = $("#mode-pill");
    const text = $("#mode-pill-text");
    pill.className = "pill";
    if (state.mode === "live") {
      pill.classList.add("pill--live");
      text.textContent = `Live on ${CFG.networkName}`;
    } else if (state.mode === "demo") {
      pill.classList.add("pill--demo");
      text.textContent = "Demo data";
    } else if (state.mode === "error") {
      pill.classList.add("pill--error");
      text.textContent = "Contract unreachable";
    } else {
      text.textContent = "Connecting";
    }

    const btn = $("#connect-btn");
    if (state.account) {
      btn.textContent = shortAddr(state.account) + (state.wallet.isSigner ? " (signer)" : "");
      btn.setAttribute("data-action", "disconnect");
      btn.title = "Click to forget this wallet in the page. Your wallet stays connected to the site until you disconnect it there too.";
    } else {
      btn.textContent = "Connect wallet";
      btn.setAttribute("data-action", "connect");
      btn.title = "";
    }

    $$(".nav__link").forEach((a) => {
      const match = a.getAttribute("href") === `#${state.route.split("/").slice(0, 2).join("/")}`;
      if (match) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  function skeleton() {
    return `
      <div class="panel">
        <div class="skeleton skeleton--title"></div>
        <div class="skeleton"></div><div class="skeleton"></div>
        <div class="skeleton" style="width:60%"></div>
      </div>
      <div class="panel"><div class="skeleton skeleton--block"></div></div>`;
  }

  function demoTag() {
    return state.mode === "demo" ? ' <span class="badge badge--demo">Sample</span>' : "";
  }

  /** Derived status for a disbursement proposal. */
  function proposalStatus(p, required) {
    const now = Math.floor(Date.now() / 1000);
    if (p.executed) return { key: "executed", label: "Executed", badge: "badge--ok" };
    if (now > p.expiresAt) return { key: "expired", label: "Expired", badge: "badge--danger" };
    if (BigInt(p.approvalCount) < BigInt(required)) {
      return { key: "awaiting", label: `Awaiting approvals ${p.approvalCount} of ${required}`, badge: "" };
    }
    if (p.executableAfter && now < p.executableAfter) return { key: "timelock", label: "In timelock", badge: "badge--warn" };
    return { key: "ready", label: "Ready to execute", badge: "badge--accent" };
  }

  function progressBlock(c) {
    const raisedUsd = usdOf(BigInt(c.raised) + BigInt(c.allocated));
    const p = pct(raisedUsd, c.targetUsd);
    const width = p == null ? 0 : Math.min(100, p);
    return `
      <div class="progress" role="img" aria-label="${p == null ? "Progress unavailable" : esc(p.toFixed(1) + " percent of target")}">
        <div class="progress__bar ${p != null && p >= 100 ? "progress__bar--full" : ""}" style="width:${width}%"></div>
      </div>
      <div class="progress__meta">
        <span>${raisedUsd == null ? polUnit(BigInt(c.raised) + BigInt(c.allocated), 2) + " raised" : esc(usd(raisedUsd)) + " raised"}</span>
        <span>${p == null ? "USD value unavailable" : esc(p.toFixed(1)) + "% of " + esc(usd(c.targetUsd))}</span>
      </div>`;
  }

  /* ---- Overview ---- */

  function viewOverview() {
    const d = state.data;
    const s = d.stats;
    const g = d.governance;
    const pendingList = d.proposals.filter((p) => !p.executed && Math.floor(Date.now() / 1000) <= p.expiresAt);

    return `
      <div class="page-head">
        <h1>A public record of relief money${demoTag()}</h1>
        <p>Every donation and every payout below is written to a public blockchain. No single
        person can move money: a payout needs ${esc(g.requiredApprovals)} of
        ${esc(g.signers.length)} signers to approve it, then it waits out a timelock before
        anyone can execute it.</p>
      </div>

      <div class="figures">
        <div class="figure">
          <div class="figure__label">Total donated</div>
          <div class="figure__value">${esc(pol(s.totalDonated, 2))}</div>
          <div class="figure__note">${SYM}${usdOf(s.totalDonated) ? " · " + esc(usd(usdOf(s.totalDonated))) : ""}</div>
        </div>
        <div class="figure">
          <div class="figure__label">Total disbursed</div>
          <div class="figure__value">${esc(pol(s.totalDisbursed, 2))}</div>
          <div class="figure__note">${SYM} across ${esc(d.proposals.filter((p) => p.executed).length)} payouts</div>
        </div>
        <div class="figure">
          <div class="figure__label">Held and accounted</div>
          <div class="figure__value">${esc(pol(s.available, 2))}</div>
          <div class="figure__note">${SYM} still in the fund</div>
        </div>
        <div class="figure">
          <div class="figure__label">General relief pool</div>
          <div class="figure__value">${esc(pol(s.generalPool, 2))}</div>
          <div class="figure__note">${SYM} awaiting donor allocation</div>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel">
          <div class="panel__head">
            <div>
              <h2>Awaiting signatures</h2>
              <p>${pendingList.length} open ${pendingList.length === 1 ? "proposal" : "proposals"}</p>
            </div>
            <a class="btn btn--small" href="#/disbursements">See all</a>
          </div>
          ${pendingList.length === 0
            ? `<div class="empty"><h3>Nothing pending</h3><p>No disbursement is waiting on a signature right now.</p></div>`
            : pendingList.slice(0, 3).map((p) => proposalCard(p, g, true)).join("")}
        </section>

        <section class="panel">
          <div class="panel__head">
            <div>
              <h2>Active campaigns</h2>
              <p>${d.campaigns.filter((c) => c.active).length} accepting donations</p>
            </div>
            <a class="btn btn--small" href="#/campaigns">See all</a>
          </div>
          ${d.campaigns.filter((c) => c.active).slice(0, 2).map((c) => `
            <div style="margin-bottom:16px">
              <h3>${esc(c.name)}</h3>
              <p class="campaign__region">${esc(c.region)}</p>
              ${progressBlock(c)}
            </div>`).join("") || `<div class="empty"><h3>No active campaigns</h3><p>A signer can open one.</p></div>`}
        </section>
      </div>

      <section class="panel">
        <div class="panel__head">
          <div><h2>Latest activity</h2><p>Read directly from contract events</p></div>
          <a class="btn btn--small" href="#/activity">Full audit trail</a>
        </div>
        ${activityTable(d.events.slice(0, 8))}
      </section>`;
  }

  /* ---- Campaigns ---- */

  function viewCampaigns() {
    const d = state.data;
    if (d.campaigns.length === 0) {
      return `
        <div class="page-head"><h1>Campaigns</h1></div>
        <div class="empty">
          <h3>No campaigns yet</h3>
          <p>Campaigns are opened by the fund's signers. Once one exists it will appear here
          with its target and everything raised against it.</p>
        </div>`;
    }
    return `
      <div class="page-head">
        <h1>Campaigns${demoTag()}</h1>
        <p>Each campaign holds its own balance. Money raised for one campaign cannot be spent
        on another, except through a donor vote that moves general pool funds.</p>
      </div>
      ${d.campaigns.map((c) => `
        <article class="campaign">
          <div class="campaign__top">
            <div>
              <h2>${esc(c.name)}</h2>
              <p class="campaign__region">${esc(c.region)} · opened ${esc(timeAgo(c.createdAt))}</p>
            </div>
            <span class="badge ${c.active ? "badge--ok" : ""}">${c.active ? "Accepting donations" : "Closed"}</span>
          </div>
          <p class="campaign__desc">${esc(c.description)}</p>
          ${progressBlock(c)}
          <div class="stat-row">
            <div><div class="stat__label">Donated</div><div class="stat__value num">${esc(polUnit(c.raised, 2))}</div></div>
            <div><div class="stat__label">Allocated by donors</div><div class="stat__value num">${esc(polUnit(c.allocated, 2))}</div></div>
            <div><div class="stat__label">Disbursed</div><div class="stat__value num">${esc(polUnit(c.disbursed, 2))}</div></div>
            <div><div class="stat__label">Available</div><div class="stat__value num">${esc(polUnit(BigInt(c.raised) + BigInt(c.allocated) - BigInt(c.disbursed), 2))}</div></div>
            <div><div class="stat__label">Donors</div><div class="stat__value num">${esc(String(c.donorCount))}</div></div>
          </div>
          <div class="actions">
            <a class="btn btn--small" href="#/campaign/${c.id}">View campaign</a>
            ${c.active ? `<a class="btn btn--small btn--primary" href="#/donate?campaign=${c.id}">Donate</a>` : ""}
          </div>
        </article>`).join("")}`;
  }

  function viewCampaignDetail(id) {
    const d = state.data;
    const c = d.campaigns.find((x) => x.id === Number(id));
    if (!c) {
      return `<div class="empty"><h3>Campaign not found</h3><p>There is no campaign with ID ${esc(id)}.</p>
        <a class="btn" href="#/campaigns">Back to campaigns</a></div>`;
    }
    const related = d.proposals.filter((p) => p.campaignId === c.id);
    const donations = d.events.filter(
      (e) => (e.type === "DonationReceived" && e.detail === `Campaign ${c.id}`) ||
             (state.mode === "demo" && e.type === "DonationReceived" && e.detail === c.name));

    return `
      <div class="page-head">
        <p><a href="#/campaigns">Campaigns</a></p>
        <h1>${esc(c.name)}${demoTag()}</h1>
        <p>${esc(c.region)} · opened ${esc(dateStr(c.createdAt))} ·
        ${c.active ? "accepting donations" : "closed to new donations"}</p>
      </div>

      <div class="panel">
        <p>${esc(c.description)}</p>
        ${progressBlock(c)}
        <div class="stat-row">
          <div><div class="stat__label">Target</div><div class="stat__value num">${esc(usd(c.targetUsd) || "—")}</div></div>
          <div><div class="stat__label">Donated</div><div class="stat__value num">${esc(polUnit(c.raised, 2))}</div></div>
          <div><div class="stat__label">Allocated by donors</div><div class="stat__value num">${esc(polUnit(c.allocated, 2))}</div></div>
          <div><div class="stat__label">Disbursed</div><div class="stat__value num">${esc(polUnit(c.disbursed, 2))}</div></div>
          <div><div class="stat__label">Available</div><div class="stat__value num">${esc(polUnit(BigInt(c.raised) + BigInt(c.allocated) - BigInt(c.disbursed), 2))}</div></div>
        </div>
        ${c.active ? `<div class="actions"><a class="btn btn--primary" href="#/donate?campaign=${c.id}">Donate to this campaign</a></div>` : ""}
      </div>

      <section class="panel">
        <div class="panel__head"><div><h2>Disbursements from this campaign</h2></div></div>
        ${related.length === 0
          ? `<div class="empty"><h3>Nothing disbursed yet</h3><p>When signers propose a payout from this campaign it will appear here with its approvals and proof.</p></div>`
          : related.map((p) => proposalCard(p, d.governance, true)).join("")}
      </section>

      <section class="panel">
        <div class="panel__head"><div><h2>Recent donations</h2></div></div>
        ${donations.length === 0
          ? `<div class="empty"><h3>No donations in the recent history window</h3><p>Only the most recent blocks are queried. Older donations are still on chain and counted in the totals above.</p></div>`
          : activityTable(donations.slice(0, 15))}
      </section>`;
  }

  /* ---- Donate ---- */

  function viewDonate(params) {
    const d = state.data;
    const preselect = params.get("campaign");
    const active = d.campaigns.filter((c) => c.active);
    const paused = d.stats.paused;

    return `
      <div class="page-head">
        <h1>Donate${demoTag()}</h1>
        <p>Donations are made in test ${SYM} on ${esc(CFG.networkName)}. Test tokens have no
        monetary value. Your wallet will ask you to confirm before anything is sent, and this
        site never asks for a seed phrase or private key.</p>
      </div>

      ${paused ? `<div class="banner banner--warn"><h3>Donations are paused</h3><p>A signer has paused the contract, so donations will be rejected until it is unpaused.</p></div>` : ""}

      <div class="grid-2">
        <section class="panel">
          <h2>Choose where it goes</h2>
          <form id="donate-form" novalidate>
            <fieldset>
              <legend>Destination</legend>
              <div class="radio-row">
                <input type="radio" id="dest-pool" name="dest" value="pool" ${!preselect ? "checked" : ""}>
                <label for="dest-pool">
                  <strong>General relief pool</strong><br>
                  <span class="hint">Donor token holders vote on which campaign receives it. Signers still approve every payout.</span>
                </label>
              </div>
              <div class="radio-row">
                <input type="radio" id="dest-campaign" name="dest" value="campaign" ${preselect ? "checked" : ""} ${active.length === 0 ? "disabled" : ""}>
                <label for="dest-campaign">
                  <strong>A specific campaign</strong><br>
                  <span class="hint">${active.length === 0 ? "No campaign is currently accepting donations." : "Ring-fenced for that campaign only."}</span>
                </label>
              </div>
            </fieldset>

            <div class="field" id="campaign-field" ${preselect ? "" : 'hidden'}>
              <label for="campaign-select">Campaign</label>
              <select id="campaign-select">
                ${active.map((c) => `<option value="${c.id}" ${String(c.id) === String(preselect) ? "selected" : ""}>${esc(c.name)} — ${esc(c.region)}</option>`).join("")}
              </select>
            </div>

            <div class="field">
              <label for="amount">Amount in ${SYM}</label>
              <input type="number" id="amount" min="0" step="0.0001" inputmode="decimal" placeholder="1.0" aria-describedby="amount-hint">
              <p class="hint" id="amount-hint">
                ${state.wallet.balance != null ? `Your balance: ${esc(polUnit(state.wallet.balance, 4))}. ` : ""}
                Keep a little back for gas.
              </p>
              <p class="error-text" id="amount-error" hidden></p>
            </div>

            <div class="field" id="usd-preview" hidden></div>

            <button class="btn btn--primary btn--block" type="submit" ${paused || state.mode !== "live" ? "disabled" : ""}>
              ${state.mode === "live" ? "Review and donate" : "Donating needs a deployed contract"}
            </button>
            ${state.mode !== "live" ? `<p class="hint">This form is disabled because the site is not connected to a deployed contract.</p>` : ""}
          </form>
        </section>

        <section class="panel">
          <h2>What happens next</h2>
          <p>Your wallet asks you to confirm the amount and the gas fee. Once the transaction
          is mined, the donation appears in the ledger with your address, the amount and the
          timestamp. That record cannot be edited or removed.</p>
          <p>You also receive governance tokens worth one token per US dollar donated, valued
          at the time of the donation. They give you a vote over how the general pool is
          allocated. They are not refundable, cannot be redeemed, and are not a claim on
          relief funds.</p>
          <p>To use your vote you must delegate the tokens to yourself once, on the
          <a href="#/governance">Governance</a> page. Until you do, your voting power is zero
          even though you hold a balance.</p>
          <h3 style="margin-top:18px">What this does not prove</h3>
          <p>The blockchain records that money moved and who approved it. It cannot verify
          that a receipt is genuine, or that an organisation receiving funds did the work it
          described. Those checks happen off chain, and the signers are accountable for them.</p>
        </section>
      </div>`;
  }

  /* ---- Disbursements ---- */

  function proposalCard(p, g, compact) {
    const st = proposalStatus(p, g.requiredApprovals);
    const required = Number(g.requiredApprovals);
    const approvals = Number(p.approvalCount);
    const campaign = state.data.campaigns.find((c) => c.id === p.campaignId);
    const ben = state.data.beneficiaries.find((b) => b.address.toLowerCase() === String(p.beneficiary).toLowerCase());
    const hasProof = p.proofHash && /[1-9a-f]/i.test(String(p.proofHash).slice(2));
    const canAct = state.wallet.isSigner && state.mode === "live";
    const timelockLeft = st.key === "timelock" ? p.executableAfter : null;

    return `
      <article class="proposal">
        <div class="proposal__head">
          <div>
            <div class="proposal__amount num">${esc(polUnit(p.amount, 2))}</div>
            <div class="campaign__region">
              ${esc(campaign ? campaign.name : "Campaign " + p.campaignId)} ·
              ${esc(CATEGORIES[p.category] || "Other")} ·
              proposal ${esc(p.id)}
            </div>
          </div>
          <span class="badge ${st.badge}">${esc(st.label)}</span>
        </div>

        <p class="proposal__purpose">${esc(p.purpose)}</p>

        <div class="approvals">
          <div class="approvals__pips" role="img" aria-label="${esc(approvals)} of ${esc(required)} approvals">
            ${Array.from({ length: required }, (_, i) => `<span class="pip ${i < approvals ? "pip--on" : ""}"></span>`).join("")}
          </div>
          <span class="num">${esc(approvals)} of ${esc(required)} approvals</span>
          ${timelockLeft ? `· <span class="countdown">executable in <span data-countdown="${esc(timelockLeft)}">${esc(countdown(timelockLeft) || "ready")}</span></span>` : ""}
          ${!p.executed && st.key !== "expired" ? `· <span>expires ${esc(timeAgo(p.expiresAt).replace(" ago", " from now"))}</span>` : ""}
        </div>

        ${compact ? "" : `
        <div class="meta-list">
          <div><div class="meta__label">Beneficiary</div><div class="meta__value">${esc(ben ? ben.name : "Unregistered")}<br>${explorerAddr(p.beneficiary)}</div></div>
          <div><div class="meta__label">Proposed by</div><div class="meta__value">${explorerAddr(p.proposer)}</div></div>
          <div><div class="meta__label">Created</div><div class="meta__value">${esc(dateStr(p.createdAt))}</div></div>
          <div><div class="meta__label">Expires</div><div class="meta__value">${esc(dateStr(p.expiresAt))}</div></div>
          ${p.executed ? `<div><div class="meta__label">Executed</div><div class="meta__value">${esc(dateStr(p.executedAt))}</div></div>` : ""}
          <div>
            <div class="meta__label">Utilisation proof</div>
            <div class="meta__value">
              ${hasProof
                ? `<span class="mono" title="${esc(p.proofHash)}">${esc(String(p.proofHash).slice(0, 18))}…</span>
                   ${p.proofUri ? `<br><a href="${esc(p.proofUri)}" target="_blank" rel="noopener noreferrer nofollow">Open the submitted document</a>
                   <br><span class="hint">The contract stores the hash only. It has not checked what the document says.</span>` : ""}`
                : p.executed ? "Not submitted yet" : "Available after execution"}
            </div>
          </div>
        </div>`}

        ${canAct || !compact ? `
        <div class="actions">
          ${compact ? `<a class="btn btn--small" href="#/disbursements">Open in full</a>` : ""}
          ${canAct && !p.executed && st.key !== "expired" ? `
            <button class="btn btn--small" data-action="approve-proposal" data-id="${p.id}">Approve</button>
            <button class="btn btn--small btn--danger" data-action="revoke-proposal" data-id="${p.id}">Revoke my approval</button>` : ""}
          ${!p.executed && st.key === "ready" && state.mode === "live" ? `
            <button class="btn btn--small btn--primary" data-action="execute-proposal" data-id="${p.id}">Execute payout</button>` : ""}
          ${canAct && p.executed && !hasProof ? `
            <button class="btn btn--small" data-action="submit-proof" data-id="${p.id}">Record utilisation proof</button>` : ""}
        </div>` : ""}
      </article>`;
  }

  function viewDisbursements() {
    const d = state.data;
    const g = d.governance;
    const open = d.proposals.filter((p) => !p.executed && Math.floor(Date.now() / 1000) <= p.expiresAt);
    const done = d.proposals.filter((p) => p.executed);
    const dead = d.proposals.filter((p) => !p.executed && Math.floor(Date.now() / 1000) > p.expiresAt);

    return `
      <div class="page-head">
        <h1>Disbursements${demoTag()}</h1>
        <p>Every payout starts as a proposal from one signer. It needs
        ${esc(g.requiredApprovals)} of ${esc(g.signers.length)} approvals, then waits out a
        ${esc(Number(g.timelockDelay))}-second timelock, and expires if it is not executed in
        time. A signer can withdraw their approval at any point before execution.</p>
      </div>

      ${state.wallet.isSigner && state.mode === "live" ? `
      <section class="panel">
        <div class="panel__head"><div><h2>Propose a disbursement</h2><p>You are a configured signer</p></div></div>
        <form id="propose-form" class="grid-2">
          <div>
            <div class="field">
              <label for="pp-campaign">Campaign</label>
              <select id="pp-campaign">
                ${d.campaigns.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="pp-beneficiary">Approved beneficiary</label>
              <select id="pp-beneficiary">
                ${d.beneficiaries.filter((b) => b.approved).map((b) => `<option value="${esc(b.address)}">${esc(b.name)} — ${esc(shortAddr(b.address))}</option>`).join("")
                  || `<option value="">No approved beneficiaries yet</option>`}
              </select>
            </div>
            <div class="field">
              <label for="pp-amount">Amount in ${SYM}</label>
              <input type="number" id="pp-amount" min="0" step="0.0001" placeholder="10.0">
            </div>
          </div>
          <div>
            <div class="field">
              <label for="pp-category">Purpose category</label>
              <select id="pp-category">${CATEGORIES.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="pp-purpose">What this money is for</label>
              <textarea id="pp-purpose" placeholder="Dry ration kits for 600 households in three relief camps"></textarea>
              <p class="hint">This is stored on chain and shown publicly. Be specific.</p>
            </div>
            <button class="btn btn--primary" type="submit">Create proposal</button>
          </div>
        </form>
      </section>` : ""}

      <section class="panel">
        <div class="panel__head"><div><h2>Open proposals</h2><p>${open.length} awaiting approval or execution</p></div></div>
        ${open.length === 0
          ? `<div class="empty"><h3>No open proposals</h3><p>Nothing is currently waiting to be paid out.</p></div>`
          : open.map((p) => proposalCard(p, g, false)).join("")}
      </section>

      <section class="panel">
        <div class="panel__head"><div><h2>Completed payouts</h2><p>${done.length} executed</p></div></div>
        ${done.length === 0
          ? `<div class="empty"><h3>Nothing disbursed yet</h3><p>Completed payouts appear here with their utilisation proofs.</p></div>`
          : done.map((p) => proposalCard(p, g, false)).join("")}
      </section>

      ${dead.length ? `
      <section class="panel">
        <div class="panel__head"><div><h2>Expired without execution</h2><p>Kept visible on purpose: a proposal that quietly lapsed is part of the record</p></div></div>
        ${dead.map((p) => proposalCard(p, g, false)).join("")}
      </section>` : ""}`;
  }

  /* ---- Governance ---- */

  function allocationCard(a) {
    const d = state.data;
    const campaign = d.campaigns.find((c) => c.id === a.campaignId);
    const now = Math.floor(Date.now() / 1000);
    const open = now <= a.voteEnd;
    const turnout = BigInt(a.forVotes) + BigInt(a.againstVotes);
    const quorumMet = BigInt(a.quorumRequired) > 0n && turnout >= BigInt(a.quorumRequired);
    const total = turnout === 0n ? 1n : turnout;
    const forPct = Number((BigInt(a.forVotes) * 100n) / total);
    const connected = state.mode === "live" && state.account;

    let status = { label: "Voting open", badge: "badge--accent" };
    if (a.executed) status = { label: "Applied", badge: "badge--ok" };
    else if (a.finalized && a.passed) status = { label: "Passed, awaiting execution", badge: "badge--warn" };
    else if (a.finalized && !a.passed) status = { label: quorumMet ? "Rejected" : "Failed quorum", badge: "badge--danger" };
    else if (!open) status = { label: "Voting closed, needs finalising", badge: "badge--warn" };

    return `
      <article class="proposal">
        <div class="proposal__head">
          <div>
            <div class="proposal__amount num">${esc(polUnit(a.amount, 2))}</div>
            <div class="campaign__region">from the general pool to ${esc(campaign ? campaign.name : "campaign " + a.campaignId)}</div>
          </div>
          <span class="badge ${status.badge}">${esc(status.label)}</span>
        </div>

        <p class="proposal__purpose">${esc(a.rationale)}</p>

        <div class="vote-bar" role="img" aria-label="${esc(forPct)} percent in favour">
          <div class="vote-bar__for" style="width:${turnout === 0n ? 0 : forPct}%"></div>
          <div class="vote-bar__against" style="width:${turnout === 0n ? 0 : 100 - forPct}%"></div>
        </div>
        <div class="progress__meta">
          <span>${esc(pol(a.forVotes, 1))} for · ${esc(pol(a.againstVotes, 1))} against</span>
          <span>${quorumMet ? "Quorum met" : `Quorum needs ${esc(pol(a.quorumRequired, 1))}`}</span>
        </div>

        <div class="meta-list">
          <div><div class="meta__label">Proposed by</div><div class="meta__value">${explorerAddr(a.proposer)}</div></div>
          <div><div class="meta__label">Voting power counted from</div><div class="meta__value">${esc(dateStr(a.snapshot))}<br><span class="hint">Tokens received after this moment do not count</span></div></div>
          <div><div class="meta__label">${open ? "Voting closes in" : "Voting closed"}</div>
            <div class="meta__value">${open ? `<span class="countdown" data-countdown="${esc(a.voteEnd)}">${esc(countdown(a.voteEnd) || "ready")}</span>` : esc(dateStr(a.voteEnd))}</div></div>
        </div>

        <div class="actions">
          ${open && connected ? `
            <button class="btn btn--small btn--primary" data-action="vote" data-id="${a.id}" data-support="1">Vote for</button>
            <button class="btn btn--small" data-action="vote" data-id="${a.id}" data-support="0">Vote against</button>` : ""}
          ${!open && !a.finalized && connected ? `<button class="btn btn--small" data-action="finalize" data-id="${a.id}">Finalise result</button>` : ""}
          ${a.finalized && a.passed && !a.executed && connected ? `
            <button class="btn btn--small btn--primary" data-action="execute-allocation" data-id="${a.id}"
              ${a.executableAfter && now < a.executableAfter ? "disabled" : ""}>
              ${a.executableAfter && now < a.executableAfter ? `Executable in ${esc(countdown(a.executableAfter) || "a moment")}` : "Apply allocation"}
            </button>` : ""}
        </div>
      </article>`;
  }

  function viewGovernance() {
    const d = state.data;
    const w = state.wallet;
    const delegated = w.delegate && w.delegate !== ethers.ZeroAddress &&
      state.account && w.delegate.toLowerCase() === state.account.toLowerCase();

    return `
      <div class="page-head">
        <h1>Donor governance${demoTag()}</h1>
        <p>Donors receive governance tokens and can vote on which campaign receives money
        from the general pool. A vote can move money between the fund's internal balances. It
        can never send money to anyone: that still requires the signers.</p>
      </div>

      <div class="grid-3">
        <section class="panel">
          <h3>Your tokens</h3>
          <div class="figure__value num" style="font-size:1.4rem">${state.account ? esc(pol(w.tokenBalance || 0n, 2)) : "—"}</div>
          <p class="hint">${state.account ? "RLF held" : "Connect a wallet to see your balance"}</p>
        </section>
        <section class="panel">
          <h3>Your voting power</h3>
          <div class="figure__value num" style="font-size:1.4rem">${state.account ? esc(pol(w.votes || 0n, 2)) : "—"}</div>
          <p class="hint">${!state.account ? "Connect a wallet" : delegated ? "Delegated to yourself" : "Delegate to activate your vote"}</p>
          ${state.account && !delegated && state.mode === "live"
            ? `<button class="btn btn--small btn--primary" data-action="delegate" style="margin-top:8px">Delegate to myself</button>` : ""}
        </section>
        <section class="panel">
          <h3>Total supply</h3>
          <div class="figure__value num" style="font-size:1.4rem">${d.token ? esc(pol(d.token.totalSupply, 2)) : "—"}</div>
          <p class="hint">One token per US dollar donated</p>
        </section>
      </div>

      ${state.account && !delegated ? `
        <div class="banner banner--warn">
          <h3>Your tokens are not voting yet</h3>
          <p>Holding tokens is not the same as having voting power. Delegate them to yourself
          once, and every token you hold from that point counts. This is how the token
          standard works, not a quirk of this project.</p>
        </div>` : ""}

      ${state.mode === "live" && state.account ? `
      <section class="panel">
        <div class="panel__head"><div><h2>Propose an allocation</h2><p>Needs at least 0.1 RLF of voting power</p></div></div>
        <form id="allocate-form" class="grid-2">
          <div>
            <div class="field">
              <label for="al-campaign">Send pool funds to</label>
              <select id="al-campaign">${d.campaigns.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="al-amount">Amount in ${SYM}</label>
              <input type="number" id="al-amount" min="0" step="0.0001" placeholder="50.0">
              <p class="hint">Pool holds ${esc(polUnit(d.stats.generalPool, 2))}</p>
            </div>
          </div>
          <div>
            <div class="field">
              <label for="al-reason">Why this campaign</label>
              <textarea id="al-reason" placeholder="Shelter rebuild is furthest from target and storm season starts in six weeks."></textarea>
            </div>
            <button class="btn btn--primary" type="submit">Open the vote</button>
          </div>
        </form>
      </section>` : ""}

      <section class="panel">
        <div class="panel__head"><div><h2>Allocation proposals</h2></div></div>
        ${d.allocations.length === 0
          ? `<div class="empty"><h3>No allocation votes yet</h3><p>Any donor with enough voting power can open one.</p></div>`
          : d.allocations.map(allocationCard).join("")}
      </section>`;
  }

  /* ---- Activity ---- */

  function activityTable(events) {
    if (!events || events.length === 0) {
      return `<div class="empty"><h3>Nothing recorded yet</h3><p>Contract events appear here as soon as the first transaction is mined.</p></div>`;
    }
    return `
      <div class="table-scroll">
        <table class="ledger">
          <thead>
            <tr><th>When</th><th>Event</th><th>Detail</th><th>Address</th><th class="right">Amount</th><th>Transaction</th></tr>
          </thead>
          <tbody>
            ${events.map((e) => `
              <tr>
                <td title="${esc(dateStr(e.timestamp))}">${esc(timeAgo(e.timestamp))}</td>
                <td>${esc(e.type.replace(/([a-z])([A-Z])/g, "$1 $2"))}</td>
                <td>${esc(e.detail || "")}</td>
                <td>${e.address ? explorerAddr(e.address) : "—"}</td>
                <td class="right amount">${e.amount != null ? esc(polUnit(e.amount, 2)) : ""}</td>
                <td>${state.mode === "demo"
                  ? `<span class="addr">${esc(shortAddr(e.txHash))}</span>`
                  : `<a class="addr" href="${esc(txLink(e.txHash))}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(e.txHash))}</a>`}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function viewActivity() {
    const d = state.data;
    return `
      <div class="page-head">
        <h1>Audit trail${demoTag()}</h1>
        <p>Every state change the contract makes emits an event, and these are read straight
        back from the chain. Nothing here is stored by this website.
        ${state.mode === "live" ? `Only the most recent ${esc(Number(CFG.eventChunkSize) * Number(CFG.eventMaxChunks))} blocks are queried, because public RPC endpoints reject unbounded history requests.` : ""}</p>
      </div>
      <section class="panel">
        <div class="panel__head">
          <div><h2>Contract events</h2><p>Newest first</p></div>
          ${state.mode === "live" ? `<button class="btn btn--small" data-action="retry">Reload</button>` : ""}
        </div>
        ${activityTable(d.events)}
      </section>`;
  }

  /* ---- Signers ---- */

  function viewSigners() {
    const d = state.data;
    const g = d.governance;
    const canAct = state.wallet.isSigner && state.mode === "live";

    return `
      <div class="page-head">
        <h1>Signers and beneficiaries${demoTag()}</h1>
        <p>These ${esc(g.signers.length)} addresses control disbursements, and any
        ${esc(g.requiredApprovals)} of them together can approve a payout. One alone can do
        nothing. The signer set is fixed at deployment and cannot be changed.</p>
      </div>

      <section class="panel">
        <div class="panel__head"><div><h2>Configured signers</h2><p>${esc(g.requiredApprovals)} of ${esc(g.signers.length)} required</p></div></div>
        <div class="table-scroll">
          <table class="ledger">
            <thead><tr><th>Address</th><th>Status</th></tr></thead>
            <tbody>
              ${g.signers.map((s) => `
                <tr>
                  <td>${explorerAddr(s, s)}</td>
                  <td>${state.account && s.toLowerCase() === state.account.toLowerCase()
                    ? `<span class="badge badge--accent">This is you</span>` : `<span class="badge">Signer</span>`}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <p class="hint" style="margin-top:12px">Timelock ${esc(Number(g.timelockDelay))} seconds ·
        proposals expire after ${esc(Math.round(Number(g.proposalExpiry) / 60))} minutes</p>
      </section>

      ${canAct ? `
      <section class="panel">
        <div class="panel__head"><div><h2>Signer actions</h2><p>Only shown to you because your wallet is a configured signer. The contract enforces this regardless of what this page shows.</p></div></div>
        <div class="grid-2">
          <form id="campaign-form">
            <h3>Open a campaign</h3>
            <div class="field"><label for="cf-name">Name</label><input type="text" id="cf-name" placeholder="Monsoon Flood Response"></div>
            <div class="field"><label for="cf-region">Region</label><input type="text" id="cf-region" placeholder="Wayanad, Kerala"></div>
            <div class="field"><label for="cf-desc">Description</label><textarea id="cf-desc"></textarea></div>
            <div class="field"><label for="cf-target">Target in US dollars</label><input type="number" id="cf-target" min="1" step="1" placeholder="50000"></div>
            <button class="btn btn--primary" type="submit">Create campaign</button>
          </form>
          <form id="beneficiary-form">
            <h3>Register a beneficiary</h3>
            <div class="field"><label for="bf-addr">Wallet address</label><input type="text" id="bf-addr" placeholder="0x…" spellcheck="false"></div>
            <div class="field"><label for="bf-name">Organisation name</label><input type="text" id="bf-name" placeholder="Wayanad District Relief Trust"></div>
            <p class="hint">Registering records a claim. It does not verify that the organisation exists or is trustworthy; you are vouching for that off chain.</p>
            <button class="btn btn--primary" type="submit" style="margin-top:12px">Register</button>
            <div class="actions">
              <button class="btn" type="button" data-action="${d.stats.paused ? "unpause" : "pause"}">
                ${d.stats.paused ? "Unpause the contract" : "Pause the contract"}
              </button>
            </div>
          </form>
        </div>
      </section>` : ""}

      <section class="panel">
        <div class="panel__head"><div><h2>Beneficiaries</h2><p>Only approved addresses can receive a payout</p></div></div>
        ${d.beneficiaries.length === 0
          ? `<div class="empty"><h3>None registered</h3><p>Signers register the organisations that may receive relief funds.</p></div>`
          : `<div class="table-scroll"><table class="ledger">
              <thead><tr><th>Organisation</th><th>Address</th><th>Approvals</th><th>Status</th>${canAct ? "<th></th>" : ""}</tr></thead>
              <tbody>
                ${d.beneficiaries.map((b) => `
                  <tr>
                    <td>${esc(b.name)}</td>
                    <td>${explorerAddr(b.address)}</td>
                    <td class="num">${esc(String(b.approvalCount))} of ${esc(g.requiredApprovals)}</td>
                    <td>${b.approved ? `<span class="badge badge--ok">Approved</span>` : `<span class="badge badge--warn">Awaiting approval</span>`}</td>
                    ${canAct ? `<td>${b.approved ? "" : `<button class="btn btn--small" data-action="approve-beneficiary" data-addr="${esc(b.address)}">Approve</button>`}</td>` : ""}
                  </tr>`).join("")}
              </tbody></table></div>`}
      </section>`;
  }

  /* ---- About ---- */

  function viewAbout() {
    const g = state.data ? state.data.governance : null;
    return `
      <div class="page-head">
        <h1>How this works</h1>
        <p>ReliefLedger is a student project that puts the full record of a disaster relief
        fund on a public blockchain, so that anyone can check what was given and what was
        spent without taking anyone's word for it.</p>
      </div>

      <div class="grid-2">
        <section class="panel">
          <h2>Why a blockchain at all</h2>
          <p>Relief funds are usually administered privately. Donors see a total and a report,
          and have to trust both. The ledger underneath is not public, and nothing stops it
          being revised after the fact.</p>
          <p>Here, every donation, approval and payout is a transaction on a public network.
          Anyone can read the whole history, and nobody, including the people who built this,
          can quietly edit an entry after it has been recorded.</p>

          <h2 style="margin-top:22px">No single person can move the money</h2>
          <p>Disbursements are controlled by a group of signers. A payout needs
          ${g ? esc(g.requiredApprovals) + " of " + esc(g.signers.length) : "several"} of them
          to approve the same proposal, naming the same recipient and the same amount. One
          signer acting alone, or one compromised key, cannot move anything.</p>
          <p>After the approvals come in, the proposal sits in a timelock before it can be
          executed. That delay exists so that an approval nobody expected can be noticed and
          revoked before the money leaves.</p>

          <h2 style="margin-top:22px">Where donor voting fits</h2>
          <p>Donating earns governance tokens, which vote on which campaign receives money
          from the general pool. A vote moves money between the fund's own internal balances.
          It cannot send money to a person or organisation. That boundary is enforced by the
          contract, not by policy.</p>
        </section>

        <section class="panel">
          <h2>What this cannot prove</h2>
          <p>This is the part most blockchain projects skip, so it is worth being plain about.</p>
          <p>A blockchain records what was submitted. It does not know whether what was
          submitted is true. Specifically:</p>
          <ul>
            <li>Registering a beneficiary records that signers vouched for an address. It does
            not establish that the organisation exists, is solvent, or will deliver aid.</li>
            <li>A utilisation proof stores the fingerprint of a document. Nothing checks that
            the document is a genuine receipt, or that the goods were ever delivered.</li>
            <li>Dollar values come from an external price feed. If that feed is wrong, the
            dollar figures are wrong. Payout amounts are set in ${SYM} and are unaffected.</li>
            <li>Large donors hold more votes. Donor governance reduces some manipulation, but
            it does not prevent a wealthy donor dominating allocation decisions.</li>
            <li>The signer set is fixed at deployment. A lost key permanently reduces the
            group, and there is no rotation mechanism in this version.</li>
          </ul>
          <p>The honest claim is narrow: this makes the record public and tamper-evident, and
          removes any single person's ability to move funds. It does not make fraud
          impossible.</p>

          <h2 style="margin-top:22px">Network details</h2>
          <p>This site uses ${esc(CFG.networkName)}, chain ID ${esc(CFG.chainId)}, with ${SYM} as
          the test currency. Test ${SYM} has no monetary value and is obtained free from a
          faucet. Transactions can be inspected at
          <a href="${esc(CFG.explorerUrl)}" target="_blank" rel="noopener noreferrer">${esc(CFG.explorerUrl.replace("https://", ""))}</a>.</p>
          <p>The contracts have not had a professional security audit. They are an educational
          project and should not be used to hold real money.</p>
        </section>
      </div>`;
  }

  /* ===========================================================================
     7. Actions
     ======================================================================== */

  async function doDonate(destination, campaignId, amountStr) {
    let value;
    try {
      value = ethers.parseEther(amountStr);
    } catch {
      toast("error", "Amount not understood", "Enter a number such as 1.5.");
      return;
    }
    if (value <= 0n) {
      toast("error", "Amount must be above zero", "The contract rejects zero-value donations.");
      return;
    }

    const where = destination === "pool"
      ? "the general relief pool"
      : `campaign ${campaignId}`;
    const ok = await confirmDialog("Confirm your donation",
      `You are about to donate ${pol(value, 6)} ${SYM} to ${where}. Your wallet will ask you to approve the transaction and its gas fee.`);
    if (!ok) return;

    await sendTx(`Donate ${pol(value, 4)} ${SYM}`, async () => {
      const fund = writeContract("fund");
      return destination === "pool"
        ? fund.donateToGeneralPool({ value })
        : fund.donate(BigInt(campaignId), { value });
    });
  }

  async function doApproveProposal(id) {
    await sendTx(`Approve proposal ${id}`, async () => writeContract("fund").approveProposal(BigInt(id)));
  }

  async function doRevokeProposal(id) {
    const ok = await confirmDialog("Withdraw your approval",
      `This removes your approval from proposal ${id}. If that drops it below the threshold, the timelock resets and must run again from the start.`);
    if (!ok) return;
    await sendTx(`Revoke approval on proposal ${id}`, async () => writeContract("fund").revokeApproval(BigInt(id)));
  }

  async function doExecute(id) {
    const p = state.data.proposals.find((x) => x.id === Number(id));
    const ok = await confirmDialog("Execute this payout",
      `This sends ${p ? pol(p.amount, 4) : ""} ${SYM} to the approved beneficiary. It cannot be undone.`);
    if (!ok) return;
    await sendTx(`Execute proposal ${id}`, async () => writeContract("fund").executeDisbursement(BigInt(id)));
  }

  async function doSubmitProof(id) {
    const input = window.prompt(
      "Paste the IPFS CID or document link for the receipts.\n\nThe contract stores a hash of what you enter. It cannot check what the document says.");
    if (!input) return;
    const hash = ethers.keccak256(ethers.toUtf8Bytes(input.trim()));
    await sendTx(`Record utilisation proof for proposal ${id}`,
      async () => writeContract("fund").submitUtilisationProof(BigInt(id), hash, input.trim()));
  }

  async function doApproveBeneficiary(addr) {
    await sendTx(`Approve beneficiary ${shortAddr(addr)}`,
      async () => writeContract("fund").approveBeneficiary(addr));
  }

  async function doDelegate() {
    await sendTx("Delegate voting power to yourself",
      async () => writeContract("token").delegate(state.account));
  }

  async function doVote(id, support) {
    await sendTx(`Vote ${support ? "for" : "against"} allocation ${id}`,
      async () => writeContract("dao").castVote(BigInt(id), support));
  }

  async function doFinalize(id) {
    await sendTx(`Finalise allocation ${id}`, async () => writeContract("dao").finalize(BigInt(id)));
  }

  async function doExecuteAllocation(id) {
    await sendTx(`Apply allocation ${id}`, async () => writeContract("dao").execute(BigInt(id)));
  }

  async function doPause(pauseIt) {
    const ok = await confirmDialog(pauseIt ? "Pause the contract" : "Unpause the contract",
      pauseIt
        ? "Donations, proposals and payouts all stop until a signer unpauses. Reading stays available."
        : "Normal operation resumes immediately.");
    if (!ok) return;
    await sendTx(pauseIt ? "Pause the contract" : "Unpause the contract",
      async () => (pauseIt ? writeContract("fund").pause() : writeContract("fund").unpause()));
  }

  /* ===========================================================================
     8. Router, events, startup
     ======================================================================== */

  function parseRoute() {
    const raw = window.location.hash.replace(/^#/, "") || "/overview";
    const [path, query] = raw.split("?");
    return { path, params: new URLSearchParams(query || "") };
  }

  function render() {
    const host = $("#view");
    renderNotices();

    if (state.mode === "loading") { host.innerHTML = skeleton(); return; }
    if (state.mode === "error") {
      host.innerHTML = `
        <div class="empty">
          <h3>Nothing can be shown right now</h3>
          <p>The site is configured to read a deployed contract, and that read failed. Sample
          data is deliberately not shown instead, because you would have no way to tell the
          difference.</p>
          <button class="btn btn--primary" data-action="retry">Try again</button>
        </div>`;
      return;
    }

    const { path, params } = parseRoute();
    state.route = path;

    let html;
    if (path === "/overview" || path === "/") html = viewOverview();
    else if (path === "/campaigns") html = viewCampaigns();
    else if (path.startsWith("/campaign/")) html = viewCampaignDetail(path.split("/")[2]);
    else if (path === "/donate") html = viewDonate(params);
    else if (path === "/disbursements") html = viewDisbursements();
    else if (path === "/governance") html = viewGovernance();
    else if (path === "/activity") html = viewActivity();
    else if (path === "/signers") html = viewSigners();
    else if (path === "/about") html = viewAbout();
    else {
      html = `<div class="empty"><h3>Page not found</h3>
        <p>That address does not match a section of this site.</p>
        <a class="btn btn--primary" href="#/overview">Back to the overview</a></div>`;
    }

    host.innerHTML = html;
    renderChrome();
    bindViewHandlers();
  }

  /** Wires up forms after each render. Buttons use delegation instead. */
  function bindViewHandlers() {
    const donateForm = $("#donate-form");
    if (donateForm) {
      const toggle = () => {
        const isCampaign = $("#dest-campaign") && $("#dest-campaign").checked;
        $("#campaign-field").hidden = !isCampaign;
      };
      $$("input[name='dest']").forEach((r) => r.addEventListener("change", toggle));

      const amountInput = $("#amount");
      amountInput.addEventListener("input", () => {
        const preview = $("#usd-preview");
        const err = $("#amount-error");
        err.hidden = true;
        amountInput.removeAttribute("aria-invalid");
        const v = parseFloat(amountInput.value);
        if (!amountInput.value) { preview.hidden = true; return; }
        if (!isFinite(v) || v <= 0) {
          err.textContent = "Enter an amount greater than zero.";
          err.hidden = false;
          amountInput.setAttribute("aria-invalid", "true");
          preview.hidden = true;
          return;
        }
        if (state.priceUsd8 != null) {
          try {
            const value = usdOf(ethers.parseEther(amountInput.value));
            preview.innerHTML = `<p class="hint">Roughly ${esc(usd(value))} at the current price feed rate, and about ${esc(pol(value * 10n ** 10n, 2))} RLF governance tokens.</p>`;
            preview.hidden = false;
          } catch { preview.hidden = true; }
        }
      });

      donateForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const dest = $("#dest-campaign") && $("#dest-campaign").checked ? "campaign" : "pool";
        const campaignId = $("#campaign-select") ? $("#campaign-select").value : null;
        const amount = $("#amount").value;
        if (!amount || parseFloat(amount) <= 0) {
          const err = $("#amount-error");
          err.textContent = "Enter an amount greater than zero.";
          err.hidden = false;
          $("#amount").setAttribute("aria-invalid", "true");
          $("#amount").focus();
          return;
        }
        doDonate(dest, campaignId, amount);
      });
    }

    const proposeForm = $("#propose-form");
    if (proposeForm) {
      proposeForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const campaignId = $("#pp-campaign").value;
        const beneficiary = $("#pp-beneficiary").value;
        const amount = $("#pp-amount").value;
        const category = $("#pp-category").value;
        const purpose = $("#pp-purpose").value.trim();
        if (!beneficiary) { toast("error", "No approved beneficiary", "Register and approve a beneficiary before proposing a payout."); return; }
        if (!amount || parseFloat(amount) <= 0) { toast("error", "Enter an amount", "The amount must be greater than zero."); return; }
        if (!purpose) { toast("error", "Describe the purpose", "The purpose is stored on chain and shown publicly."); return; }
        await sendTx(`Propose ${amount} ${SYM} disbursement`, async () =>
          writeContract("fund").proposeDisbursement(
            BigInt(campaignId), beneficiary, ethers.parseEther(amount), Number(category), purpose));
      });
    }

    const allocateForm = $("#allocate-form");
    if (allocateForm) {
      allocateForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const campaignId = $("#al-campaign").value;
        const amount = $("#al-amount").value;
        const reason = $("#al-reason").value.trim();
        if (!amount || parseFloat(amount) <= 0) { toast("error", "Enter an amount", "The amount must be greater than zero."); return; }
        if (!reason) { toast("error", "Give a reason", "Other donors need something to vote on."); return; }
        await sendTx(`Propose allocating ${amount} ${SYM}`, async () =>
          writeContract("dao").propose(BigInt(campaignId), ethers.parseEther(amount), reason));
      });
    }

    const campaignForm = $("#campaign-form");
    if (campaignForm) {
      campaignForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = $("#cf-name").value.trim();
        const region = $("#cf-region").value.trim();
        const desc = $("#cf-desc").value.trim();
        const target = $("#cf-target").value;
        if (!name || !region) { toast("error", "Name and region are required", "The contract rejects an empty name or region."); return; }
        if (!target || parseFloat(target) <= 0) { toast("error", "Set a target", "Enter the fundraising target in US dollars."); return; }
        const targetUsd8 = BigInt(Math.round(parseFloat(target) * 100)) * 10n ** 6n;
        await sendTx(`Create campaign "${name}"`, async () =>
          writeContract("fund").createCampaign(name, region, desc, targetUsd8));
      });
    }

    const beneficiaryForm = $("#beneficiary-form");
    if (beneficiaryForm) {
      beneficiaryForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const addr = $("#bf-addr").value.trim();
        const name = $("#bf-name").value.trim();
        if (!ethers.isAddress(addr)) { toast("error", "That is not a valid address", "Paste the full 42-character wallet address."); return; }
        if (!name) { toast("error", "Name required", "Record who this address belongs to."); return; }
        await sendTx(`Register ${name}`, async () =>
          writeContract("fund").registerBeneficiary(ethers.getAddress(addr), name));
      });
    }

    startTicker();
  }

  /** One delegated click handler for every data-action button on the page. */
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    const id = target.getAttribute("data-id");

    switch (action) {
      case "connect": connectWallet(true); break;
      case "disconnect": disconnectWallet(); break;
      case "switch-network": switchNetwork(); break;
      case "retry": boot(); break;
      case "approve-proposal": doApproveProposal(id); break;
      case "revoke-proposal": doRevokeProposal(id); break;
      case "execute-proposal": doExecute(id); break;
      case "submit-proof": doSubmitProof(id); break;
      case "approve-beneficiary": doApproveBeneficiary(target.getAttribute("data-addr")); break;
      case "delegate": doDelegate(); break;
      case "vote": doVote(id, target.getAttribute("data-support") === "1"); break;
      case "finalize": doFinalize(id); break;
      case "execute-allocation": doExecuteAllocation(id); break;
      case "pause": doPause(true); break;
      case "unpause": doPause(false); break;
      default: break;
    }
  });

  /* ---- mobile navigation ---- */
  $("#nav-toggle").addEventListener("click", () => {
    const nav = $("#nav");
    const open = nav.classList.toggle("is-open");
    $("#nav-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#nav-list").addEventListener("click", (e) => {
    if (e.target.matches(".nav__link")) {
      $("#nav").classList.remove("is-open");
      $("#nav-toggle").setAttribute("aria-expanded", "false");
    }
  });

  /* ---- wallet events ---- */
  if (hasWallet()) {
    window.ethereum.on("accountsChanged", async (accounts) => {
      if (!accounts || accounts.length === 0) { disconnectWallet(); return; }
      await connectWallet(false);
    });
    // A chain change invalidates every contract binding, so rebuild from scratch.
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  window.addEventListener("hashchange", render);

  // Stop polling while the tab is hidden; resume on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (state.mode === "live") { startPolling(); refresh(); }
  });

  window.addEventListener("beforeunload", () => { stopPolling(); if (state.tickTimer) clearInterval(state.tickTimer); });

  /* ---- go ---- */
  boot().then(() => {
    if (hasWallet()) connectWallet(false); // silent reconnect if already authorised
  });
})();
