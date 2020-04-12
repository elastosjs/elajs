
import bytesToTypes from './bytesToTypes'
import typesToBytes from './typesToBytes'
import { namehash } from './namehash'

// @param hexStr does not expect to have a leading 0x prefix!
const hexToBytes = (hexStr) => {
  return Buffer.from(hexStr, 'hex')
}

const bytes32ToHex = (input) => {
  return input
}

const exports = {
  namehash,

  ...bytesToTypes,
  ...typesToBytes
}

export default exports
