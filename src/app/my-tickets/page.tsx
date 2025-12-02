"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { lotteryAbi } from "@/lib/abi/lottery";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { formatSeriesName, formatTicketNumber, getSeriesCode } from "@/lib/seriesUtils";
import styles from "./my-tickets.module.css";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;

type TicketInfo = {
  ticketId: bigint;
  seriesId: bigint;
  ticketNumber: bigint;
};

type SeriesGroup = {
  seriesId: bigint;
  tickets: TicketInfo[];
  totalTickets: bigint;
  ticketsSold: bigint;
};

const extractSeriesAndNumber = (ticketId: bigint): { seriesId: bigint; ticketNumber: bigint } => {
  const seriesId = ticketId >> BigInt(128);
  const ticketNumber = ticketId & ((BigInt(1) << BigInt(128)) - BigInt(1));
  return { seriesId, ticketNumber };
};

export default function MyTicketsPage() {
  const { address, isConnected } = useAccount();
  const [expandedSeries, setExpandedSeries] = useState<Set<bigint>>(new Set());
  const [clickedTicket, setClickedTicket] = useState<bigint | null>(null);

  const { data: ownedTicketIds, refetch: refetchOwnedTickets } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "getOwnedTicketIds",
    args: [address ?? zeroAddress],
    query: {
      enabled: Boolean(LOTTERY_ADDRESS && isConnected && address),
      refetchInterval: 20_000,
    },
  });

  const ticketIds = useMemo(() => {
    if (!ownedTicketIds || !Array.isArray(ownedTicketIds)) return [];
    return ownedTicketIds as bigint[];
  }, [ownedTicketIds]);

  const ticketsBySeries = useMemo(() => {
    const grouped = new Map<bigint, TicketInfo[]>();
    
    ticketIds.forEach((ticketId) => {
      const { seriesId, ticketNumber } = extractSeriesAndNumber(ticketId);
      if (!grouped.has(seriesId)) {
        grouped.set(seriesId, []);
      }
      grouped.get(seriesId)!.push({ ticketId, seriesId, ticketNumber });
    });

    return grouped;
  }, [ticketIds]);

  const seriesIds = useMemo(() => {
    return Array.from(ticketsBySeries.keys()).sort((a, b) => {
      // Sort alphabetically by series code (AA, AB, AC, ..., AAA, AAB, etc.)
      const codeA = getSeriesCode(a);
      const codeB = getSeriesCode(b);
      return codeA.localeCompare(codeB);
    });
  }, [ticketsBySeries]);

  const seriesInfoContracts = useMemo(() => {
    if (!LOTTERY_ADDRESS || seriesIds.length === 0) return [];
    return seriesIds.map((seriesId) => ({
      address: LOTTERY_ADDRESS,
      abi: lotteryAbi,
      functionName: "getSeriesInfo" as const,
      args: [seriesId],
    }));
  }, [seriesIds]);

  const { data: seriesInfoData } = useReadContracts({
    contracts: seriesInfoContracts,
    query: {
      enabled: seriesInfoContracts.length > 0,
    },
  });

  const seriesGroups: SeriesGroup[] = useMemo(() => {
    if (!seriesInfoData) return [];

    return seriesIds.map((seriesId, index) => {
      const tickets = ticketsBySeries.get(seriesId) || [];
      const info = seriesInfoData[index];
      
      let totalTickets = BigInt(0);
      let ticketsSold = BigInt(0);

      if (info?.status === "success" && info.result) {
        // getSeriesInfo returns: (totalTickets, soldCount, drawExecuted, readyForDraw, winningTicketNumbers)
        // Handle the result safely without strict tuple typing
        const result = info.result;
        if (Array.isArray(result) && result.length >= 2) {
          const first = result[0];
          const second = result[1];
          if (typeof first === "bigint") {
            totalTickets = first;
          }
          if (typeof second === "bigint") {
            ticketsSold = second;
          }
        }
      }

      return {
        seriesId,
        tickets: tickets.sort((a, b) => {
          if (a.ticketNumber < b.ticketNumber) return -1;
          if (a.ticketNumber > b.ticketNumber) return 1;
          return 0;
        }),
        totalTickets,
        ticketsSold,
      };
    });
  }, [seriesIds, ticketsBySeries, seriesInfoData]);

  const totalTicketsOwned = useMemo(() => {
    return ticketIds.length;
  }, [ticketIds]);


  const toggleSeries = (seriesId: bigint) => {
    setExpandedSeries((prev) => {
      const next = new Set(prev);
      if (next.has(seriesId)) {
        next.delete(seriesId);
      } else {
        next.add(seriesId);
      }
      return next;
    });
  };

  const handleTicketClick = (ticketId: bigint) => {
    setClickedTicket(ticketId);
    setTimeout(() => setClickedTicket(null), 400);
  };

  if (!isConnected) {
    return (
      <div className={styles.page}>
        <GlowingOrbs />
        <main className={styles.container}>
          <header className={styles.header}>
            <h1 className={styles.title}>My Tickets</h1>
            <p className={styles.subtitle}>
              Connect your wallet to view your lottery tickets
            </p>
          </header>
          <div className={styles.emptyState}>
            <p className={styles.emptyMessage}>
              Please connect your wallet to see your tickets
            </p>
            <Link href="/" className={styles.backLink}>
              ← Back to Home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  if (totalTicketsOwned === 0) {
    return (
      <div className={styles.page}>
        <GlowingOrbs />
        <main className={styles.container}>
          <header className={styles.header}>
            <h1 className={styles.title}>My Tickets</h1>
            <p className={styles.subtitle}>
              You don&apos;t have any tickets yet
            </p>
          </header>
          <div className={styles.emptyState}>
            <p className={styles.emptyMessage}>
              Purchase tickets to see them here organized by series
            </p>
            <div className={styles.emptyActions}>
              <Link href="/" className={styles.primaryLink}>
                Buy Tickets
              </Link>
              <Link href="/tickets" className={styles.secondaryLink}>
                Browse Tickets
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <GlowingOrbs />
      <main className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>My Tickets</h1>
            <p className={styles.subtitle}>
              Your lottery tickets organized by series
            </p>
          </div>
          <div className={styles.headerStats}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Total Tickets</span>
              <span className={styles.statValue}>{totalTicketsOwned.toLocaleString()}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Series</span>
              <span className={styles.statValue}>{seriesGroups.length}</span>
            </div>
          </div>
        </header>

        <div className={styles.seriesList}>
          {seriesGroups.map((group, groupIndex) => {
            const isExpanded = expandedSeries.has(group.seriesId);
            const padLength = group.totalTickets.toString().length;
            
            return (
              <motion.div
                key={group.seriesId.toString()}
                className={styles.seriesCard}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: groupIndex * 0.1 }}
              >
                <div 
                  className={styles.seriesHeader}
                  onClick={() => toggleSeries(group.seriesId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleSeries(group.seriesId);
                    }
                  }}
                >
                  <div className={styles.seriesTitleRow}>
                    <h2 className={styles.seriesTitle}>
                      Series {formatSeriesName(group.seriesId)}
                    </h2>
                    <motion.div
                      className={styles.expandIcon}
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.3 }}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
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
                  <div className={styles.seriesMeta}>
                    <span className={styles.seriesCount}>
                      {group.tickets.length} ticket{group.tickets.length !== 1 ? "s" : ""}
                    </span>
                    <span className={styles.seriesProgress}>
                      {group.ticketsSold.toLocaleString()} / {group.totalTickets.toLocaleString()} sold
                    </span>
                  </div>
                </div>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: "easeInOut" }}
                      style={{ overflow: "hidden" }}
                    >
                      <div className={styles.ticketsGrid}>
                        {group.tickets.map((ticket, ticketIndex) => {
                          const isClicked = clickedTicket === ticket.ticketId;
                          return (
                            <motion.div
                              key={ticket.ticketId.toString()}
                              className={styles.ticketCard}
                              initial={{ opacity: 0, scale: 0.9 }}
                              animate={{ 
                                opacity: 1, 
                                scale: isClicked ? 0.3 : 1,
                              }}
                              transition={{ 
                                delay: ticketIndex * 0.02,
                                scale: { 
                                  duration: 0.4,
                                  ease: [0.4, 0, 0.2, 1]
                                }
                              }}
                              onClick={() => handleTicketClick(ticket.ticketId)}
                              whileHover={{ scale: 1.05, y: -4 }}
                              whileTap={{ scale: 0.9 }}
                            >
                              <span className={styles.ticketNumber}>
                                {formatTicketNumber(ticket.ticketNumber, ticket.seriesId, padLength)}
                              </span>
                              <span className={styles.ticketSeriesLabel}>
                                Series {formatSeriesName(group.seriesId)}
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
        </div>

        <div className={styles.footer}>
          <Link href="/" className={styles.backLink}>
            ← Back to Home
          </Link>
          <Link href="/tickets" className={styles.secondaryLink}>
            Browse All Tickets
          </Link>
        </div>
      </main>
    </div>
  );
}

