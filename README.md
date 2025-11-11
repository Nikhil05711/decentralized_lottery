# Nebula Lottery

Nebula Lottery is a fully animated decentralized raffle dApp built on the BNB Testnet. Players connect with MetaMask or Trust Wallet (via WalletConnect), purchase multiple lottery tickets priced at **0.11 USDT** each, and monitor live ticket metrics directly from the smart contract.

## Features

- Wallet onboarding with RainbowKit + wagmi (MetaMask, Trust Wallet, WalletConnect, Coinbase, Rainbow)
- Animated, glassmorphism-inspired UI crafted with Framer Motion
- Smart-contract ready purchase flow with dynamic approval + buy sequence
- Real-time reads for ticket price and total tickets sold
- Configurable contract, USDT token, and RPC endpoints via environment variables

## Prerequisites

- Node.js ≥ 18
- An RPC endpoint for BNB Testnet (`NEXT_PUBLIC_BSC_RPC_URL`)
- WalletConnect Cloud project ID (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`)
- Deployed Lottery contract and USDT token addresses on BNB Testnet

## Configuration

Create a `.env.local` file at the project root and populate the public variables:

```bash
NEXT_PUBLIC_BSC_RPC_URL="https://bsc-testnet.drpc.org"
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID="your-walletconnect-project-id"
NEXT_PUBLIC_LOTTERY_ADDRESS="0xYourLotteryContract"
NEXT_PUBLIC_USDT_ADDRESS="0xYourUsdtToken"
NEXT_PUBLIC_TOTAL_TICKETS="100"
```

> All variables must be prefixed with `NEXT_PUBLIC_` so they are available inside the browser runtime.

## Development

Install dependencies (already installed in this workspace):

```bash
npm install
```

Run the local development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to explore the animated lottery experience. Visit `/tickets` for the live ticket board showing sold (red watermark) and available (cyan watermark) entries, and `/draw` for the draw/reward control center with transaction history.

## Smart Contract

The repository includes a reference contract at `contracts/Lottery.sol`. It accepts an ERC-20 stablecoin (USDT) and exposes:

- `buyTickets(uint256 count)` – transfers USDT from the buyer to the contract and mints ticket balances
- `setTicketPrice(uint256 newTicketPrice)` – owner-only price control (18-decimal USDT values)
- `withdraw(address to, uint256 amount)` – owner-only treasury extraction

Deploy the contract to BNB Testnet, record the deployed addresses, and update the environment variables accordingly. Remember to fund test wallets with BNB (for gas) and USDT.

## Design & UX

- Animated background aurora with dynamically moving light orbs
- Responsive layout with elevated hero stats and ticket purchase module
- Sequential CTA that requests ERC-20 allowance before confirming a ticket purchase
- Toast-like success and error messaging tied to on-chain transaction receipts

## Production Build

```bash
npm run build
npm run start
```

## Security & Testing Checklist

- Thoroughly test allowance + purchase flows using wagmi’s testing utilities or Cypress + smart contract mocks
- Validate contract ownership operations (`setTicketPrice`, `withdraw`) on testnet prior to launch
- Consider audit/review for contract logic and integrate Chainlink VRF or similar for randomness in future iterations

Enjoy building and iterating on your decentralized lottery! 🚀

