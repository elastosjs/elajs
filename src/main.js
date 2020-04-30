
import bytesToTypes from './bytesToTypes'
import { uintToBytes32 } from './typesToBytes'
import { namehash } from './namehash'
import { keccak256 } from './keccak256'
import elajs from './elajs'

// @param hexStr does not expect to have a leading 0x prefix!
const hexToBytes = (hexStr) => {
  return Buffer.from(hexStr, 'hex')
}

const bytes32ToHex = (input) => {
  return input
}

const exports = {
  elajs,

  namehash,
  keccak256,

  ...bytesToTypes,
  uintToBytes32
}

export default exports
