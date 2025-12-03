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

// Completely custom storage that uses cookies in browser, no-op during SSR
// This prevents any localStorage access during build/SSR
const customStorage = {
  getItem: (key: string): string | null => {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    try {
      const name = key + "=";
      const decodedCookie = decodeURIComponent(document.cookie);
      const ca = decodedCookie.split(";");
      for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === " ") {
          c = c.substring(1);
        }
        if (c.indexOf(name) === 0) {
          return c.substring(name.length, c.length);
        }
      }
      return null;
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    try {
      document.cookie = `${key}=${value}; path=/; max-age=31536000; SameSite=Lax`;
    } catch {
      // Ignore errors during SSR
    }
  },
  removeItem: (key: string): void => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    try {
      document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    } catch {
      // Ignore errors during SSR
    }
  },
};

export const wagmiConfig = createConfig({
  chains: [bscTestnet],
  connectors,
  ssr: true,
  storage: createStorage({
    storage: customStorage as any,
  }),
  transports: {
    [bscTestnet.id]: http(
      process.env.NEXT_PUBLIC_BSC_RPC_URL ?? "https://bsc-testnet.drpc.org"
    ),
  },
});

