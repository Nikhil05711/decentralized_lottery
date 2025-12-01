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
  createWalletClient,
  formatUnits,
  http,
  parseAbiItem,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import styles from "./draw.module.css";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { lotteryAbi } from "@/lib/abi/lottery";
import { erc20Abi } from "@/lib/abi/erc20";
import { formatSeriesName, formatTicketNumber } from "@/lib/seriesUtils";

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

  // Note: activeSeriesId doesn't exist in the contract
  // We'll monitor all series from localStorage countdown timers instead
  const activeSeriesId = BigInt(0); // Placeholder - not used for automation

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
    // Return empty for now - automation monitors from localStorage instead
    return { total: BigInt(0), sold: BigInt(0) };
  }, []);

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
    // Use active series ID for formatting (lastDrawTicket is just the ticket number)
    if (activeSeriesId > BigInt(0)) {
      return `Ticket ${formatTicketNumber(lastDrawTicket, activeSeriesId, ticketPadLength)}`;
    }
    return `Ticket #${lastDrawTicket.toString().padStart(ticketPadLength, "0")}`;
  }, [lastDrawTicket, ticketPadLength, activeSeriesId]);

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
    if (typeof window === "undefined" || typeof document === "undefined") return;
    
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
                  {hasActiveSeries ? formatSeriesName(activeSeriesId) : "None"}
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
          {automationStatus && (
            <div className={styles.automationBanner}>
              🤖 <strong>Auto-Bot Status:</strong> {automationStatus}
            </div>
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

