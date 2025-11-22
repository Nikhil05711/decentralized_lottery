"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { motion } from "framer-motion";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits, zeroAddress, BaseError } from "viem";
import styles from "./page.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { wagmiConfig } from "@/lib/wagmi";
import { formatSeriesName } from "@/lib/seriesUtils";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as `0x${string}` | undefined;
const USD_PRICE_PER_TICKET = 0.11;
const QUICK_PICK_PRESETS = [1, 5, 10, 25, 50] as const;

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

  const { data: totalSeriesCountData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "totalSeriesCount",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
      refetchInterval: 20_000,
    },
  });

  const totalSeriesCount = useMemo(() => {
    if (typeof totalSeriesCountData === "bigint") return Number(totalSeriesCountData);
    if (typeof totalSeriesCountData === "number") return totalSeriesCountData;
    return 0;
  }, [totalSeriesCountData]);

  const seriesIds = useMemo(() => {
    if (totalSeriesCount === 0) return [];
    return Array.from({ length: totalSeriesCount }, (_, i) => BigInt(i + 1));
  }, [totalSeriesCount]);

  // Get info for all series to find available ones
  const { data: allSeriesInfoData } = useReadContracts({
    contracts: seriesIds.map((seriesId) => ({
      address: LOTTERY_ADDRESS!,
      abi: lotteryAbi,
      functionName: "getSeriesInfo" as const,
      args: [seriesId],
    })),
    query: {
      enabled: Boolean(LOTTERY_ADDRESS) && seriesIds.length > 0,
      refetchInterval: 20_000,
    },
  });

  // Find first available series (with tickets left)
  const firstAvailableSeries = useMemo(() => {
    if (!allSeriesInfoData || allSeriesInfoData.length === 0) return null;
    
    for (let i = 0; i < seriesIds.length; i++) {
      const info = allSeriesInfoData[i];
      if (info?.status === "success" && info.result) {
        const tuple = info.result as ReadonlyArray<unknown>;
        const total = Array.isArray(tuple) && typeof tuple[0] === "bigint" ? tuple[0] : BigInt(0);
        const sold = Array.isArray(tuple) && typeof tuple[1] === "bigint" ? tuple[1] : BigInt(0);
        const drawExecuted = Array.isArray(tuple) && typeof tuple[2] === "boolean" ? tuple[2] : false;
        
        if (!drawExecuted && sold < total && total > BigInt(0)) {
          return {
            seriesId: seriesIds[i],
            total,
            sold,
          };
        }
      }
    }
    return null;
  }, [allSeriesInfoData, seriesIds]);

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

  const { data: balanceData, refetch: refetchBalance } = useReadContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address ?? zeroAddress],
    query: {
      enabled: Boolean(USDT_ADDRESS && isConnected && address),
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

  const usdtBalance = useMemo(() => {
    if (typeof balanceData === "bigint") return balanceData;
    if (typeof balanceData === "number") return BigInt(balanceData);
    return BigInt(0);
  }, [balanceData]);

  const usdtBalanceFormatted = useMemo(() => {
    if (!isConnected || usdtBalance === BigInt(0)) return "0.00";
    return Number(formatUnits(usdtBalance, decimals)).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }, [usdtBalance, decimals, isConnected]);

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

  const activeSeriesTotalCount = useMemo(
    () => firstAvailableSeries ? clampToSafeNumber(firstAvailableSeries.total) : 0,
    [firstAvailableSeries]
  );

  const activeSeriesSoldCount = useMemo(
    () => firstAvailableSeries ? clampToSafeNumber(firstAvailableSeries.sold) : 0,
    [firstAvailableSeries]
  );

  const activeSeriesId = useMemo(
    () => firstAvailableSeries?.seriesId || BigInt(0),
    [firstAvailableSeries]
  );

  const hasActiveSeries = useMemo(
    () => firstAvailableSeries !== null,
    [firstAvailableSeries]
  );

  const ticketsLeft = useMemo(
    () => Math.max(activeSeriesTotalCount - activeSeriesSoldCount, 0),
    [activeSeriesSoldCount, activeSeriesTotalCount]
  );

  const salesOpen = useMemo(
    () => hasActiveSeries && ticketsLeft > 0,
    [hasActiveSeries, ticketsLeft]
  );

  const seriesAvailability = useMemo(() => {
    if (!hasActiveSeries) {
      return "Activate or queue the next series to restart ticket sales.";
    }
    return `${ticketsLeft.toLocaleString()} of ${activeSeriesTotalCount.toLocaleString()} tickets remain in this series.`;
  }, [activeSeriesTotalCount, hasActiveSeries, ticketsLeft]);

  const previewTicketNumbers = useMemo(() => {
    if (!salesOpen || ticketCount < 1 || !firstAvailableSeries) return [];
    const start = firstAvailableSeries.sold + BigInt(1);
    const limit = Math.min(ticketCount, 6);
    return Array.from({ length: limit }, (_, index) => {
      const ticketNumber = start + BigInt(index);
      return ticketNumber.toString();
    });
  }, [firstAvailableSeries, salesOpen, ticketCount]);

  const maxSelectable = useMemo(() => {
    if (!salesOpen) return 0;
    if (ticketsLeft <= 0) return 0;
    return Math.min(ticketsLeft, 100);
  }, [salesOpen, ticketsLeft]);

  const activeSeriesLabel = useMemo(
    () => (hasActiveSeries ? `Series ${formatSeriesName(activeSeriesId)}` : "No active series"),
    [activeSeriesId, hasActiveSeries]
  );

  const activeSeriesHint = useMemo(() => {
    if (!hasActiveSeries) {
      return "Queue the next series to resume sales";
    }
    return `Series ${formatSeriesName(activeSeriesId)} · total ${activeSeriesTotalCount}`;
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

      // Get available series for purchase
      if (!firstAvailableSeries) {
        setFeedback("No series with available tickets. Please try again.");
        return;
      }

      const buyHash = await writeContractAsync({
        address: LOTTERY_ADDRESS,
        abi: lotteryAbi,
        functionName: "buyTickets",
        args: [firstAvailableSeries.seriesId, BigInt(ticketCount)],
      });

      await waitForTransactionReceipt(wagmiConfig, {
        hash: buyHash,
      });

      setFeedback(`Success! You now own ${ticketCount} ticket(s).`);
      setTicketCount(1);
      await Promise.all([refetchAllowance(), refetchTickets(), refetchPrice(), refetchBalance()]);
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

  const clampSelection = useCallback(
    (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return 1;
      const safeMax = maxSelectable || 1;
      return Math.min(Math.max(1, value), safeMax);
    },
    [maxSelectable]
  );

  const handleQuantityInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = Number(event.target.value);
      if (Number.isNaN(nextValue)) {
        setTicketCount(1);
        return;
      }
      setTicketCount(clampSelection(Math.floor(nextValue)));
    },
    [clampSelection]
  );

  const handleQuickSelect = useCallback(
    (value: number) => {
      if (maxSelectable === 0) return;
      setTicketCount(clampSelection(value));
    },
    [clampSelection, maxSelectable]
  );

  const handleRandomizeCount = useCallback(() => {
    if (maxSelectable === 0) return;
    const randomCount = Math.floor(Math.random() * maxSelectable) + 1;
    setTicketCount(randomCount);
  }, [maxSelectable]);

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
            <div className={styles.walletBarRight}>
              {isConnected && (
                <div className={styles.balanceDisplay}>
                  <span className={styles.balanceLabel}>Balance:</span>
                  <span className={styles.balanceValue}>{usdtBalanceFormatted} USDT</span>
                </div>
              )}
              <ConnectButton showBalance={false} chainStatus="icon" />
            </div>
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
            <div className={styles.seriesPanel}>
              <div className={styles.seriesCopy}>
                <p className={styles.seriesEyebrow}>Series in focus</p>
                <p className={styles.seriesName}>{activeSeriesLabel}</p>
                <p className={styles.seriesMeta}>{seriesAvailability}</p>
              </div>
              <div className={styles.seriesActions}>
                <div className={styles.seriesStat}>
                  <span className={styles.seriesStatLabel}>Progress</span>
                  <span className={styles.seriesStatValue}>
                    {activeSeriesProgress}
                  </span>
                </div>
                <div className={styles.seriesStat}>
                  <span className={styles.seriesStatLabel}>Remaining</span>
                  <span className={styles.seriesStatValue}>
                    {hasActiveSeries ? ticketsLeft.toLocaleString() : "—"}
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.ticketRow}>
              <span className={styles.ticketLabel}>Ticket quantity</span>
              <div className={styles.quantityStack}>
                <div className={styles.quantityControl}>
                  <button
                    className={styles.quantityButton}
                    onClick={decrement}
                    disabled={ticketCount <= 1 || isBusy}
                  >
                    -
                  </button>
                  <motion.input
                    key={ticketCount}
                    className={styles.quantityInput}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={maxSelectable || 1}
                    value={ticketCount}
                    onChange={handleQuantityInputChange}
                    disabled={isBusy || maxSelectable === 0}
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 220, damping: 16 }}
                  />
                  <button
                    className={styles.quantityButton}
                    onClick={increment}
                    disabled={
                      isBusy ||
                      maxSelectable === 0 ||
                      ticketCount >= maxSelectable
                    }
                  >
                    +
                  </button>
                </div>

                <div className={styles.quickPickGroup}>
                  {QUICK_PICK_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      className={`${styles.quickPickButton} ${
                        ticketCount === preset ? styles.quickPickButtonActive : ""
                      }`}
                      onClick={() => handleQuickSelect(preset)}
                      disabled={
                        isBusy || maxSelectable === 0 || preset > maxSelectable
                      }
                    >
                      {preset} {preset === 1 ? "ticket" : "tickets"}
                    </button>
                  ))}
                  <button
                    className={`${styles.quickPickButton} ${styles.quickPickButtonRandom}`}
                    onClick={handleRandomizeCount}
                    disabled={isBusy || maxSelectable === 0}
                  >
                    Lucky dip
                  </button>
                </div>
              </div>
            </div>

            {salesOpen && previewTicketNumbers.length > 0 && (
              <div className={styles.previewBanner}>
                <span className={styles.previewLabel}>Projected numbers</span>
                <div className={styles.previewList}>
                  {previewTicketNumbers.map((number) => (
                    <span key={number} className={styles.previewChip}>
                      #{number}
                    </span>
                  ))}
                  {ticketCount > previewTicketNumbers.length && (
                    <span className={styles.previewExtra}>
                      +{ticketCount - previewTicketNumbers.length} more
                    </span>
                  )}
                </div>
              </div>
            )}

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
              <Link className={styles.secondaryLink} href="/rewards">
                Rewards & Prizes
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

