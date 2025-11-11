"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion } from "framer-motion";
import { useReadContract } from "wagmi";
import { lotteryAbi } from "@/lib/abi/lottery";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import styles from "./tickets.module.css";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;

const clampToSafeNumber = (value: bigint | number | undefined) => {
  if (typeof value === "number") return value;
  if (typeof value !== "bigint") return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const safeValue = value > max ? max : value;
  return Number(safeValue);
};

export default function TicketsPage() {
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

  const totalTickets = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.total),
    [activeSeriesTotals]
  );

  const soldTickets = useMemo(
    () => clampToSafeNumber(activeSeriesTotals.sold),
    [activeSeriesTotals]
  );

  const ticketsLeft = useMemo(
    () => Math.max(totalTickets - soldTickets, 0),
    [soldTickets, totalTickets]
  );

  const tickets = useMemo(() => {
    if (totalTickets <= 0) return [];
    return Array.from({ length: totalTickets }, (_, index) => {
      const number = index + 1;
      const isSold = index < soldTickets;
      return { number, isSold };
    });
  }, [soldTickets, totalTickets]);

  const hasActiveSeries = useMemo(
    () => activeSeriesId > BigInt(0),
    [activeSeriesId]
  );

  const activeSeriesLabel = useMemo(
    () => (hasActiveSeries ? `Series #${activeSeriesId.toString()}` : "No active series"),
    [activeSeriesId, hasActiveSeries]
  );

  const salesOpen = useMemo(
    () => hasActiveSeries && soldTickets < totalTickets,
    [hasActiveSeries, soldTickets, totalTickets]
  );

  const padLength = useMemo(
    () => Math.max(String(totalTickets || 0).length, 3),
    [totalTickets]
  );

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
            <Link href="/" className={styles.primaryLink}>
              Back to purchase
            </Link>
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

        {tickets.length === 0 ? (
          <div className={styles.subtitle}>
            No tickets to display yet. Queue and activate the next series to
            populate the board.
          </div>
        ) : (
          <section className={styles.grid}>
            {tickets.map((ticket) => (
              <motion.div
                key={`${activeSeriesLabel}-${ticket.number}`}
                className={`${styles.ticket} ${
                  ticket.isSold ? styles.ticketSold : styles.ticketAvailable
                }`}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{
                  duration: 0.4,
                  delay: ticket.number * 0.005,
                  ease: "easeOut",
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
                  {ticket.isSold ? "SOLD" : "AVAILABLE"}
                </span>
              </motion.div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

