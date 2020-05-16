const { strToBytes32 } = require('../src/typesToBytes')

console.log('0x' + strToBytes32(process.argv[2]).toString('hex'))
