"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  type Address,
} from "wagmi";
import {
  BaseError,
  formatUnits,
  parseAbiItem,
  parseUnits,
} from "viem";
import styles from "./draw.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { TOTAL_TICKETS } from "@/lib/constants";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as Address | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as Address | undefined;

const fallbackDecimals = 6;

const purchaseEvent = parseAbiItem(
  "event TicketPurchased(address indexed buyer, uint256 count, uint256 totalCost)"
);
const withdrawEvent = parseAbiItem(
  "event Withdraw(address indexed to, uint256 amount)"
);
const priceEvent = parseAbiItem(
  "event TicketPriceUpdated(uint256 newPrice)"
);

type FlowState = "idle" | "draw" | "distribute";

type HistoryEntry = {
  txHash?: `0x${string}`;
  type: "purchase" | "withdraw" | "price";
  heading: string;
  subheading: string;
  amount: string;
  timestamp?: string;
  blockNumber?: bigint;
};

const formatError = (error: unknown) => {
  if (!error) return "";
  if (error instanceof BaseError) {
    return error.shortMessage || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
};

const formatDate = (timestamp?: string) => {
  if (!timestamp) return "Pending";
  return timestamp;
};

const formatAddress = (address?: string) => {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
};

export default function DrawPage() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { data: decimalsData } = useReadContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
    query: {
      enabled: Boolean(USDT_ADDRESS),
    },
  });

  const decimals = useMemo(() => {
    if (typeof decimalsData === "number") return decimalsData;
    if (typeof decimalsData === "bigint") return Number(decimalsData);
    return fallbackDecimals;
  }, [decimalsData]);

  const { data: priceData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketPrice",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
    },
  });

  const { data: ticketsSoldData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketsSold",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
      refetchInterval: 20_000,
    },
  });

  const { data: ownerData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "owner",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
    },
  });

  const ticketPriceRaw = useMemo(() => {
    if (typeof priceData === "bigint") return priceData;
    if (typeof priceData === "number") return BigInt(priceData);
    return parseUnits("0.11", decimals);
  }, [decimals, priceData]);

  const ticketsSold = useMemo(() => {
    if (typeof ticketsSoldData === "bigint") return ticketsSoldData;
    if (typeof ticketsSoldData === "number") return BigInt(ticketsSoldData);
    return 0n;
  }, [ticketsSoldData]);

  const ticketsSoldCount = useMemo(() => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const safeValue = ticketsSold > max ? max : ticketsSold;
    return Number(safeValue);
  }, [ticketsSold]);

  const ticketsLeft = useMemo(
    () => Math.max(TOTAL_TICKETS - ticketsSoldCount, 0),
    [ticketsSoldCount]
  );

  const totalPot = useMemo(() => {
    try {
      return ticketsSold * ticketPriceRaw;
    } catch {
      return 0n;
    }
  }, [ticketPriceRaw, ticketsSold]);

  const formattedPot = useMemo(
    () =>
      Number(formatUnits(totalPot, decimals)).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
    [decimals, totalPot]
  );

  const ticketsSoldPercent = useMemo(() => {
    if (TOTAL_TICKETS === 0) return 0;
    return Math.min(
      100,
      Math.round((ticketsSoldCount / TOTAL_TICKETS) * 100)
    );
  }, [ticketsSoldCount]);

  const isOwner = useMemo(() => {
    if (!address || !ownerData) return false;
    return address.toLowerCase() === ownerData.toLowerCase();
  }, [address, ownerData]);

  useEffect(() => {
    if (!publicClient || !LOTTERY_ADDRESS) return;

    let cancelled = false;
    const blockTimestampCache = new Map<string, string>();

    const loadTimestamp = async (blockNumber: bigint | undefined) => {
      if (!blockNumber) return undefined;
      const key = blockNumber.toString();
      if (blockTimestampCache.has(key)) {
        return blockTimestampCache.get(key);
      }
      const block = await publicClient.getBlock({ blockNumber });
      const timestamp = Number(block.timestamp);
      const formatted = new Date(timestamp * 1000).toLocaleString();
      blockTimestampCache.set(key, formatted);
      return formatted;
    };

    const loadHistory = async () => {
      try {
        setHistoryLoading(true);
        setHistoryError(null);
        const latestBlock = await publicClient.getBlockNumber();
        const span = 6000n;
        const fromBlock = latestBlock > span ? latestBlock - span : 0n;

        const [purchaseLogs, withdrawLogs, priceLogs] = await Promise.all([
          publicClient.getLogs({
            address: LOTTERY_ADDRESS,
            event: purchaseEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
          publicClient.getLogs({
            address: LOTTERY_ADDRESS,
            event: withdrawEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
          publicClient.getLogs({
            address: LOTTERY_ADDRESS,
            event: priceEvent,
            fromBlock,
            toBlock: latestBlock,
          }),
        ]);

        const entries: HistoryEntry[] = [];

        for (const log of purchaseLogs) {
          const args = log.args as {
            buyer: Address;
            count: bigint;
            totalCost: bigint;
          };
          const timestamp = await loadTimestamp(log.blockNumber ?? undefined);
          entries.push({
            txHash: log.transactionHash ?? undefined,
            type: "purchase",
            heading: `${args.count.toString()} ticket(s) purchased`,
            subheading: `Buyer · ${formatAddress(args.buyer)}`,
            amount: `${Number(
              formatUnits(args.totalCost, decimals)
            ).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            })} USDT`,
            timestamp,
            blockNumber: log.blockNumber ?? undefined,
          });
        }

        for (const log of withdrawLogs) {
          const args = log.args as { to: Address; amount: bigint };
          const timestamp = await loadTimestamp(log.blockNumber ?? undefined);
          entries.push({
            txHash: log.transactionHash ?? undefined,
            type: "withdraw",
            heading: "Reward distribution",
            subheading: `Recipient · ${formatAddress(args.to)}`,
            amount: `${Number(
              formatUnits(args.amount, decimals)
            ).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            })} USDT`,
            timestamp,
            blockNumber: log.blockNumber ?? undefined,
          });
        }

        for (const log of priceLogs) {
          const args = log.args as { newPrice: bigint };
          const timestamp = await loadTimestamp(log.blockNumber ?? undefined);
          entries.push({
            txHash: log.transactionHash ?? undefined,
            type: "price",
            heading: "Ticket price updated",
            subheading: "Adjustment",
            amount: `${Number(
              formatUnits(args.newPrice, decimals)
            ).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            })} USDT`,
            timestamp,
            blockNumber: log.blockNumber ?? undefined,
          });
        }

        entries.sort((a, b) => {
          const blockA = a.blockNumber ?? 0n;
          const blockB = b.blockNumber ?? 0n;
          if (blockA === blockB) return 0;
          return blockA > blockB ? -1 : 1;
        });

        if (!cancelled) {
          setHistory(entries.slice(0, 60));
        }
      } catch (error) {
        if (!cancelled) {
          setHistoryError(formatError(error));
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };

    loadHistory();

    const interval = setInterval(loadHistory, 45_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [decimals, publicClient]);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    []
  );

  const handleAction = (action: Exclude<FlowState, "idle">) => {
    if (!isOwner) {
      setStatusMessage("Only the lottery owner can trigger draws or rewards.");
      return;
    }
    setFlowState(action);
    setStatusMessage(
      "This control requires the on-chain draw/reward function. Deploy the upgraded contract and wire it here."
    );
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setFlowState("idle");
    }, 1500);
  };

  return (
    <div className={styles.page}>
      <GlowingOrbs />
      <main className={styles.main}>
        <header className={styles.hero}>
          <div className={styles.heroText}>
            <p className={styles.eyebrow}>Draw control center</p>
            <h1 className={styles.title}>Distribute rewards with confidence</h1>
            <p className={styles.subtitle}>
              Monitor the live prize pool, track sold tickets, and coordinate
              reward distribution. Action buttons are gated to the contract
              owner and update the timeline below once the upgraded smart
              contract is connected.
            </p>
          </div>
          <div className={styles.statsPanel}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Current prize pool</span>
              <span className={styles.statValue}>{formattedPot} USDT</span>
              <span className={styles.statHint}>
                Calculated from ticket sales · auto-refreshing
              </span>
            </div>
            <div className={styles.statRow}>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Tickets sold</span>
                <span className={styles.microValue}>{ticketsSoldCount}</span>
              </div>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Tickets left</span>
                <span className={styles.microValue}>{ticketsLeft}</span>
              </div>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Progress</span>
                <span className={styles.microValue}>
                  {ticketsSoldPercent}%
                </span>
              </div>
            </div>
            <Link href="/" className={styles.homeLink}>
              Back to ticket purchase
            </Link>
          </div>
        </header>

        <motion.section
          className={styles.actions}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <div className={styles.actionHeader}>
            <h2 className={styles.sectionTitle}>Draw workflow</h2>
            <p className={styles.sectionSubtitle}>
              Trigger and confirm each phase in order: lock sales, select the
              winner, and distribute the prize. Integrate your randomness
              provider (e.g., Chainlink VRF) before launching on mainnet.
            </p>
          </div>
          <div className={styles.actionGrid}>
            <div className={styles.actionCard}>
              <h3>1. Draw winning ticket</h3>
              <p>
                Finalize entries and request verifiable randomness to select the
                winner. This should seal the round and emit a dedicated event.
              </p>
              <button
                className={styles.actionButton}
                onClick={() => handleAction("draw")}
                disabled={flowState !== "idle"}
              >
                {flowState === "draw" ? "Preparing..." : "Initiate draw"}
              </button>
            </div>
            <div className={styles.actionCard}>
              <h3>2. Distribute rewards</h3>
              <p>
                Transfer the accumulated USDT pot to the winner and broadcast an
                on-chain receipt. The `Withdraw` event feeds directly into the
                history log.
              </p>
              <button
                className={styles.actionButtonSecondary}
                onClick={() => handleAction("distribute")}
                disabled={flowState !== "idle"}
              >
                {flowState === "distribute"
                  ? "Routing funds..."
                  : "Send winnings"}
              </button>
            </div>
          </div>
          {statusMessage && (
            <div className={styles.statusBanner}>{statusMessage}</div>
          )}
          {!isOwner && (
            <p className={styles.permissionHint}>
              Connect as the contract owner to enable draw & reward controls.
            </p>
          )}
        </motion.section>

        <motion.section
          className={styles.history}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
        >
          <div className={styles.historyHeader}>
            <h2 className={styles.sectionTitle}>Transaction timeline</h2>
            <p className={styles.sectionSubtitle}>
              Real-time feed of ticket purchases, prize withdrawals, and price
              updates. Pulls the last ~6k blocks from the BNB Greenfield testnet
              RPC and refreshes every 45 seconds.
            </p>
          </div>
          {historyError && (
            <div className={styles.errorBanner}>{historyError}</div>
          )}
          {historyLoading && history.length === 0 ? (
            <div className={styles.loadingState}>Loading recent activity…</div>
          ) : history.length === 0 ? (
            <div className={styles.emptyState}>
              No on-chain activity detected yet. Purchases and reward payouts
              will appear here automatically.
            </div>
          ) : (
            <div className={styles.historyList}>
              {history.map((entry, index) => (
                <div key={`${entry.txHash ?? index}-${entry.heading}`} className={styles.historyItem}>
                  <span
                    className={`${styles.historyMarker} ${
                      entry.type === "withdraw"
                        ? styles.markerWithdraw
                        : entry.type === "purchase"
                        ? styles.markerPurchase
                        : styles.markerNeutral
                    }`}
                  />
                  <div className={styles.historyContent}>
                    <div className={styles.historyHeaderRow}>
                      <h3>{entry.heading}</h3>
                      <span className={styles.historyAmount}>{entry.amount}</span>
                    </div>
                    <p className={styles.historySubheading}>{entry.subheading}</p>
                    <div className={styles.historyMeta}>
                      <span>{formatDate(entry.timestamp)}</span>
                      {entry.txHash && (
                        <a
                          href={`https://testnet.bscscan.com/tx/${entry.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View on BscScan →
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.section>
      </main>
    </div>
  );
}

