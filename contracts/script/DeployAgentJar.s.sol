// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {IAgentIdRegistry} from "../src/interfaces/IAgentIdRegistry.sol";

/// @notice Deploys the ownerless AgentJar contract.
/// @dev Reads `PRIVATE_KEY` from the environment and never logs it.
///      Broadcast only when a release is explicitly requested.
contract DeployAgentJar is Script {
    IAgentIdRegistry internal constant REGISTRY = IAgentIdRegistry(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);
    IERC20 internal constant USDT = IERC20(0x55d398326f99059fF775485246999027B3197955);
    IERC20 internal constant USDC = IERC20(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d);

    function run() external returns (AgentJar jar) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        jar = new AgentJar(REGISTRY, USDT, USDC);
        vm.stopBroadcast();

        console2.log("AgentJar", address(jar));
        console2.log("registry", address(REGISTRY));
        console2.log("usdt", address(USDT));
        console2.log("usdc", address(USDC));
    }
}
