"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits, zeroAddress, BaseError } from "viem";
import styles from "./page.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { wagmiConfig } from "@/lib/wagmi";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as `0x${string}` | undefined;
const USD_PRICE_PER_TICKET = 0.11;

const fallbackDecimals = 6;
const clampToSafeNumber = (value: bigint | number | undefined) => {
  if (typeof value === "number") return value;
  if (typeof value !== "bigint") return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > max ? max : value);
};

type FlowStatus = "idle" | "approving" | "buying";

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

export default function Home() {
  const { address, isConnected } = useAccount();
  const [ticketCount, setTicketCount] = useState(1);
  const [status, setStatus] = useState<FlowStatus>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);

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

  const { data: priceData, refetch: refetchPrice } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketPrice",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
    },
  });

  const { data: ticketsSoldData, refetch: refetchTickets } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketsSold",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
      refetchInterval: 30_000,
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

  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address ?? zeroAddress, LOTTERY_ADDRESS ?? zeroAddress],
    query: {
      enabled: Boolean(
        USDT_ADDRESS && LOTTERY_ADDRESS && isConnected && address
      ),
      refetchInterval: 20_000,
    },
  });

  const { writeContractAsync } = useWriteContract();

  const ticketPriceRaw = useMemo(() => {
    if (typeof priceData === "bigint") return priceData;
    if (typeof priceData === "number") return BigInt(priceData);
    return parseUnits(USD_PRICE_PER_TICKET.toString(), decimals);
  }, [decimals, priceData]);

  const totalCost = useMemo(() => {
    try {
      return ticketPriceRaw * BigInt(ticketCount);
    } catch {
      return undefined;
    }
  }, [ticketCount, ticketPriceRaw]);

  const allowance = useMemo(() => {
    if (typeof allowanceData === "bigint") return allowanceData;
    if (typeof allowanceData === "number") return BigInt(allowanceData);
    return BigInt(0);
  }, [allowanceData]);

  const ticketsSold = useMemo(() => {
    if (typeof ticketsSoldData === "bigint") return ticketsSoldData;
    if (typeof ticketsSoldData === "number") return BigInt(ticketsSoldData);
    return BigInt(0);
  }, [ticketsSoldData]);

  const ticketsSoldCount = useMemo(() => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const value = ticketsSold > max ? max : ticketsSold;
    return Number(value);
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

  const salesOpen = useMemo(
    () => hasActiveSeries && activeSeriesTotals.total > activeSeriesTotals.sold,
    [activeSeriesTotals, hasActiveSeries]
  );

  const maxSelectable = useMemo(() => {
    if (!salesOpen) return 0;
    if (ticketsLeft <= 0) return 0;
    return Math.min(ticketsLeft, 100);
  }, [salesOpen, ticketsLeft]);

  const activeSeriesLabel = useMemo(
    () => (hasActiveSeries ? `Series #${activeSeriesId.toString()}` : "No active series"),
    [activeSeriesId, hasActiveSeries]
  );

  const activeSeriesHint = useMemo(() => {
    if (!hasActiveSeries) {
      return "Queue the next series to resume sales";
    }
    return `Series ${activeSeriesId.toString()} · total ${activeSeriesTotalCount}`;
  }, [activeSeriesId, activeSeriesTotalCount, hasActiveSeries]);

  const activeSeriesProgress = useMemo(() => {
    if (activeSeriesTotalCount === 0) return "0%";
    const percent = Math.min(
      100,
      Math.round((activeSeriesSoldCount / activeSeriesTotalCount) * 100)
    );
    return `${percent}% sold`;
  }, [activeSeriesSoldCount, activeSeriesTotalCount]);

  useEffect(() => {
    if (maxSelectable === 0) {
      setTicketCount(1);
      return;
    }
    setTicketCount((current) =>
      current > maxSelectable ? maxSelectable : current
    );
  }, [maxSelectable]);

  const needsApproval = useMemo(() => {
    if (!isConnected || !totalCost) return false;
    return allowance < totalCost;
  }, [allowance, isConnected, totalCost]);

  const isBusy = status !== "idle";

  const prettyUnitUSDT = useMemo(() => {
    return Number(
      formatUnits(ticketPriceRaw, decimals)
    ).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }, [decimals, ticketPriceRaw]);

  const prettyUnitUSD = USD_PRICE_PER_TICKET.toFixed(2);

  const prettyTotalUSDT = useMemo(() => {
    if (!totalCost) return "0";
    return Number(formatUnits(totalCost, decimals)).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }, [decimals, totalCost]);

  const prettyTotalUSD = useMemo(
    () => (ticketCount * USD_PRICE_PER_TICKET).toFixed(2),
    [ticketCount]
  );

  const handleBuy = async () => {
    if (!isConnected) {
      setFeedback("Connect your wallet to continue.");
      return;
    }
    if (!LOTTERY_ADDRESS || !USDT_ADDRESS) {
      setFeedback(
        "Missing contract configuration. Set NEXT_PUBLIC_LOTTERY_ADDRESS and NEXT_PUBLIC_USDT_ADDRESS."
      );
      return;
    }
    if (!salesOpen) {
      setFeedback("Ticket sales are paused until the next series is activated.");
      return;
    }
    if (ticketsLeft === 0) {
      setFeedback("This series is sold out. Watch for the next series to launch.");
      return;
    }
    if (ticketCount > ticketsLeft) {
      setFeedback(`Only ${ticketsLeft} ticket(s) remain in the current series.`);
      return;
    }
    if (!totalCost || ticketCount < 1) {
      setFeedback("Select at least one ticket.");
      return;
    }

    setFeedback(null);

    try {
      if (needsApproval) {
        setStatus("approving");
        const approveHash = await writeContractAsync({
          address: USDT_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [LOTTERY_ADDRESS, totalCost],
        });

        await waitForTransactionReceipt(wagmiConfig, {
          hash: approveHash,
        });

        await refetchAllowance();
      }

      setStatus("buying");

      const buyHash = await writeContractAsync({
        address: LOTTERY_ADDRESS,
        abi: lotteryAbi,
        functionName: "buyTickets",
        args: [BigInt(ticketCount)],
      });

      await waitForTransactionReceipt(wagmiConfig, {
        hash: buyHash,
      });

      setFeedback(`Success! You now own ${ticketCount} ticket(s).`);
      setTicketCount(1);
      await Promise.all([refetchAllowance(), refetchTickets(), refetchPrice()]);
    } catch (error) {
      setFeedback(formatError(error));
    } finally {
      setStatus("idle");
    }
  };

  const increment = () =>
    setTicketCount((current) => Math.min(maxSelectable, current + 1));
  const decrement = () =>
    setTicketCount((current) => Math.max(1, Math.min(current - 1, maxSelectable)));

  const envReady = Boolean(LOTTERY_ADDRESS && USDT_ADDRESS);

  return (
    <div className={styles.page}>
      <GlowingOrbs />
      <motion.main
        className={styles.main}
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      >
        <motion.section
          className={styles.heroCard}
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: "easeOut", delay: 0.1 }}
        >
          <span className={styles.fadeBorder} />
          <div className={styles.walletBar}>
            <h1 className={styles.title}>Nebula Lottery</h1>
            <ConnectButton showBalance={false} chainStatus="icon" />
          </div>
          <p className={styles.subtitle}>
            Experience a cinematic, on-chain raffle on the BNB Testnet. Each
            ticket costs exactly 0.11 USDT. Accumulate more entries to boost
            your odds and watch the prize pool grow in real time.
          </p>
          <div className={styles.metrics}>
            <motion.div
              className={styles.metricCard}
              whileHover={{ y: -6 }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
            >
              <span className={styles.metricLabel}>Ticket Price</span>
              <span className={styles.metricValue}>${prettyUnitUSD} USD</span>
              <span className={styles.walletState}>
                {prettyUnitUSDT} USDT · live from contract
              </span>
            </motion.div>
            <motion.div
              className={styles.metricCard}
              whileHover={{ y: -6 }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
            >
              <span className={styles.metricLabel}>Lifetime Tickets Sold</span>
              <span className={styles.metricValue}>
                {ticketsSoldCount.toLocaleString()}
              </span>
              <span className={styles.walletState}>
                Live counter from the smart contract
              </span>
            </motion.div>
            <motion.div
              className={styles.metricCard}
              whileHover={{ y: -6 }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
            >
              <span className={styles.metricLabel}>Tickets Left</span>
              <span className={styles.metricValue}>
                {hasActiveSeries ? ticketsLeft.toLocaleString() : "—"}
              </span>
              <span className={styles.walletState}>
                {hasActiveSeries ? activeSeriesHint : "Sales resume next series"}
              </span>
            </motion.div>
          </div>
        </motion.section>

        <motion.section
          className={styles.ticketCard}
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: "easeOut", delay: 0.2 }}
        >
          <div className={styles.ticketHeader}>
            <h2 className={styles.ticketTitle}>Claim your spot</h2>
            <span className={styles.statusPill}>
              {isConnected ? "Wallet ready" : "Connect wallet"}
            </span>
          </div>

          <div className={styles.ticketBody}>
            <div className={styles.ticketRow}>
              <span className={styles.ticketLabel}>Ticket quantity</span>
              <div className={styles.quantityControl}>
                <button
                  className={styles.quantityButton}
                  onClick={decrement}
                  disabled={ticketCount <= 1 || isBusy}
                >
                  -
                </button>
                <motion.span
                  key={ticketCount}
                  className={styles.quantityValue}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 220, damping: 16 }}
                >
                  {ticketCount}
                </motion.span>
                <button
                  className={styles.quantityButton}
                  onClick={increment}
                  disabled={
                    isBusy || maxSelectable === 0 || ticketCount >= maxSelectable
                  }
                >
                  +
                </button>
              </div>
            </div>

            <div className={styles.ticketRow}>
              <span className={styles.ticketLabel}>Total cost</span>
              <div className={styles.totalBreakdown}>
                <span className={styles.totalPrimary}>{prettyTotalUSDT} USDT</span>
                <span className={styles.totalSecondary}>
                  ≈ ${prettyTotalUSD} USD
                </span>
              </div>
            </div>

            {!envReady && (
              <div className={styles.errorBanner}>
                Configure `NEXT_PUBLIC_LOTTERY_ADDRESS`,
                `NEXT_PUBLIC_USDT_ADDRESS`, and `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to enable transactions.
              </div>
            )}
            {envReady && !salesOpen && (
              <div className={styles.errorBanner}>
                {hasActiveSeries
                  ? "Current series is sold out. Queue the next series to reopen sales."
                  : "Ticket sales are paused until the next series is activated."}
              </div>
            )}

            {feedback && (
              <div
                className={
                  feedback.toLowerCase().startsWith("success")
                    ? styles.successBanner
                    : styles.errorBanner
                }
              >
                {feedback}
              </div>
            )}
          </div>

          <div className={styles.ticketBody}>
            <button
              className={styles.ctaButton}
              onClick={handleBuy}
              disabled={
                !isConnected ||
                !envReady ||
                isBusy ||
                !totalCost ||
                ticketCount < 1 ||
                !salesOpen ||
                maxSelectable === 0
              }
            >
              {isBusy
                ? status === "approving"
                  ? "Approving"
                  : "Confirming"
                : needsApproval
                ? "Approve & Purchase"
                : "Buy Tickets"}
            </button>
            <div className={styles.linkCluster}>
              <Link className={styles.secondaryLink} href="/tickets">
                View ticket board
              </Link>
              <Link className={styles.secondaryLink} href="/draw">
                Draw & rewards
              </Link>
            </div>
            <p className={styles.helperText}>
              Connected wallet: {isConnected ? address : "Not connected"}
            </p>
          </div>
        </motion.section>
      </motion.main>
    </div>
  );
}

