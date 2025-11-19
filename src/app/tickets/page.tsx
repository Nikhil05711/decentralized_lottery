"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
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
import { formatSeriesName, formatTicketNumber } from "@/lib/seriesUtils";
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
  const [selectedTicketsSeries, setSelectedTicketsSeries] = useState<Map<number, bigint>>(new Map());
  const [selectionFeedback, setSelectionFeedback] = useState<string | null>(null);
  const [selectionTarget, setSelectionTarget] = useState(0);
  const [expandedSeries, setExpandedSeries] = useState<Set<bigint>>(new Set());
  const [seriesTicketsData, setSeriesTicketsData] = useState<Map<bigint, { tickets: Array<{ number: number; isSold: boolean }>; soldLookup: Set<number> | null }>>(new Map());

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

  const { data: totalSeriesCountData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "totalSeriesCount",
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

  const totalSeriesCount = useMemo(() => {
    if (typeof totalSeriesCountData === "bigint") return Number(totalSeriesCountData);
    if (typeof totalSeriesCountData === "number") return totalSeriesCountData;
    return 0;
  }, [totalSeriesCountData]);

  const seriesIds = useMemo(() => {
    if (totalSeriesCount === 0) return [];
    return Array.from({ length: totalSeriesCount }, (_, i) => BigInt(i + 1));
  }, [totalSeriesCount]);

  const seriesInfoContracts = useMemo(() => {
    if (!LOTTERY_ADDRESS || seriesIds.length === 0) return [];
    return seriesIds.map((seriesId) => ({
      address: LOTTERY_ADDRESS,
      abi: lotteryAbi,
      functionName: "seriesInfo" as const,
      args: [seriesId],
    }));
  }, [seriesIds]);

  const { data: allSeriesInfoData, refetch: refetchAllSeriesInfo } = useReadContracts({
    contracts: seriesInfoContracts,
    query: {
      enabled: seriesInfoContracts.length > 0,
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

  type SeriesData = {
    seriesId: bigint;
    totalTickets: bigint;
    ticketsSold: bigint;
    isActive: boolean;
    isCompleted: boolean;
    ticketsLeft: number;
  };

  const allSeriesData = useMemo(() => {
    if (!allSeriesInfoData || allSeriesInfoData.length === 0) return [];
    
    return seriesIds
      .map((seriesId, index) => {
        const info = allSeriesInfoData[index];
        if (!info || info.status !== "success" || !info.result) return null;

        const tuple = info.result as ReadonlyArray<unknown> & {
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

        const isCompleted = total > BigInt(0) && sold === total;
        const isActive = seriesId === activeSeriesId;
        const ticketsLeft = Math.max(Number(total) - Number(sold), 0);

        return {
          seriesId,
          totalTickets: total,
          ticketsSold: sold,
          isActive,
          isCompleted,
          ticketsLeft,
        } as SeriesData;
      })
      .filter((series): series is SeriesData => series !== null && !series.isCompleted)
      .sort((a, b) => {
        // Active series first, then by series ID (newest first)
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        if (a.seriesId > b.seriesId) return -1;
        if (a.seriesId < b.seriesId) return 1;
        return 0;
      });
  }, [allSeriesInfoData, seriesIds, activeSeriesId]);

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

  const totalCost = useMemo(() => {
    if (!ticketCount) return undefined;
    try {
      return ticketPriceRaw * BigInt(ticketCount);
    } catch {
      return undefined;
    }
  }, [ticketCount, ticketPriceRaw]);

  const toggleSeries = useCallback((seriesId: bigint) => {
    setExpandedSeries((prev) => {
      const next = new Set(prev);
      if (next.has(seriesId)) {
        next.delete(seriesId);
      } else {
        next.add(seriesId);
      }
      return next;
    });
  }, []);

  // Auto-expand active series on load and when activeSeriesId changes
  useEffect(() => {
    if (activeSeriesId > BigInt(0)) {
      setExpandedSeries((prev) => {
        const next = new Set(prev);
        if (!next.has(activeSeriesId)) {
          next.add(activeSeriesId);
        }
        return next;
      });
    }
  }, [activeSeriesId]);

  // Create ticket owner contracts for expanded series only
  const seriesTicketOwnerContracts = useMemo(() => {
    if (!LOTTERY_ADDRESS || expandedSeries.size === 0) return new Map<bigint, any[]>();
    
    const contractsMap = new Map<bigint, any[]>();
    allSeriesData.forEach((series) => {
      if (expandedSeries.has(series.seriesId) && series.totalTickets > BigInt(0)) {
        const totalTickets = clampToSafeNumber(series.totalTickets);
        const base = series.seriesId << BigInt(128);
        const contracts = Array.from({ length: totalTickets }, (_, index) => ({
          address: LOTTERY_ADDRESS,
          abi: lotteryAbi,
          functionName: "ticketOwners" as const,
          args: [base | BigInt(index + 1)],
        }));
        contractsMap.set(series.seriesId, contracts);
      }
    });
    return contractsMap;
  }, [LOTTERY_ADDRESS, expandedSeries, allSeriesData]);

  // Fetch ticket owners for all expanded series
  const allTicketOwnerContracts = useMemo(() => {
    const all: any[] = [];
    seriesTicketOwnerContracts.forEach((contracts) => {
      all.push(...contracts);
    });
    return all;
  }, [seriesTicketOwnerContracts]);

  const { data: allTicketOwnersData, refetch: refetchAllTicketOwners } = useReadContracts({
    contracts: allTicketOwnerContracts,
    query: {
      enabled: allTicketOwnerContracts.length > 0,
      refetchInterval: 20_000,
    },
  });

  // Process ticket data per series
  useEffect(() => {
    if (!allTicketOwnersData || allTicketOwnersData.length === 0) return;

    const newSeriesTicketsData = new Map<bigint, { tickets: Array<{ number: number; isSold: boolean }>; soldLookup: Set<number> | null }>();
    let dataIndex = 0;

    allSeriesData.forEach((series) => {
      if (expandedSeries.has(series.seriesId)) {
        const contracts = seriesTicketOwnerContracts.get(series.seriesId);
        if (!contracts) return;

        const soldLookup = new Set<number>();
        const tickets: Array<{ number: number; isSold: boolean }> = [];
        const totalTickets = clampToSafeNumber(series.totalTickets);

        for (let i = 0; i < contracts.length && dataIndex < allTicketOwnersData.length; i++) {
          const entry = allTicketOwnersData[dataIndex];
          const owner = (entry?.result as `0x${string}` | undefined) ?? zeroAddress;
          const ticketNumber = i + 1;
          const isSold = owner !== zeroAddress;
          
          if (isSold) {
            soldLookup.add(ticketNumber);
          }
          tickets.push({ number: ticketNumber, isSold });
          dataIndex++;
        }

        newSeriesTicketsData.set(series.seriesId, { tickets, soldLookup });
      }
    });

    setSeriesTicketsData(newSeriesTicketsData);
  }, [allTicketOwnersData, expandedSeries, allSeriesData, seriesTicketOwnerContracts]);

  // All available tickets (for manual clicking from any series)
  const availableTicketSet = useMemo(() => {
    const allAvailable = new Set<number>();
    seriesTicketsData.forEach((data, seriesId) => {
      data.tickets.forEach((ticket) => {
        if (!ticket.isSold) {
          allAvailable.add(ticket.number);
        }
      });
    });
    return allAvailable;
  }, [seriesTicketsData]);

  // Active series tickets only (for quick select and manual picks section)
  const activeSeriesAvailableTickets = useMemo(() => {
    const activeTickets = new Set<number>();
    const activeSeriesData = seriesTicketsData.get(activeSeriesId);
    if (activeSeriesData) {
      activeSeriesData.tickets.forEach((ticket) => {
        if (!ticket.isSold) {
          activeTickets.add(ticket.number);
        }
      });
    }
    return activeTickets;
  }, [seriesTicketsData, activeSeriesId]);

  const activeSeriesAvailableNumbers = useMemo(() => {
    return Array.from(activeSeriesAvailableTickets).sort((a, b) => a - b);
  }, [activeSeriesAvailableTickets]);

  // Get active series info to determine if buttons should be enabled
  const activeSeriesInfo = useMemo(() => {
    return allSeriesData.find(s => s.isActive);
  }, [allSeriesData]);

  const maxCustomSelectable = useMemo(() => {
    // If we have detailed ticket data, use that
    if (activeSeriesAvailableTickets.size > 0) {
      return Math.min(activeSeriesAvailableTickets.size, MAX_CUSTOM_SELECTION);
    }
    // Otherwise, use series info to determine availability
    if (activeSeriesInfo && activeSeriesInfo.ticketsLeft > 0) {
      return Math.min(activeSeriesInfo.ticketsLeft, MAX_CUSTOM_SELECTION);
    }
    return 0;
  }, [activeSeriesAvailableTickets.size, activeSeriesInfo]);

  const padLength = useMemo(() => {
    let max = 3;
    allSeriesData.forEach((series) => {
      const total = Number(series.totalTickets);
      if (total > max) max = total;
    });
    return Math.max(String(max).length, 3);
  }, [allSeriesData]);

  // Filter out tickets that are no longer available
  useEffect(() => {
    setSelectedTickets((current) =>
      current.filter((ticket) => availableTicketSet.has(ticket))
    );
  }, [availableTicketSet]);

  // For manual picks section: filter to only active series tickets and limit to maxCustomSelectable
  useEffect(() => {
    if (maxCustomSelectable === 0) {
      setSelectionTarget(0);
      // Only clear tickets that are from active series (keep manually selected from other series)
      setSelectedTickets((current) => {
        return current.filter((ticket) => {
          const ticketSeries = selectedTicketsSeries.get(ticket);
          return ticketSeries !== activeSeriesId;
        });
      });
      setSelectedTicketsSeries((prev) => {
        const next = new Map(prev);
        prev.forEach((seriesId, ticket) => {
          if (seriesId === activeSeriesId) {
            next.delete(ticket);
          }
        });
        return next;
      });
      return;
    }
    
    setSelectionTarget((current) => {
      if (!current || current > maxCustomSelectable) {
        const activeSeriesCount = Array.from(selectedTicketsSeries.values()).filter(
          (sid) => sid === activeSeriesId
        ).length;
        return Math.min(maxCustomSelectable, activeSeriesCount || 0);
      }
      return current;
    });
    
    // Limit active series tickets to maxCustomSelectable, but keep tickets from other series
    setSelectedTickets((current) => {
      const activeSeriesTickets = current.filter(
        (ticket) => selectedTicketsSeries.get(ticket) === activeSeriesId
      );
      const otherSeriesTickets = current.filter(
        (ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId
      );
      
      if (activeSeriesTickets.length > maxCustomSelectable) {
        const toKeep = activeSeriesTickets.slice(0, maxCustomSelectable);
        const toRemove = activeSeriesTickets.slice(maxCustomSelectable);
        setSelectedTicketsSeries((prev) => {
          const next = new Map(prev);
          toRemove.forEach((ticket) => next.delete(ticket));
          return next;
        });
        return [...otherSeriesTickets, ...toKeep];
      }
      return current;
    });
  }, [activeSeriesAvailableTickets, maxCustomSelectable, activeSeriesId, selectedTicketsSeries]);

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

  // Count only active series tickets for manual picks section
  const selectionCount = useMemo(() => {
    return selectedTickets.filter(
      (ticket) => selectedTicketsSeries.get(ticket) === activeSeriesId
    ).length;
  }, [selectedTickets, selectedTicketsSeries, activeSeriesId]);

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

  // Legacy functions for sequential purchase (kept for compatibility but not used in new UI)
  const increment = () => setTicketCount((current) => current + 1);
  const decrement = () => setTicketCount((current) => Math.max(1, current - 1));

  const clampSelection = useCallback(
    (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return 1;
      return Math.max(1, value);
    },
    []
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
      setTicketCount(clampSelection(value));
    },
    [clampSelection]
  );

  const handleRandomizeCount = useCallback(() => {
    if (maxCustomSelectable === 0) return;
    const randomCount = Math.floor(Math.random() * maxCustomSelectable) + 1;
    setTicketCount(randomCount);
  }, [maxCustomSelectable]);

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
    // Check if there are any available tickets
    const hasAvailableTickets = allSeriesData.some(s => s.ticketsLeft > 0);
    if (!hasAvailableTickets) {
      setFeedback("All series are sold out. Watch for the next series to launch.");
      return;
    }
    
    // For sequential purchase, use active series
    const activeSeries = allSeriesData.find(s => s.isActive);
    if (!activeSeries) {
      setFeedback("No active series available for sequential purchase.");
      return;
    }
    if (ticketCount > activeSeries.ticketsLeft) {
      setFeedback(`Only ${activeSeries.ticketsLeft} ticket(s) remain in the active series.`);
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
        refetchAllSeriesInfo(),
        refetchPrice(),
        refetchActiveSeriesId(),
        refetchAllTicketOwners(),
        refetchBalance(),
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
    refetchAllSeriesInfo,
    refetchAllTicketOwners,
    refetchBalance,
    totalCost,
    writeContractAsync,
    allSeriesData,
  ]);

  const handleTicketToggle = useCallback(
    (ticketNumber: number, seriesId: bigint) => {
      if (!envReady || isBusy) return;
      if (!availableTicketSet.has(ticketNumber)) return;
      
      setSelectedTickets((current) => {
        if (current.includes(ticketNumber)) {
          setSelectedTicketsSeries((prev) => {
            const next = new Map(prev);
            next.delete(ticketNumber);
            return next;
          });
          return current.filter((value) => value !== ticketNumber);
        }
        if (current.length >= Math.min(MAX_CUSTOM_SELECTION, availableTicketSet.size)) {
          return current;
        }
        setSelectedTicketsSeries((prev) => {
          const next = new Map(prev);
          next.set(ticketNumber, seriesId);
          return next;
        });
        return [...current, ticketNumber].sort((a, b) => a - b);
      });
      setSelectionFeedback(null);
    },
    [availableTicketSet, envReady, isBusy]
  );

  const handleRemoveSelected = useCallback((ticketNumber: number) => {
    setSelectedTickets((current) => current.filter((value) => value !== ticketNumber));
    setSelectedTicketsSeries((prev) => {
      const next = new Map(prev);
      next.delete(ticketNumber);
      return next;
    });
  }, []);


  const randomizeSelection = useCallback(
    (target: number, seriesId?: bigint) => {
      if (maxCustomSelectable === 0) {
        // Only clear active series tickets, keep manually selected from other series
        setSelectedTickets((current) => {
          return current.filter((ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId);
        });
        setSelectedTicketsSeries((prev) => {
          const next = new Map(prev);
          prev.forEach((sid, ticket) => {
            if (sid === activeSeriesId) {
              next.delete(ticket);
            }
          });
          return next;
        });
        setSelectionTarget(0);
        return;
      }
      const desired = Math.min(Math.max(1, target), maxCustomSelectable);
      
      // For manual picks section, always use active series tickets
      // Only use specified seriesId if explicitly provided (for future use)
      const targetSeriesId = seriesId || activeSeriesId;
      
      let availableTickets: Array<{ number: number; seriesId: bigint }> = [];
      const seriesData = seriesTicketsData.get(targetSeriesId);
      
      if (seriesData && seriesData.tickets.length > 0) {
        // Use detailed ticket data if available
        availableTickets = seriesData.tickets
          .filter((t) => !t.isSold)
          .map((t) => ({ number: t.number, seriesId: targetSeriesId }));
      } else {
        // If ticket data not loaded yet, show feedback and wait
        setSelectionFeedback("Loading ticket data... Please expand the active series or wait a moment.");
        return;
      }

      if (availableTickets.length === 0) {
        setSelectionFeedback("No available tickets in the active series.");
        return;
      }

      // Shuffle
      for (let i = availableTickets.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [availableTickets[i], availableTickets[j]] = [availableTickets[j], availableTickets[i]];
      }

      const selected = availableTickets.slice(0, Math.min(desired, availableTickets.length));
      const newActiveSeriesTickets = selected.map((t) => t.number).sort((a, b) => a - b);
      
      // Keep tickets from other series, replace only active series tickets
      setSelectedTickets((current) => {
        const otherSeriesTickets = current.filter(
          (ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId
        );
        return [...otherSeriesTickets, ...newActiveSeriesTickets].sort((a, b) => a - b);
      });
      
      setSelectedTicketsSeries((prev) => {
        const next = new Map(prev);
        // Remove old active series tickets
        prev.forEach((sid, ticket) => {
          if (sid === activeSeriesId) {
            next.delete(ticket);
          }
        });
        // Add new active series tickets
        selected.forEach((t) => {
          next.set(t.number, t.seriesId);
        });
        return next;
      });
      
      setSelectionTarget(desired);
      setSelectionFeedback(null);
    },
    [activeSeriesAvailableTickets.size, maxCustomSelectable, seriesTicketsData, activeSeriesId, selectedTicketsSeries]
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
        // Only clear active series tickets
        setSelectedTickets((current) => {
          return current.filter((ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId);
        });
        setSelectedTicketsSeries((prev) => {
          const next = new Map(prev);
          prev.forEach((seriesId, ticket) => {
            if (seriesId === activeSeriesId) {
              next.delete(ticket);
            }
          });
          return next;
        });
        return;
      }
      // Only select from active series
      randomizeSelection(nextValue, activeSeriesId);
    },
    [randomizeSelection, activeSeriesId, selectedTicketsSeries]
  );

  const handleSelectionPreset = useCallback(
    (value: number) => {
      if (maxCustomSelectable === 0) return;
      // Only select from active series
      randomizeSelection(value, activeSeriesId);
    },
    [maxCustomSelectable, randomizeSelection, activeSeriesId]
  );

  const handleShuffleSelection = useCallback(() => {
    if (selectionCount === 0) return;
    // Only shuffle active series tickets
    randomizeSelection(selectionCount, activeSeriesId);
  }, [randomizeSelection, selectionCount, activeSeriesId]);

  const handleLuckyDipSelection = useCallback(() => {
    if (maxCustomSelectable === 0) return;
    const randomCount = Math.floor(Math.random() * maxCustomSelectable) + 1;
    // Only select from active series
    randomizeSelection(randomCount, activeSeriesId);
  }, [maxCustomSelectable, randomizeSelection, activeSeriesId]);

  const incrementSelection = useCallback(() => {
    if (maxCustomSelectable === 0) return;
    const base = selectionTarget || selectionCount || 0;
    // Only select from active series
    randomizeSelection(Math.min(base + 1, maxCustomSelectable), activeSeriesId);
  }, [maxCustomSelectable, randomizeSelection, selectionCount, selectionTarget, activeSeriesId]);

  const decrementSelection = useCallback(() => {
    const base = selectionTarget || selectionCount;
    if (!base || base <= 1) {
      setSelectionTarget(0);
      // Only clear active series tickets, keep manually selected from other series
      setSelectedTickets((current) => {
        return current.filter((ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId);
      });
      setSelectedTicketsSeries((prev) => {
        const next = new Map(prev);
        prev.forEach((seriesId, ticket) => {
          if (seriesId === activeSeriesId) {
            next.delete(ticket);
          }
        });
        return next;
      });
      return;
    }
    // Only select from active series
    randomizeSelection(base - 1, activeSeriesId);
  }, [randomizeSelection, selectionCount, selectionTarget, activeSeriesId, selectedTicketsSeries]);

  const handleClearSelection = useCallback(() => {
    // Only clear active series tickets, keep manually selected from other series
    setSelectedTickets((current) => {
      return current.filter((ticket) => selectedTicketsSeries.get(ticket) !== activeSeriesId);
    });
    setSelectedTicketsSeries((prev) => {
      const next = new Map(prev);
      prev.forEach((seriesId, ticket) => {
        if (seriesId === activeSeriesId) {
          next.delete(ticket);
        }
      });
      return next;
    });
    setSelectionTarget(0);
    setSelectionFeedback(null);
  }, [activeSeriesId, selectedTicketsSeries]);

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
    // Check if there are available tickets
    const hasAvailableTickets = allSeriesData.some(s => s.ticketsLeft > 0);
    if (!hasAvailableTickets) {
      setSelectionFeedback("All series are sold out. Queue the next series to reopen sales.");
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
    // Group tickets by series
    const ticketsBySeries = new Map<bigint, number[]>();
    selectedTickets.forEach((ticketNumber) => {
      const seriesId = selectedTicketsSeries.get(ticketNumber);
      if (seriesId) {
        if (!ticketsBySeries.has(seriesId)) {
          ticketsBySeries.set(seriesId, []);
        }
        ticketsBySeries.get(seriesId)!.push(ticketNumber);
      }
    });

    if (ticketsBySeries.size === 0) {
      setSelectionFeedback("No valid tickets selected.");
      return;
    }

    // Check if all tickets are still available
    const unavailableTickets = selectedTickets.filter((ticket) => !availableTicketSet.has(ticket));
    if (unavailableTickets.length > 0) {
      setSelectionFeedback("One or more selected tickets are no longer available.");
      setSelectedTickets((current) =>
        current.filter((ticket) => availableTicketSet.has(ticket))
      );
      setSelectedTicketsSeries((prev) => {
        const next = new Map(prev);
        unavailableTickets.forEach((ticket) => next.delete(ticket));
        return next;
      });
      return;
    }

    // For now, we can only buy from active series (contract limitation)
    // Buy tickets from each series separately
    const activeSeriesTickets = ticketsBySeries.get(activeSeriesId);
    if (!activeSeriesTickets || activeSeriesTickets.length === 0) {
      setSelectionFeedback("Please select tickets from the active series. Buying from other series requires contract updates.");
      return;
    }

    // If tickets from multiple series, warn user (for now only allow active series)
    if (ticketsBySeries.size > 1) {
      setSelectionFeedback("Currently, you can only buy tickets from the active series. Please select tickets from Series " + formatSeriesName(activeSeriesId));
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

      // Use tickets from active series
      const sortedTickets = activeSeriesTickets.sort((a, b) => a - b);
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
      setSelectedTicketsSeries(new Map());
      await Promise.all([
        refetchAllowance(),
        refetchAllSeriesInfo(),
        refetchPrice(),
        refetchActiveSeriesId(),
        refetchAllTicketOwners(),
        refetchBalance(),
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
    refetchAllSeriesInfo,
    refetchAllTicketOwners,
    refetchBalance,
    selectedTickets,
    selectedTicketsSeries,
    activeSeriesId,
    selectionNeedsApproval,
    selectionTotalCost,
    writeContractAsync,
    availableTicketSet,
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
              Browse all available series and select tickets from any series you prefer. 
              Click on a series to expand and view its tickets. Purchased tickets are sealed in red, 
              remaining allotments glow cyan.
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
              {isConnected && (
                <span className={styles.balanceStat}>
                  Balance: <strong>{usdtBalanceFormatted} USDT</strong>
                </span>
              )}
              <span>
                Series: <strong>{allSeriesData.length}</strong>
              </span>
              <span>
                Active: <strong>{allSeriesData.filter(s => s.isActive).length}</strong>
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
                  Quick select and manual quantity tools work with the active series only. You can also manually click tickets from any series below, but only active series tickets can be purchased.
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
                    disabled={maxCustomSelectable === 0 || (selectionTarget === 0 && selectionCount === 0) || isBusy}
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
                title={selectionCount === 0 ? "Select tickets first to shuffle" : "Shuffle selected tickets"}
              >
                🔀 Shuffle (Active Series)
              </button>
              <button
                className={styles.selectionSecondaryButton}
                onClick={handleClearSelection}
                disabled={selectionCount === 0 || isBusy}
                title={selectionCount === 0 ? "No active series tickets to clear" : "Clear active series selection"}
              >
                ✕ Clear Active Series
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
                    Your Selection ({selectedTickets.length} total, {selectionCount} from active series)
                  </span>
                </div>
                <div className={styles.selectionChips}>
                  {selectedTickets.map((ticket) => {
                    const ticketSeriesId = selectedTicketsSeries.get(ticket);
                    const isFromActiveSeries = ticketSeriesId === activeSeriesId;
                    return (
                      <button
                        key={`selected-${ticket}`}
                        className={`${styles.selectionChip} ${!isFromActiveSeries ? styles.selectionChipInactive : ""}`}
                        onClick={() => handleRemoveSelected(ticket)}
                        type="button"
                        title={isFromActiveSeries ? "Click to remove" : "This ticket is from a different series. Only active series tickets can be purchased."}
                      >
                        <span>
                          {ticketSeriesId ? formatTicketNumber(ticket, ticketSeriesId, padLength) : `#${ticket.toString().padStart(padLength, "0")}`}
                        </span>
                        <span aria-hidden="true" className={styles.selectionChipRemove}>×</span>
                      </button>
                    );
                  })}
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
          {envReady && allSeriesData.length > 0 && allSeriesData.every(s => s.ticketsLeft === 0) && (
            <div className={styles.errorBanner}>
              All series are sold out. Queue the next series to reopen sales.
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
                isBusy ||
                selectedTickets.length === 0 ||
                !selectedTickets.every(t => selectedTicketsSeries.get(t) === activeSeriesId)
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

        {allSeriesData.length === 0 ? (
          <div className={styles.subtitle}>
            No series available yet. Queue and activate a series to start ticket sales.
          </div>
        ) : (
          <section className={styles.seriesContainer}>
            {allSeriesData.map((series, seriesIndex) => {
              const isExpanded = expandedSeries.has(series.seriesId);
              const seriesTickets = seriesTicketsData.get(series.seriesId);
              const seriesPadLength = Math.max(String(Number(series.totalTickets)).length, 3);
              
              return (
                <motion.div
                  key={series.seriesId.toString()}
                  className={`${styles.seriesCard} ${series.isActive ? styles.seriesCardActive : ""}`}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: seriesIndex * 0.1 }}
                >
                  <div 
                    className={styles.seriesCardHeader}
                    onClick={() => toggleSeries(series.seriesId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSeries(series.seriesId);
                      }
                    }}
                  >
                    <div className={styles.seriesCardTitleRow}>
                      <h3 className={styles.seriesCardTitle}>
                        Series {formatSeriesName(series.seriesId)}
                      </h3>
                      <div className={styles.seriesCardHeaderRight}>
                        {series.isActive && (
                          <span className={styles.seriesActiveBadge}>Active</span>
                        )}
                        <motion.div
                          className={styles.seriesExpandIcon}
                          animate={{ rotate: isExpanded ? 180 : 0 }}
                          transition={{ duration: 0.3 }}
                        >
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                            <path
                              d="M5 7.5L10 12.5L15 7.5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </motion.div>
                      </div>
                    </div>
                    <div className={styles.seriesCardSummary}>
                      <span>
                        {series.ticketsSold.toLocaleString()} / {series.totalTickets.toLocaleString()} sold
                      </span>
                      <span>
                        {series.ticketsLeft.toLocaleString()} available
                      </span>
                    </div>
                  </div>

                  <AnimatePresence>
                    {isExpanded && seriesTickets && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        style={{ overflow: "hidden" }}
                      >
                        <div className={styles.seriesTicketsGrid}>
                          {seriesTickets.tickets.map((ticket, ticketIndex) => {
                            // Only show as selected if this specific ticket (number + series) is selected
                            const isSelected = selectedTickets.includes(ticket.number) && 
                                              selectedTicketsSeries.get(ticket.number) === series.seriesId;
                            return (
                              <motion.div
                                key={`series-${series.seriesId}-ticket-${ticket.number}`}
                                className={`${styles.ticket} ${
                                  ticket.isSold ? styles.ticketSold : styles.ticketAvailable
                                } ${!ticket.isSold ? styles.ticketInteractive : ""} ${
                                  isSelected ? styles.ticketSelected : ""
                                }`}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{
                  duration: 0.4,
                                  delay: ticketIndex * 0.005,
                  ease: "easeOut",
                }}
                                role={!ticket.isSold ? "button" : undefined}
                                tabIndex={!ticket.isSold ? 0 : -1}
                                onClick={() => !ticket.isSold && handleTicketToggle(ticket.number, series.seriesId)}
                                onKeyDown={(event) => {
                                  if ((event.key === "Enter" || event.key === " ") && !ticket.isSold) {
                                    event.preventDefault();
                                    handleTicketToggle(ticket.number, series.seriesId);
                                  }
                }}
              >
                                <span className={styles.ticketNumber}>
                                  Ticket {formatTicketNumber(ticket.number, series.seriesId, seriesPadLength)}
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
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}

