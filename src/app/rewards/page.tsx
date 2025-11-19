"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { lotteryAbi } from "@/lib/abi/lottery";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import { formatSeriesName } from "@/lib/seriesUtils";
import styles from "./rewards.module.css";

const SERIES_PER_PAGE = 5;

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;
const REWARD_PER_WINNER = 1; // $1 per winner
const REWARD_PERCENTAGE = 0.1; // 10% of tickets get rewards

type SeriesRewardInfo = {
  seriesId: bigint;
  totalTickets: bigint;
  ticketsSold: bigint;
  rewardCount: number;
  totalRewardPool: number;
  userTickets: number;
  userPotentialRewards: number;
  isActive: boolean;
  isCompleted: boolean;
};

const extractSeriesAndNumber = (ticketId: bigint): { seriesId: bigint; ticketNumber: bigint } => {
  const seriesId = ticketId >> BigInt(128);
  const ticketNumber = ticketId & ((BigInt(1) << BigInt(128)) - BigInt(1));
  return { seriesId, ticketNumber };
};

const calculateRewards = (ticketsSold: bigint, totalTickets: bigint): { count: number; pool: number } => {
  const sold = Number(ticketsSold);
  const total = Number(totalTickets);
  const pool = sold > 0 ? sold : total;
  
  // 10% of tickets get rewards, minimum 10 winners
  const rewardCount = Math.max(10, Math.floor(pool * REWARD_PERCENTAGE));
  const totalRewardPool = rewardCount * REWARD_PER_WINNER;
  
  return { count: rewardCount, pool: totalRewardPool };
};

export default function RewardsPage() {
  const { address, isConnected } = useAccount();
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedSeries, setExpandedSeries] = useState<Set<bigint>>(new Set());

  const { data: activeSeriesIdData } = useReadContract({
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

  const { data: ownedTicketIds } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "getOwnedTicketIds",
    args: [address ?? zeroAddress],
    query: {
      enabled: Boolean(LOTTERY_ADDRESS && isConnected && address),
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

  const userTicketsBySeries = useMemo(() => {
    if (!ownedTicketIds || !Array.isArray(ownedTicketIds)) return new Map<bigint, number>();
    
    const grouped = new Map<bigint, number>();
    (ownedTicketIds as bigint[]).forEach((ticketId) => {
      const { seriesId } = extractSeriesAndNumber(ticketId);
      grouped.set(seriesId, (grouped.get(seriesId) || 0) + 1);
    });
    
    return grouped;
  }, [ownedTicketIds]);

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

  const { data: seriesInfoData } = useReadContracts({
    contracts: seriesInfoContracts,
    query: {
      enabled: seriesInfoContracts.length > 0,
    },
  });

  const seriesRewards: SeriesRewardInfo[] = useMemo(() => {
    if (!seriesInfoData) return [];

    return seriesIds.map((seriesId, index) => {
      const info = seriesInfoData[index];
      let totalTickets = BigInt(0);
      let ticketsSold = BigInt(0);

      if (info?.status === "success" && info.result) {
        const tuple = info.result as ReadonlyArray<unknown> & {
          totalTickets?: bigint;
          ticketsSold?: bigint;
        };
        totalTickets =
          typeof tuple.totalTickets === "bigint"
            ? tuple.totalTickets
            : (Array.isArray(tuple) && typeof tuple[0] === "bigint" ? tuple[0] : BigInt(0));
        ticketsSold =
          typeof tuple.ticketsSold === "bigint"
            ? tuple.ticketsSold
            : (Array.isArray(tuple) && typeof tuple[1] === "bigint" ? tuple[1] : BigInt(0));
      }

      const { count: rewardCount, pool: totalRewardPool } = calculateRewards(ticketsSold, totalTickets);
      const userTickets = userTicketsBySeries.get(seriesId) || 0;
      
      // Calculate potential rewards: if user owns all tickets, they can win all rewards
      // Otherwise, it's proportional to their ticket ownership
      const totalPool = Number(ticketsSold > 0 ? ticketsSold : totalTickets);
      const userPotentialRewards = totalPool > 0 
        ? Math.min(rewardCount, Math.floor((userTickets / totalPool) * rewardCount))
        : 0;

      const isActive = seriesId === activeSeriesId;
      const isCompleted = totalTickets > BigInt(0) && ticketsSold === totalTickets;

      return {
        seriesId,
        totalTickets,
        ticketsSold,
        rewardCount,
        totalRewardPool,
        userTickets,
        userPotentialRewards,
        isActive,
        isCompleted,
      };
    }).sort((a, b) => {
      // Sort: active first, then by series ID (newest first)
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.seriesId > b.seriesId) return -1;
      if (a.seriesId < b.seriesId) return 1;
      return 0;
    });
  }, [seriesIds, seriesInfoData, userTicketsBySeries, activeSeriesId]);

  const totalPotentialRewards = useMemo(() => {
    return seriesRewards.reduce((sum, series) => sum + series.userPotentialRewards * REWARD_PER_WINNER, 0);
  }, [seriesRewards]);

  const totalRewardPool = useMemo(() => {
    return seriesRewards.reduce((sum, series) => sum + series.totalRewardPool, 0);
  }, [seriesRewards]);

  const totalPages = useMemo(() => {
    return Math.ceil(seriesRewards.length / SERIES_PER_PAGE);
  }, [seriesRewards.length]);

  const paginatedSeries = useMemo(() => {
    const startIndex = (currentPage - 1) * SERIES_PER_PAGE;
    const endIndex = startIndex + SERIES_PER_PAGE;
    return seriesRewards.slice(startIndex, endIndex);
  }, [seriesRewards, currentPage]);

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

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={styles.page}>
      <GlowingOrbs />
      <main className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Rewards & Prizes</h1>
            <p className={styles.subtitle}>
              Win $1 per reward slot. 10% of tickets in each series win rewards, with a minimum of 10 winners per series.
            </p>
          </div>
          {isConnected && (
            <div className={styles.headerStats}>
              <div className={styles.statCard}>
                <span className={styles.statLabel}>Your Potential</span>
                <span className={styles.statValue}>${totalPotentialRewards.toFixed(2)}</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statLabel}>Total Pool</span>
                <span className={styles.statValue}>${totalRewardPool.toFixed(2)}</span>
              </div>
            </div>
          )}
        </header>

        <section className={styles.infoSection}>
          <h2 className={styles.sectionTitle}>How Rewards Work</h2>
          <div className={styles.infoGrid}>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>💰</div>
              <h3 className={styles.infoTitle}>Reward Amount</h3>
              <p className={styles.infoText}>
                Each winner receives <strong>$1 USDT</strong> per reward slot
              </p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>📊</div>
              <h3 className={styles.infoTitle}>Distribution</h3>
              <p className={styles.infoText}>
                <strong>10% of tickets</strong> in each series win rewards, with a minimum of <strong>10 winners</strong> per series
              </p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🎯</div>
              <h3 className={styles.infoTitle}>Your Chances</h3>
              <p className={styles.infoText}>
                If you own all tickets in a series, you can win <strong>all rewards</strong> for that series
              </p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>📈</div>
              <h3 className={styles.infoTitle}>Example</h3>
              <p className={styles.infoText}>
                If 200 tickets are sold, <strong>20 people</strong> win $1 each (10% of 200)
              </p>
            </div>
          </div>
        </section>

        <section className={styles.seriesSection}>
          <h2 className={styles.sectionTitle}>Series Rewards</h2>
          {seriesRewards.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyMessage}>
                No series data available yet. Series will appear here once they are created.
              </p>
            </div>
          ) : (
            <>
              <div className={styles.seriesList}>
                {paginatedSeries.map((series, index) => {
                  const isExpanded = expandedSeries.has(series.seriesId);
                  const globalIndex = (currentPage - 1) * SERIES_PER_PAGE + index;
                  
                  return (
                    <motion.div
                      key={series.seriesId.toString()}
                      className={`${styles.seriesCard} ${series.isActive ? styles.seriesCardActive : ""} ${series.isCompleted ? styles.seriesCardCompleted : ""}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                    >
                      <div 
                        className={styles.seriesHeader}
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
                        <div className={styles.seriesTitleRow}>
                          <h3 className={styles.seriesTitle}>
                            Series {formatSeriesName(series.seriesId)}
                          </h3>
                          <div className={styles.seriesHeaderRight}>
                            <div className={styles.seriesBadges}>
                              {series.isActive && (
                                <span className={styles.activeBadge}>Active</span>
                              )}
                              {series.isCompleted && (
                                <span className={styles.completedBadge}>Completed</span>
                              )}
                            </div>
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
                        </div>
                        <div className={styles.seriesSummary}>
                          <span className={styles.summaryText}>
                            {series.rewardCount} winners · ${series.totalRewardPool.toFixed(2)} pool
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
                            <div className={styles.seriesStats}>
                              <div className={styles.statRow}>
                                <span className={styles.statLabel}>Tickets Sold</span>
                                <span className={styles.statValue}>
                                  {series.ticketsSold.toLocaleString()} / {series.totalTickets.toLocaleString()}
                                </span>
                              </div>
                              <div className={styles.statRow}>
                                <span className={styles.statLabel}>Reward Winners</span>
                                <span className={styles.statValue}>{series.rewardCount} winners</span>
                              </div>
                              <div className={styles.statRow}>
                                <span className={styles.statLabel}>Total Reward Pool</span>
                                <span className={styles.statValue}>${series.totalRewardPool.toFixed(2)}</span>
                              </div>
                              {isConnected && series.userTickets > 0 && (
                                <>
                                  <div className={styles.statDivider} />
                                  <div className={styles.statRow}>
                                    <span className={styles.statLabel}>Your Tickets</span>
                                    <span className={styles.statValue}>{series.userTickets}</span>
                                  </div>
                                  <div className={styles.statRow}>
                                    <span className={styles.statLabel}>Your Potential Rewards</span>
                                    <span className={`${styles.statValue} ${styles.highlightValue}`}>
                                      ${(series.userPotentialRewards * REWARD_PER_WINNER).toFixed(2)}
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className={styles.pagination}>
                  <button
                    className={styles.paginationButton}
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                  >
                    ← Previous
                  </button>
                  <div className={styles.paginationPages}>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                      <button
                        key={page}
                        className={`${styles.paginationPage} ${currentPage === page ? styles.paginationPageActive : ""}`}
                        onClick={() => handlePageChange(page)}
                      >
                        {page}
                      </button>
                    ))}
                  </div>
                  <button
                    className={styles.paginationButton}
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage === totalPages}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <div className={styles.footer}>
          <Link href="/" className={styles.backLink}>
            ← Back to Home
          </Link>
          {isConnected && (
            <Link href="/my-tickets" className={styles.secondaryLink}>
              My Tickets
            </Link>
          )}
          <Link href="/tickets" className={styles.secondaryLink}>
            Browse Tickets
          </Link>
        </div>
      </main>
    </div>
  );
}

