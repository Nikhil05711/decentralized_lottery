// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Nebula Lottery
/// @notice Minimal lottery contract that sells tickets priced in USDT on BNB Testnet.
contract Lottery {
    /// -----------------------------------------------------------------------
    /// Events
    /// -----------------------------------------------------------------------

    event TicketPriceUpdated(uint256 newPrice);
    event TicketPurchased(
        address indexed buyer,
        uint256 count,
        uint256 totalCost,
        uint256[] ticketIds,
        uint256 indexed seriesId
    );
    event Withdraw(address indexed to, uint256 amount);
    event SeriesConfigured(uint256 indexed seriesId, uint256 totalTickets);
    event SeriesActivated(uint256 indexed seriesId, uint256 totalTickets);
    event SeriesCompleted(uint256 indexed seriesId);

    /// -----------------------------------------------------------------------
    /// Errors
    /// -----------------------------------------------------------------------

    error InvalidAddress();
    error InvalidTicketCount();
    error NotOwner();
    error TransferFailed();
    error NoActiveSeries();
    error InsufficientTickets();
    error InvalidTicketNumber();
    error TicketAlreadySold(uint256 ticketNumber);
    error InvalidTicketNumber();
    error TicketAlreadySold(uint256 ticketNumber);

    /// -----------------------------------------------------------------------
    /// Storage
    /// -----------------------------------------------------------------------

    struct Series {
        uint256 totalTickets;
        uint256 ticketsSold;
    }

    address public owner;
    IERC20 public immutable usdt;
    uint256 public ticketPrice;
    uint256 public ticketsSold;
    uint256 public activeSeriesId;
    uint256 public totalSeriesCount;
    mapping(uint256 => Series) public seriesInfo;
    mapping(address => uint256) public ticketBalances;
    mapping(uint256 => address) public ticketOwners;
    mapping(uint256 => uint256) public ticketSeries;
    mapping(address => uint256[]) private ownedTicketIds;

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

    constructor(address usdtAddress, uint256 initialTicketPrice) {
        if (usdtAddress == address(0)) revert InvalidAddress();
        owner = msg.sender;
        usdt = IERC20(usdtAddress);
        ticketPrice = initialTicketPrice;
    }

    /// -----------------------------------------------------------------------
    /// Owner actions
    /// -----------------------------------------------------------------------

    function setTicketPrice(uint256 newTicketPrice) external onlyOwner {
        ticketPrice = newTicketPrice;
        emit TicketPriceUpdated(newTicketPrice);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (!usdt.transfer(to, amount)) revert TransferFailed();
        emit Withdraw(to, amount);
    }

    function queueSeries(uint256 ticketCount) external onlyOwner {
        if (ticketCount == 0) revert InvalidTicketCount();

        totalSeriesCount += 1;
        Series storage newSeries = seriesInfo[totalSeriesCount];
        newSeries.totalTickets = ticketCount;
        newSeries.ticketsSold = 0;

        emit SeriesConfigured(totalSeriesCount, ticketCount);

        if (activeSeriesId == 0) {
            activeSeriesId = totalSeriesCount;
            emit SeriesActivated(activeSeriesId, ticketCount);
        }
    }

    /// -----------------------------------------------------------------------
    /// Public actions
    /// -----------------------------------------------------------------------

    function buyTickets(uint256 count) external {
        if (count == 0) revert InvalidTicketCount();

        _ensureActiveSeries();
        if (activeSeriesId == 0) revert NoActiveSeries();

        Series storage series = seriesInfo[activeSeriesId];
        uint256 remaining = series.totalTickets - series.ticketsSold;
        if (count > remaining) revert InsufficientTickets();

        uint256[] memory ticketNumbers = new uint256[](count);
        uint256 startNumber = series.ticketsSold + 1;
        for (uint256 i = 0; i < count; i++) {
            ticketNumbers[i] = startNumber + i;
        }

        _completePurchase(msg.sender, activeSeriesId, series, ticketNumbers);
    }

    function buyTicketsAt(uint256[] calldata ticketNumbers) external {
        uint256 count = ticketNumbers.length;
        if (count == 0) revert InvalidTicketCount();

        _ensureActiveSeries();
        if (activeSeriesId == 0) revert NoActiveSeries();

        Series storage series = seriesInfo[activeSeriesId];
        uint256 remaining = series.totalTickets - series.ticketsSold;
        if (count > remaining) revert InsufficientTickets();

        uint256[] memory sanitized = _validateTicketNumbers(ticketNumbers, series.totalTickets);

        _completePurchase(msg.sender, activeSeriesId, series, sanitized);
    }

    function getOwnedTicketIds(address account) external view returns (uint256[] memory) {
        return ownedTicketIds[account];
    }

    function getSeriesInfo(uint256 seriesId)
        external
        view
        returns (uint256 totalTickets, uint256 sold)
    {
        Series storage series = seriesInfo[seriesId];
        return (series.totalTickets, series.ticketsSold);
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
        uint256[] memory ticketIds = _mintTickets(buyer, seriesId, series.totalTickets, ticketNumbers);

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
            _advanceSeries();
        }
    }

    function _validateTicketNumbers(uint256[] calldata ticketNumbers, uint256 totalTickets)
        internal
        pure
        returns (uint256[] memory sanitized)
    {
        uint256 count = ticketNumbers.length;
        sanitized = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 ticketNumber = ticketNumbers[i];
            if (ticketNumber == 0 || ticketNumber > totalTickets) revert InvalidTicketNumber();
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
            if (ticketNumber == 0 || ticketNumber > totalTicketsInSeries) revert InvalidTicketNumber();

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

    function _ensureActiveSeries() internal {
        if (activeSeriesId == 0) {
            _advanceSeries();
            return;
        }

        Series storage series = seriesInfo[activeSeriesId];
        if (series.ticketsSold == series.totalTickets) {
            _advanceSeries();
        }
    }

    function _advanceSeries() internal {
        uint256 startId = activeSeriesId == 0 ? 1 : activeSeriesId + 1;
        for (uint256 id = startId; id <= totalSeriesCount; id++) {
            Series storage candidate = seriesInfo[id];
            if (candidate.totalTickets == 0) continue;
            if (candidate.ticketsSold < candidate.totalTickets) {
                activeSeriesId = id;
                emit SeriesActivated(id, candidate.totalTickets);
                return;
            }
        }

        activeSeriesId = 0;
    }
}

/// @dev Minimal ERC20 interface to interact with USDT without external dependencies.
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

