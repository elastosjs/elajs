

// we use this over Web3.utils.numberToHex because this pads
// extra 0's to ensure it's 32 bytes to the left, however strings read
// left to right so we don't care
const uintToBytes32 = (input) => {
  const inputBuf = new Buffer.alloc(4)
  inputBuf.writeUInt32BE(input)

  const targetBuf = new Buffer.alloc(32)
  inputBuf.copy(targetBuf, 28)

  return '0x' + targetBuf.toString('hex')
}

export {
  uintToBytes32
}
