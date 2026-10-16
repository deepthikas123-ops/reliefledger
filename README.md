# ReliefLedger frontend (Ethereum Sepolia build)

This copy is configured for **Ethereum Sepolia** (chain ID 11155111, coin ETH). The coin symbol
and network details come from `config.js`, so the same code runs on any EVM test network.

To go live: deploy the contracts, paste the three addresses into `config.js`, then serve this
folder (`py -m http.server 8000`) or deploy it to Vercel with the Root Directory set to the
folder that contains `index.html`.

---


The public website. Plain HTML, CSS and JavaScript with ethers.js from a pinned CDN. No build
step, no framework, no server-side code.

## Run it locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. A local server is preferable to opening `index.html`
directly, because some browsers restrict `file://` pages.

## Deploy to Vercel

| Setting | Value |
|---------|-------|
| Framework Preset | Other |
| Root Directory | `frontend` |
| Build Command | empty |
| Output Directory | empty |

No `vercel.json` is needed. Routing uses URL hashes, which the browser resolves without server
rewrite rules.

Any static host works: Netlify, GitHub Pages, Cloudflare Pages, or a plain web server.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell and navigation |
| `styles.css` | Design tokens, layout, responsive and print rules |
| `config.js` | Public configuration: addresses, chain, RPC, explorer |
| `abi.js` | **Generated** from solc output. Do not hand-edit. |
| `demo-data.js` | Sample data, used only when no address is configured |
| `app.js` | Helpers, state, chain access, views, actions, router |
| `assets/logo.svg` | Original wordmark |

## Configuration

Everything in `config.js` is public, because it ships to every visitor's browser. Never put a
private key, seed phrase or API secret there, or in a Vercel environment variable.

Set `fundAddress`, `tokenAddress` and `daoAddress` after deploying the contracts, then commit
and redeploy. For quick testing you can instead pass them in the URL:
`?fund=0x…&token=0x…&dao=0x…`. Query parameters only apply where the configured address is
blank, so a link cannot override a configured address.

Set `deploymentBlock` to your deployment block to make event history queries faster.

## Three modes

| Mode | When | What is shown |
|------|------|---------------|
| Demo | No `fundAddress` | Labelled sample data, violet indicator |
| Live | Address set and reachable | Chain data only, green indicator |
| Error | Address set, unreachable | An error and a retry, red indicator |

The error state deliberately does not fall back to sample data. A visitor could not tell the
difference between invented figures and real ones, so showing nothing is the honest option.

## Notes for maintainers

All ethers calls live in the "blockchain access" section of `app.js`, so the rendering code
runs identically against live and sample data.

Reads use a public JSON-RPC provider, so the fund is auditable without a wallet. Writes rebind
to the wallet signer and carry a 25% gas margin, which is not padding: vote checkpoints are
keyed by timestamp, and a transaction that mines a second after its gas estimate can cost
about 20,000 gas more than estimated.

Event history is fetched in bounded block ranges walking backwards from the chain head.
Requesting block 0 to latest in one call is the most common way a dashboard like this breaks
against a public RPC.

Every string that comes from the chain is escaped before it reaches `innerHTML`. Campaign
names and proposal purposes are attacker-controlled input.

Browser validation is for usability only. The contract is the security boundary.
