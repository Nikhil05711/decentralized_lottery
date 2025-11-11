// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Nebula Lottery
/// @notice Minimal lottery contract that sells tickets priced in USDT on BNB Testnet.
contract Lottery {
    /// -----------------------------------------------------------------------
    /// Events
    /// -----------------------------------------------------------------------

    event TicketPriceUpdated(uint256 newPrice);
    event TicketPurchased(address indexed buyer, uint256 count, uint256 totalCost);
    event Withdraw(address indexed to, uint256 amount);

    /// -----------------------------------------------------------------------
    /// Errors
    /// -----------------------------------------------------------------------

    error InvalidAddress();
    error InvalidTicketCount();
    error NotOwner();
    error TransferFailed();

    /// -----------------------------------------------------------------------
    /// Storage
    /// -----------------------------------------------------------------------

    address public owner;
    IERC20 public immutable usdt;
    uint256 public ticketPrice;
    uint256 public ticketsSold;
    mapping(address => uint256) public ticketBalances;

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

    /// -----------------------------------------------------------------------
    /// Public actions
    /// -----------------------------------------------------------------------

    function buyTickets(uint256 count) external {
        if (count == 0) revert InvalidTicketCount();

        uint256 totalCost = ticketPrice * count;
        ticketsSold += count;
        ticketBalances[msg.sender] += count;

        emit TicketPurchased(msg.sender, count, totalCost);

        if (totalCost > 0) {
            if (!usdt.transferFrom(msg.sender, address(this), totalCost)) {
                revert TransferFailed();
            }
        }
    }
}

/// @dev Minimal ERC20 interface to interact with USDT without external dependencies.
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

