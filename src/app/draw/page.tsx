"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  useAccount,
  usePublicClient,
  useReadContract,
} from "wagmi";
import {
  BaseError,
  formatUnits,
  parseAbiItem,
  parseUnits,
  type Address,
} from "viem";
import styles from "./draw.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as Address | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as Address | undefined;

const fallbackDecimals = 6;
const ticketNumberMask = (BigInt(1) << BigInt(128)) - BigInt(1);
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DRAW_HOUR_IST = 21;

const toIst = (date: Date) =>
  new Date(date.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);

const fromIst = (date: Date) =>
  new Date(date.getTime() - IST_OFFSET_MINUTES * MS_PER_MINUTE);

const getNextDrawDate = (reference: Date = new Date()) => {
  const istNow = toIst(reference);
  const target = new Date(istNow);
  target.setHours(DRAW_HOUR_IST, 0, 0, 0);
  if (istNow >= target) {
    target.setDate(target.getDate() + 1);
  }
  return fromIst(target);
};

const getPreviousDrawDate = (nextDraw: Date) =>
  new Date(nextDraw.getTime() - MS_PER_DAY);

const clampToSafeNumber = (value: bigint | number | undefined) => {
  if (typeof value === "number") return value;
  if (typeof value !== "bigint") return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > max ? max : value);
};

const extractTicketOrdinal = (ticketId: bigint) => {
  const ordinal = ticketId & ticketNumberMask;
  return ordinal.toString();
};

const formatTicketRange = (ticketIds: readonly bigint[] | undefined) => {
  if (!ticketIds || ticketIds.length === 0) return "Ticket IDs pending";
  if (ticketIds.length === 1) {
    return `Ticket #${extractTicketOrdinal(ticketIds[0])}`;
  }
  const first = extractTicketOrdinal(ticketIds[0]);
  const last = extractTicketOrdinal(ticketIds[ticketIds.length - 1]);
  return `Tickets #${first}–#${last}`;
};

const formatDuration = (milliseconds: number) => {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    seconds.toString().padStart(2, "0"),
  ].join(":");
};

const formatIstDateTime = (date: Date) => {
  const istDate = toIst(date);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    day: "numeric",
    month: "short",
  }).format(istDate);
};

const resolveDrawTicket = (sold: number, total: number) => {
  const pool = sold > 0 ? sold : total;
  if (pool <= 0) return null;
  return Math.floor(Math.random() * pool) + 1;
};

const purchaseEvent = parseAbiItem(
  "event TicketPurchased(address indexed buyer, uint256 count, uint256 totalCost, uint256[] ticketIds, uint256 indexed seriesId)"
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

  const { data: activeSeriesIdData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "activeSeriesId",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
      refetchInterval: 20_000,
    },
  });

  const activeSeriesId = useMemo(() => {
    if (typeof activeSeriesIdData === "bigint") return activeSeriesIdData;
    if (typeof activeSeriesIdData === "number") return BigInt(activeSeriesIdData);
    return BigInt(0);
  }, [activeSeriesIdData]);

  const { data: activeSeriesInfoData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "seriesInfo",
    args: [activeSeriesId],
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
    return BigInt(0);
  }, [ticketsSoldData]);

  const ticketsSoldCount = useMemo(() => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const safeValue = ticketsSold > max ? max : ticketsSold;
    return Number(safeValue);
  }, [ticketsSold]);

  const activeSeriesTotals = useMemo(() => {
    if (!activeSeriesInfoData) {
      return { total: BigInt(0), sold: BigInt(0) };
    }
    const tuple = activeSeriesInfoData as ReadonlyArray<unknown> & {
      totalTickets?: bigint;
      ticketsSold?: bigint;
    };
    const total =
      typeof tuple.totalTickets === "bigint"
        ? tuple.totalTickets
        : (Array.isArray(tuple) && typeof tuple[0] === "bigint" ? tuple[0] : BigInt(0));
    const sold =
      typeof tuple.ticketsSold === "bigint"
        ? tuple.ticketsSold
        : (Array.isArray(tuple) && typeof tuple[1] === "bigint" ? tuple[1] : BigInt(0));
    return { total, sold };
  }, [activeSeriesInfoData]);

  const activeSeriesTotalCount = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.total),
    [activeSeriesTotals]
  );

  const activeSeriesSoldCount = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.sold),
    [activeSeriesTotals]
  );

  const hasActiveSeries = useMemo(
    () => activeSeriesId > BigInt(0),
    [activeSeriesId]
  );

  const ticketsLeft = useMemo(
    () => Math.max(activeSeriesTotalCount - activeSeriesSoldCount, 0),
    [activeSeriesSoldCount, activeSeriesTotalCount]
  );

  const totalPot = useMemo(() => {
    try {
      return ticketsSold * ticketPriceRaw;
    } catch {
      return BigInt(0);
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
    if (activeSeriesTotalCount === 0) return 0;
    return Math.min(
      100,
      Math.round((activeSeriesSoldCount / activeSeriesTotalCount) * 100)
    );
  }, [activeSeriesSoldCount, activeSeriesTotalCount]);

  const isOwner = useMemo(() => {
    if (!address || !ownerData) return false;
    return address.toLowerCase() === ownerData.toLowerCase();
  }, [address, ownerData]);

  const [nextDrawTime, setNextDrawTime] = useState<Date>(() => getNextDrawDate());
  const [previousDrawTime, setPreviousDrawTime] = useState<Date>(() =>
    getPreviousDrawDate(getNextDrawDate())
  );
  const [timeRemainingMs, setTimeRemainingMs] = useState(() =>
    Math.max(nextDrawTime.getTime() - Date.now(), 0)
  );
  const [lastDrawTicket, setLastDrawTicket] = useState<number | null>(null);

  const drawWindowMs = useMemo(
    () =>
      Math.max(nextDrawTime.getTime() - previousDrawTime.getTime(), MS_PER_DAY),
    [nextDrawTime, previousDrawTime]
  );

  const progressRatio = useMemo(() => {
    if (drawWindowMs <= 0) return 0;
    const clampedRemaining = Math.min(
      Math.max(timeRemainingMs, 0),
      drawWindowMs
    );
    const elapsed = drawWindowMs - clampedRemaining;
    return Math.min(Math.max(elapsed / drawWindowMs, 0), 1);
  }, [drawWindowMs, timeRemainingMs]);

  const countdownDisplay = useMemo(
    () => formatDuration(timeRemainingMs),
    [timeRemainingMs]
  );

  const countdownCircumference = useMemo(() => 2 * Math.PI * 70, []);
  const countdownDashOffset = useMemo(
    () => countdownCircumference * (1 - progressRatio),
    [countdownCircumference, progressRatio]
  );

  const ticketsInPlay = useMemo(() => {
    if (activeSeriesSoldCount > 0) return activeSeriesSoldCount;
    return activeSeriesTotalCount;
  }, [activeSeriesSoldCount, activeSeriesTotalCount]);

  const ticketPadLength = useMemo(
    () => Math.max(String(Math.max(ticketsInPlay, 0)).length, 3),
    [ticketsInPlay]
  );

  const formattedLastDraw = useMemo(() => {
    if (lastDrawTicket == null) return "Awaiting first draw";
    return `Ticket #${lastDrawTicket
      .toString()
      .padStart(ticketPadLength, "0")}`;
  }, [lastDrawTicket, ticketPadLength]);

  const drawRangeLabel = useMemo(() => {
    if (ticketsInPlay <= 0) {
      return "Activate a series to open the draw range.";
    }
    return `Random range: 1 – ${ticketsInPlay.toLocaleString()}`;
  }, [ticketsInPlay]);

  const nextDrawIstLabel = useMemo(
    () => formatIstDateTime(nextDrawTime),
    [nextDrawTime]
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const remaining = nextDrawTime.getTime() - now;
      if (remaining <= 0) {
        const candidate = resolveDrawTicket(
          activeSeriesSoldCount,
          activeSeriesTotalCount
        );
        if (candidate !== null) {
          setLastDrawTicket(candidate);
        }
        const upcoming = getNextDrawDate(new Date(now));
        setPreviousDrawTime(getPreviousDrawDate(upcoming));
        setNextDrawTime(upcoming);
        const nextRemaining = Math.max(upcoming.getTime() - now, 0);
        setTimeRemainingMs(nextRemaining);
      } else {
        setTimeRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [nextDrawTime, activeSeriesSoldCount, activeSeriesTotalCount]);

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
        const span = BigInt(6000);
        const fromBlock = latestBlock > span ? latestBlock - span : BigInt(0);

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
            ticketIds?: readonly bigint[];
            seriesId?: bigint;
          };
          const timestamp = await loadTimestamp(log.blockNumber ?? undefined);
          const ticketSummary = formatTicketRange(args.ticketIds);
          const seriesLabel =
            args.seriesId && args.seriesId > BigInt(0)
              ? `Series ${args.seriesId.toString()}`
              : "Series pending";
          entries.push({
            txHash: log.transactionHash ?? undefined,
            type: "purchase",
            heading: `${seriesLabel} · ${args.count.toString()} ticket(s)`,
            subheading: `${ticketSummary} · Buyer · ${formatAddress(
              args.buyer
            )}`,
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
          const blockA = a.blockNumber ?? BigInt(0);
          const blockB = b.blockNumber ?? BigInt(0);
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
  }, [decimals, publicClient, LOTTERY_ADDRESS]);

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
            <div className={styles.countdownCard}>
              <div className={styles.countdownRing}>
                <svg
                  className={styles.countdownSvg}
                  viewBox="0 0 160 160"
                  aria-hidden="true"
                >
                  <circle
                    className={styles.countdownCircleBase}
                    cx="80"
                    cy="80"
                    r="70"
                  />
                  <circle
                    className={styles.countdownCircleProgress}
                    cx="80"
                    cy="80"
                    r="70"
                    strokeDasharray={`${countdownCircumference} ${countdownCircumference}`}
                    strokeDashoffset={countdownDashOffset}
                  />
                </svg>
                <div className={styles.countdownCenter}>
                  <span className={styles.countdownTime}>{countdownDisplay}</span>
                  <span className={styles.countdownLabel}>Time to draw</span>
                </div>
              </div>
              <div className={styles.countdownInfo}>
                <span className={styles.countdownHeading}>
                  Daily draw · 9:00 PM IST
                </span>
                <span className={styles.countdownSubheading}>
                  Next draw: {nextDrawIstLabel}
                </span>
                <span className={styles.countdownSubheading}>{drawRangeLabel}</span>
                <span className={styles.countdownHint}>
                  Last result: {formattedLastDraw}
                </span>
              </div>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Current prize pool</span>
              <span className={styles.statValue}>{formattedPot} USDT</span>
              <span className={styles.statHint}>
                Calculated from ticket sales · auto-refreshing
              </span>
            </div>
            <div className={styles.statRow}>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Active series</span>
                <span className={styles.microValue}>
                  {hasActiveSeries ? `#${activeSeriesId.toString()}` : "None"}
                </span>
              </div>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Tickets left</span>
                <span className={styles.microValue}>
                  {hasActiveSeries ? ticketsLeft : "—"}
                </span>
              </div>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Progress</span>
                <span className={styles.microValue}>
                  {hasActiveSeries ? `${ticketsSoldPercent}%` : "—"}
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

