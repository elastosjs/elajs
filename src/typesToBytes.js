


const strToBytes32 = (input) => {

  const targetBuf = new Buffer.alloc(32)
  const inputBuf = new Buffer.from(input)
  const inputByteLen = inputBuf.byteLength

  // overflow isn't written
  inputBuf.copy(targetBuf, inputByteLen < 32 ? 32 - inputByteLen : 0)

  return targetBuf
}

const uintToBytes32 = (input) => {
  const inputBuf = new Buffer.alloc(4)
  inputBuf.writeUInt32BE(input)

  const targetBuf = new Buffer.alloc(32)
  inputBuf.copy(targetBuf, 28)

  return targetBuf
}

export default {
  strToBytes32,
  uintToBytes32
}
