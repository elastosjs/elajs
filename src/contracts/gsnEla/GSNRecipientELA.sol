pragma solidity ^0.5.0;

import "../ozEla/InitializableELA.sol";
import "./IRelayRecipientELA.sol";
import "./GSNContextELA.sol";
import "./bouncers/GSNBouncerBaseELA.sol";
import "./IRelayHubELA.sol";

/*
 * @dev Base GSN recipient contract, adding the recipient interface and enabling
 * GSN support. Not all interface methods are implemented, derived contracts
 * must do so themselves.
 */
contract GSNRecipientELA is InitializableELA, IRelayRecipientELA, GSNContextELA, GSNBouncerBaseELA {
    function initialize(address relayHubAddr) public initializer {
        GSNContextELA.initialize(relayHubAddr);
    }

    function getHubAddr() public view returns (address) {
        return _getRelayHub();
    }

    // This function is view for future-proofing, it may require reading from
    // storage in the future.
    function relayHubVersion() public view returns (string memory) {
        this; // silence state mutability warning without generating bytecode - see https://github.com/ethereum/solidity/issues/2691
        return "1.0.0";
    }

    function _withdrawDeposits(uint256 amount, address payable payee) internal {
        IRelayHubELA(_getRelayHub()).withdraw(amount, payee);
    }
}
