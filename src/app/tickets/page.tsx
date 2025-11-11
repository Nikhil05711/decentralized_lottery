"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion } from "framer-motion";
import { useReadContract } from "wagmi";
import { lotteryAbi } from "@/lib/abi/lottery";
import { GlowingOrbs } from "@/components/GlowingOrbs";
import styles from "./tickets.module.css";
import { TOTAL_TICKETS } from "@/lib/constants";

const LOTTERY_ADDRESS = process.env
  .NEXT_PUBLIC_LOTTERY_ADDRESS as `0x${string}` | undefined;

const clampToSafeNumber = (value: bigint | undefined) => {
  if (!value) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const safeValue = value > max ? max : value;
  return Number(safeValue);
};

export default function TicketsPage() {
  const { data: ticketsSoldData } = useReadContract({
    address: LOTTERY_ADDRESS,
    abi: lotteryAbi,
    functionName: "ticketsSold",
    query: {
      enabled: Boolean(LOTTERY_ADDRESS),
      refetchInterval: 20_000,
    },
  });

  const ticketsSold = useMemo(
    () =>
      clampToSafeNumber(
        typeof ticketsSoldData === "bigint"
          ? ticketsSoldData
          : typeof ticketsSoldData === "number"
          ? BigInt(ticketsSoldData)
          : undefined
      ),
    [ticketsSoldData]
  );

  const tickets = useMemo(() => {
    const soldCount = Math.min(ticketsSold, TOTAL_TICKETS);
    return Array.from({ length: TOTAL_TICKETS }, (_, index) => {
      const number = index + 1;
      const isSold = number <= soldCount;
      return { number, isSold };
    });
  }, [ticketsSold]);

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
            </p>
          </div>
          <div className={styles.ctaGroup}>
            <Link href="/" className={styles.primaryLink}>
              Back to purchase
            </Link>
            <div className={styles.stats}>
              <span>
                Sold: <strong>{ticketsSold}</strong>
              </span>
              <span>
                Remaining:{" "}
                <strong>{Math.max(TOTAL_TICKETS - ticketsSold, 0)}</strong>
              </span>
              <span>
                Total: <strong>{TOTAL_TICKETS}</strong>
              </span>
            </div>
          </div>
        </header>

        <section className={styles.grid}>
          {tickets.map((ticket) => (
            <motion.div
              key={ticket.number}
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
                Ticket #{ticket.number.toString().padStart(3, "0")}
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
      </main>
    </div>
  );
}

