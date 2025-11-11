const envTotalTickets = Number(process.env.NEXT_PUBLIC_TOTAL_TICKETS);

export const TOTAL_TICKETS =
  Number.isFinite(envTotalTickets) && envTotalTickets > 0
    ? Math.floor(envTotalTickets)
    : 100;

