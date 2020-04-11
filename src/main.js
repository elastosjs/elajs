
import _ from 'lodash'

const strToBytes32 = (input) => {

  const targetBuf = new Buffer.alloc(32)
  const inputBuf = new Buffer.from(input)
  const inputByteLen = inputBuf.byteLength

  // overflow isn't written
  inputBuf.copy(targetBuf, inputByteLen < 32 ? 32 - inputByteLen : 0)

  return targetBuf
}

// TODO: this needs to trim leading zeroes
const bytes32ToStr = (buf) => {
  return _.trimStart(buf.toString(), '\u0000')
}

const uintToBytes32 = (input) => {
  const inputBuf = new Buffer.alloc(4)
  inputBuf.writeUInt32BE(input)

  const targetBuf = new Buffer.alloc(32)
  inputBuf.copy(targetBuf, 28)

  return targetBuf
}

const bytes32ToUint = (buf) => {
  const buf4 = new Buffer.alloc(4)
  buf.copy(buf4, 0, 28)
  return parseInt(buf4.readUInt32BE().toString(10))
}

// @param hexStr should not have a leading 0x prefix!
const hexToBytes = (hexStr) => {
  return Buffer.from(hexStr, 'hex')
}

const bytes32ToHex = (input) => {
  return input
}

export {
  strToBytes32,
  bytes32ToStr,

  uintToBytes32,
  bytes32ToUint
}
