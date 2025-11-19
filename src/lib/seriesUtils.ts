/**
 * Converts a series ID to alphabetical format (AA, AB, AC... AZ, AAA... AAZ, ABA... ABZ, etc.)
 * and appends the series number at the end.
 * 
 * Pattern:
 * - Series 1-26: AA-1, AB-2, ..., AZ-26
 * - Series 27-52: AAA-27, AAB-28, ..., AAZ-52
 * - Series 53-78: ABA-53, ABB-54, ..., ABZ-78
 * - Series 79-104: ACA-79, ACB-80, ..., ACZ-104
 * - And so on...
 */
export function formatSeriesName(seriesId: bigint | number): string {
  const id = typeof seriesId === "bigint" ? Number(seriesId) : seriesId;
  
  if (id <= 0) {
    return `AA-${id}`;
  }

  let letters = "";
  
  if (id <= 26) {
    // 2 letters: AA to AZ (series 1-26)
    // AA = 1, AB = 2, ..., AZ = 26
    const letterIndex = id - 1; // 0-25
    const secondLetter = String.fromCharCode(65 + letterIndex); // A-Z
    letters = "A" + secondLetter;
  } else {
    // 3 letters: AAA onwards (series 27+)
    // AAA = 27, AAB = 28, ..., AAZ = 52
    // ABA = 53, ABB = 54, ..., ABZ = 78
    // ACA = 79, ACB = 80, ..., ACZ = 104
    // ...
    // AZA = 677, AZB = 678, ..., AZZ = 702
    // BAA = 703, BAB = 704, ..., BAZ = 728
    // ...
    
    const remaining = id - 27; // 0-based index for 3-letter codes
    
    // Calculate positions in the 3-letter grid
    // Each "row" (first letter) has 26*26 = 676 combinations
    // Each "column" (second letter) has 26 combinations
    // Each "position" (third letter) is 0-25
    
    const firstLetterIndex = Math.floor(remaining / (26 * 26)); // Which row (A, B, C, ...)
    const secondLetterIndex = Math.floor((remaining % (26 * 26)) / 26); // Which column (A-Z)
    const thirdLetterIndex = remaining % 26; // Which position (A-Z)
    
    const firstLetter = String.fromCharCode(65 + firstLetterIndex);
    const secondLetter = String.fromCharCode(65 + secondLetterIndex);
    const thirdLetter = String.fromCharCode(65 + thirdLetterIndex);
    
    letters = firstLetter + secondLetter + thirdLetter;
  }
  
  return `${letters}-${id}`;
}

/**
 * Gets just the alphabetical code from a series ID (without the number suffix)
 * Example: Series 1 -> "AA", Series 2 -> "AB", Series 27 -> "AAA"
 */
export function getSeriesCode(seriesId: bigint | number): string {
  const id = typeof seriesId === "bigint" ? Number(seriesId) : seriesId;
  
  if (id <= 0) {
    return "AA";
  }

  let letters = "";
  
  if (id <= 26) {
    const letterIndex = id - 1;
    const secondLetter = String.fromCharCode(65 + letterIndex);
    letters = "A" + secondLetter;
  } else {
    const remaining = id - 27;
    const firstLetterIndex = Math.floor(remaining / (26 * 26));
    const secondLetterIndex = Math.floor((remaining % (26 * 26)) / 26);
    const thirdLetterIndex = remaining % 26;
    
    const firstLetter = String.fromCharCode(65 + firstLetterIndex);
    const secondLetter = String.fromCharCode(65 + secondLetterIndex);
    const thirdLetter = String.fromCharCode(65 + thirdLetterIndex);
    
    letters = firstLetter + secondLetter + thirdLetter;
  }
  
  return letters;
}

/**
 * Formats a ticket number with series code and series number
 * Example: Series AA-1, ticket 1 -> "AA1001"
 *          Series AA-1, ticket 100 -> "AA1100"
 *          Series AB-2, ticket 1 -> "AB2001"
 * 
 * Format: [SeriesCode][SeriesNumber][PaddedTicketNumber]
 */
export function formatTicketNumber(
  ticketNumber: bigint | number,
  seriesId: bigint | number,
  padLength: number = 3
): string {
  const ticketNum = typeof ticketNumber === "bigint" ? Number(ticketNumber) : ticketNumber;
  const seriesNum = typeof seriesId === "bigint" ? Number(seriesId) : seriesId;
  
  const seriesCode = getSeriesCode(seriesId);
  const paddedTicket = ticketNum.toString().padStart(padLength, "0");
  
  return `${seriesCode}${seriesNum}${paddedTicket}`;
}

