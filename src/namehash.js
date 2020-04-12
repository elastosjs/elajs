const { Keccak } = require('sha3')
const sha3 = new Keccak(256)

function namehashInner(input){
  if (input === ''){
    return new Buffer.alloc(32)
  }

  const inputSplit = input.split('.')

  const label = inputSplit.shift()
  const remainder = inputSplit.join('.')

  const labelSha3 = sha3.update(label).digest()

  console.log(labelSha3.toString('hex'))

  sha3.reset()

  const iter = sha3.update(Buffer.concat([namehashInner(remainder), labelSha3])).digest()
  sha3.reset() // TODO: figure out why this needs to be here
  return iter
}

function namehash(input){
  return '0x' + namehashInner(input).toString('hex')
}

/*
function isNamehashSubOf(subKey, base, target){

  // const expectedHash =

}

function namehashSub(subRaw, base){
  sha3.reset()

  return sha3.update(Buffer.concat([base, subKey])).digest()
}
*/

export { namehash }

// 0000000000000000000000000000000000000000000000000000000000000000
