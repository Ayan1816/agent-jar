import type { Abi } from 'viem'
import artifact from '@/abi/AgentJar.json'

/** Full contract ABI, copied from contracts/abi/AgentJar.json. */
export const agentJarAbi = artifact as Abi

export const registryAbi = [
  {
    type: 'function',
    name: 'ownerOfHandle',
    stateMutability: 'view',
    inputs: [{ name: 'handle', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'handleOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const
