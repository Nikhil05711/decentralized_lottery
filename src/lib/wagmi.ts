import { cookieStorage, createStorage } from "wagmi";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  trustWallet,
  walletConnectWallet,
  rainbowWallet,
  coinbaseWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { bscTestnet } from "wagmi/chains";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

if (!projectId) {
  console.warn(
    "Missing WalletConnect project id. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable WalletConnect compatible wallets."
  );
}

const popularWallets = [
  {
    groupName: "Popular",
    wallets: [
      metaMaskWallet,
      trustWallet,
      walletConnectWallet,
      rainbowWallet,
      coinbaseWallet,
    ],
  },
];

const connectors = connectorsForWallets(popularWallets, {
  appName: "Nebula Lottery",
  projectId: projectId ?? "demo",
  appDescription:
    "Decentralized lottery where every ticket costs 0.11 USDT on BNB Testnet.",
  appIcon:
    "https://raw.githubusercontent.com/vercel/next.js/canary/examples/with-web3/public/favicon.ico",
});

export const wagmiConfig = createConfig({
  chains: [bscTestnet],
  connectors,
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
  transports: {
    [bscTestnet.id]: http(
      process.env.NEXT_PUBLIC_BSC_RPC_URL ?? "https://bsc-testnet.drpc.org"
    ),
  },
});

