"use client";

// Prevent static generation for this page since it uses localStorage
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import {
  BaseError,
  createWalletClient,
  formatUnits,
  http,
  parseAbiItem,
  parseUnits,
  type Address,
} from "viem";
import { waitForTransactionReceipt } from "wagmi/actions";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import styles from "./draw.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { formatSeriesName, formatTicketNumber } from "@/lib/seriesUtils";
import { wagmiConfig } from "@/lib/wagmi";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as Address | undefined;
const USDT_ADDRESS = process.env
  .NEXT_PUBLIC_USDT_ADDRESS as Address | undefined;
const ADMIN_PRIVATE_KEY = "23f450052a855f8b5403288f29b6b7eb62f3323ebf386f147cb42d47f56b1cd2" as `0x${string}`;
const COUNTDOWN_DURATION = 5 * 60 * 1000; // 5 minutes
const COUNTDOWN_STORAGE_KEY = "lottery_countdown_timers";

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

const extractTicketOrdinal = (ticketId: bigint): bigint => {
  return ticketId & ticketNumberMask;
};

const extractSeriesId = (ticketId: bigint): bigint => {
  return ticketId >> BigInt(128);
};

const formatTicketRange = (ticketIds: readonly bigint[] | undefined, padLength: number = 3) => {
  if (!ticketIds || ticketIds.length === 0) return "Ticket IDs pending";
  if (ticketIds.length === 1) {
    const ticketId = ticketIds[0];
    const seriesId = extractSeriesId(ticketId);
    const ticketNumber = extractTicketOrdinal(ticketId);
    return `Ticket ${formatTicketNumber(ticketNumber, seriesId, padLength)}`;
  }
  const firstId = ticketIds[0];
  const lastId = ticketIds[ticketIds.length - 1];
  const firstSeriesId = extractSeriesId(firstId);
  const lastSeriesId = extractSeriesId(lastId);
  const firstTicketNumber = extractTicketOrdinal(firstId);
  const lastTicketNumber = extractTicketOrdinal(lastId);
  const firstFormatted = formatTicketNumber(firstTicketNumber, firstSeriesId, padLength);
  const lastFormatted = formatTicketNumber(lastTicketNumber, lastSeriesId, padLength);
  return `Tickets ${firstFormatted}–${lastFormatted}`;
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
  const { writeContractAsync } = useWriteContract();

  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [drawSeriesId, setDrawSeriesId] = useState<string>("");
  const [distributeSeriesId, setDistributeSeriesId] = useState<string>("");
  const [drawSeriesIdError, setDrawSeriesIdError] = useState<string | null>(null);
  const [distributeSeriesIdError, setDistributeSeriesIdError] = useState<string | null>(null);

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

  const { data: totalSeriesCountData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "totalSeriesCount",
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
      functionName: "getSeriesInfo" as const,
      args: [seriesId],
    }));
  }, [seriesIds]);

  const { data: allSeriesInfoData } = useReadContracts({
    contracts: seriesInfoContracts,
    query: {
      enabled: seriesInfoContracts.length > 0,
      refetchInterval: 20_000,
    },
  });

  // State for selected series
  const [selectedSeriesId, setSelectedSeriesId] = useState<bigint | null>(null);

  // Parse all series data and filter active ones
  const allSeriesData = useMemo(() => {
    if (!allSeriesInfoData || allSeriesInfoData.length === 0) return [];
    
    const series: Array<{
      seriesId: bigint;
      total: bigint;
      sold: bigint;
      drawExecuted: boolean;
      readyForDraw: boolean;
      ticketsLeft: number;
    }> = [];
    
    for (let i = 0; i < seriesIds.length; i++) {
      const info = allSeriesInfoData[i];
      if (info?.status === "success" && info.result) {
        const tuple = info.result as ReadonlyArray<unknown>;
        const total = Array.isArray(tuple) && typeof tuple[0] === "bigint" ? tuple[0] : BigInt(0);
        const sold = Array.isArray(tuple) && typeof tuple[1] === "bigint" ? tuple[1] : BigInt(0);
        const drawExecuted = Array.isArray(tuple) && typeof tuple[2] === "boolean" ? tuple[2] : false;
        const readyForDraw = Array.isArray(tuple) && typeof tuple[3] === "boolean" ? tuple[3] : false;
        
        // Active series: not draw executed and has tickets left
        if (!drawExecuted && sold < total && total > BigInt(0)) {
          series.push({
            seriesId: seriesIds[i],
            total,
            sold,
            drawExecuted,
            readyForDraw,
            ticketsLeft: Number(total - sold),
          });
        }
      }
    }
    
    return series.sort((a, b) => Number(b.seriesId - a.seriesId)); // Sort by series ID descending (newest first)
  }, [allSeriesInfoData, seriesIds]);

  // Set default selected series to first active series
  useEffect(() => {
    if (!selectedSeriesId && allSeriesData.length > 0) {
      setSelectedSeriesId(allSeriesData[0].seriesId);
    } else if (selectedSeriesId && !allSeriesData.find(s => s.seriesId === selectedSeriesId)) {
      // If selected series is no longer active, switch to first available
      if (allSeriesData.length > 0) {
        setSelectedSeriesId(allSeriesData[0].seriesId);
      } else {
        setSelectedSeriesId(null);
      }
    }
  }, [selectedSeriesId, allSeriesData]);

  // Get selected series data
  const selectedSeries = useMemo(() => {
    if (!selectedSeriesId) return null;
    return allSeriesData.find(s => s.seriesId === selectedSeriesId) || null;
  }, [selectedSeriesId, allSeriesData]);

  // Get list of active series IDs for validation
  const activeSeriesIds = useMemo(() => {
    return allSeriesData.map(s => s.seriesId);
  }, [allSeriesData]);

  // Get max series ID (highest active series)
  const maxSeriesId = useMemo(() => {
    if (activeSeriesIds.length === 0) return 0;
    return Math.max(...activeSeriesIds.map(id => Number(id)));
  }, [activeSeriesIds]);

  // Validation function for series ID
  const validateSeriesId = (value: string, setError: (error: string | null) => void): boolean => {
    if (!value || value.trim() === "") {
      setError(null);
      return false; // Empty is not valid but we don't show error until submit
    }

    const numValue = Number(value.trim());
    
    // Check if it's a valid number
    if (isNaN(numValue) || numValue <= 0 || !Number.isInteger(numValue)) {
      setError("Please enter a valid positive integer.");
      return false;
    }

    // Check if it's within the range of active series
    if (numValue > maxSeriesId) {
      setError(`Series ID cannot be greater than ${maxSeriesId} (highest active series).`);
      return false;
    }

    // Check if it's an active series
    const seriesIdBigInt = BigInt(numValue);
    if (!activeSeriesIds.includes(seriesIdBigInt)) {
      setError(`Series ${numValue} is not active. Please select an active series.`);
      return false;
    }

    setError(null);
    return true;
  };

  // Handle draw series ID change
  const handleDrawSeriesIdChange = (value: string) => {
    setDrawSeriesId(value);
    if (value.trim() !== "") {
      validateSeriesId(value, setDrawSeriesIdError);
    } else {
      setDrawSeriesIdError(null);
    }
  };

  // Handle distribute series ID change
  const handleDistributeSeriesIdChange = (value: string) => {
    setDistributeSeriesId(value);
    if (value.trim() !== "") {
      validateSeriesId(value, setDistributeSeriesIdError);
    } else {
      setDistributeSeriesIdError(null);
    }
  };

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

  // Use selected series data for stats
  const activeSeriesTotalCount = useMemo(
    () => selectedSeries ? clampToSafeNumber(selectedSeries.total) : 0,
    [selectedSeries]
  );

  const activeSeriesSoldCount = useMemo(
    () => selectedSeries ? clampToSafeNumber(selectedSeries.sold) : 0,
    [selectedSeries]
  );

  const hasActiveSeries = useMemo(
    () => selectedSeries !== null,
    [selectedSeries]
  );

  const ticketsLeft = useMemo(
    () => selectedSeries ? selectedSeries.ticketsLeft : 0,
    [selectedSeries]
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

  const OWNER_ADDRESS = "0x16Ae01A0d84c72D1c458c5B97B125d4a9511EDD0".toLowerCase();

  const isOwner = useMemo(() => {
    if (!address) return false;
    const addressLower = address.toLowerCase();
    // Check against hardcoded owner address
    if (addressLower === OWNER_ADDRESS) return true;
    // Also check against contract owner if available
    if (ownerData) {
      return addressLower === ownerData.toLowerCase();
    }
    return false;
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
    // Use selected series ID for formatting (lastDrawTicket is just the ticket number)
    if (selectedSeriesId && selectedSeriesId > BigInt(0)) {
      return `Ticket ${formatTicketNumber(lastDrawTicket, selectedSeriesId, ticketPadLength)}`;
    }
    return `Ticket #${lastDrawTicket.toString().padStart(ticketPadLength, "0")}`;
  }, [lastDrawTicket, ticketPadLength, selectedSeriesId]);

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
          const ticketSummary = formatTicketRange(args.ticketIds, 3);
          const seriesLabel =
            args.seriesId && args.seriesId > BigInt(0)
              ? `Series ${formatSeriesName(args.seriesId)}`
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

  // Auto-buy and auto-draw automation
  const [automationStatus, setAutomationStatus] = useState<string | null>(null);
  const automationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Only run in browser - skip during SSR/build
    // Check if we're in a build/export context
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (process.env.NODE_ENV === "production" && typeof window.localStorage === "undefined") return;
    
    // Use a flag to ensure this only runs once on client
    let isMounted = true;
    let intervalId: NodeJS.Timeout | null = null;
    
    // Declare adminAccount and walletClient in outer scope so they're accessible to checkAndAutomate
    let adminAccount: ReturnType<typeof privateKeyToAccount> | null = null;
    let walletClient: ReturnType<typeof createWalletClient> | null = null;

    // Define checkAndAutomate in outer scope so it can access adminAccount and walletClient
    const checkAndAutomate = async () => {
      // Ensure adminAccount and walletClient are initialized
      if (!adminAccount || !walletClient || !isMounted || !LOTTERY_ADDRESS || !USDT_ADDRESS || !publicClient) return;
      try {
        // Get countdown timers from localStorage (only available in browser)
        if (typeof window === "undefined") return;
        let stored: string | null = null;
        try {
          stored = window.localStorage?.getItem(COUNTDOWN_STORAGE_KEY) ?? null;
        } catch (e) {
          // localStorage not available (SSR)
          return;
        }
        
        if (!stored) {
          setAutomationStatus(null);
          return;
        }

        const countdownTimers = JSON.parse(stored) as Record<string, number>;
        const currentTime = Date.now();
        
        // Check each series with an active countdown
        for (const [seriesIdStr, startTime] of Object.entries(countdownTimers)) {
          const seriesId = BigInt(seriesIdStr);
          const elapsed = currentTime - (startTime as number);
          const remaining = COUNTDOWN_DURATION - elapsed;

          // Only act if countdown is active (within 5 minutes)
          if (remaining > 0 && remaining <= COUNTDOWN_DURATION) {
            try {
              // Get series info
              const seriesInfo = await publicClient.readContract({
                address: LOTTERY_ADDRESS,
                abi: lotteryAbi,
                functionName: "getSeriesInfo",
                args: [seriesId],
              });

              // getSeriesInfo returns (totalTickets, sold) or (totalTickets, sold, drawExecuted, readyForDraw, winningTicketNumbers)
              const seriesInfoArray = seriesInfo as readonly unknown[];
              const totalTickets = Array.isArray(seriesInfoArray) && typeof seriesInfoArray[0] === "bigint" ? seriesInfoArray[0] : BigInt(0);
              const sold = Array.isArray(seriesInfoArray) && typeof seriesInfoArray[1] === "bigint" ? seriesInfoArray[1] : BigInt(0);
              const ticketsLeft = Number(totalTickets - sold);
              const salesPercent = totalTickets > BigInt(0) ? Number((sold * BigInt(100)) / totalTickets) : 0;

              // Auto-buy remaining tickets if in last 5 minutes and at 90%+
              if (salesPercent >= 90 && ticketsLeft > 0 && ticketsLeft <= 10) {
                setAutomationStatus(`Auto-buying ${ticketsLeft} remaining tickets for Series ${seriesIdStr}...`);

                // Get ticket numbers that need to be bought
                const ticketNumbers: bigint[] = [];
                for (let i = 1; i <= Number(totalTickets); i++) {
                  const ticketId = (seriesId << BigInt(128)) | BigInt(i);
                  try {
                    const owner = await publicClient.readContract({
                      address: LOTTERY_ADDRESS,
                      abi: lotteryAbi,
                      functionName: "ticketOwners",
                      args: [ticketId],
                    }) as Address;
                    
                    if (owner === "0x0000000000000000000000000000000000000000") {
                      ticketNumbers.push(BigInt(i));
                      if (ticketNumbers.length >= ticketsLeft) break;
                    }
                  } catch (e) {
                    // Ticket not sold yet
                    ticketNumbers.push(BigInt(i));
                    if (ticketNumbers.length >= ticketsLeft) break;
                  }
                }

                if (ticketNumbers.length > 0) {
                  // Check USDT balance and allowance
                  const adminBalance = await publicClient.readContract({
                    address: USDT_ADDRESS,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [adminAccount.address],
                  }) as bigint;

                  const totalCost = ticketPriceRaw * BigInt(ticketNumbers.length);
                  
                  if (adminBalance < totalCost) {
                    setAutomationStatus(`Insufficient USDT balance. Need ${formatUnits(totalCost, decimals)} USDT`);
                    continue;
                  }

                  // Check and approve if needed
                  const allowance = await publicClient.readContract({
                    address: USDT_ADDRESS,
                    abi: erc20Abi,
                    functionName: "allowance",
                    args: [adminAccount.address, LOTTERY_ADDRESS],
                  }) as bigint;

                  if (allowance < totalCost) {
                    setAutomationStatus(`Approving USDT...`);
                    // Approve 10000x the purchase amount so admin doesn't need to approve again
                    const approveAmount = totalCost * BigInt(10000);
                    const approveHash = await walletClient.writeContract({
                      account: adminAccount,
                      chain: bscTestnet,
                      address: USDT_ADDRESS,
                      abi: erc20Abi,
                      functionName: "approve",
                      args: [LOTTERY_ADDRESS, approveAmount],
                    });
                    await publicClient.waitForTransactionReceipt({ hash: approveHash });
                  }

                  // Buy remaining tickets
                  setAutomationStatus(`Buying ${ticketNumbers.length} tickets for Series ${seriesIdStr}...`);
                  const buyHash = await walletClient.writeContract({
                    account: adminAccount,
                    chain: bscTestnet,
                    address: LOTTERY_ADDRESS,
                    abi: lotteryAbi,
                    functionName: "buyTicketsAt",
                    args: [seriesId, ticketNumbers],
                  });
                  
                  await publicClient.waitForTransactionReceipt({ hash: buyHash });
                  setAutomationStatus(`Successfully bought ${ticketNumbers.length} tickets for Series ${seriesIdStr}!`);
                  
                  // Wait a bit for the transaction to be processed, then check if we can execute draw
                  await new Promise(resolve => setTimeout(resolve, 3000));
                  
                  // After buying tickets, check if we have >= 90 tickets sold and execute draw
                  try {
                    // Re-check series info after purchase
                    const updatedSeriesInfo = await publicClient.readContract({
                      address: LOTTERY_ADDRESS,
                      abi: lotteryAbi,
                      functionName: "getSeriesInfo",
                      args: [seriesId],
                    });
                    
                    const updatedArray = updatedSeriesInfo as readonly unknown[];
                    const updatedSold = Array.isArray(updatedArray) && typeof updatedArray[1] === "bigint" ? updatedArray[1] : BigInt(0);
                    
                    // Check if we have at least 90 tickets sold (DRAW_THRESHOLD)
                    if (updatedSold >= BigInt(90)) {
                      setAutomationStatus(`Series ${seriesIdStr} has 90+ tickets sold. Executing auto-draw...`);
                      
                      try {
                        const executeDrawHash = await walletClient.writeContract({
                          account: adminAccount,
                          chain: bscTestnet,
                          address: LOTTERY_ADDRESS,
                          abi: lotteryAbi,
                          functionName: "executeDraw",
                          args: [seriesId],
                        });
                        
                        await publicClient.waitForTransactionReceipt({ hash: executeDrawHash });
                        setAutomationStatus(`✅ Auto-draw executed successfully for Series ${seriesIdStr}!`);
                        
                        // Remove from countdown timers
                        delete countdownTimers[seriesIdStr];
                        if (typeof window !== "undefined" && window.localStorage) {
                          if (Object.keys(countdownTimers).length === 0) {
                            window.localStorage.removeItem(COUNTDOWN_STORAGE_KEY);
                          } else {
                            window.localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(countdownTimers));
                          }
                        }
                      } catch (drawError: any) {
                        // Check if draw was already executed
                        if (drawError.message?.includes("DrawAlreadyExecuted") || drawError.message?.includes("draw already executed")) {
                          setAutomationStatus(`Series ${seriesIdStr} draw was already executed.`);
                        } else {
                          console.error("Auto-draw error:", drawError);
                          setAutomationStatus(`Draw execution error: ${formatError(drawError)}`);
                        }
                      }
                    }
                  } catch (error) {
                    console.error("Error checking series after purchase:", error);
                  }
                }
              }

              // Also check if countdown expired and we're at 90%+ - execute draw if not already done
              if (remaining <= 0 && remaining > -60000) { // Within 1 minute after countdown expires
                try {
                  // Check if we have at least 90 tickets sold
                  if (sold >= BigInt(90)) {
                    setAutomationStatus(`Countdown expired for Series ${seriesIdStr}. Executing auto-draw...`);
                    
                    try {
                      const executeDrawHash = await walletClient.writeContract({
                        account: adminAccount,
                        chain: bscTestnet,
                        address: LOTTERY_ADDRESS,
                        abi: lotteryAbi,
                        functionName: "executeDraw",
                        args: [seriesId],
                      });
                      
                      await publicClient.waitForTransactionReceipt({ hash: executeDrawHash });
                      setAutomationStatus(`✅ Auto-draw executed successfully for Series ${seriesIdStr}!`);
                      
                      // Remove from countdown timers
                      delete countdownTimers[seriesIdStr];
                      if (typeof window !== "undefined" && window.localStorage) {
                        if (Object.keys(countdownTimers).length === 0) {
                          window.localStorage.removeItem(COUNTDOWN_STORAGE_KEY);
                        } else {
                          window.localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(countdownTimers));
                        }
                      }
                    } catch (drawError: any) {
                      // Check if draw was already executed
                      if (drawError.message?.includes("DrawAlreadyExecuted") || drawError.message?.includes("draw already executed")) {
                        setAutomationStatus(`Series ${seriesIdStr} draw was already executed.`);
                        // Remove from countdown timers anyway
                        delete countdownTimers[seriesIdStr];
                        if (typeof window !== "undefined" && window.localStorage) {
                          if (Object.keys(countdownTimers).length === 0) {
                            window.localStorage.removeItem(COUNTDOWN_STORAGE_KEY);
                          } else {
                            window.localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(countdownTimers));
                          }
                        }
                      } else {
                        console.error("Auto-draw error:", drawError);
                        setAutomationStatus(`Draw execution error: ${formatError(drawError)}`);
                      }
                    }
                  }
                } catch (error) {
                  console.error(`Error processing expired countdown for series ${seriesIdStr}:`, error);
                }
              }
            } catch (error) {
              console.error(`Error processing series ${seriesIdStr}:`, error);
              setAutomationStatus(`Error: ${formatError(error)}`);
            }
          }
        }
        } catch (error) {
          console.error("Automation error:", error);
          setAutomationStatus(`Automation error: ${formatError(error)}`);
        }
      };

    const initializeAutomation = async () => {
      if (!isMounted || !LOTTERY_ADDRESS || !USDT_ADDRESS || !publicClient) return;

      // Create admin wallet client
      try {
        adminAccount = privateKeyToAccount(ADMIN_PRIVATE_KEY);
        walletClient = createWalletClient({
          account: adminAccount,
          chain: bscTestnet,
          transport: http(process.env.NEXT_PUBLIC_BSC_RPC_URL ?? "https://bsc-testnet.drpc.org"),
        });
      } catch (error) {
        console.error("Failed to create admin wallet:", error);
        adminAccount = null;
        walletClient = null;
        return;
      }

      // Check every 10 seconds
      automationIntervalRef.current = setInterval(() => {
        if (isMounted && adminAccount && walletClient) {
          checkAndAutomate();
        }
      }, 10_000);
      
      // Initial check after a small delay to ensure wallet is initialized
      setTimeout(() => {
        if (isMounted && adminAccount && walletClient) {
          checkAndAutomate();
        }
      }, 2000);
    };

    // Initialize after a small delay to ensure we're in the browser
    const timeoutId = setTimeout(() => {
      if (isMounted) initializeAutomation();
    }, 100);

    return () => {
      isMounted = false;
      if (automationIntervalRef.current) {
        clearInterval(automationIntervalRef.current);
      }
      clearTimeout(timeoutId);
    };
  }, [LOTTERY_ADDRESS, USDT_ADDRESS, publicClient, ticketPriceRaw, decimals]);

  const handleAction = async (action: Exclude<FlowState, "idle">) => {
    if (!isOwner) {
      setStatusMessage("Only the lottery owner can trigger draws or rewards.");
      return;
    }

    if (!LOTTERY_ADDRESS) {
      setStatusMessage("Lottery contract address not configured.");
      return;
    }

    let seriesId: bigint;
    
    if (action === "draw") {
      if (!drawSeriesId || drawSeriesId.trim() === "") {
        setStatusMessage("Please enter a Series ID for the draw.");
        setDrawSeriesIdError("Series ID is required.");
        return;
      }
      if (!validateSeriesId(drawSeriesId, setDrawSeriesIdError)) {
        setStatusMessage(drawSeriesIdError || "Invalid Series ID.");
        return;
      }
      try {
        seriesId = BigInt(drawSeriesId.trim());
      } catch (error) {
        setStatusMessage("Invalid Series ID. Please enter a valid number.");
        setDrawSeriesIdError("Invalid Series ID format.");
        return;
      }
    } else {
      if (!distributeSeriesId || distributeSeriesId.trim() === "") {
        setStatusMessage("Please enter a Series ID for reward distribution.");
        setDistributeSeriesIdError("Series ID is required.");
        return;
      }
      if (!validateSeriesId(distributeSeriesId, setDistributeSeriesIdError)) {
        setStatusMessage(distributeSeriesIdError || "Invalid Series ID.");
        return;
      }
      try {
        seriesId = BigInt(distributeSeriesId.trim());
      } catch (error) {
        setStatusMessage("Invalid Series ID. Please enter a valid number.");
        setDistributeSeriesIdError("Invalid Series ID format.");
        return;
      }
    }

    setFlowState(action);
    setStatusMessage(null);

    try {
      if (action === "draw") {
        setStatusMessage(`Executing draw for Series ${seriesId.toString()}...`);
        const hash = await writeContractAsync({
          address: LOTTERY_ADDRESS,
          abi: lotteryAbi,
          functionName: "executeDraw",
          args: [seriesId],
        });

        await waitForTransactionReceipt(wagmiConfig, {
          hash,
        });

        setStatusMessage(`✅ Draw executed successfully for Series ${seriesId.toString()}!`);
        setDrawSeriesId("");
      } else {
        setStatusMessage(`Distributing rewards for Series ${seriesId.toString()}...`);
        const hash = await writeContractAsync({
          address: LOTTERY_ADDRESS,
          abi: lotteryAbi,
          functionName: "distributeRewards",
          args: [seriesId],
        });

        await waitForTransactionReceipt(wagmiConfig, {
          hash,
        });

        setStatusMessage(`✅ Rewards distributed successfully for Series ${seriesId.toString()}!`);
        setDistributeSeriesId("");
      }
    } catch (error) {
      setStatusMessage(`Error: ${formatError(error)}`);
    } finally {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setFlowState("idle");
        setStatusMessage(null);
      }, 5000);
    }
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
            {/* Clock section commented out */}
            {/* <div className={styles.countdownCard}>
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
            </div> */}
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Current prize pool</span>
              <span className={styles.statValue}>{formattedPot} USDT</span>
              <span className={styles.statHint}>
                Calculated from ticket sales · auto-refreshing
              </span>
            </div>
            <div className={styles.statRow}>
              <div className={styles.statMicro} style={{ gridColumn: "1 / -1" }}>
                <span className={styles.microLabel}>Select Active Series</span>
                <select
                  value={selectedSeriesId?.toString() || ""}
                  onChange={(e) => {
                    const seriesId = BigInt(e.target.value);
                    setSelectedSeriesId(seriesId);
                  }}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: "1px solid rgba(255, 255, 255, 0.1)",
                    background: "rgba(0, 0, 0, 0.3)",
                    color: "white",
                    fontSize: "0.9rem",
                    marginTop: "8px",
                    cursor: "pointer",
                  }}
                >
                  {allSeriesData.length === 0 ? (
                    <option value="">No active series</option>
                  ) : (
                    allSeriesData.map((series) => (
                      <option key={series.seriesId.toString()} value={series.seriesId.toString()}>
                        Series {formatSeriesName(series.seriesId)} - {series.ticketsLeft} tickets left ({Number((series.sold * BigInt(100)) / series.total)}% sold)
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className={styles.statMicro}>
                <span className={styles.microLabel}>Active series</span>
                <span className={styles.microValue}>
                  {hasActiveSeries && selectedSeries ? formatSeriesName(selectedSeries.seriesId) : "None"}
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
          {isOwner ? (
            <>
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
              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", marginBottom: "8px", fontSize: "0.9rem", color: "rgba(255, 255, 255, 0.8)" }}>
                  Series ID:
                </label>
                <input
                  type="number"
                  min="1"
                  max={maxSeriesId}
                  value={drawSeriesId}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Prevent typing numbers higher than maxSeriesId
                    if (value === "" || (Number(value) >= 1 && Number(value) <= maxSeriesId)) {
                      handleDrawSeriesIdChange(value);
                    }
                  }}
                  placeholder={`Enter Series ID (1-${maxSeriesId})`}
                  disabled={flowState !== "idle" || maxSeriesId === 0}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: drawSeriesIdError 
                      ? "1px solid rgba(239, 68, 68, 0.8)" 
                      : "1px solid rgba(255, 255, 255, 0.1)",
                    background: "rgba(0, 0, 0, 0.3)",
                    color: "white",
                    fontSize: "0.95rem",
                    outline: "none",
                  }}
                />
                {drawSeriesIdError && (
                  <div style={{
                    marginTop: "6px",
                    fontSize: "0.85rem",
                    color: "rgba(239, 68, 68, 0.9)",
                  }}>
                    {drawSeriesIdError}
                  </div>
                )}
                {maxSeriesId > 0 && !drawSeriesIdError && (
                  <div style={{
                    marginTop: "6px",
                    fontSize: "0.8rem",
                    color: "rgba(255, 255, 255, 0.5)",
                  }}>
                    Active series: {activeSeriesIds.map(id => id.toString()).join(", ")}
                  </div>
                )}
              </div>
              <button
                className={styles.actionButton}
                onClick={() => handleAction("draw")}
                disabled={flowState !== "idle"}
              >
                {flowState === "draw" ? "Preparing..." : "Execute draw"}
              </button>
            </div>
            <div className={styles.actionCard}>
              <h3>2. Distribute rewards</h3>
              <p>
                Transfer the accumulated USDT pot to the winner and broadcast an
                on-chain receipt. The `Withdraw` event feeds directly into the
                history log.
              </p>
              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", marginBottom: "8px", fontSize: "0.9rem", color: "rgba(255, 255, 255, 0.8)" }}>
                  Series ID:
                </label>
                <input
                  type="number"
                  min="1"
                  max={maxSeriesId}
                  value={distributeSeriesId}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Prevent typing numbers higher than maxSeriesId
                    if (value === "" || (Number(value) >= 1 && Number(value) <= maxSeriesId)) {
                      handleDistributeSeriesIdChange(value);
                    }
                  }}
                  placeholder={`Enter Series ID (1-${maxSeriesId})`}
                  disabled={flowState !== "idle" || maxSeriesId === 0}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: distributeSeriesIdError 
                      ? "1px solid rgba(239, 68, 68, 0.8)" 
                      : "1px solid rgba(255, 255, 255, 0.1)",
                    background: "rgba(0, 0, 0, 0.3)",
                    color: "white",
                    fontSize: "0.95rem",
                    outline: "none",
                  }}
                />
                {distributeSeriesIdError && (
                  <div style={{
                    marginTop: "6px",
                    fontSize: "0.85rem",
                    color: "rgba(239, 68, 68, 0.9)",
                  }}>
                    {distributeSeriesIdError}
                  </div>
                )}
                {maxSeriesId > 0 && !distributeSeriesIdError && (
                  <div style={{
                    marginTop: "6px",
                    fontSize: "0.8rem",
                    color: "rgba(255, 255, 255, 0.5)",
                  }}>
                    Active series: {activeSeriesIds.map(id => id.toString()).join(", ")}
                  </div>
                )}
              </div>
              <button
                className={styles.actionButtonSecondary}
                onClick={() => handleAction("distribute")}
                disabled={flowState !== "idle"}
              >
                {flowState === "distribute"
                  ? "Routing funds..."
                  : "Distribute Rewards"}
              </button>
            </div>
          </div>
          {statusMessage && (
            <div className={styles.statusBanner}>{statusMessage}</div>
          )}
            {automationStatus && (
              <div className={styles.automationBanner}>
                🤖 <strong>Auto-Bot Status:</strong> {automationStatus}
          </div>
            )}
            </>
          ) : (
            <div style={{
              padding: "40px 20px",
              textAlign: "center",
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: "16px",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}>
              <h3 style={{
                fontSize: "1.2rem",
                marginBottom: "12px",
                color: "rgba(255, 255, 255, 0.9)",
              }}>
                Owner Access Required
              </h3>
              <p style={{
                fontSize: "0.95rem",
                color: "rgba(255, 255, 255, 0.6)",
                lineHeight: "1.6",
              }}>
                Only the contract owner can access draw and reward distribution functions.
                <br />
                Please connect with the owner wallet to continue.
              </p>
            </div>
          )}
        </motion.section>
      </main>
    </div>
  );
}

