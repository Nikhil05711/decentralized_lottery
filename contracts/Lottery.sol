/**
 *Submitted for verification at testnet.bscscan.com on 2025-11-29
*/

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Nebula Lottery
/// @notice Minimal lottery contract that sells tickets priced in USDT on BNB Testnet.
contract Lottery {
    /// -----------------------------------------------------------------------
    /// Events
    /// -----------------------------------------------------------------------

    event TicketPriceUpdated(uint256 newPrice);
    event RewardUpdated(uint256 newReward);

    event TicketPurchased(
        address indexed buyer,
        uint256 count,
        uint256 totalCost,
        uint256[] ticketIds,
        uint256 indexed seriesId
    );
    event Withdraw(address indexed to, uint256 amount);
    event SeriesConfigured(uint256 indexed seriesId, uint256 totalTickets);
    event SeriesCompleted(uint256 indexed seriesId);
    event DrawExecuted(
        uint256 indexed seriesId,
        uint256[] winningTicketNumbers,
        uint256 randomSeed
    );
    event RewardsDistributed(
        uint256 indexed seriesId,
        address[] winners,
        uint256 rewardPerWinner,
        uint256 totalRewardAmount
    );

    /// -----------------------------------------------------------------------
    /// Errors
    /// -----------------------------------------------------------------------

    error InvalidAddress();
    error InvalidTicketCount();
    error NotOwner();
    error TransferFailed();
    error InsufficientTickets();
    error InvalidTicketNumber();
    error TicketAlreadySold(uint256 ticketNumber);
    error SeriesNotCompleted(uint256 seriesId);
    error RewardsAlreadyDistributed(uint256 seriesId);
    error InsufficientWinners(uint256 seriesId);
    error InvalidSeriesId(uint256 seriesId);
    error SeriesNotReadyForDraw(uint256 seriesId);
    error DrawNotExecuted(uint256 seriesId);
    error DrawAlreadyExecuted(uint256 seriesId);
    error NotEnoughTicketsSold(uint256 seriesId);

    /// -----------------------------------------------------------------------
    /// Storage
    /// -----------------------------------------------------------------------

    uint256 public constant TICKETS_PER_SERIES = 100;
    uint256 public constant DRAW_THRESHOLD = 90; // 90% of 100 tickets
    uint256 public constant WINNING_TICKETS_COUNT = 10;

    struct Series {
        uint256 totalTickets; // Always 100
        uint256 ticketsSold;
        uint256[] winningTicketNumbers; // Empty until draw is executed
        bool drawExecuted;
        uint256 drawRandomSeed;
    }

    address public owner;
    IERC20 public immutable usdt;
    uint256 public ticketPrice;
    uint256 public ticketsSold;
    uint256 public totalSeriesCount;
    uint256 public rewardPerUser = 1;
    mapping(uint256 => Series) public seriesInfo;
    mapping(address => uint256) public ticketBalances;
    mapping(uint256 => address) public ticketOwners;
    mapping(uint256 => uint256) public ticketSeries;
    mapping(address => uint256[]) private ownedTicketIds;
    mapping(uint256 => bool) public rewardsDistributed;

    /// -----------------------------------------------------------------------
    /// Modifiers
    /// -----------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// -----------------------------------------------------------------------
    /// Constructor
    /// -----------------------------------------------------------------------

    constructor(address usdtAddress) {
        if (usdtAddress == address(0)) revert InvalidAddress();
        owner = msg.sender;
        usdt = IERC20(usdtAddress);
        ticketPrice = 0.11 * 10 ** 18;
    }

    /// -----------------------------------------------------------------------
    /// Owner actions
    /// -----------------------------------------------------------------------

    function setTicketPrice(uint256 newTicketPrice) external onlyOwner {
        ticketPrice = newTicketPrice;
        emit TicketPriceUpdated(newTicketPrice);
    }

    function setReward(uint256 newReward) external onlyOwner {
        ticketPrice = newReward;
        emit RewardUpdated(newReward);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function transferFunds(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (!usdt.transfer(to, amount)) revert TransferFailed();
        emit Withdraw(to, amount);
    }

    /// @notice Generate a new series with 100 tickets
    function generateSeries() external onlyOwner {
        totalSeriesCount += 1;
        Series storage newSeries = seriesInfo[totalSeriesCount];
        newSeries.totalTickets = TICKETS_PER_SERIES;
        newSeries.ticketsSold = 0;
        newSeries.drawExecuted = false;

        emit SeriesConfigured(totalSeriesCount, TICKETS_PER_SERIES);
    }

    /// @notice Execute draw for a series that has at least 90% tickets sold
    /// Generates 10 random winning ticket numbers (1-100)
    /// @param seriesId The series ID to draw for
    function executeDraw(uint256 seriesId) external onlyOwner {
        // Validate series exists
        if (seriesId == 0 || seriesId > totalSeriesCount)
            revert InvalidSeriesId(seriesId);

        Series storage currentSeries = seriesInfo[seriesId];

        // Validate series has at least 90 tickets sold
        if (currentSeries.ticketsSold < DRAW_THRESHOLD)
            revert NotEnoughTicketsSold(seriesId);

        // Validate draw hasn't been executed yet
        if (currentSeries.drawExecuted) revert DrawAlreadyExecuted(seriesId);

        // Generate random seed from block data
        // Note: In production, use Chainlink VRF for true randomness
        uint256 randomSeed = uint256(
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1),
                    block.timestamp,
                    block.prevrandao,
                    msg.sender,
                    seriesId,
                    currentSeries.ticketsSold
                )
            )
        );

        currentSeries.drawRandomSeed = randomSeed;

        // Generate 10 unique random ticket numbers between 1 and 100
        uint256[] memory winningNumbers = _generateWinningNumbers(
            randomSeed,
            currentSeries.ticketsSold
        );
        currentSeries.winningTicketNumbers = winningNumbers;
        currentSeries.drawExecuted = true;

        emit DrawExecuted(seriesId, winningNumbers, randomSeed);
    }

    /// @notice Distribute rewards to winners based on winning ticket numbers
    /// @param seriesId The series ID to distribute rewards for
    function distributeRewards(uint256 seriesId) external onlyOwner {
        // Validate series exists
        if (seriesId == 0 || seriesId > totalSeriesCount)
            revert InvalidSeriesId(seriesId);

        Series storage currentSeries = seriesInfo[seriesId];

        // Validate draw has been executed
        if (!currentSeries.drawExecuted) revert DrawNotExecuted(seriesId);

        // Validate rewards haven't been distributed yet
        if (rewardsDistributed[seriesId])
            revert RewardsAlreadyDistributed(seriesId);

        // Get winners based on winning ticket numbers
        address[] memory winners = new address[](WINNING_TICKETS_COUNT);
        uint256 winnersCount = 0;

        // Find owners of winning tickets
        for (
            uint256 i = 0;
            i < currentSeries.winningTicketNumbers.length;
            i++
        ) {
            uint256 winningTicketNumber = currentSeries.winningTicketNumbers[i];
            uint256 ticketId = (seriesId << 128) | winningTicketNumber;
            address ticketOwner = ticketOwners[ticketId];

            if (ticketOwner != address(0)) {
                winners[winnersCount] = ticketOwner;
                winnersCount++;
            }
        }

        if (winnersCount == 0) revert InsufficientWinners(seriesId);

        // Calculate reward pool for this series (tickets sold * ticket price)
        uint256 totalRewardPool = currentSeries.ticketsSold * ticketPrice;

        // Calculate equal reward per winning ticket (each winning ticket gets same reward)
        uint256 rewardPerWinner = rewardPerUser * 10 ** 18; // 1 USDT (assuming 18 decimals)
        // Ensure we have enough balance
        uint256 contractBalance = usdt.balanceOf(address(this));
        if (contractBalance < totalRewardPool) {
            // Use available balance if less than full pool
            totalRewardPool = contractBalance;
            rewardPerWinner = totalRewardPool / WINNING_TICKETS_COUNT;
        }

        // Distribute rewards - same user can receive multiple rewards if they own multiple winning tickets
        for (uint256 i = 0; i < winnersCount; i++) {
            if (winners[i] != address(0) && rewardPerWinner > 0) {
                if (!usdt.transfer(winners[i], rewardPerWinner)) {
                    revert TransferFailed();
                }
            }
        }

        // Mark rewards as distributed
        rewardsDistributed[seriesId] = true;

        // Create a clean winners array for the event (only unique addresses)
        address[] memory uniqueWinners = _getUniqueAddresses(
            winners,
            winnersCount
        );

        // Emit event
        emit RewardsDistributed(
            seriesId,
            uniqueWinners,
            rewardPerWinner,
            rewardPerWinner * winnersCount
        );
    }

    /// -----------------------------------------------------------------------
    /// Public actions
    /// -----------------------------------------------------------------------

    /// @notice Buy tickets from a specific series (sequential ticket numbers)
    /// @param seriesId The series ID to buy tickets from
    /// @param count Number of tickets to buy
    function buyTickets(uint256 seriesId, uint256 count) external {
        if (count == 0) revert InvalidTicketCount();
        if (seriesId == 0 || seriesId > totalSeriesCount)
            revert InvalidSeriesId(seriesId);

        Series storage currentSeries = seriesInfo[seriesId];

        // Check if draw has been executed - can't buy after draw
        if (currentSeries.drawExecuted) revert SeriesNotCompleted(seriesId);

        uint256 remaining = currentSeries.totalTickets -
            currentSeries.ticketsSold;
        if (count > remaining) revert InsufficientTickets();

        uint256[] memory ticketNumbers = new uint256[](count);
        uint256 startNumber = currentSeries.ticketsSold + 1;
        for (uint256 i = 0; i < count; i++) {
            ticketNumbers[i] = startNumber + i;
        }

        _completePurchase(msg.sender, seriesId, currentSeries, ticketNumbers);
    }

    /// @notice Buy specific ticket numbers from a series
    /// @param seriesId The series ID to buy tickets from
    /// @param ticketNumbers Array of specific ticket numbers to buy (1-100)
    function buyTicketsAt(
        uint256 seriesId,
        uint256[] calldata ticketNumbers
    ) external {
        uint256 count = ticketNumbers.length;
        if (count == 0) revert InvalidTicketCount();
        if (seriesId == 0 || seriesId > totalSeriesCount)
            revert InvalidSeriesId(seriesId);

        Series storage currentSeries = seriesInfo[seriesId];

        // Check if draw has been executed - can't buy after draw
        if (currentSeries.drawExecuted) revert SeriesNotCompleted(seriesId);

        uint256 remaining = currentSeries.totalTickets -
            currentSeries.ticketsSold;
        if (count > remaining) revert InsufficientTickets();

        uint256[] memory sanitized = _validateTicketNumbers(
            ticketNumbers,
            currentSeries.totalTickets
        );

        _completePurchase(msg.sender, seriesId, currentSeries, sanitized);
    }

    function getOwnedTicketIds(
        address account
    ) external view returns (uint256[] memory) {
        return ownedTicketIds[account];
    }

    function getSeriesInfo(
        uint256 seriesId
    )
        external
        view
        returns (
            uint256 totalTickets,
            uint256 soldCount,
            bool drawExecuted,
            bool readyForDraw,
            uint256[] memory winningTicketNumbers
        )
    {
        Series storage currentSeries = seriesInfo[seriesId];
        bool isReadyForDraw = currentSeries.ticketsSold >= DRAW_THRESHOLD &&
            !currentSeries.drawExecuted;
        return (
            currentSeries.totalTickets,
            currentSeries.ticketsSold,
            currentSeries.drawExecuted,
            isReadyForDraw,
            currentSeries.winningTicketNumbers
        );
    }

    /// -----------------------------------------------------------------------
    /// Internal helpers
    /// -----------------------------------------------------------------------

    function _completePurchase(
        address buyer,
        uint256 seriesId,
        Series storage series,
        uint256[] memory ticketNumbers
    ) internal {
        uint256 count = ticketNumbers.length;
        uint256 totalCost = ticketPrice * count;
        uint256[] memory ticketIds = _mintTickets(
            buyer,
            seriesId,
            series.totalTickets,
            ticketNumbers
        );

        series.ticketsSold += count;
        ticketsSold += count;
        ticketBalances[buyer] += count;

        emit TicketPurchased(buyer, count, totalCost, ticketIds, seriesId);

        if (totalCost > 0) {
            if (!usdt.transferFrom(buyer, address(this), totalCost)) {
                revert TransferFailed();
            }
        }

        if (series.ticketsSold == series.totalTickets) {
            emit SeriesCompleted(seriesId);
        }
    }

    function _validateTicketNumbers(
        uint256[] calldata ticketNumbers,
        uint256 totalTickets
    ) internal pure returns (uint256[] memory sanitized) {
        uint256 count = ticketNumbers.length;
        sanitized = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 ticketNumber = ticketNumbers[i];
            if (ticketNumber == 0 || ticketNumber > totalTickets)
                revert InvalidTicketNumber();
            sanitized[i] = ticketNumber;
        }
    }

    function _mintTickets(
        address buyer,
        uint256 seriesId,
        uint256 totalTicketsInSeries,
        uint256[] memory ticketNumbers
    ) internal returns (uint256[] memory ticketIds) {
        uint256 count = ticketNumbers.length;
        ticketIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 ticketNumber = ticketNumbers[i];
            if (ticketNumber == 0 || ticketNumber > totalTicketsInSeries)
                revert InvalidTicketNumber();

            uint256 currentTicketId = (seriesId << 128) | ticketNumber;
            if (ticketOwners[currentTicketId] != address(0)) {
                revert TicketAlreadySold(ticketNumber);
            }

            ticketOwners[currentTicketId] = buyer;
            ticketSeries[currentTicketId] = seriesId;
            ownedTicketIds[buyer].push(currentTicketId);
            ticketIds[i] = currentTicketId;
        }
    }

    /// @notice Generate 10 unique random winning ticket numbers (1-100)
    /// @param randomSeed The random seed for generating numbers
    /// @param soldCount Number of tickets sold (used for documentation, always generates 10 numbers)
    function _generateWinningNumbers(
        uint256 randomSeed,
        uint256 soldCount
    ) internal pure returns (uint256[] memory) {
        uint256[] memory winningNumbers = new uint256[](WINNING_TICKETS_COUNT);
        bool[101] memory used; // Index 0 unused, 1-100 for ticket numbers
        uint256 count = 0;
        uint256 seed = randomSeed;

        // Always generate exactly 10 unique random numbers between 1-100
        while (count < WINNING_TICKETS_COUNT) {
            // Generate number between 1 and 100
            seed = uint256(keccak256(abi.encodePacked(seed, count)));
            uint256 ticketNumber = (seed % TICKETS_PER_SERIES) + 1;

            // Check if this number hasn't been selected yet
            if (!used[ticketNumber]) {
                used[ticketNumber] = true;
                winningNumbers[count] = ticketNumber;
                count++;
            }

            // Safety check to prevent infinite loop (shouldn't happen with 100 tickets and 10 winners)
            // If somehow we're stuck, try different seed variations
            if (count < WINNING_TICKETS_COUNT) {
                uint256 attempts = 0;
                while (used[ticketNumber] && attempts < 200) {
                    seed = uint256(
                        keccak256(
                            abi.encodePacked(seed, count, attempts, soldCount)
                        )
                    );
                    ticketNumber = (seed % TICKETS_PER_SERIES) + 1;
                    if (!used[ticketNumber]) {
                        used[ticketNumber] = true;
                        winningNumbers[count] = ticketNumber;
                        count++;
                        break;
                    }
                    attempts++;
                }
            }
        }

        return winningNumbers;
    }

    /// @notice Get unique addresses from an array
    function _getUniqueAddresses(
        address[] memory addresses,
        uint256 length
    ) internal pure returns (address[] memory) {
        address[] memory temp = new address[](length);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < length; i++) {
            bool isUnique = true;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (temp[j] == addresses[i]) {
                    isUnique = false;
                    break;
                }
            }
            if (isUnique && addresses[i] != address(0)) {
                temp[uniqueCount] = addresses[i];
                uniqueCount++;
            }
        }

        address[] memory unique = new address[](uniqueCount);
        for (uint256 i = 0; i < uniqueCount; i++) {
            unique[i] = temp[i];
        }

        return unique;
    }
}

/// @dev Minimal ERC20 interface to interact with USDT without external dependencies.
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}