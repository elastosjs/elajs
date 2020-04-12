

import _ from 'lodash'


const bytes32ToStr = (buf) => {
  return _.trimStart(buf.toString(), '\u0000')
}

const bytes32ToUint = (buf) => {
  const buf4 = new Buffer.alloc(4)
  buf.copy(buf4, 0, 28)
  return parseInt(buf4.readUInt32BE().toString(10))
}

export default {
  bytes32ToStr,
  bytes32ToUint
}
