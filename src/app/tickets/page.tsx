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
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { BaseError, formatUnits, parseUnits, zeroAddress } from "viem";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { wagmiConfig } from "@/lib/wagmi";
import styles from "./tickets.module.css";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as `0x${string}` | undefined;
const USD_PRICE_PER_TICKET = 0.11;
const fallbackDecimals = 6;
const QUICK_PICK_PRESETS = [1, 5, 10, 25, 50] as const;
const MAX_CUSTOM_SELECTION = 100;

type FlowStatus = "idle" | "approving" | "buying";

const clampToSafeNumber = (value: bigint | number | undefined) => {
  if (typeof value === "number") return value;
  if (typeof value !== "bigint") return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const safeValue = value > max ? max : value;
  return Number(safeValue);
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

export default function TicketsPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [ticketCount, setTicketCount] = useState(1);
  const [status, setStatus] = useState<FlowStatus>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedTickets, setSelectedTickets] = useState<number[]>([]);
  const [selectionFeedback, setSelectionFeedback] = useState<string | null>(null);
  const [selectionTarget, setSelectionTarget] = useState(0);

  const { data: activeSeriesIdData, refetch: refetchActiveSeriesId } =
    useReadContract({
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

  const { data: activeSeriesInfoData, refetch: refetchSeriesInfo } =
    useReadContract({
      address: LOTTERY_ADDRESS,
      abi: lotteryAbi,
      functionName: "seriesInfo",
      args: [activeSeriesId],
      query: {
        enabled: Boolean(LOTTERY_ADDRESS),
        refetchInterval: 20_000,
      },
    });

  const { data: decimalsData } = useReadContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
    query: {
      enabled: Boolean(USDT_ADDRESS),
    },
  });

  const { data: priceData, refetch: refetchPrice } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketPrice",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
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

  const decimals = useMemo(() => {
    if (typeof decimalsData === "number") return decimalsData;
    if (typeof decimalsData === "bigint") return Number(decimalsData);
    return fallbackDecimals;
  }, [decimalsData]);

  const ticketPriceRaw = useMemo(() => {
    if (typeof priceData === "bigint") return priceData;
    if (typeof priceData === "number") return BigInt(priceData);
    return parseUnits(USD_PRICE_PER_TICKET.toString(), decimals);
  }, [decimals, priceData]);

  const allowance = useMemo(() => {
    if (typeof allowanceData === "bigint") return allowanceData;
    if (typeof allowanceData === "number") return BigInt(allowanceData);
    return BigInt(0);
  }, [allowanceData]);

  const totalCost = useMemo(() => {
    if (!ticketCount) return undefined;
    try {
      return ticketPriceRaw * BigInt(ticketCount);
    } catch {
      return undefined;
    }
  }, [ticketCount, ticketPriceRaw]);

  const hasActiveSeries = useMemo(
    () => activeSeriesId > BigInt(0),
    [activeSeriesId]
  );

  const totalTickets = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.total),
    [activeSeriesTotals]
  );

  const ticketOwnerContracts = useMemo(() => {
    if (!hasActiveSeries || !LOTTERY_ADDRESS || totalTickets <= 0) {
      return [];
    }
    const base = activeSeriesId << BigInt(128);
    return Array.from({ length: totalTickets }, (_, index) => ({
      address: LOTTERY_ADDRESS,
      abi: lotteryAbi,
      functionName: "ticketOwners",
      args: [base | BigInt(index + 1)],
    }));
  }, [LOTTERY_ADDRESS, activeSeriesId, hasActiveSeries, totalTickets]);

  const { data: ticketOwnersData, refetch: refetchTicketOwners } = useReadContracts({
    contracts: ticketOwnerContracts,
    query: {
      enabled: ticketOwnerContracts.length > 0,
      refetchInterval: 20_000,
    },
  });

  const soldTickets = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.sold),
    [activeSeriesTotals]
  );

  const ticketsLeft = useMemo(
    () => Math.max(totalTickets - soldTickets, 0),
    [soldTickets, totalTickets]
  );

  const activeSeriesLabel = useMemo(
    () => (hasActiveSeries ? `Series #${activeSeriesId.toString()}` : "No active series"),
    [activeSeriesId, hasActiveSeries]
  );

  const salesOpen = useMemo(
    () => hasActiveSeries && soldTickets < totalTickets,
    [hasActiveSeries, soldTickets, totalTickets]
  );

  const soldLookup = useMemo(() => {
    if (!ticketOwnersData || ticketOwnersData.length === 0) return null;
    const lookup = new Set<number>();
    ticketOwnersData.forEach((entry, index) => {
      const owner = (entry?.result as `0x${string}` | undefined) ?? zeroAddress;
      if (owner !== zeroAddress) {
        lookup.add(index + 1);
      }
    });
    return lookup;
  }, [ticketOwnersData]);

  const tickets = useMemo(() => {
    if (totalTickets <= 0) return [];
    const soldSet = soldLookup;
    return Array.from({ length: totalTickets }, (_, index) => {
      const number = index + 1;
      const isSold = soldSet ? soldSet.has(number) : index < soldTickets;
      return { number, isSold };
    });
  }, [soldLookup, soldTickets, totalTickets]);

  const availableTicketNumbers = useMemo(
    () => tickets.filter((ticket) => !ticket.isSold).map((ticket) => ticket.number),
    [tickets]
  );

  const availableTicketSet = useMemo(
    () => new Set(availableTicketNumbers),
    [availableTicketNumbers]
  );

  const maxCustomSelectable = useMemo(() => {
    if (!salesOpen) return 0;
    return Math.min(availableTicketNumbers.length, MAX_CUSTOM_SELECTION);
  }, [availableTicketNumbers.length, salesOpen]);

  const padLength = useMemo(
    () => Math.max(String(totalTickets || 0).length, 3),
    [totalTickets]
  );

  const seriesAvailability = useMemo(() => {
    if (!hasActiveSeries) {
      return "Activate or queue the next series to restart ticket sales.";
    }
    return `${ticketsLeft.toLocaleString()} of ${totalTickets.toLocaleString()} tickets remain in this series.`;
  }, [hasActiveSeries, ticketsLeft, totalTickets]);

  const activeSeriesProgress = useMemo(() => {
    if (totalTickets === 0) return "0%";
    const percent = Math.min(
      100,
      Math.round((soldTickets / Math.max(totalTickets, 1)) * 100)
    );
    return `${percent}% sold`;
  }, [soldTickets, totalTickets]);

  const previewTicketNumbers = useMemo(() => {
    if (!salesOpen || ticketCount < 1) return [];
    const start = activeSeriesTotals.sold + BigInt(1);
    const limit = Math.min(ticketCount, 6);
    return Array.from({ length: limit }, (_, index) => {
      const ticketNumber = start + BigInt(index);
      return ticketNumber.toString();
    });
  }, [activeSeriesTotals.sold, salesOpen, ticketCount]);

  const maxSelectable = useMemo(() => {
    if (!salesOpen) return 0;
    if (ticketsLeft <= 0) return 0;
    return Math.min(ticketsLeft, 100);
  }, [salesOpen, ticketsLeft]);

  useEffect(() => {
    if (maxSelectable === 0) {
      setTicketCount(1);
      return;
    }
    setTicketCount((current) =>
      current > maxSelectable ? maxSelectable : current
    );
  }, [maxSelectable]);

  useEffect(() => {
    setSelectedTickets((current) =>
      current.filter((ticket) => availableTicketSet.has(ticket))
    );
  }, [availableTicketSet]);

  useEffect(() => {
    if (maxCustomSelectable === 0) {
      setSelectionTarget(0);
      setSelectedTickets([]);
      return;
    }
    setSelectionTarget((current) => {
      if (!current || current > maxCustomSelectable) {
        return Math.min(maxCustomSelectable, selectedTickets.length || 0);
      }
      return current;
    });
    setSelectedTickets((current) => {
      const filtered = current.filter((ticket) => availableTicketSet.has(ticket));
      if (filtered.length > maxCustomSelectable) {
        return filtered.slice(0, maxCustomSelectable);
      }
      return filtered;
    });
  }, [availableTicketSet, maxCustomSelectable, selectedTickets.length]);

  const needsApproval = useMemo(() => {
    if (!isConnected || !totalCost) return false;
    return allowance < totalCost;
  }, [allowance, isConnected, totalCost]);

  const isBusy = status !== "idle";
  const envReady = Boolean(LOTTERY_ADDRESS && USDT_ADDRESS);

  const prettyUnitUSDT = useMemo(() => {
    return Number(formatUnits(ticketPriceRaw, decimals)).toLocaleString(
      undefined,
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }
    );
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

  const selectionCount = selectedTickets.length;

  const selectionTotalCost = useMemo(() => {
    if (selectionCount === 0) return undefined;
    try {
      return ticketPriceRaw * BigInt(selectionCount);
    } catch {
      return undefined;
    }
  }, [selectionCount, ticketPriceRaw]);

  const selectionTotalUSDT = useMemo(() => {
    if (!selectionTotalCost) return "0";
    return Number(formatUnits(selectionTotalCost, decimals)).toLocaleString(
      undefined,
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }
    );
  }, [decimals, selectionTotalCost]);

  const selectionTotalUSD = useMemo(
    () => (selectionCount * USD_PRICE_PER_TICKET).toFixed(2),
    [selectionCount]
  );

  const selectionNeedsApproval = useMemo(() => {
    if (!isConnected || !selectionTotalCost) return false;
    return allowance < selectionTotalCost;
  }, [allowance, isConnected, selectionTotalCost]);

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

  const handleBuy = useCallback(async () => {
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
      const lotteryAddress = LOTTERY_ADDRESS;
      const usdtAddress = USDT_ADDRESS;

      if (needsApproval) {
        setStatus("approving");
        const approveHash = await writeContractAsync({
          address: usdtAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [lotteryAddress, totalCost],
        });

        await waitForTransactionReceipt(wagmiConfig, {
          hash: approveHash,
        });

        await refetchAllowance();
      }

      setStatus("buying");

      const buyHash = await writeContractAsync({
        address: lotteryAddress,
        abi: lotteryAbi,
        functionName: "buyTickets",
        args: [BigInt(ticketCount)],
      });

      await waitForTransactionReceipt(wagmiConfig, {
        hash: buyHash,
      });

      setFeedback(`Success! You now own ${ticketCount} ticket(s).`);
      setTicketCount(1);
      await Promise.all([
        refetchAllowance(),
        refetchSeriesInfo(),
        refetchPrice(),
        refetchActiveSeriesId(),
      ]);
    } catch (error) {
      setFeedback(formatError(error));
    } finally {
      setStatus("idle");
    }
  }, [
    isConnected,
    ticketCount,
    needsApproval,
    refetchActiveSeriesId,
    refetchAllowance,
    refetchPrice,
    refetchSeriesInfo,
    salesOpen,
    ticketsLeft,
    totalCost,
    writeContractAsync,
  ]);

  const handleTicketToggle = useCallback(
    (ticketNumber: number) => {
      if (!envReady || !salesOpen || isBusy) return;
      if (!availableTicketSet.has(ticketNumber)) return;
      setSelectedTickets((current) => {
        if (current.includes(ticketNumber)) {
          return current.filter((value) => value !== ticketNumber);
        }
        if (current.length >= Math.min(MAX_CUSTOM_SELECTION, availableTicketSet.size)) {
          return current;
        }
        return [...current, ticketNumber].sort((a, b) => a - b);
      });
      setSelectionFeedback(null);
    },
    [availableTicketSet, envReady, isBusy, salesOpen]
  );

  const handleRemoveSelected = useCallback((ticketNumber: number) => {
    setSelectedTickets((current) => current.filter((value) => value !== ticketNumber));
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedTickets([]);
    setSelectionFeedback(null);
  }, []);

  const randomizeSelection = useCallback(
    (target: number) => {
      if (maxCustomSelectable === 0 || availableTicketNumbers.length === 0) {
        setSelectedTickets([]);
        setSelectionTarget(0);
        return;
      }
      const desired = Math.min(Math.max(1, target), maxCustomSelectable);
      const pool = [...availableTicketNumbers];
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const next = pool.slice(0, desired).sort((a, b) => a - b);
      setSelectedTickets(next);
      setSelectionTarget(desired);
      setSelectionFeedback(null);
    },
    [availableTicketNumbers, maxCustomSelectable]
  );

  const handleSelectionQuantityChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = Number(event.target.value);
      if (Number.isNaN(nextValue)) {
        setSelectionTarget(0);
        return;
      }
      if (nextValue <= 0) {
        setSelectionTarget(0);
        setSelectedTickets([]);
        return;
      }
      randomizeSelection(nextValue);
    },
    [randomizeSelection]
  );

  const handleSelectionPreset = useCallback(
    (value: number) => {
      if (maxCustomSelectable === 0) return;
      randomizeSelection(value);
    },
    [maxCustomSelectable, randomizeSelection]
  );

  const handleShuffleSelection = useCallback(() => {
    if (selectionCount === 0) return;
    randomizeSelection(selectionCount);
  }, [randomizeSelection, selectionCount]);

  const handleLuckyDipSelection = useCallback(() => {
    if (maxCustomSelectable === 0) return;
    const randomCount = Math.floor(Math.random() * maxCustomSelectable) + 1;
    randomizeSelection(randomCount);
  }, [maxCustomSelectable, randomizeSelection]);

  const incrementSelection = useCallback(() => {
    if (maxCustomSelectable === 0) return;
    const base = selectionTarget || selectionCount || 0;
    randomizeSelection(Math.min(base + 1, maxCustomSelectable));
  }, [maxCustomSelectable, randomizeSelection, selectionCount, selectionTarget]);

  const decrementSelection = useCallback(() => {
    const base = selectionTarget || selectionCount;
    if (!base || base <= 1) {
      setSelectionTarget(0);
      setSelectedTickets([]);
      return;
    }
    randomizeSelection(base - 1);
  }, [randomizeSelection, selectionCount, selectionTarget]);

  const handleBuySelected = useCallback(async () => {
    if (!isConnected) {
      setSelectionFeedback("Connect your wallet to continue.");
      return;
    }
    if (!LOTTERY_ADDRESS || !USDT_ADDRESS) {
      setSelectionFeedback(
        "Missing contract configuration. Set NEXT_PUBLIC_LOTTERY_ADDRESS and NEXT_PUBLIC_USDT_ADDRESS."
      );
      return;
    }
    if (!salesOpen) {
      setSelectionFeedback("Ticket sales are paused until the next series is activated.");
      return;
    }
    if (selectedTickets.length === 0) {
      setSelectionFeedback("Select at least one ticket from the grid.");
      return;
    }
    if (!selectionTotalCost) {
      setSelectionFeedback("Unable to determine ticket cost. Please retry.");
      return;
    }
    if (selectedTickets.some((ticket) => !availableTicketSet.has(ticket))) {
      setSelectionFeedback("One or more selected tickets are no longer available.");
      setSelectedTickets((current) =>
        current.filter((ticket) => availableTicketSet.has(ticket))
      );
      return;
    }

    setSelectionFeedback(null);

    try {
      const lotteryAddress = LOTTERY_ADDRESS;
      const usdtAddress = USDT_ADDRESS;

      if (selectionNeedsApproval) {
        setStatus("approving");
        const approveHash = await writeContractAsync({
          address: usdtAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [lotteryAddress, selectionTotalCost],
        });

        await waitForTransactionReceipt(wagmiConfig, {
          hash: approveHash,
        });

        await refetchAllowance();
      }

      setStatus("buying");

      const sortedTickets = [...selectedTickets].sort((a, b) => a - b);
      const buyHash = await writeContractAsync({
        address: lotteryAddress,
        abi: lotteryAbi,
        functionName: "buyTicketsAt",
        args: [sortedTickets.map((ticket) => BigInt(ticket))],
      });

      await waitForTransactionReceipt(wagmiConfig, {
        hash: buyHash,
      });

      setSelectionFeedback(
        `Success! You reserved ${sortedTickets.length} ticket${sortedTickets.length === 1 ? "" : "s"}.`
      );
      setSelectedTickets([]);
      await Promise.all([
        refetchAllowance(),
        refetchSeriesInfo(),
        refetchPrice(),
        refetchActiveSeriesId(),
        refetchTicketOwners(),
      ]);
    } catch (error) {
      setSelectionFeedback(formatError(error));
    } finally {
      setStatus("idle");
    }
  }, [
    LOTTERY_ADDRESS,
    USDT_ADDRESS,
    availableTicketSet,
    isConnected,
    refetchActiveSeriesId,
    refetchAllowance,
    refetchPrice,
    refetchSeriesInfo,
    refetchTicketOwners,
    salesOpen,
    selectedTickets,
    selectionNeedsApproval,
    selectionTotalCost,
    writeContractAsync,
  ]);

  return (
    <div className={styles.page}>
      <GlowingOrbs />
      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Ticket board</p>
            <h1 className={styles.title}>Current draw availability</h1>
            <p className={styles.subtitle}>
              Follow the live ticket ledger for the current draw. Purchased
              tickets are sealed in red, remaining allotments glow cyan. Refresh
              updates every few seconds directly from the smart contract.
              <br />
              Active series: <strong>{activeSeriesLabel}</strong> ·{" "}
              {salesOpen ? "Sales active" : "Sales closed"}.
            </p>
          </div>
          <div className={styles.ctaGroup}>
            <div className={styles.navLinks}>
              <Link href="/" className={styles.primaryLink}>
                Back to purchase
              </Link>
              <Link href="/rewards" className={styles.secondaryLink}>
                Rewards
              </Link>
              {isConnected && (
                <Link href="/my-tickets" className={styles.secondaryLink}>
                  My Tickets
                </Link>
              )}
            </div>
            <div className={styles.stats}>
              <span>
                Series: <strong>{activeSeriesLabel}</strong>
              </span>
              <span>
                Sold: <strong>{soldTickets.toLocaleString()}</strong>
              </span>
              <span>
                Remaining: <strong>{ticketsLeft.toLocaleString()}</strong>
              </span>
              <span>
                Total: <strong>{totalTickets.toLocaleString()}</strong>
              </span>
            </div>
          </div>
        </header>

        <section className={styles.selectionPanel}>
          <div className={styles.selectionHeader}>
            <div className={styles.selectionHeaderContent}>
              <div>
                <p className={styles.selectionEyebrow}>Manual Selection</p>
                <h3 className={styles.selectionTitle}>Pick Your Tickets</h3>
                <p className={styles.selectionSubtitle}>
                  Select specific ticket numbers from the grid below. Click any available ticket to add or remove it from your selection.
                </p>
              </div>
              <div className={styles.selectionHeaderStats}>
                <div className={styles.selectionStatCard}>
                  <span className={styles.selectionStatLabel}>Selected</span>
                  <span className={styles.selectionStatValue}>
                    {selectionCount.toLocaleString()}
                  </span>
                </div>
                <div className={styles.selectionStatCard}>
                  <span className={styles.selectionStatLabel}>Total Cost</span>
                  <span className={styles.selectionStatValue}>
                    {selectionTotalUSDT} USDT
                  </span>
                  <span className={styles.selectionStatHint}>
                    ≈ ${selectionTotalUSD} USD
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.selectionTools}>
            <div className={styles.selectionToolsRow}>
              <div className={styles.selectionToolGroup}>
                <label className={styles.selectionToolLabel}>Quick Select</label>
                <div className={styles.selectionQuickGroup}>
                  {QUICK_PICK_PRESETS.map((preset) => (
                    <button
                      key={`selection-preset-${preset}`}
                      className={`${styles.selectionQuickButton} ${
                        (selectionTarget || selectionCount) === preset
                          ? styles.selectionQuickButtonActive
                          : ""
                      }`}
                      onClick={() => handleSelectionPreset(preset)}
                      disabled={preset > maxCustomSelectable || isBusy}
                    >
                      {preset}
                    </button>
                  ))}
                  <button
                    className={`${styles.selectionQuickButton} ${styles.selectionQuickButtonRandom}`}
                    onClick={handleLuckyDipSelection}
                    disabled={maxCustomSelectable === 0 || isBusy}
                  >
                    🎲 Lucky dip
                  </button>
                </div>
              </div>
              <div className={styles.selectionToolGroup}>
                <label className={styles.selectionToolLabel}>Custom Quantity</label>
                <div className={styles.selectionQuantity}>
                  <button
                    className={styles.quantityButton}
                    onClick={decrementSelection}
                    disabled={selectionCount === 0 && selectionTarget === 0}
                  >
                    −
                  </button>
                  <input
                    className={styles.quantityInput}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={maxCustomSelectable || 0}
                    value={selectionTarget || selectionCount || ""}
                    onChange={handleSelectionQuantityChange}
                    disabled={maxCustomSelectable === 0 || isBusy}
                    placeholder="0"
                  />
                  <button
                    className={styles.quantityButton}
                    onClick={incrementSelection}
                    disabled={
                      maxCustomSelectable === 0 ||
                      (selectionTarget || selectionCount || 0) >= maxCustomSelectable
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
            <div className={styles.selectionActionsRow}>
              <button
                className={styles.selectionSecondaryButton}
                onClick={handleShuffleSelection}
                disabled={selectionCount === 0 || isBusy}
              >
                🔀 Shuffle
              </button>
              <button
                className={styles.selectionSecondaryButton}
                onClick={handleClearSelection}
                disabled={selectedTickets.length === 0 || isBusy}
              >
                ✕ Clear All
              </button>
            </div>
          </div>

          <div className={styles.selectionChipsContainer}>
            {selectedTickets.length === 0 ? (
              <div className={styles.selectionPlaceholder}>
                <span>No tickets selected yet</span>
                <span className={styles.selectionPlaceholderHint}>
                  Click on available tickets in the grid below to add them to your selection
                </span>
              </div>
            ) : (
              <>
                <div className={styles.selectionChipsHeader}>
                  <span className={styles.selectionChipsLabel}>
                    Your Selection ({selectedTickets.length})
                  </span>
                </div>
                <div className={styles.selectionChips}>
                  {selectedTickets.map((ticket) => (
                    <button
                      key={`selected-${ticket}`}
                      className={styles.selectionChip}
                      onClick={() => handleRemoveSelected(ticket)}
                      type="button"
                      title="Click to remove"
                    >
                      #{ticket.toString().padStart(padLength, "0")}
                      <span aria-hidden="true" className={styles.selectionChipRemove}>×</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {selectionFeedback && (
            <div
              className={
                selectionFeedback.toLowerCase().startsWith("success")
                  ? styles.successBanner
                  : styles.errorBanner
              }
            >
              {selectionFeedback}
            </div>
          )}

          {!envReady && (
            <div className={styles.errorBanner}>
              Configure `NEXT_PUBLIC_LOTTERY_ADDRESS`,
              `NEXT_PUBLIC_USDT_ADDRESS`, and
              `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to enable transactions.
            </div>
          )}
          {envReady && !salesOpen && (
            <div className={styles.errorBanner}>
              {hasActiveSeries
                ? "Current series is sold out. Queue the next series to reopen sales."
                : "Ticket sales are paused until the next series is activated."}
            </div>
          )}

          <div className={styles.selectionPurchase}>
            <button
              className={styles.selectionPrimaryButton}
              onClick={handleBuySelected}
              disabled={
                !isConnected ||
                !envReady ||
                selectionCount === 0 ||
                !selectionTotalCost ||
                !salesOpen ||
                isBusy
              }
            >
              {isBusy
                ? status === "approving"
                  ? "Approving..."
                  : "Confirming..."
                : selectionNeedsApproval
                ? "Approve & Buy Tickets"
                : `Buy ${selectionCount} Ticket${selectionCount !== 1 ? "s" : ""}`}
            </button>
            {isConnected && (
              <p className={styles.selectionWalletHint}>
                Wallet: {address?.slice(0, 6)}...{address?.slice(-4)}
              </p>
            )}
            {!isConnected && (
              <p className={styles.selectionWalletHint}>
                Connect your wallet to purchase tickets
              </p>
            )}
          </div>
        </section>

        {tickets.length === 0 ? (
          <div className={styles.subtitle}>
            No tickets to display yet. Queue and activate the next series to
            populate the board.
          </div>
        ) : (
          <section className={styles.grid}>
            {tickets.map((ticket) => {
              const isSelected = selectedTickets.includes(ticket.number);
              return (
                <motion.div
                  key={`${activeSeriesLabel}-${ticket.number}`}
                  className={`${styles.ticket} ${
                    ticket.isSold ? styles.ticketSold : styles.ticketAvailable
                  } ${!ticket.isSold ? styles.ticketInteractive : ""} ${
                    isSelected ? styles.ticketSelected : ""
                  }`}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    duration: 0.4,
                    delay: ticket.number * 0.005,
                    ease: "easeOut",
                  }}
                  role={!ticket.isSold ? "button" : undefined}
                  tabIndex={!ticket.isSold ? 0 : -1}
                  onClick={() => handleTicketToggle(ticket.number)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleTicketToggle(ticket.number);
                    }
                  }}
                >
                  <span className={styles.ticketNumber}>
                    Ticket #{ticket.number.toString().padStart(padLength, "0")}
                  </span>
                  <span
                    className={`${styles.stamp} ${
                      ticket.isSold ? styles.stampSold : styles.stampAvailable
                    }`}
                  >
                    {ticket.isSold ? "SOLD" : isSelected ? "SELECTED" : "AVAILABLE"}
                  </span>
                </motion.div>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}

