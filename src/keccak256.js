const { Keccak } = require('sha3')
const sha3 = new Keccak(256)

function keccak256(input){

  if (input.substring(0, 2) === '0x'){
    input = Buffer.from(input.substring(2), 'hex')
  }

  sha3.reset()

  const hash = sha3.update(input).digest()

  return '0x' + hash.toString('hex')
}

export { keccak256 }
