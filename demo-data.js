/**
 * Sample data for demo mode.
 *
 * NONE OF THIS IS BLOCKCHAIN DATA. It exists so the interface can be reviewed before any
 * contract is deployed. It is only ever used when no contract address is configured, it is
 * labelled wherever it appears, and it is never blended into a figure presented as on-chain.
 *
 * The addresses below are deliberately patterned (0xDe30…DE0n) so nobody can mistake them
 * for real deployed contracts or real wallets.
 */
(function () {
  const now = () => Math.floor(Date.now() / 1000);
  const E = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n; // n POL as wei
  const USD = (n) => BigInt(Math.round(n * 100)) * 10n ** 6n; // n USD at 8 decimals

  const A = {
    signer1: "0xDe30000000000000000000000000000000000DE01",
    signer2: "0xDe30000000000000000000000000000000000DE02",
    signer3: "0xDe30000000000000000000000000000000000DE03",
    ben1: "0xDe30000000000000000000000000000000000DE04",
    ben2: "0xDe30000000000000000000000000000000000DE05",
    ben3: "0xDe30000000000000000000000000000000000DE06",
    donor1: "0xDe30000000000000000000000000000000000DE07",
    donor2: "0xDe30000000000000000000000000000000000DE08",
    donor3: "0xDe30000000000000000000000000000000000DE09",
  };

  const t = now();
  const H = 3600;

  const campaigns = [
    {
      id: 1,
      name: "Monsoon Flood Response",
      region: "Wayanad, Kerala",
      description:
        "Emergency food, clean water and temporary shelter for households displaced by flooding along the Kabini river.",
      targetUsd: USD(50000),
      raised: E(68000),
      allocated: E(12000),
      disbursed: E(31000),
      donorCount: 214n,
      createdAt: t - 26 * 24 * H,
      active: true,
    },
    {
      id: 2,
      name: "Cyclone Shelter Rebuild",
      region: "Puri district, Odisha",
      description:
        "Rebuilding four community cyclone shelters damaged in the last storm season, including roofing and water tanks.",
      targetUsd: USD(80000),
      raised: E(42000),
      allocated: 0n,
      disbursed: E(9500),
      donorCount: 97n,
      createdAt: t - 12 * 24 * H,
      active: true,
    },
    {
      id: 3,
      name: "Earthquake Medical Supply",
      region: "Chamoli, Uttarakhand",
      description:
        "Trauma kits, field medicines and transport for two mobile clinics serving cut-off villages.",
      targetUsd: USD(25000),
      raised: E(104000),
      allocated: 0n,
      disbursed: E(104000),
      donorCount: 341n,
      createdAt: t - 94 * 24 * H,
      active: false,
    },
  ];

  const beneficiaries = [
    { address: A.ben1, name: "Wayanad District Relief Trust", registered: true, approved: true, approvalCount: 3n },
    { address: A.ben2, name: "Coastal Shelter Collective", registered: true, approved: true, approvalCount: 2n },
    { address: A.ben3, name: "Himalayan Mobile Clinics", registered: true, approved: false, approvalCount: 1n },
  ];

  const proposals = [
    {
      id: 4,
      campaignId: 1,
      beneficiary: A.ben1,
      amount: E(9000),
      category: 0,
      purpose: "Dry ration kits for 600 households in three relief camps",
      proposer: A.signer1,
      approvalCount: 1n,
      createdAt: t - 2 * H,
      executableAfter: 0,
      expiresAt: t + 46 * H,
      executedAt: 0,
      executed: false,
      proofHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      proofUri: "",
    },
    {
      id: 3,
      campaignId: 2,
      beneficiary: A.ben2,
      amount: E(6500),
      category: 4,
      purpose: "Roofing sheets and fixings for shelters 2 and 3",
      proposer: A.signer2,
      approvalCount: 2n,
      createdAt: t - 5 * H,
      executableAfter: t + 40,
      expiresAt: t + 43 * H,
      executedAt: 0,
      executed: false,
      proofHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      proofUri: "",
    },
    {
      id: 2,
      campaignId: 1,
      beneficiary: A.ben1,
      amount: E(18000),
      category: 2,
      purpose: "Temporary shelter materials and site preparation",
      proposer: A.signer1,
      approvalCount: 2n,
      createdAt: t - 9 * 24 * H,
      executableAfter: t - 9 * 24 * H + 60,
      expiresAt: t - 8 * 24 * H,
      executedAt: t - 9 * 24 * H + 400,
      executed: true,
      proofHash: "0x9f2c4a1d77e3b58c06d4a9f1e2b7c38d55a0e9b4c1d6f8302a7b5e4c9d1f06a83",
      proofUri: "ipfs://bafybeigdyrztsamplecidnotarealdocumenthash",
    },
    {
      id: 1,
      campaignId: 1,
      beneficiary: A.ben1,
      amount: E(13000),
      category: 1,
      purpose: "Field medicines and two weeks of clinic staffing",
      proposer: A.signer3,
      approvalCount: 3n,
      createdAt: t - 21 * 24 * H,
      executableAfter: t - 21 * 24 * H + 60,
      expiresAt: t - 20 * 24 * H,
      executedAt: t - 21 * 24 * H + 900,
      executed: true,
      proofHash: "0x3b81ff0c5a9d27e46b08c1a3d5f7e9b24c60a8d1f3e5b7c9a2d4f6081b3c5e7a9",
      proofUri: "",
    },
  ];

  const allocations = [
    {
      id: 2,
      campaignId: 2,
      amount: E(8000),
      proposer: A.donor1,
      rationale: "Shelter rebuild is furthest from target and storm season starts in six weeks.",
      snapshot: t - 90,
      voteEnd: t + 95,
      forVotes: E(430),
      againstVotes: E(85),
      quorumRequired: E(390),
      executableAfter: 0,
      finalized: false,
      passed: false,
      executed: false,
    },
    {
      id: 1,
      campaignId: 1,
      amount: E(12000),
      proposer: A.donor2,
      rationale: "Flood response has the highest verified caseload this month.",
      snapshot: t - 6 * 24 * H,
      voteEnd: t - 6 * 24 * H + 180,
      forVotes: E(1240),
      againstVotes: E(96),
      quorumRequired: E(380),
      executableAfter: t - 6 * 24 * H + 240,
      finalized: true,
      passed: true,
      executed: true,
    },
  ];

  const events = [
    { type: "DonationReceived", blockNumber: 9481233, timestamp: t - 1800, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a1", address: A.donor3, amount: E(250), detail: "Monsoon Flood Response" },
    { type: "ProposalCreated", blockNumber: 9481190, timestamp: t - 2 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a2", address: A.signer1, amount: E(9000), detail: "Proposal 4 — Food" },
    { type: "ProposalApproved", blockNumber: 9480955, timestamp: t - 5 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a3", address: A.signer3, amount: null, detail: "Proposal 3 reached 2 of 3" },
    { type: "GeneralPoolDonationReceived", blockNumber: 9480604, timestamp: t - 11 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a4", address: A.donor1, amount: E(1500), detail: "General relief pool" },
    { type: "BeneficiaryApproved", blockNumber: 9479881, timestamp: t - 3 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a5", address: A.ben2, amount: null, detail: "Coastal Shelter Collective" },
    { type: "GeneralPoolAllocated", blockNumber: 9478120, timestamp: t - 6 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a6", address: A.donor2, amount: E(12000), detail: "Allocated to Monsoon Flood Response" },
    { type: "UtilisationProofSubmitted", blockNumber: 9477402, timestamp: t - 8 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a7", address: A.signer2, amount: null, detail: "Proposal 2 receipts" },
    { type: "DisbursementExecuted", blockNumber: 9477180, timestamp: t - 9 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a8", address: A.ben1, amount: E(18000), detail: "Shelter materials" },
    { type: "CampaignCreated", blockNumber: 9470551, timestamp: t - 12 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000a9", address: A.signer1, amount: null, detail: "Cyclone Shelter Rebuild" },
    { type: "Paused", blockNumber: 9462219, timestamp: t - 40 * 24 * H, txHash: "0xDe300000000000000000000000000000000000000000000000000000000000aa", address: A.signer2, amount: null, detail: "Paused during a suspected key compromise, resolved same day" },
  ];

  const totalDonated = E(214000);
  const totalDisbursed = E(144500);

  window.RELIEF_DEMO = {
    isDemo: true,
    polUsd: 25_000_000n, // $0.25 with 8 decimals
    stats: {
      totalDonated,
      totalDisbursed,
      available: totalDonated - totalDisbursed,
      generalPool: E(18400),
      campaignCount: 3n,
      proposalCount: 4n,
      pendingProposals: 2n,
      donationCount: 652n,
      paused: false,
    },
    governance: {
      signers: [A.signer1, A.signer2, A.signer3],
      requiredApprovals: 2n,
      timelockDelay: 60n,
      proposalExpiry: 172800n,
    },
    campaigns,
    beneficiaries,
    proposals,
    allocations,
    events,
    token: { totalSupply: E(53500), symbol: "RLF" },
  };
})();
