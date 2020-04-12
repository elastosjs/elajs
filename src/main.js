
import bytesToTypes from './bytesToTypes'
import typesToBytes from './typesToBytes'
import { namehash } from './namehash'
import { keccak256 } from './keccak256'

// @param hexStr does not expect to have a leading 0x prefix!
const hexToBytes = (hexStr) => {
  return Buffer.from(hexStr, 'hex')
}

const bytes32ToHex = (input) => {
  return input
}

const exports = {
  namehash,
  keccak256,

  ...bytesToTypes,
  ...typesToBytes
}

export default exports
